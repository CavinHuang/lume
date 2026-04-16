import { describe, expect, test } from "bun:test";
import type { SDKMessage } from "@lume/shared";
import {
  appendSdkMessage,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "./agent-stream-accumulator";

describe("agent-stream-accumulator", () => {
  test("应累计 SDK 消息", () => {
    const state = createAgentStreamAccumulatorState();
    appendSdkMessage(state, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }]
      }
    } as unknown as SDKMessage);

    expect(state.messages).toHaveLength(1);
  });

  test("usage-only result 不应被视为可渲染输出", () => {
    const state = createAgentStreamAccumulatorState();
    appendSdkMessage(state, {
      type: "result",
      usage: { input_tokens: 12 }
    } as unknown as SDKMessage);
    expect(hasRenderableAssistantOutput(state)).toBeFalse();
  });

  test("tool_use 应被视为可渲染输出", () => {
    const state = createAgentStreamAccumulatorState();
    appendSdkMessage(state, {
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
    expect(hasRenderableAssistantOutput(state)).toBeTrue();
  });

  test("thinking-only assistant 也应被视为可渲染输出", () => {
    const state = createAgentStreamAccumulatorState();
    appendSdkMessage(state, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "先检查配置" }]
      }
    } as unknown as SDKMessage);
    expect(hasRenderableAssistantOutput(state)).toBeTrue();
  });
});
