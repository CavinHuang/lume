import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAutomationJob } from "./automation-manager";
import { listAutomationRuns, resolveAutomationModelKind, runAutomationJobNow, stopAutomationRunner } from "./automation-runner-service";

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
});
