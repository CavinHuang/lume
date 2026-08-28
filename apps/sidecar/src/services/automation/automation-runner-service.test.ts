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
// config/channel mock：让 run 真正走到 dispatchAgentRun（同 cross-job-skip 先例）。
// 默认无模型配置时 pickExecutionChannel 在派发前即抛，挂死 stub 与超时路径不可达。
const configActual = await import("../system/lume-config-service");
mock.module("../system/lume-config-service", () => ({
  ...configActual,
  getEffectiveLumeConfig: () => ({ models: { agent: { defaultModelRef: "test:p1" } } })
}));
const systemConfigActual = await import("../system/system-config-service");
mock.module("../system/system-config-service", () => ({
  ...systemConfigActual,
  getEffectiveSystemConfig: () => ({ models: { agent: { defaultModelRef: "test:p1" } } })
}));
const channelActual = await import("../channel/channel-manager");
mock.module("../channel/channel-manager", () => ({
  ...channelActual,
  resolveChannelModelBinding: () => ({ channel: { id: "c1" }, modelId: "m1", family: "anthropic" })
}));

mock.module("../agent/agent-service", () => ({
  ...agentServiceActual,
  dispatchAgentRun: (input: unknown, emit: DispatchEmit) => dispatchStub(input, emit)
}));

