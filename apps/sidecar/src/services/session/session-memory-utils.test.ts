import { describe, expect, test } from "bun:test";
import {
  extractSessionText,
  parseSessionMessageRecord
} from "./session-memory-utils";

describe("session-memory-utils", () => {
  test("parseSessionMessageRecord 应兼容 OpenClaw 包装格式", () => {
    const parsed = parseSessionMessageRecord({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello\nworld" }]
      }
    });
    expect(parsed).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello\nworld" }]
    });
  });

  test("parseSessionMessageRecord 应兼容 Lume 原生格式", () => {
    const parsed = parseSessionMessageRecord({
      role: "user",
      content: "  hi   there  "
    });
    expect(parsed).toEqual({ role: "user", content: "  hi   there  " });
  });

  test("extractSessionText 应提取 text block 并归一化", () => {
    const extracted = extractSessionText([
      { type: "text", text: "line1\nline2" },
      { type: "image", url: "x" },
      { type: "text", text: " line3 " }
    ]);
    expect(extracted).toBe("line1 line2 line3");
  });
});
