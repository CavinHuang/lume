import { describe, expect, test } from "bun:test";
import {
  isWeakGeneratedTitle,
  sanitizeGeneratedTitle,
  shouldAutoGenerateSessionTitle
} from "./session-title-summarizer";

describe("session-title-summarizer", () => {
  test("默认会话标题应允许自动生成", () => {
    expect(shouldAutoGenerateSessionTitle("新 Agent 会话")).toBe(true);
    expect(shouldAutoGenerateSessionTitle("新会话")).toBe(true);
    expect(shouldAutoGenerateSessionTitle("new agent session")).toBe(true);
  });

  test("用户自定义标题不应被自动覆盖", () => {
    expect(shouldAutoGenerateSessionTitle("供应商对齐方案")).toBe(false);
  });

  test("应清洗模型标题格式", () => {
    const title = sanitizeGeneratedTitle("  \"# 供应商迁移执行计划\"  ");
    expect(title).toBe("供应商迁移执行计划");
  });

  test("弱标题应被识别", () => {
    expect(isWeakGeneratedTitle("总结")).toBe(true);
    expect(isWeakGeneratedTitle("OK")).toBe(true);
    expect(isWeakGeneratedTitle("供应商与工具对齐计划")).toBe(false);
  });
});
