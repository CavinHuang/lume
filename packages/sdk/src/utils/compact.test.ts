import { describe, expect, test } from "bun:test";
import { compactConversation, createAutoCompactState, shouldAutoCompact } from "./compact.js";

describe("context compaction image safety", () => {
  test("removes top-level and nested tool_result images before summarization", async () => {
    let request: any;
    const provider = {
      async createMessage(input: any) {
        request = input;
        return {
          content: [{ type: "text", text: "摘要" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    } as any;
    const result = await compactConversation(provider, "test-model", [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "shot",
        _meta: { computerUseAction: { actionId: "action-1", action: "click", phase: "observed", window: { id: 42, app: "微信" } } },
        content: [{ type: "image", source: { type: "base64", data: "SECRET_BASE64" } }],
      }],
    }], createAutoCompactState());

    expect(JSON.stringify(request)).not.toContain("SECRET_BASE64");
    expect(result.compactedMessages).toEqual([{
      role: "user",
      content: [{
        type: "text",
        text: "摘要\n\n[Authoritative Computer Use action facts]\naction-1: click on 微信#42; phase=observed; not verified complete",
        _meta: { contextBlock: "compaction" },
      }],
    }]);
  });

  test("screenshots alone do not trigger auto compaction", () => {
    const images = Array.from({ length: 100 }, () => ({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "x".repeat(40_000) },
    }));
    expect(shouldAutoCompact([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "shot", content: images }] },
    ], "test-model", createAutoCompactState())).toBeFalse();
  });
});
