import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  getSubagentRunRegistry,
  resetSubagentRunRegistryForTest
} from "./subagent-run-registry";

let previousConfigDir: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-subagent-runs-"));
  resetSubagentRunRegistryForTest();
});

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.LUME_CONFIG_DIR;
  } else {
    process.env.LUME_CONFIG_DIR = previousConfigDir;
  }
  resetSubagentRunRegistryForTest();
});

describe("subagent-run-registry", () => {
  test("应创建并更新 run 状态", () => {
    const registry = getSubagentRunRegistry();
    const runId = randomUUID();

    const created = registry.create({
      runId,
      parentThreadId: "session-main",
      childThreadId: "session-child",
      task: "scan repository",
      cleanup: "keep",
      requestedAgentId: "agent-alpha",
      resolvedAgentId: "agent-alpha",
      modelRef: "openai/gpt-5.4",
      channelId: "channel-a",
      modelId: "model-a"
    });

    expect(created.runId).toBe(runId);
    expect(created.status).toBe("accepted");
    expect(created.modelRef).toBe("openai/gpt-5.4");
    expect(created.startedAt).toBeUndefined();
    expect(created.endedAt).toBeUndefined();

    const running = registry.update(runId, { status: "running" });
    expect(running).not.toBeNull();
    expect(running?.status).toBe("running");
    expect(typeof running?.startedAt).toBe("number");

    const completed = registry.update(runId, {
      status: "completed",
      outcome: {
        output: "done",
        usageEvents: 3
      }
    });

    expect(completed).not.toBeNull();
    expect(completed?.status).toBe("completed");
    expect(completed?.outcome?.output).toBe("done");
    expect(completed?.outcome?.usageEvents).toBe(3);
    expect(typeof completed?.endedAt).toBe("number");

    const byParent = registry.listByParentSession("session-main");
    expect(byParent).toHaveLength(1);
    expect(byParent[0]?.runId).toBe(runId);
  });

  test("应在重建 registry 后恢复持久化 runs", () => {
    const runId = randomUUID();
    {
      const registry = getSubagentRunRegistry();
      registry.create({
        runId,
        parentThreadId: "session-main",
        childThreadId: "session-child",
        task: "persist me",
        cleanup: "delete",
        status: "running"
      });
      registry.update(runId, {
        status: "timed_out",
        outcome: {
          error: "timeout"
        }
      });
    }

    resetSubagentRunRegistryForTest();

    const restored = getSubagentRunRegistry().get(runId);
    expect(restored).not.toBeNull();
    expect(restored?.status).toBe("timed_out");
    expect(restored?.cleanup).toBe("delete");
    expect(restored?.outcome?.error).toBe("timeout");
    expect(typeof restored?.endedAt).toBe("number");
  });

  test("重建 registry 后应把未完成的持久化 run 标记为异常退出", () => {
    const runId = randomUUID();
    {
      const registry = getSubagentRunRegistry();
      registry.create({
        runId,
        parentThreadId: "session-main",
        childThreadId: "session-child",
        task: "interrupted child task",
        cleanup: "keep",
        status: "running"
      });
    }

    resetSubagentRunRegistryForTest();

    const restored = getSubagentRunRegistry().get(runId);
    expect(restored).not.toBeNull();
    expect(restored?.status).toBe("errored");
    expect(restored?.outcome?.errorCode).toBe("process_restarted");
    expect(restored?.outcome?.error).toContain("Sidecar 进程重启");
    expect(typeof restored?.endedAt).toBe("number");
  });

  test("应支持按控制会话聚合 runs 并统计状态", () => {
    const registry = getSubagentRunRegistry();
    const owner = "session-owner";
    const childA = randomUUID();
    const childB = randomUUID();
    const childC = randomUUID();

    registry.create({
      runId: randomUUID(),
      parentThreadId: owner,
      rootThreadId: owner,
      childThreadId: childA,
      task: "task-a",
      cleanup: "keep",
      status: "running"
    });
    registry.create({
      runId: randomUUID(),
      parentThreadId: "session-mid",
      rootThreadId: owner,
      childThreadId: childB,
      task: "task-b",
      cleanup: "keep",
      status: "completed"
    });
    registry.create({
      runId: randomUUID(),
      parentThreadId: "session-other",
      rootThreadId: "session-other",
      childThreadId: childC,
      task: "task-c",
      cleanup: "keep",
      status: "errored"
    });

    const controlled = registry.listControlledByThread(owner);
    expect(controlled).toHaveLength(2);
    expect(controlled.every((item) => item.rootThreadId === owner || item.parentThreadId === owner)).toBe(true);

    const summary = registry.summarizeStatuses(controlled);
    expect(summary.running).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.errored).toBe(0);
  });
});

