import { describe, expect, test } from "bun:test";
import {
  appendAgentEvents,
  buildAssistantAgentMessage,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "./agent-stream-accumulator";

describe("agent-stream-accumulator", () => {
  test("text_complete 事件应更新累计文本", () => {
    const state = createAgentStreamAccumulatorState();
    appendAgentEvents(state, [{ type: "text_complete", text: "hello", isIntermediate: false }]);
    expect(state.text).toBe("hello");
  });

  test("text_complete 与已有 text_delta 应按重叠合并", () => {
    const state = createAgentStreamAccumulatorState();
    appendAgentEvents(state, [{ type: "text_delta", text: "hello " }]);
    appendAgentEvents(state, [{ type: "text_complete", text: "hello world", isIntermediate: false }]);
    expect(state.text).toBe("hello world");
  });

  test("usage-only 事件不应被视为可渲染输出", () => {
    const state = createAgentStreamAccumulatorState();
    appendAgentEvents(state, [{
      type: "usage_update",
      usage: { inputTokens: 12 }
    }]);
    expect(hasRenderableAssistantOutput(state)).toBeFalse();
    expect(buildAssistantAgentMessage(state, "zai/glm-4.7")).toBeNull();
  });

  test("tool 事件应被视为可渲染输出", () => {
    const state = createAgentStreamAccumulatorState();
    appendAgentEvents(state, [{
      type: "tool_start",
      toolUseId: "tool-1",
      toolName: "Read",
      input: { path: "README.md" }
    }]);
    expect(hasRenderableAssistantOutput(state)).toBeTrue();
  });
});
