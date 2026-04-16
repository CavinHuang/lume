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

