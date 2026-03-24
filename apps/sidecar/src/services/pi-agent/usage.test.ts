import { describe, expect, test } from "bun:test";
import { resolveAgentEventTotalTokens } from "./usage";

describe("pi-agent usage", () => {
  test("应优先使用事件显式提供的 totalTokens", () => {
    expect(resolveAgentEventTotalTokens({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 3,
      totalTokens: 99
    })).toBe(99);
  });

  test("缺少 totalTokens 时应从 usage 明细推导", () => {
    expect(resolveAgentEventTotalTokens({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheCreationTokens: 3
    })).toBe(38);
  });
});
