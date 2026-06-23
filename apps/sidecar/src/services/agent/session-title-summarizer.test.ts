import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@lume/shared";
import {
  isWeakGeneratedTitle,
  resolveTitleConversationText,
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

  test("标题对话源文本应包含用户消息与助手首轮回复（提供足够信息）", () => {
    const messages: AgentMessage[] = [
      { id: "m1", role: "user", content: "如何配置一个新的模型供应商？", createdAt: 1 },
      { id: "m2", role: "assistant", content: "你可以在设置 → 渠道里新增供应商，填入 baseURL 与 API Key。", createdAt: 2 }
    ];
    const text = resolveTitleConversationText(messages, "fallback");

    expect(text).toContain("如何配置一个新的模型供应商？");
    expect(text).toContain("你可以在设置 → 渠道里新增供应商");
  });

  test("缺少助手回复时标题对话源文本应回退到用户消息", () => {
    const messages: AgentMessage[] = [
      { id: "m1", role: "user", content: "帮我整理本周读书笔记", createdAt: 1 }
    ];
    const text = resolveTitleConversationText(messages, "fallback");

    expect(text).toBe("帮我整理本周读书笔记");
  });
});
