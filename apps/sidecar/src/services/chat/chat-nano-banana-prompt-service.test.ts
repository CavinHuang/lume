import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@lume/shared";
import {
  buildNanoBananaEnhancedPrompt,
  inferNanoBananaAspectRatio,
  inferNanoBananaImageSize,
  shouldUseReferenceImagesForNanoBanana
} from "./chat-nano-banana-prompt-service";

describe("chat-nano-banana-prompt-service", () => {
  test("buildNanoBananaEnhancedPrompt 应附加静态 style/constraint 引导", () => {
    const prompt = buildNanoBananaEnhancedPrompt("做一张赛博朋克风格海报", {
      messageHistory: [],
      useReferenceImages: false
    });

    expect(prompt).toContain("做一张赛博朋克风格海报");
    expect(prompt).toContain("[Style guidance]");
    expect(prompt).toContain("[Constraint guidance]");
    expect(prompt).toContain("no watermark");
    expect(prompt).toContain("no text overlay");
  });

  test("buildNanoBananaEnhancedPrompt 空输入应返回空字符串", () => {
    expect(buildNanoBananaEnhancedPrompt("")).toBe("");
    expect(buildNanoBananaEnhancedPrompt("  ")).toBe("");
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
