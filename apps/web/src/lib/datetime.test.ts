import { describe, expect, test } from "bun:test";
import { formatDateTime } from "./datetime";

describe("formatDateTime", () => {
  test("合法 ISO 返回 YYYY-MM-DD HH:mm 形状", () => {
    expect(formatDateTime("2026-08-07T10:30:00Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
  test("无效输入原样返回", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatDateTime("")).toBe("");
  });
});
