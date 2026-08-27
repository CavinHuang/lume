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

    expect(hasRenderableAssistantOutput(state)).toBeTrue();
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

  test("压缩 system 事件（started/progress/boundary）应被视为可渲染输出", () => {
    // manual /compact 的 run 只产出压缩 system 事件、无 assistant 消息，
    // 这些事件应被认可为有意义的可渲染输出，避免误报「未检测到可渲染输出」。
    for (const subtype of ["context_compaction_started", "context_compaction_progress", "compact_boundary"]) {
      const state = createAgentStreamAccumulatorState();
      appendSdkMessage(state, { type: "system", subtype } as unknown as SDKMessage);
      expect(hasRenderableAssistantOutput(state)).toBeTrue();
    }
  });
});
