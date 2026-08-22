import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAutomationJob } from "./automation-manager";
import {
  listAutomationRuns,
  refreshAutomationRunnerJobs,
  resolveAutomationModelKind,
  runAutomationJobNow,
  scheduledJobIdsForTests,
  startAutomationRunner,
  stopAutomationRunner
} from "./automation-runner-service";

describe("resolveAutomationModelKind", () => {
  it("routine 系统动作 → routine 模型", () => {
    expect(resolveAutomationModelKind({ systemAction: "routine", source: "system" })).toBe("routine");
  });

  it("用户手动或让 agent 创建的定时任务 → automation 模型", () => {
    expect(resolveAutomationModelKind({ source: "manual" })).toBe("automation");
    // 无 source/systemAction 也视为用户任务
    expect(resolveAutomationModelKind({})).toBe("automation");
  });

  it("其他系统任务（如记忆蒸馏）→ agent 默认模型", () => {
    expect(resolveAutomationModelKind({ systemAction: "memory_distill_workspace", source: "system" })).toBe("agent");
  });
});

describe("automation-runner-service", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-automation-runner-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(async () => {
    await stopAutomationRunner();
    if (oldConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = oldConfigDir;
    }
    rmSync(tempConfigDir, { recursive: true, force: true });
  });

  it("应支持立即执行并写入运行记录", async () => {
    const job = createAutomationJob({
      name: "手动执行任务",
      schedule: { type: "interval", intervalMs: 60_000 },
      prompt: "测试"
    });

    const run = await runAutomationJobNow({ id: job.id });
    expect(run.jobId).toBe(job.id);
    expect(["success", "failed", "skipped"]).toContain(run.status);
    expect(run.trigger).toBe("manual");

    const runs = listAutomationRuns({ jobId: job.id, limit: 10 });
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]?.id).toBe(run.id);
  });

  it("运行记录文件应使用 jsonl 追加写入", async () => {
    const job = createAutomationJob({
      name: "追加记录任务",
      schedule: { type: "interval", intervalMs: 60_000 },
      prompt: "测试"
    });
    await runAutomationJobNow({ id: job.id });
    await runAutomationJobNow({ id: job.id });

    const runsPath = join(tempConfigDir, "automation", "runs", "all.jsonl");
    expect(existsSync(runsPath)).toBeTrue();
    const lines = readFileSync(runsPath, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("存量坏 job 不毒化整轮刷新：好 job 正常调度，坏 job 被跳过 (#452)", async () => {
    const good = createAutomationJob({
      name: "正常任务",
      schedule: { type: "interval", intervalMs: 60_000 },
      prompt: "测试"
    });
    // 直接改写索引模拟旧版放行的存量数据（现行 create/update 已拒绝这些输入）
    const indexPath = join(tempConfigDir, "automation", "jobs.json");
    const index = JSON.parse(readFileSync(indexPath, "utf-8")) as { version: number; jobs: Array<Record<string, unknown>> };
    index.jobs.push(
      {
        id: "legacy-infeasible",
        name: "永假 cron 存量任务",
        enabled: true,
        schedule: { type: "cron", cronExpr: "0 9 31 2 *" },
        prompt: "x",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nextRunAt: null
      },
      {
        id: "legacy-corrupt",
        name: "schedule 缺失存量任务",
        enabled: true,
        schedule: null,
        prompt: "x",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        nextRunAt: Date.now() - 1000
      }
    );
    writeFileSync(indexPath, JSON.stringify(index), "utf-8");

    // 修复前：scheduleJob 内 getNextAutomationRunAt 抛错（或访问 null.schedule），
    // refresh 先 clearSchedules 再遍历 → 整轮中断，好 job 定时器被清且不补
    await expect(startAutomationRunner()).resolves.toBeUndefined();

    const scheduled = scheduledJobIdsForTests();
    expect(scheduled).toContain(good.id);
    expect(scheduled).not.toContain("legacy-infeasible");
    expect(scheduled).not.toContain("legacy-corrupt");

    // 重复刷新同样安全
    await refreshAutomationRunnerJobs();
    expect(scheduledJobIdsForTests()).toContain(good.id);
  });
});
