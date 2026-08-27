import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * dispatchAgentRun stub：本文件钉的是"运行记录写入/调度隔离"行为，不是
 * LLM 派发集成。真实派发在测试环境会走完整 attempt 链（无模型配置时挂起），
 * waitForThreadIdle 改为真实等待后(#547)必须 stub 掉才能保持确定性。
 * mock.module 是 process-global 的：spread 真实模块仅覆写一个函数，缩小对
 * 同进程后续测试文件的串扰面（同 cross-job-skip 先例的隔离惯例）。
 */
const agentServiceActual = await import("../agent/agent-service");
type DispatchEmit = { onComplete?: (payload?: { reason?: "max_turns" | "repeat_guard" }) => void };
let dispatchStub: (input: unknown, emit: DispatchEmit) => Promise<unknown> = async () => {
  throw new Error("model unavailable (test stub)");
};
mock.module("../agent/agent-service", () => ({
  ...agentServiceActual,
  dispatchAgentRun: (input: unknown, emit: DispatchEmit) => dispatchStub(input, emit)
}));

const { createAutomationJob } = await import("./automation-manager");
// 被测模块必须等全部 mock.module 就位后再动态加载——静态 import 会被 hoist 到
// mock 注册之前，stub 对已绑定真实引用的被测模块不生效（bun mock 时序）
const {
  listAutomationRuns,
  refreshAutomationRunnerJobs,
  resolveAutomationModelKind,
  resolveAutomationRunOutcome,
  runAutomationJobNow,
  scheduledJobIdsForTests,
  startAutomationRunner,
  stopAutomationRunner
} = await import("./automation-runner-service");

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

  it("立即执行受理即返回 running 回执，真实运行记录异步落盘(#586)", async () => {
    const job = createAutomationJob({
      name: "手动执行任务",
      schedule: { type: "interval", intervalMs: 60_000 },
      prompt: "测试"
    });

    const receipt = await runAutomationJobNow({ id: job.id });
    expect(receipt.jobId).toBe(job.id);
    expect(receipt.status).toBe("running");
    expect(receipt.trigger).toBe("manual");

    // 受理即返回：真实记录由后台 executeJob 完成后写入，轮询等待落盘
    let runs = listAutomationRuns({ jobId: job.id, limit: 10 });
    for (let i = 0; i < 50 && runs.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      runs = listAutomationRuns({ jobId: job.id, limit: 10 });
    }
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(["success", "failed", "skipped", "running", "waiting_for_user", "waiting_for_approval"]).toContain(runs[0]?.status ?? "");
    expect(runs[0]?.id ?? "").not.toBe(receipt.id);
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
    let lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (existsSync(runsPath)) {
        lines = readFileSync(runsPath, "utf-8").trim().split("\n");
        if (lines.length >= 2) break;
      }
    }
    expect(existsSync(runsPath)).toBeTrue();
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("正常完成的 run(onComplete 无载荷)记 success(#649 review P1-1 对照)", () => {
    const outcome = resolveAutomationRunOutcome({
      runtimeError: null, waitingForUser: false, waitingForApproval: false, turnLimitedStopped: false, threadId: "thread-1"
    });
    expect(outcome.status).toBe("success");
    expect(outcome.message).toContain("任务执行完成");
  });

  it("触顶停止的 run 如实记 failed 而非假成功(#649 review P1-1)", () => {
    // 检测挂 onComplete 的 reason——T7a 后 sidecar 生产不再构造 run.turn_limited 事件
    // (onRuntimeEvent 检测在生产中永不为真);消费分支缺失时触顶 run 会照落「任务执行完成」，
    // desktop 通知面(只对 failed/waiting_* 弹)对半途而废的无人值守任务永不提醒。
    const outcome = resolveAutomationRunOutcome({
      runtimeError: null, waitingForUser: false, waitingForApproval: false, turnLimitedStopped: true, threadId: "thread-1"
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("回合上限");
  });

  it("#649 round3: repeat_guard 保护停止与 max_turns 同归 failed", () => {
    // agent-service onComplete 对两种保护性停止都发 reason(max_turns/repeat_guard),
    // 消费侧对两者都置位 turnLimitedStopped;漏匹配任一 = P1-1 同构假成功
    expect(resolveAutomationRunOutcome({
      runtimeError: null, waitingForUser: false, waitingForApproval: false, turnLimitedStopped: true, threadId: "t"
    }).status).toBe("failed");
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
