import { describe, expect, test } from "bun:test";
import { createMemoryToolErrorResult, createMemoryToolResult } from "./memory-tool-response";

describe("memory-tool-response", () => {
  test("createMemoryToolResult 返回 text content 包装", () => {
    const result = createMemoryToolResult({ ok: true });
    expect(result.content.length).toBe(1);
    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("\"ok\": true");
  });

  test("createMemoryToolErrorResult 不应包含 isError 字段（OpenClaw 对齐）", () => {
    const result = createMemoryToolErrorResult({ disabled: true, error: "boom" });
    const resultRecord = result as unknown as Record<string, unknown>;
    expect("isError" in result).toBeFalse();
    expect(Array.isArray(result.content)).toBeTrue();
    expect(JSON.stringify(resultRecord)).toContain("\"disabled\\\": true");
  });
});
