import { describe, expect, test } from "bun:test";
import { stripFrontMatter } from "./workspace-template-utils";

describe("stripFrontMatter", () => {
  test("LF 基本形态剥离", () => {
    expect(stripFrontMatter("---\ntitle: x\n---\n正文")).toBe("正文");
  });

  test("CRLF 全程剥离(Windows 用户文档主场景,#531 收敛裁定)", () => {
    expect(stripFrontMatter("---\r\ntitle: x\r\n---\r\n正文")).toBe("正文");
    expect(stripFrontMatter("---\ntitle: x\r\n---\r\n正文")).toBe("正文"); // 混合行尾
  });

  test("无闭合符或非 front matter 保持原文", () => {
    const open = "---\ntitle: x\n没有闭合";
    expect(stripFrontMatter(open)).toBe(open);
    expect(stripFrontMatter("普通开头正文\n---\n中间")).toBe("普通开头正文\n---\n中间");
    expect(stripFrontMatter("")).toBe("");
  });

  test("四杠闭合行按前三杠截断(新旧实现一致的既有语义,残杆留在正文)", () => {
    expect(stripFrontMatter("---\na\n----\nb")).toBe("-\nb");
  });
});
