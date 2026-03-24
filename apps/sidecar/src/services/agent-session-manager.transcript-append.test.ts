import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendAgentCompatibilityMessage,
  createAgentSession,
  getAgentSessionMessages
} from "./agent-session-manager";
import { createOrResumeRuntimeCoreSessionManager } from "./pi-agent/runtime-core/session-store";

describe("agent-session-manager transcript compatibility merge", () => {
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

  test("transcript 已存在时应合并兼容层追加的子任务通知", () => {
    const session = createAgentSession("append transcript");
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), session.id);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "已有用户消息" }],
      timestamp: 100
    });
    sessionManager.appendMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: "已有助手回复" }],
      timestamp: 150
    });

    appendAgentCompatibilityMessage(session.id, {
      id: "announce-1",
      role: "assistant",
      content: "后续补充通知",
      createdAt: 200,
      model: "subagent/announce",
      metadata: {
        subagentAnnounce: true
      }
    }, "subagent_announce");

    const messages = getAgentSessionMessages(session.id);
    expect(messages).toHaveLength(3);
    expect(messages[0]?.content).toBe("已有用户消息");
    expect(messages[1]?.content).toBe("已有助手回复");
    expect(messages[2]?.content).toBe("后续补充通知");
    expect(messages[2]?.model).toBe("subagent/announce");
  });

  test("transcript 已存在时应把 metadata 兼容层并回对应主消息", () => {
    const session = createAgentSession("metadata overlay");
    const sessionManager = createOrResumeRuntimeCoreSessionManager(process.cwd(), session.id);
    sessionManager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "计划执行请求" }],
      timestamp: 100
    });
    sessionManager.appendMessage({
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: "好的，开始执行" }],
      timestamp: 150
    });

    appendAgentCompatibilityMessage(session.id, {
      id: "overlay-1",
      role: "user",
      content: "计划执行请求",
      createdAt: 101,
      metadata: {
        planExecutionKey: "plan-001"
      }
    });

    const messages = getAgentSessionMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe("计划执行请求");
    expect(messages[0]?.metadata?.planExecutionKey).toBe("plan-001");
    expect(messages[1]?.content).toBe("好的，开始执行");
  });
});