const { createAutomationJob } = await import("./automation-manager");
// 被测模块必须等全部 mock.module 就位后再动态加载——静态 import 会被 hoist 到
// mock 注册之前，stub 对已绑定真实引用的被测模块不生效（bun mock 时序）
const {
  listAutomationRuns,
  listLatestAutomationRunsByJob,
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

  it("一次扫描返回多个 job 的最新 run", async () => {
    const { getAutomationRunsPath } = await import("../infra/config-paths");
    writeFileSync(getAutomationRunsPath(), [
      { id: "run-a-old", jobId: "job-a", startedAt: 1 },
      { id: "run-b", jobId: "job-b", startedAt: 3 },
      { id: "run-a-new", jobId: "job-a", startedAt: 4 },
      { id: "run-other", jobId: "job-other", startedAt: 5 },
    ].map((run) => JSON.stringify(run)).join("\n"), "utf-8");

    const latest = listLatestAutomationRunsByJob(["job-a", "job-b"]);

    expect(latest.get("job-a")?.id).toBe("run-a-new");
    expect(latest.get("job-b")?.id).toBe("run-b");
    expect(latest.has("job-other")).toBeFalse();
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
    // 首笔到达 dispatch 后为真异步，须等其收尾再触发第二笔，否则撞 runningJobs 拒绝
    for (let i = 0; i < 50 && listAutomationRuns({ jobId: job.id, limit: 10 }).length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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

  it("notification writer 抛错(EPIPE)不断掉 run 收尾与重放链(#647 follow-up7)", async () => {
    const { setOutboundNotificationWriter } = await import("../infra/outbound-notification");
    setOutboundNotificationWriter(() => {
      throw new Error("EPIPE: broken pipe");
    });
    try {
      const job = createAutomationJob({
        name: "通知炸链任务",
        schedule: { type: "interval", intervalMs: 120 },
        prompt: "测试"
      });
      await startAutomationRunner();

      // writer 抛错只允许丢事件本身，不得跳过后续 merged-trigger 重放：
      // 修复前 writer 位于 executeJob 尾部重调度块之前，抛错即整条调度链静默终止
      let runs: ReturnType<typeof listAutomationRuns> = [];
      for (let i = 0; i < 60; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        runs = listAutomationRuns({ jobId: job.id, limit: 20 }).filter((run) => run.status !== "skipped");
        if (runs.length >= 2) break;
      }
      expect(runs.length).toBeGreaterThanOrEqual(2);
    } finally {
      setOutboundNotificationWriter(() => {});
    }
  }, 12_000);

  it("启动追账的过期任务错峰触发，不再同一 sweep 齐发(#647 follow-up6)", async () => {
    const jobs = Array.from({ length: 5 }, (_, i) => createAutomationJob({
      name: `追账齐发任务${i}`,
      schedule: { type: "interval", intervalMs: 60_000 },
      prompt: "测试"
    }));
    // 全部 backdate 成过期任务，模拟停机期间累积的待补跑（默认 misfire=补跑最新一次）
    const indexPath = join(tempConfigDir, "automation", "jobs.json");
    const index = JSON.parse(readFileSync(indexPath, "utf-8")) as {
      version: number;
      jobs: Array<Record<string, unknown>>;
    };
    const past = Date.now() - 5_000;
    for (const entry of index.jobs) entry.nextRunAt = past;
    writeFileSync(indexPath, JSON.stringify(index), "utf-8");

    await startAutomationRunner();
    // 轮询等 5 个 run 全部落盘（错峰后最迟一批 ≈ 6s）
    let runs: ReturnType<typeof listAutomationRuns> = [];
    for (let i = 0; i < 120 && runs.length < jobs.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      runs = listAutomationRuns({ limit: 100 });
    }
    expect(runs.length).toBeGreaterThanOrEqual(jobs.length);
    // 修复前：全部 delay=0 → 同一 timer sweep 齐发，startedAt 散布 <100ms；
    // 错峰后按刷新轮内序数 1.5s 步进摊开（5 任务散布 ≈ 6s）
    const starts = runs.map((run) => run.startedAt).sort((a, b) => a - b);
    expect(starts[starts.length - 1]! - starts[0]!).toBeGreaterThanOrEqual(4_000);
  }, 20_000);


  it("无人值守 run 超过 wall-clock 上限即中止并记 failed(#647 follow-up3)", async () => {
    process.env.LUME_AUTOMATION_RUN_TIMEOUT_MS = "300";
    const previous = dispatchStub;
    // dispatch 挂死：模拟 provider 无响应——租约心跳持续续命、runningJobs 永久占位
    dispatchStub = () => new Promise(() => {});
    try {
      const job = createAutomationJob({
        name: "超时中止任务",
        schedule: { type: "interval", intervalMs: 60_000 },
        prompt: "测试"
      });
      await runAutomationJobNow({ id: job.id });

      let timedOut: ReturnType<typeof listAutomationRuns>[number] | undefined;
      for (let i = 0; i < 50 && !timedOut; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        timedOut = listAutomationRuns({ jobId: job.id, limit: 10 }).find((run) => run.status === "failed");
      }
      expect(timedOut?.message).toContain("wall-clock");
    } finally {
      dispatchStub = previous;
      delete process.env.LUME_AUTOMATION_RUN_TIMEOUT_MS;
    }
  }, 15_000);

  it("per-job thinkingLevel 与 toolResourceIds 透传 dispatch(#647 P2-19)", async () => {
    const dispatched: Array<{ thinkingLevel?: string; messageMetadata?: { toolPolicy?: { allow?: string[] } } }> = [];
    const previous = dispatchStub;
    dispatchStub = ((input: unknown) => {
      dispatched.push(input as { thinkingLevel?: string; messageMetadata?: { toolPolicy?: { allow?: string[] } } });
      return Promise.reject(new Error("jobfield test stub"));
    }) as typeof dispatchStub;
    try {
      const job = createAutomationJob({
        name: "字段接线任务",
        schedule: { type: "interval", intervalMs: 60_000 },
        thinkingLevel: "high",
        toolResourceIds: ["browser:*", "mcp:fetch"],
        prompt: "测试"
      });
      await runAutomationJobNow({ id: job.id });
      for (let i = 0; i < 50 && dispatched.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(dispatched[0]?.thinkingLevel).toBe("high");
      expect(dispatched[0]?.messageMetadata?.toolPolicy?.allow).toEqual(["browser:*", "mcp:fetch"]);
    } finally {
      dispatchStub = previous;
    }
  });

  it("job.defaultModel 覆盖系统默认 modelRef，未配置则回落(#647 P2-19)", async () => {
    const dispatched: Array<{ modelRef?: string; thinkingLevel?: string }> = [];
    const previous = dispatchStub;
    dispatchStub = ((input: unknown) => {
      dispatched.push(input as { modelRef?: string; thinkingLevel?: string });
      return Promise.reject(new Error("jobfield test stub"));
    }) as typeof dispatchStub;
    try {
      const override = createAutomationJob({
        name: "模型覆盖任务",
        schedule: { type: "interval", intervalMs: 60_000 },
        defaultModel: "custom:model-ref",
        prompt: "测试"
      });
      await runAutomationJobNow({ id: override.id });
      for (let i = 0; i < 50 && dispatched.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(dispatched[0]?.modelRef).toBe("custom:model-ref");

      dispatched.length = 0;
      const fallback = createAutomationJob({
        name: "默认回落任务",
        schedule: { type: "interval", intervalMs: 60_000 },
        prompt: "测试"
      });
      await runAutomationJobNow({ id: fallback.id });
      for (let i = 0; i < 50 && dispatched.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(dispatched[0]?.modelRef).toBe("test:p1");
      expect(dispatched[0]?.thinkingLevel).toBeUndefined();
    } finally {
      dispatchStub = previous;
    }
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
