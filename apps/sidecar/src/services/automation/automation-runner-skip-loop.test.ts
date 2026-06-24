import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 回归：once 任务在「任务仍在运行」被跳过时，不得触发 refreshAutomationRunnerJobs。
 *
 * 旧实现在 executeJob 后无条件 `.finally(refresh)`：过期 once 任务 delay=0，
 * 一次跳过 → refresh → 重新 setTimeout(0) → 再次跳过 → refresh …… 以事件循环
 * 速率自转（线上单任务 1–2 分钟内数万条 skip）。
 *
 * 本文件用 mock.module 单独隔离（process-global，避免污染其它测试文件），
 * 让 sendAgentMessage 永不 resolve 模拟“长任务在飞”，再手动触发一次 refresh
 * 点燃回路，断言 skip 条目有界（旧代码会瞬间产生数百条）。
 */

mock.module("../agent/agent-service", () => ({
  // 永不 resolve：executeJob 停在 await sendAgentMessage，job 留在 runningJobs
  sendAgentMessage: () => new Promise<void>(() => {})
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
  return listAutomationRuns({ jobId, limit: 10000 }).filter((r) => r.status === "skipped").length;
}

describe("automation-runner skip 死循环回归", () => {
  let tempConfigDir = "";
  const oldConfigDir = process.env.LUME_CONFIG_DIR;

  beforeEach(() => {
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-skip-loop-"));
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

  it("在飞期间被再次触发只应有界 skip，不形成 refresh 死循环", async () => {
    const job = createAutomationJob({
      name: "长任务",
      // 过期 once 任务 → scheduleJob 用 setTimeout(0) 立即触发
      schedule: { type: "once", runAt: Date.now() - 1000 },
      prompt: "长任务"
    });

    await startAutomationRunner();
    // 等待初始 setTimeout(0) 触发并进入在飞状态（runningJobs）
    await new Promise((resolve) => setTimeout(resolve, 50));
    const skipsBeforeIgnite = countSkips(job.id);
    expect(skipsBeforeIgnite).toBe(0); // 首次触发是真实执行（在飞），非 skip

    // 手动触发一次 refresh，模拟「另一个任务执行完点燃重排」
    await refreshAutomationRunnerJobs();
    // 给可能的死循环一段充分时间（旧代码在此窗口内会产生数百条 skip）
    await new Promise((resolve) => setTimeout(resolve, 200));

    const skipsAfterIgnite = countSkips(job.id);
    // 修复后：重排只 arm 一次 setTimeout(0) → 恰好 1 次 skip，且不再自我 refresh。
    // 旧代码：此处会远超 2（数百）。
    expect(skipsAfterIgnite).toBeLessThanOrEqual(2);
  });
});