describe("delegation completion signal", () => {
  test("resolve 唤醒 waitForDelegations(all)", async () => {
    const reg = getSubagentRunRegistry();
    reg.create({ runId: "r1", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c1", task: "t", cleanup: "keep", status: "running" });
    reg.createDelegationCompletion("r1");
    const wait = reg.waitForDelegations({ parentThreadId: "p1", mode: "all", timeoutMs: 1000 });
    // 模拟 delegate background 分支结束：既翻 status 又 resolve completion（S2 真实行为）
    reg.update("r1", { status: "completed", outcome: { output: "done" } });
    reg.resolveDelegationCompletion("r1");
    const result = await wait;
    expect(result.status).toBe("completed");
    expect(result.completedCount).toBe(1);
  });

  test("any 模式 minCompleted=1 首个完成即返回", async () => {
    const reg = getSubagentRunRegistry();
    reg.create({ runId: "r1", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c1", task: "t", cleanup: "keep", status: "running" });
    reg.create({ runId: "r2", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c2", task: "t", cleanup: "keep", status: "running" });
    reg.createDelegationCompletion("r1");
    reg.createDelegationCompletion("r2");
    const wait = reg.waitForDelegations({ parentThreadId: "p1", mode: "any", minCompleted: 1, timeoutMs: 1000 });
    reg.update("r1", { status: "completed", outcome: { output: "done-1" } });
    reg.resolveDelegationCompletion("r1");
    const result = await wait;
    expect(result.status).toBe("completed");
    expect(result.completedCount).toBeGreaterThanOrEqual(1);
  });

  test("超时返回 timeout", async () => {
    const reg = getSubagentRunRegistry();
    reg.create({ runId: "r1", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c1", task: "t", cleanup: "keep", status: "running" });
    reg.createDelegationCompletion("r1");
    const result = await reg.waitForDelegations({ parentThreadId: "p1", mode: "all", timeoutMs: 50 });
    expect(result.status).toBe("timeout");
  });

  test("只等待指定的后台委派", async () => {
    const reg = getSubagentRunRegistry();
    reg.create({ runId: "current", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c1", task: "current", cleanup: "keep", status: "running", background: true });
    reg.create({ runId: "other", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c2", task: "other", cleanup: "keep", status: "running", background: true });
    reg.createDelegationCompletion("current");
    reg.createDelegationCompletion("other");
    const wait = reg.waitForDelegations({ parentThreadId: "p1", runIds: ["current"], mode: "all", timeoutMs: 1000 });

    reg.update("current", { status: "completed" });
    reg.resolveDelegationCompletion("current");

    await expect(wait).resolves.toMatchObject({ status: "completed", completedCount: 1, runningCount: 0 });
  });

  test("中止信号立即取消等待", async () => {
    const reg = getSubagentRunRegistry();
    reg.create({ runId: "r1", parentThreadId: "p1", rootThreadId: "p1", depth: 1, childThreadId: "c1", task: "t", cleanup: "keep", status: "running", background: true });
    reg.createDelegationCompletion("r1");
    const controller = new AbortController();
    const wait = reg.waitForDelegations({ parentThreadId: "p1", mode: "all", timeoutMs: 1000, abortSignal: controller.signal });

    controller.abort();

    await expect(wait).rejects.toThrow("aborted");
  });

  test("无 running 立即返回 completed", async () => {
    const reg = getSubagentRunRegistry();
    const result = await reg.waitForDelegations({ parentThreadId: "p1", mode: "all", timeoutMs: 1000 });
    expect(result.status).toBe("completed");
    expect(result.runningCount).toBe(0);
  });
});
