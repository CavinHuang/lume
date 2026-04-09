import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";
import { applySdkMessage, type AgentStreamState } from "./agent-streaming";

function createState(): AgentStreamState {
  return {
    running: true,
    content: "",
    reasoning: "",
    toolActivities: []
  };
}

describe("agent-streaming", () => {
  test("assistant 消息应避免和已有 content 重复拼接", () => {
    const state = createState();
    const afterDelta = applySdkMessage(state, {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: {
          type: "text_delta",
          text: "Hello "
        }
      }
    } as unknown as SDKMessage);

    const afterAssistant = applySdkMessage(afterDelta, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }]
      }
    } as SDKMessage);

    expect(afterAssistant.content).toBe("Hello world");
  });

  test("tool_use/tool_result 应创建并完成 tool activity", () => {
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const afterStart = applySdkMessage(createState(), {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: { path: "README.md" }
          }]
        }
      } as unknown as SDKMessage);
      now = 1_975;
      const afterResult = applySdkMessage(afterStart, {
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "ok"
          }]
        }
      } as unknown as SDKMessage);

      expect(afterResult.toolActivities).toEqual([{
        toolUseId: "tool-1",
        toolName: "Read",
        input: { path: "README.md" },
        parentToolUseId: undefined,
        startedAt: 1_000,
        done: true,
        isError: false,
        result: "ok",
        elapsedMs: 975
      }]);
    } finally {
      Date.now = realNow;
    }
  });

  test("独立 tool_result 消息也应完成 tool activity", () => {
    const realNow = Date.now;
    let now = 2_000;
    Date.now = () => now;
    try {
      const afterStart = applySdkMessage(createState(), {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "tool-standalone",
            name: "Read",
            input: { path: "README.md" }
          }]
        }
      } as unknown as SDKMessage);
      now = 2_250;
      const afterResult = applySdkMessage(afterStart, {
        type: "tool_result",
        result: {
          tool_use_id: "tool-standalone",
          tool_name: "Read",
          output: "done"
        }
      } as unknown as SDKMessage);

      expect(afterResult.toolActivities).toEqual([{
        toolUseId: "tool-standalone",
        toolName: "Read",
        input: { path: "README.md" },
        parentToolUseId: undefined,
        startedAt: 2_000,
        done: true,
        isError: false,
        result: "done",
        elapsedMs: 250
      }]);
    } finally {
      Date.now = realNow;
    }
  });

  test("thinking delta 与 assistant thinking 应独立累积", () => {
    const afterReasoningDelta = applySdkMessage(createState(), {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_delta",
        delta: {
          type: "thinking_delta",
          thinking: "先检查"
        }
      }
    } as unknown as SDKMessage);
    const afterAssistant = applySdkMessage(afterReasoningDelta, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "先检查上下文" }]
      }
    } as unknown as SDKMessage);

    expect(afterAssistant.reasoning).toBe("先检查上下文");
    expect(afterAssistant.content).toBe("");
  });
});
