import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 回归：once 任务卡在 runningJobs 时，其它任务完成触发的 refreshAutomationRunnerJobs
 * 会以 delay=0 重排它（runAt 已过期）→ 立即触发 → skip。当多个 refresh 间隔到来
 * （模拟「多个其它任务陆续完成，各自在 .then 里调一次 refresh」），每次 refresh 都会
 * 重新 arm 一个 setTimeout(0)，并在两次 refresh 之间触发一次 skip，形成「跨 job」的
 * skip 风暴（线上整点可见单 job 数百条 skip、单日数千条）。
 *
 * d30ec0a 只断了「同 job 自环」（skip 后不再 refresh），没断这条跨 job 路径——
 * 本文件专门覆盖它。
 */

mock.module("../agent/agent-service", () => ({
  // 永不 resolve：executeJob 停在 await dispatchAgentRun，job 留在 runningJobs
  dispatchAgentRun: () => new Promise<void>(() => {}),
  // #587 起 runner 还导入此导出；mock 工厂须枚举全量被导出（bun 缺具名导出即抛）
  onAgentInteractionResolved: () => () => {}
}));

mock.module("../channel/channel-manager", () => ({
  resolveChannelModelBinding: () => ({ channel: { id: "c1" }, modelId: "m1", family: "anthropic" })
}));

mock.module("../system/lume-config-service", () => ({
  getEffectiveLumeConfig: () => ({ models: { agent: { defaultModelRef: "test:p1" } } })
}));

const { createAutomationJob } = await import("./automation-manager");
const {
  listAutomationRuns,
  refreshAutomationRunnerJobs,
  startAutomationRunner,
  stopAutomationRunner
} = await import("./automation-runner-service");

function countSkips(jobId: string): number {
  return listAutomationRuns({ jobId, limit: 100000 }).filter((r) => r.status === "skipped").length;
}

describe("automation-runner 跨 job skip 风暴回归", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-cross-skip-"));
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

  it("卡住时多次 refresh（模拟其它任务完成）只应有界 skip，不形成风暴", async () => {
    const job = createAutomationJob({
      name: "卡住的任务",
      // 过期 once 任务 → scheduleJob 用 setTimeout(0) 立即触发
      schedule: { type: "once", runAt: Date.now() - 1000 },
      prompt: "卡住的任务"
    });

    await startAutomationRunner();
    // 等待初始 setTimeout(0) 触发并进入在飞状态（runningJobs）
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(countSkips(job.id)).toBe(0); // 首次触发是真实执行（在飞），非 skip

    // 模拟「其它多个任务陆续完成」：每个完成都会在 .then 里调一次 refresh
    for (let i = 0; i < 10; i++) {
      await refreshAutomationRunnerJobs();
      // 让 refresh 重排出的 setTimeout(0) 在两次 refresh 之间真正触发
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    const skips = countSkips(job.id);
    // 修复前：~10 条 skip（每次 refresh 一条）；修复后：0（scheduleJob 跳过已在 runningJobs 的 once-job）
    expect(skips).toBeLessThanOrEqual(1);
  });
});
