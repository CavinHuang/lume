import { describe, expect, test } from "bun:test";
import { buildMessageAttachmentBrief } from "./message-attachments";

describe("buildMessageAttachmentBrief", () => {
  test("returns empty string when no attachments are present", () => {
    expect(buildMessageAttachmentBrief()).toBe("");
    expect(buildMessageAttachmentBrief([])).toBe("");
  });

  test("formats a compact relative-path attachment brief", () => {
    const brief = buildMessageAttachmentBrief([{
      id: "att-1",
      filename: "brief.md",
      mediaType: "text/markdown",
      size: 12_288,
      threadPath: "docs/brief.md"
    }, {
      id: "att-2",
      filename: "screen.png",
      mediaType: "image/png",
      size: 420_000,
      threadPath: "images/screen.png"
    }]);

    expect(brief).toContain("本轮用户附加了以下附件：");
    expect(brief).toContain("- brief.md (text/markdown, 12 KB): docs/brief.md");
    expect(brief).toContain("- screen.png (image/png, 410 KB)");
    expect(brief).not.toContain("images/screen.png");
    expect(brief).toContain("使用文件读取工具访问对应路径");
    expect(brief).not.toContain("/Users/");
    expect(brief).not.toContain("base64");
  });
});
