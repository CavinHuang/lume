import { describe, expect, test } from "bun:test";
import {
  deriveFallbackAgentTitleFromUserMessage,
  resolveAgentTitleSourceText
} from "./session-title-summarizer";

describe("agent-service fallback title", () => {
  test("应从用户消息生成兜底标题", () => {
    const title = deriveFallbackAgentTitleFromUserMessage("  帮我梳理一下 Lume 的工具对齐计划，并给出执行顺序  ");
    expect(title).toBe("帮我梳理一下 Lume 的工具对齐计划");
  });

  test("空消息应返回 null", () => {
    expect(deriveFallbackAgentTitleFromUserMessage("   ")).toBeNull();
  });

  test("应清洗标点并压缩空白", () => {
    const title = deriveFallbackAgentTitleFromUserMessage("“请   帮我，整理：Lume   的 memory & soul 对齐方案！”");
    expect(title).not.toBeNull();
    expect(title).not.toContain("“");
    expect(title).not.toContain("，");
    expect(title).not.toContain("：");
    expect((title ?? "").length).toBeLessThanOrEqual(20);
  });

  test("短消息应原样作为标题返回", () => {
    const title = deriveFallbackAgentTitleFromUserMessage("修复 plan 模式");
    expect(title).toBe("修复 plan 模式");
  });

  test("标题源应优先使用 assistant 总结", () => {
    const source = resolveAgentTitleSourceText(
      [
        { id: "u1", role: "user", content: "用户原始问题", createdAt: 1 },
        { id: "a1", role: "assistant", content: "我已完成工具对齐与风险排查总结", createdAt: 2 }
      ],
      "用户原始问题"
    );
    expect(source).toContain("用户目标：用户原始问题");
    expect(source).toContain("Agent 回答总结：我已完成工具对齐与风险排查总结");
  });
});
