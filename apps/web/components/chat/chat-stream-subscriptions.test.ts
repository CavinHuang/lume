import { describe, expect, test } from "bun:test";
import type { ChatToolActivity } from "@lume/shared";
import {
  appendConversationStreamChunk,
  appendConversationStreamReasoning,
  appendConversationToolActivity
} from "./chat-stream-subscriptions";

describe("chat-stream-subscriptions", () => {
  test("chunk 应追加到 streaming content", () => {
    expect(appendConversationStreamChunk(undefined, "hello")).toEqual({
      streaming: true,
      content: "hello",
      reasoning: "",
      toolActivities: []
    });

    expect(appendConversationStreamChunk({
      streaming: true,
      content: "hello",
      reasoning: "",
      toolActivities: []
    }, " world")).toEqual({
      streaming: true,
      content: "hello world",
      reasoning: "",
      toolActivities: []
    });
  });

  test("reasoning 应追加到 streaming reasoning", () => {
    expect(appendConversationStreamReasoning({
      streaming: true,
      content: "",
      reasoning: "step1",
      toolActivities: []
    }, " -> step2")).toEqual({
      streaming: true,
      content: "",
      reasoning: "step1 -> step2",
      toolActivities: []
    });
  });

  test("tool activity 应追加到活动列表", () => {
    const activity: ChatToolActivity = {
      type: "start",
      toolName: "web_search",
      toolCallId: "call-1"
    };

    expect(appendConversationToolActivity(undefined, activity)).toEqual({
      streaming: true,
      content: "",
      reasoning: "",
      toolActivities: [activity]
    });
  });
});
