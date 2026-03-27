import { describe, expect, test } from "bun:test";
import type { AgentEvent as PiCoreAgentEvent } from "@mariozechner/pi-agent-core";
import { mapPiSessionEventToAgentEvents } from "./map-pi-session-event";

describe("map-pi-session-event", () => {
  test("message_update text_delta 应映射为 text_delta", () => {
    const event = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_delta", delta: "你好" }
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event);
    expect(mapped).toEqual([{ type: "text_delta", text: "你好" }]);
  });

  test("message_update text_end 应映射为 text_complete", () => {
    const event = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: { type: "text_end", content: "你好，世界" }
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event);
    expect(mapped).toEqual([{
      type: "text_complete",
      text: "你好，世界",
      isIntermediate: false
    }]);
  });

  test("tool_execution_start 应映射为 tool_start", () => {
    const event = {
      type: "tool_execution_start",
      toolName: "Read",
      toolCallId: "call_1",
      args: { path: "README.md" }
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event);
    expect(mapped[0]?.type).toBe("tool_start");
    if (mapped[0]?.type !== "tool_start") {
      throw new Error("unexpected type");
    }
    expect(mapped[0].toolName).toBe("Read");
    expect(mapped[0].toolUseId).toBe("call_1");
  });

  test("tool_execution_end 应映射为 tool_result", () => {
    const event = {
      type: "tool_execution_end",
      toolName: "Read",
      toolCallId: "call_2",
      result: { ok: true },
      isError: false
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event);
    expect(mapped[0]?.type).toBe("tool_result");
    if (mapped[0]?.type !== "tool_result") {
      throw new Error("unexpected type");
    }
    expect(mapped[0].toolUseId).toBe("call_2");
    expect(mapped[0].isError).toBeFalse();
  });

  test("message_end assistant 应映射 text_complete + usage_update", () => {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "最终答案" }],
        usage: {
          input: 10,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 30,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event, { contextWindow: 200000 });
    expect(mapped).toEqual([
      {
        type: "text_complete",
        text: "最终答案",
        isIntermediate: false
      },
      {
        type: "usage_update",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          totalTokens: 30,
          costUsd: 0,
          contextWindow: 200000
        }
      }
    ]);
  });

  test("message_end assistant 应分离 reasoning 与正式正文", () => {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先检查配置" },
          { type: "text", text: "这是正式回答" }
        ]
      }
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event);
    expect(mapped).toEqual([
      {
        type: "reasoning_complete",
        text: "先检查配置",
        isIntermediate: false
      },
      {
        type: "text_complete",
        text: "这是正式回答",
        isIntermediate: false
      }
    ]);
  });

  test("message_update done 应回填完整文本", () => {
    const event = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "done",
        message: {
          content: [{ type: "text", text: "done-text" }]
        }
      }
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event);
    expect(mapped).toEqual([{
      type: "text_complete",
      text: "done-text",
      isIntermediate: false
    }]);
  });

  test("message_update done 应同时回填 reasoning 与正文", () => {
    const event = {
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "done",
        message: {
          content: [
            { type: "reasoning", reasoning: "逐步分析" },
            { type: "text", text: "done-text" }
          ]
        }
      }
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event);
    expect(mapped).toEqual([
      {
        type: "reasoning_complete",
        text: "逐步分析",
        isIntermediate: false
      },
      {
        type: "text_complete",
        text: "done-text",
        isIntermediate: false
      }
    ]);
  });

  test("message_end 非标准 output_text 结构也应映射为 text_complete", () => {
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "output_text", text: "glm-text" }]
      }
    } as unknown as PiCoreAgentEvent;
    const mapped = mapPiSessionEventToAgentEvents(event);
    expect(mapped).toEqual([{
      type: "text_complete",
      text: "glm-text",
      isIntermediate: false
    }]);
  });

});
