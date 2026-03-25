import { describe, expect, test } from "bun:test";
import {
  applyRuntimeCoreStreamWrappers,
  createRuntimeCoreStreamWrapperState
} from "./stream-wrappers";
import type { AgentEvent } from "@lume/shared";

describe("runtime-core stream-wrappers", () => {
  test("应过滤空文本流事件", () => {
    const state = createRuntimeCoreStreamWrapperState();
    const events: AgentEvent[] = [
      { type: "text_delta", text: "" },
      { type: "text_complete", text: "   ", isIntermediate: false },
      { type: "usage_update", usage: { inputTokens: 1 } }
    ];

    expect(applyRuntimeCoreStreamWrappers(events, state)).toEqual([
      { type: "usage_update", usage: { inputTokens: 1 } }
    ]);
  });

  test("应去重相邻重复的最终 text_complete", () => {
    const state = createRuntimeCoreStreamWrapperState();

    const first = applyRuntimeCoreStreamWrappers([
      { type: "text_complete", text: "hello world", isIntermediate: false }
    ], state);
    const second = applyRuntimeCoreStreamWrappers([
      { type: "text_complete", text: "hello world", isIntermediate: false }
    ], state);

    expect(first).toEqual([
      { type: "text_complete", text: "hello world", isIntermediate: false }
    ]);
    expect(second).toEqual([]);
  });

  test("中间态 text_complete 不应吞掉后续最终 text_complete", () => {
    const state = createRuntimeCoreStreamWrapperState();

    const first = applyRuntimeCoreStreamWrappers([
      { type: "text_complete", text: "draft", isIntermediate: true }
    ], state);
    const second = applyRuntimeCoreStreamWrappers([
      { type: "text_complete", text: "draft", isIntermediate: false }
    ], state);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
  });

  test("bigmodel anthropic 兼容端点应忽略仅空白差异的最终 text_complete", () => {
    const state = createRuntimeCoreStreamWrapperState();

    const first = applyRuntimeCoreStreamWrappers([
      { type: "text_complete", text: "hello world", isIntermediate: false }
    ], state, {
      provider: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic"
    });
    const second = applyRuntimeCoreStreamWrappers([
      { type: "text_complete", text: "hello world\n", isIntermediate: false }
    ], state, {
      provider: "anthropic",
      baseUrl: "https://open.bigmodel.cn/api/anthropic"
    });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test("官方 anthropic 端点不应吞掉有空白差异的最终 text_complete", () => {
    const state = createRuntimeCoreStreamWrapperState();

    applyRuntimeCoreStreamWrappers([
      { type: "text_complete", text: "hello world", isIntermediate: false }
    ], state, {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com"
    });
    const second = applyRuntimeCoreStreamWrappers([
      { type: "text_complete", text: "hello world\n", isIntermediate: false }
    ], state, {
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com"
    });

    expect(second).toHaveLength(1);
  });
});
