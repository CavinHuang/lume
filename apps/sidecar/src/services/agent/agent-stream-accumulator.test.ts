import { describe, expect, test } from "bun:test";
import {
  appendAgentEvents,
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

  test("reasoning-only 事件也应被视为可渲染输出", () => {
    const state = createAgentStreamAccumulatorState();
    appendAgentEvents(state, [{
      type: "reasoning_complete",
      text: "先检查配置",
      isIntermediate: false
    }]);
    expect(hasRenderableAssistantOutput(state)).toBeTrue();
  });
});
