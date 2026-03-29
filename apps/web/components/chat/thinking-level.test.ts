import { describe, expect, test } from "bun:test";
import {
  isThinkingEnabled,
  normalizeThinkingLevel,
  resolveThinkingLevelBudget
} from "./thinking-level";

describe("thinking-level", () => {
  test("normalizeThinkingLevel 应兼容旧布尔开关", () => {
    expect(normalizeThinkingLevel(undefined, true)).toBe("medium");
    expect(normalizeThinkingLevel(undefined, false)).toBe("off");
    expect(normalizeThinkingLevel("high", false)).toBe("high");
  });

  test("isThinkingEnabled 应仅在 off 时返回 false", () => {
    expect(isThinkingEnabled("off")).toBeFalse();
    expect(isThinkingEnabled("medium")).toBeTrue();
  });

  test("resolveThinkingLevelBudget 应返回对应预算", () => {
    expect(resolveThinkingLevelBudget("off")).toBeNull();
    expect(resolveThinkingLevelBudget("low")).toBe(4096);
    expect(resolveThinkingLevelBudget("medium")).toBe(16384);
    expect(resolveThinkingLevelBudget("high")).toBe(32768);
    expect(resolveThinkingLevelBudget("max")).toBe(65536);
  });
});
