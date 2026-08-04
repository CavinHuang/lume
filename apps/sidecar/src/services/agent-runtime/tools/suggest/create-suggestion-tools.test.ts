/**
 * create-suggestion-tools.test.ts — suggestion_analyze 工具注册测试
 *
 * 策略：用 mock.module 隔离 suggest/service.runAnalysisAndPersist，
 * 验证工厂产出工具（无参数 + 非只读）+ handler 调用 runAnalysisAndPersist({})
 * 并返回 { added, summary }。service 自身的 fail-open / 去重逻辑由 service.test.ts 覆盖。
 */
import type { ToolDefinition } from "@lume/agent-sdk";
import { describe, expect, mock, test } from "bun:test";

// ===== mock.module 依赖 =====
const analysisMock = mock(async (_ctx: object): Promise<number> => 2);

mock.module("../../../suggest/service", () => ({
  runAnalysisAndPersist: analysisMock,
}));

const { createSuggestionTools } = await import("./create-suggestion-tools");

// ===== helpers =====
function resolveAnalyze(): ToolDefinition {
  const tools = createSuggestionTools();
  const analyze = tools.find((t) => t.name === "suggestion_analyze");
  if (!analyze) throw new Error("suggestion_analyze 工具未注册");
  return analyze;
}

async function callTool(tool: ToolDefinition) {
  const result = await tool.call({}, { cwd: process.cwd() });
  const parsed = JSON.parse(result.content as string) as Record<string, unknown>;
  return (parsed.data ?? parsed) as Record<string, unknown>;
}

describe("createSuggestionTools", () => {
  test("注册 suggestion_analyze 工具（无参数 + 非只读）", () => {
    const analyze = resolveAnalyze();
    expect(analyze.description).toContain("主动建议");
    // 无必填参数、无属性
    const schema = analyze.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required ?? []).toEqual([]);
    expect(Object.keys(schema.properties ?? {})).toEqual([]);
  });

  test("handler 调用 runAnalysisAndPersist({}) 并返回 added + summary", async () => {
    analysisMock.mockClear();
    const data = await callTool(resolveAnalyze());

    expect(analysisMock).toHaveBeenCalledTimes(1);
    expect(analysisMock.mock.calls[0]).toEqual([{}]);
    expect(data.added).toBe(2);
    expect(typeof data.summary).toBe("string");
    expect(data.summary).toContain("2");
  });

  test("handler 在 runAnalysisAndPersist 返回 0 时仍正常返回", async () => {
    analysisMock.mockClear();
    analysisMock.mockResolvedValueOnce(0);
    const data = await callTool(resolveAnalyze());

    expect(data.added).toBe(0);
    expect(data.summary).toContain("0");
  });
});
