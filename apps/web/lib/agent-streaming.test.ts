import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@lume/shared";
import { applyAgentEvent, type AgentStreamState } from "./agent-streaming";

function createState(): AgentStreamState {
  return {
    running: true,
    content: "",
    toolActivities: [],
    teammates: []
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
    const afterResult = applyAgentEvent(afterStart, toolResult);

    expect(afterResult.toolActivities).toEqual([
      {
        toolUseId: "tool-1",
        toolName: "Read",
        input: { path: "README.md" },
        intent: undefined,
        displayName: undefined,
        parentToolUseId: undefined,
        done: true,
        isError: false,
        result: "ok"
      }
    ]);
  });
});
