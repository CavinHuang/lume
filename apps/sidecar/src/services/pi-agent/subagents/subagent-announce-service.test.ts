import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentSession, getAgentSessionMessages } from "../../agent/agent-session-manager";
import { announceSubagentCompletion } from "./subagent-announce-service";
import type { SubagentRun } from "./subagent-run.types";
import { subscribeSubagentAnnounceEvent } from "./subagent-announce-bus";

let previousConfigDir: string | undefined;

beforeEach(() => {
  previousConfigDir = process.env.LUME_CONFIG_DIR;
  process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-subagent-announce-"));
});

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.LUME_CONFIG_DIR;
  } else {
    process.env.LUME_CONFIG_DIR = previousConfigDir;
  }
});

function buildRun(parentSessionId: string): SubagentRun {
  return {
    runId: randomUUID(),
    parentSessionId,
    rootSessionId: parentSessionId,
    depth: 1,
    childSessionId: randomUUID(),
    label: "测试子任务",
    task: "run test task",
    status: "completed",
    cleanup: "keep",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: Date.now() - 500,
    endedAt: Date.now(),
    outcome: {
      output: "mock output",
      usageEvents: 2
    }
  };
}

describe("subagent-announce-service", () => {
  test("应向父会话追加 completion 消息并发布事件", async () => {
    const parent = createAgentSession("父会话", "channel-x");
    const run = buildRun(parent.id);
    const events: Array<{ sessionId: string; runId: string }> = [];
    const unsubscribe = subscribeSubagentAnnounceEvent((event) => {
      events.push({ sessionId: event.sessionId, runId: event.runId });
    });
    try {
      const result = await announceSubagentCompletion({ run });
      expect(result.delivered).toBe(true);
      expect(result.attempts).toBe(1);

      const messages = getAgentSessionMessages(parent.id);
      const last = messages[messages.length - 1];
      expect(last?.role).toBe("assistant");
      expect(last?.content).toContain("子任务完成通知");
      expect(last?.metadata?.subagentAnnounce).toBe(true);
      expect(last?.metadata?.runId).toBe(run.runId);
      expect(last?.metadata?.childSessionId).toBe(run.childSessionId);
      expect(events).toHaveLength(1);
      expect(events[0]?.sessionId).toBe(parent.id);
      expect(events[0]?.runId).toBe(run.runId);
    } finally {
      unsubscribe();
    }
  });

  test("父会话不存在时应返回失败", async () => {
    const run = buildRun("missing-parent");
    const result = await announceSubagentCompletion({ run });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("目标会话不存在");
  });

  test("设置 deliverySessionId 时应投递到指定会话", async () => {
    const parent = createAgentSession("父会话", "channel-x");
    const inbox = createAgentSession("收件会话", "channel-x");
    const run = {
      ...buildRun(parent.id),
      deliverySessionId: inbox.id
    };
    const result = await announceSubagentCompletion({ run });
    expect(result.delivered).toBe(true);
    const inboxMessages = getAgentSessionMessages(inbox.id);
    const parentMessages = getAgentSessionMessages(parent.id);
    expect(inboxMessages.some((item) => item.metadata?.subagentAnnounce === true)).toBe(true);
    expect(parentMessages.some((item) => item.metadata?.subagentAnnounce === true)).toBe(false);
  });
});
