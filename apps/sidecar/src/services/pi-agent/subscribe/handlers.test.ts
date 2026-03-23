import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@lume/shared";
import type { AgentEvent as PiCoreAgentEvent } from "@mariozechner/pi-agent-core";
import { createAgentStreamAccumulatorState } from "../../agent-stream-accumulator";
import { handlePiSessionEvent } from "./handlers";

describe("pi subscribe handlers", () => {
  test("应映射并分发 message_update text_delta", () => {
    const captured: string[] = [];
    const accumulator = createAgentStreamAccumulatorState();
    const event = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "hello" }
    } as unknown as PiCoreAgentEvent;

    const mapped = handlePiSessionEvent({
      event,
      contextWindow: 200000,
      accumulator,
      onEvent: (agentEvent) => {
        if (agentEvent.type === "text_delta") {
          captured.push(agentEvent.text);
        }
      }
    });

    expect(mapped).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(captured).toEqual(["hello"]);
    expect(accumulator.text).toBe("hello");
    expect(accumulator.events.length).toBe(1);
  });

  test("message_update 非 text_delta 时应回退提取 assistant 文本", () => {
    const captured: AgentEvent[] = [];
    const accumulator = createAgentStreamAccumulatorState();
    const event = {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fallback-text" }]
      },
      assistantMessageEvent: { type: "thinking_delta", delta: "..." }
    } as unknown as PiCoreAgentEvent;

    const mapped = handlePiSessionEvent({
      event,
      accumulator,
      onEvent: (agentEvent) => {
        captured.push(agentEvent);
      }
    });

    expect(mapped).toEqual([{ type: "text_delta", text: "fallback-text" }]);
    expect(captured).toEqual([{ type: "text_delta", text: "fallback-text" }]);
    expect(accumulator.text).toBe("fallback-text");
  });

  test("message_update text_end 应通过 text_complete 更新累积文本", () => {
    const accumulator = createAgentStreamAccumulatorState();
    const event = {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello world" }]
      },
      assistantMessageEvent: { type: "text_end", content: "hello world" }
    } as unknown as PiCoreAgentEvent;

    const mapped = handlePiSessionEvent({
      event,
      accumulator,
      onEvent: () => undefined
    });

    expect(mapped).toEqual([{
      type: "text_complete",
      text: "hello world",
      isIntermediate: false
    }]);
    expect(accumulator.text).toBe("hello world");
  });

  test("message_update 非标准 output_text 结构时应回退提取文本", () => {
    const accumulator = createAgentStreamAccumulatorState();
    const event = {
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "output_text", text: "glm-fallback" }]
      },
      assistantMessageEvent: { type: "thinking_delta", delta: "..." }
    } as unknown as PiCoreAgentEvent;

    const mapped = handlePiSessionEvent({
      event,
      accumulator,
      onEvent: () => undefined
    });

    expect(mapped).toEqual([{ type: "text_delta", text: "glm-fallback" }]);
    expect(accumulator.text).toBe("glm-fallback");
  });
});
