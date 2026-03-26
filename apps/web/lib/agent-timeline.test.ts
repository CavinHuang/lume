import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import { extractTimelineEvents } from "./agent-timeline";

describe("agent-timeline", () => {
  test("应优先用 text_complete 覆盖同 turn 的 delta 累积", () => {
    const message: AgentMessage = {
      id: "m1",
      role: "assistant",
      content: "",
      createdAt: 1,
      events: [
        { type: "text_delta", text: "Hel", turnId: "t1" },
        { type: "text_delta", text: "lo", turnId: "t1" },
        { type: "text_complete", text: "Hello", isIntermediate: false, turnId: "t1" }
      ]
    };

    expect(extractTimelineEvents(message)).toEqual([
      {
        type: "text",
        content: "Hello",
        eventId: "t1",
        turnId: "t1",
        parentToolUseId: undefined
      }
    ]);
  });

  test("只有工具事件但 message.content 有文本时应补 fallback text event", () => {
    const message: AgentMessage = {
      id: "m2",
      role: "assistant",
      content: "最终回答",
      createdAt: 1,
      events: [
        {
          type: "tool_start",
          toolUseId: "tool-1",
          toolName: "Read",
          input: {}
        }
      ]
    };

    const events = extractTimelineEvents(message);
    expect(events.some((event) => event.type === "text" && event.content === "最终回答")).toBe(true);
  });
});
