import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendAgentTranscriptMessage,
  createAgentSession,
  getAgentSessionMessages
} from "./agent-thread-manager";

describe("agent-thread-manager transcript projection", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-session-append-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = previousConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("subagent announce 应直接写入 transcript 并保留派生 metadata", () => {
    const session = createAgentSession("append transcript");
    appendAgentTranscriptMessage(session.id, {
      id: "announce-1",
      role: "assistant",
      content: "子任务完成通知: 测试子任务 (completed)\nrunId: run-123\nchildSessionKey: child-456",
      createdAt: 200,
      model: "subagent/announce"
    });

    const messages = getAgentSessionMessages(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toContain("子任务完成通知");
    expect(messages[0]?.model).toBe("subagent/announce");
    expect(messages[0]?.metadata?.subagentAnnounce).toBe(true);
    expect(messages[0]?.metadata?.runId).toBe("run-123");
    expect(messages[0]?.metadata?.childSessionId).toBe("child-456");
    expect(messages[0]?.metadata?.status).toBe("completed");
  });

  test("appendAgentTranscriptMessage 应保留 reasoning", () => {
    const session = createAgentSession("append reasoning");
    appendAgentTranscriptMessage(session.id, {
      id: "assistant-1",
      role: "assistant",
      content: "正式回答",
      reasoning: "先检查配置再回答",
      createdAt: 300,
      model: "zai/glm-5-turbo"
    });

    const messages = getAgentSessionMessages(session.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe("正式回答");
    expect(messages[0]?.reasoning).toBe("先检查配置再回答");
  });
});
