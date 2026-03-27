import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@lume/shared";
import {
  buildNanoBananaEnhancedPrompt,
  inferNanoBananaAspectRatio,
  inferNanoBananaImageSize,
  shouldUseReferenceImagesForNanoBanana
} from "./chat-nano-banana-prompt-service";

describe("chat-nano-banana-prompt-service", () => {
  test("继续编辑时应继承历史风格并保留意图记忆", () => {
    const history = [
      {
        id: "u1",
        role: "user",
        content: "做一张赛博朋克风格海报，不要文字",
        createdAt: Date.now()
      }
    ] as ChatMessage[];

    const prompt = buildNanoBananaEnhancedPrompt("继续这张，改成横版", {
      messageHistory: history,
      useReferenceImages: true
    });

    expect(prompt).toContain("cyberpunk style");
    expect(prompt).toContain("no text overlay");
    expect(prompt).toContain("Intent memory");
  });

  test("应推断画幅、分辨率和参考图使用策略", () => {
    expect(inferNanoBananaAspectRatio("请做横版 16:9 海报")).toBe("16:9");
    expect(inferNanoBananaImageSize("导出 4K 高清图")).toBe("4K");
    expect(
      shouldUseReferenceImagesForNanoBanana({
        userMessage: "基于上一张图继续优化",
        previousAssistantAttachments: [
          {
            id: "att-1",
            filename: "image.png",
            localPath: "/tmp/image.png",
            mediaType: "image/png",
            size: 1
          }
        ]
      })
    ).toBeTrue();
  });
});
