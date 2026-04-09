import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentMessageAppendedEvent, SDKMessage } from "@lume/shared";

mock.module("../../providers", () => ({
  fetchTitle: async () => null,
  getAdapter: () => ({
    buildTitleRequest: () => ({})
  })
}));

mock.module("../pi-agent/runtime-core/attempt", () => ({
  runPiAgent: async (
    _params: unknown,
    emit: {
      onSdkMessage: (message: SDKMessage) => void;
      onComplete: () => void;
      onError: (error: string) => void;
    }
  ) => {
    emit.onSdkMessage({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{
          type: "text",
          text: "mock assistant output"
        }]
      }
    } as SDKMessage);
    emit.onSdkMessage({
      type: "result",
      subtype: "success",
      duration_ms: 12,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    } as SDKMessage);
    emit.onComplete();
    return { status: "completed" as const };
  },
  stopPiAgent: () => undefined
}));

describe("agent-service", () => {
  let previousConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-agent-service-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(async () => {
    const { resetAgentRuntimeStatusManagerForTest } = await import("./agent-runtime-status-manager");
    resetAgentRuntimeStatusManagerForTest();
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

  test("sendAgentMessage 应先追加 user 可见消息，再在完成后追加 assistant 与原始 sdk transcript", async () => {
    const { createAgentThread, getAgentThreadMessages, getAgentThreadSDKMessages } = await import("./agent-thread-manager");
    const { sendAgentMessage } = await import("./agent-service");
    const thread = createAgentThread("send lifecycle", "channel-test");
    const appended: AgentMessageAppendedEvent[] = [];

    await sendAgentMessage({
      threadId: thread.id,
      userMessage: "hello agent",
      channelId: "channel-test",
      modelId: "provider/model-test"
    }, {
      onSdkMessage: () => undefined,
      onMessageAppended: (event) => {
        appended.push(event);
      },
      onComplete: () => undefined,
      onError: () => undefined,
      onTitleUpdated: () => undefined,
      onAskUserQuestion: () => undefined,
      onToolPermissionRequest: () => undefined
    });

    const visibleMessages = getAgentThreadMessages(thread.id);
    const sdkMessages = getAgentThreadSDKMessages(thread.id);

    expect(appended).toHaveLength(2);
    expect(appended[0]?.message.role).toBe("user");
    expect(appended[0]?.message.sdkMessages?.[0]?.type).toBe("user");
    expect(appended[1]?.message.role).toBe("assistant");
    expect(appended[1]?.message.sdkMessages?.map((message) => message.type)).toEqual(["assistant", "result"]);

    expect(visibleMessages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(visibleMessages[0]?.sdkMessages?.[0]?.type).toBe("user");
    expect(visibleMessages[1]?.content).toBe("mock assistant output");
    expect(sdkMessages.map((message) => message.type)).toEqual(["user", "assistant", "result"]);
  });
});
