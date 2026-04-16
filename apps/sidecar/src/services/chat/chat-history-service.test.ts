import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StreamCompleteEvent, StreamErrorEvent } from "@lume/shared";
import { createConversation, getConversationMessages } from "./conversation-manager";
import {
  completeAbortedAssistantResponse,
  completeAssistantResponse,
  completeEmptyAbort,
  completeMockResponse,
  emitChatSendError,
} from "./chat-history-service";

describe("chat-history-service", () => {
  let prevConfigDir: string | undefined;

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    process.env.LUME_CONFIG_DIR = mkdtempSync(join(tmpdir(), "lume-chat-history-service-"));
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
  });

  test("completeAssistantResponse 应写入 user/assistant 消息并发出 complete", () => {
    const conversation = createConversation("history-complete");
    const completeEvents: StreamCompleteEvent[] = [];
    const errorEvents: StreamErrorEvent[] = [];

    completeAssistantResponse({
      conversationId: conversation.id,
      userMessage: "你好",
      assistantContent: "世界",
      assistantModel: "mock-model",
      assistantReasoning: "thinking",
      emit: {
        onComplete: (event) => { completeEvents.push(event); },
        onError: (event) => { errorEvents.push(event); },
      },
    });

    const messages = getConversationMessages(conversation.id);
    expect(messages.length).toBe(2);
    expect(messages[0]?.role).toBe("user");
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toBe("世界");
    expect(messages[1]?.reasoning).toBe("thinking");
    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0]?.messageId).toBe(messages[1]?.id);
    expect(errorEvents.length).toBe(0);
  });

  test("completeAbortedAssistantResponse 应写入 stopped assistant 消息", () => {
    const conversation = createConversation("history-abort");
    const completeEvents: StreamCompleteEvent[] = [];

    completeAbortedAssistantResponse({
      conversationId: conversation.id,
      userMessage: "继续",
      assistantContent: "部分内容",
      assistantModel: "mock-model",
      emit: {
        onComplete: (event) => { completeEvents.push(event); },
        onError: () => {},
      },
    });

    const messages = getConversationMessages(conversation.id);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.stopped).toBeTrue();
    expect(completeEvents.length).toBe(1);
  });

  test("completeMockResponse / completeEmptyAbort / emitChatSendError 应发出对应事件", () => {
    const conversation = createConversation("history-events");
    const completeEvents: StreamCompleteEvent[] = [];
    const errorEvents: StreamErrorEvent[] = [];
    const emitter = {
      onComplete: (event: StreamCompleteEvent) => { completeEvents.push(event); },
      onError: (event: StreamErrorEvent) => { errorEvents.push(event); },
    };

    completeMockResponse({
      conversationId: conversation.id,
      userMessage: "mock",
      assistantContent: "mock-result",
      assistantModel: "mock-model",
      emit: emitter,
    });
    completeEmptyAbort({
      conversationId: conversation.id,
      assistantModel: "mock-model",
      emit: emitter,
    });
    emitChatSendError({
      conversationId: conversation.id,
      error: "失败",
      emit: emitter,
    });

    expect(completeEvents.length).toBe(2);
    expect(completeEvents[1]?.messageId).toBe("");
    expect(errorEvents.length).toBe(1);
    expect(errorEvents[0]?.error).toBe("失败");
  });
});
