import { describe, expect, test } from "bun:test";
import { WebFetchTool } from "./web-fetch";

describe("WebFetchTool", () => {
  test("exposes correct tool metadata", () => {
    expect(WebFetchTool.name).toBe("WebFetch");
    expect(WebFetchTool.isReadOnly?.()).toBe(true);
    expect(WebFetchTool.isConcurrencySafe?.()).toBe(true);
  });

  test("rejects invalid URLs", async () => {
    const result = await WebFetchTool.call(
      { url: "not-a-url" },
      { sandbox: undefined } as any
    );
    // Result is a tool result object with content property
    expect(result).toBeDefined();
    expect((result as any).is_error).toBe(true);
    expect((result as any).content).toContain("Error fetching");
  });

  test("schema accepts markdown, text, and html formats", () => {
    const fmt = WebFetchTool.inputSchema.properties?.format as any;
    expect(fmt?.enum).toContain("markdown");
    expect(fmt?.enum).toContain("text");
    expect(fmt?.enum).toContain("html");
  });
});
