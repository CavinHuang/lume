import { describe, expect, test } from "bun:test";
import {
  compactMemorySummaryText,
  summarizeMemoryConversationFallback
} from "./conversation-summary";

describe("memory conversation summary afterglow filtering", () => {
  test("fallback summary strips assistant afterglow", () => {
    const summary = summarizeMemoryConversationFallback({
      userMessage: "帮我做一个计划",
      runState: {
        generatedItems: [{
          type: "assistant_message",
          id: "assistant-1",
          content: [{ type: "text", text: "计划完成\n⟡ 这个风险先别忽略" }],
          createdAt: "2026-06-06T00:00:00.000Z"
        }]
      }
    } as Parameters<typeof summarizeMemoryConversationFallback>[0]);

    expect(summary).toContain("Assistant outcome: 计划完成");
    expect(summary).not.toContain("这个风险先别忽略");
    expect(summary).not.toContain("⟡");
  });

  test("compact summary text strips afterglow before compaction", () => {
    expect(compactMemorySummaryText("正文\n- ⟡ 不要存我\n收尾")).toBe("正文 收尾");
  });
});
