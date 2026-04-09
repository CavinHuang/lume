import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAgentThread, getAgentThreadMessages } from "../../agent/agent-thread-manager";
import { announceSubagentCompletion } from "./subagent-announce-service";
import type { SubagentRun } from "./subagent-run.types";

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

function buildRun(parentThreadId: string): SubagentRun {
  return {
    runId: randomUUID(),
    parentThreadId,
    rootThreadId: parentThreadId,
    depth: 1,
    childThreadId: randomUUID(),
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
  test("应向父线程追加 completion 消息", async () => {
    const parent = createAgentThread("父线程", "channel-x");
    const run = buildRun(parent.id);
    const result = await announceSubagentCompletion({ run });
    expect(result.delivered).toBe(true);
    expect(result.attempts).toBe(1);

    const messages = getAgentThreadMessages(parent.id);
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content).toContain("子任务完成通知");
    expect(last?.metadata?.subagentAnnounce).toBe(true);
    expect(last?.metadata?.runId).toBe(run.runId);
    expect(last?.metadata?.childThreadId).toBe(run.childThreadId);
  });

  test("父线程不存在时应返回失败", async () => {
    const run = buildRun("missing-parent");
    const result = await announceSubagentCompletion({ run });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("目标线程不存在");
  });

  test("设置 deliveryThreadId 时应投递到指定会话", async () => {
    const parent = createAgentThread("父线程", "channel-x");
    const inbox = createAgentThread("收件线程", "channel-x");
    const run = {
      ...buildRun(parent.id),
      deliveryThreadId: inbox.id
    };
    const result = await announceSubagentCompletion({ run });
    expect(result.delivered).toBe(true);
    const inboxMessages = getAgentThreadMessages(inbox.id);
    const parentMessages = getAgentThreadMessages(parent.id);
    expect(inboxMessages.some((item) => item.metadata?.subagentAnnounce === true)).toBe(true);
    expect(parentMessages.some((item) => item.metadata?.subagentAnnounce === true)).toBe(false);
  });
});

