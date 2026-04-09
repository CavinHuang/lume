import { describe, expect, test } from "bun:test";
import {
  isWeakGeneratedTitle,
  sanitizeGeneratedTitle,
  shouldAutoGenerateThreadTitle
} from "./session-title-summarizer";

describe("session-title-summarizer", () => {
  test("默认线程标题应允许自动生成", () => {
    expect(shouldAutoGenerateThreadTitle("新 Agent 线程")).toBe(true);
    expect(shouldAutoGenerateThreadTitle("新线程")).toBe(true);
    expect(shouldAutoGenerateThreadTitle("new agent thread")).toBe(true);
  });

  test("用户自定义标题不应被自动覆盖", () => {
    expect(shouldAutoGenerateThreadTitle("供应商对齐方案")).toBe(false);
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
