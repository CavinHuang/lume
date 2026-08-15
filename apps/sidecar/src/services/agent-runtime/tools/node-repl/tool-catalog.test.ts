import { describe, expect, test } from "bun:test";
import { buildToolCatalogResult, renderToolCatalogSdk, type CatalogTool } from "./tool-catalog";

function makeTool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: "search",
    description: "Search the workspace for a query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" }
      }
    },
    ...overrides
  };
}

describe("renderToolCatalogSdk", () => {
  test("renders a section per tool with typed parameter signature", () => {
    const text = renderToolCatalogSdk([
      makeTool(),
      makeTool({ name: "read", inputSchema: { type: "object", properties: { path: { type: "string" } } } })
    ]);

    expect(text).toContain("## search");
    expect(text).toContain("## read");
    expect(text).toContain("Search the workspace for a query.");
    expect(text).toContain("await tools.search({ query: string, limit: number })");
    expect(text).toContain("await tools.read({ path: string })");
    expect(text.indexOf("## search")).toBeLessThan(text.indexOf("## read"));
  });

  test("renders a no-argument call for a schema without properties", () => {
    const text = renderToolCatalogSdk([
      makeTool({ name: "refresh", inputSchema: { type: "object", properties: {} } }),
      makeTool({ name: "bare", inputSchema: {} })
    ]);

    expect(text).toContain("await tools.refresh()");
    expect(text).toContain("await tools.bare()");
  });

  test("maps JSON schema types to TypeScript names and unknown types to unknown", () => {
    const text = renderToolCatalogSdk([
      makeTool({
        name: "mixed",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            count: { type: "integer" },
            ratio: { type: "number" },
            flag: { type: "boolean" },
            tags: { type: "array" },
            nested: { type: "object" },
            mystery: { type: "geomancy" }
          }
        }
      })
    ]);

    expect(text).toContain(
      "await tools.mixed({ text: string, count: number, ratio: number, flag: boolean, tags: unknown[], nested: Record<string, unknown>, mystery: unknown })"
    );
  });

  test("truncates descriptions to six lines", () => {
    const description = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n");
    const text = renderToolCatalogSdk([makeTool({ description })]);

    expect(text).toContain("line-5");
    expect(text).not.toContain("line-6");
    expect(text).not.toContain("line-7");
  });

  test("mentions permission approval and the explicit tools.call form", () => {
    const text = renderToolCatalogSdk([makeTool()]);

    expect(text).toContain("permission");
    expect(text).toContain("tools.call(name, params)");
  });
});

describe("buildToolCatalogResult", () => {
  test("returns the catalog and its rendered documentation", () => {
    const tools = [makeTool()];
    const result = buildToolCatalogResult(tools);

    expect(result.tools).toBe(tools);
    expect(result.documentation).toBe(renderToolCatalogSdk(tools));
    expect(result.documentation).toContain("## search");
  });
});
