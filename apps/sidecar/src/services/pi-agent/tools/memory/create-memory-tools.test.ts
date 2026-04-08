import { describe, expect, test } from "bun:test";
import { createSdkMemoryTools } from "./create-memory-tools";

describe("create-pi-memory-tools", () => {
  test("应按启用集合生成对应工具", () => {
    const tools = createSdkMemoryTools({
      workspaceSlug: "demo",
      enabledTools: new Set(["memory_search", "memory_get"]),
      includeCitations: true
    });
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["memory_search", "memory_get"]);
  });
});
