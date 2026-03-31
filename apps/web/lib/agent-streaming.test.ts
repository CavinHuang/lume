import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@lume/shared";
import { applyAgentEvent, type AgentStreamState } from "./agent-streaming";

function createState(): AgentStreamState {
  return {
    running: true,
    content: "",
    reasoning: "",
    toolActivities: []
  };
}

describe("agent-streaming", () => {
  test("text_complete 应避免和已有 content 重复拼接", () => {
    const state = createState();
    const afterDelta = applyAgentEvent(state, { type: "text_delta", text: "Hello " });
    const afterComplete = applyAgentEvent(afterDelta, {
      type: "text_complete",
      text: "Hello world",
      isIntermediate: false
    });

    expect(afterComplete.content).toBe("Hello world");
  });

  test("tool_start/tool_result 应创建并完成 tool activity", () => {
    const realNow = Date.now;
    let now = 1_000;
    Date.now = () => now;
    try {
      const toolStart: AgentEvent = {
        type: "tool_start",
        toolUseId: "tool-1",
        toolName: "Read",
        input: { path: "README.md" }
      };
      const toolResult: AgentEvent = {
        type: "tool_result",
        toolUseId: "tool-1",
        toolName: "Read",
        result: "ok",
        isError: false
      };

      const afterStart = applyAgentEvent(createState(), toolStart);
      now = 1_975;
      const afterResult = applyAgentEvent(afterStart, toolResult);

      expect(afterResult.toolActivities).toEqual([{
        toolUseId: "tool-1",
        toolName: "Read",
        input: { path: "README.md" },
        intent: undefined,
        displayName: undefined,
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

  test("reasoning 事件应独立累积，不污染正文 content", () => {
    const afterReasoningDelta = applyAgentEvent(createState(), {
      type: "reasoning_delta",
      text: "先检查"
    });
    const afterReasoningComplete = applyAgentEvent(afterReasoningDelta, {
      type: "reasoning_complete",
      text: "先检查上下文",
      isIntermediate: false
    });

    expect(afterReasoningComplete.reasoning).toBe("先检查上下文");
    expect(afterReasoningComplete.content).toBe("");
  });
});
