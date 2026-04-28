import { describe, expect, test } from "bun:test";
import { createSdkMemoryTools } from "./create-memory-tools";

describe("create-pi-memory-tools", () => {
  test("应按启用集合生成对应工具", () => {
    const tools = createSdkMemoryTools({
      workspaceSlug: "demo",
      enabledTools: new Set(["memory.search", "memory.read"]),
      includeCitations: true
    });
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["memory.search", "memory.read"]);
  });

  test("应保留旧 underscore memory tool 名称兼容", () => {
    const tools = createSdkMemoryTools({
      workspaceSlug: "demo",
      enabledTools: new Set(["memory_search", "memory_get"]),
      includeCitations: true
    });
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["memory_search", "memory_get"]);
  });

  test("memory search 描述应保持按需召回而非强制查档", () => {
    const tools = createSdkMemoryTools({
      workspaceSlug: "demo",
      enabledTools: new Set(["memory_search", "memory.search"]),
      includeCitations: true
    });
    const descriptions = tools.map((tool) => tool.description).join("\n");

    expect(descriptions).toContain("loaded context is insufficient");
    expect(descriptions).toContain("Integrate results naturally");
    expect(descriptions).not.toContain("Mandatory recall step");
  });

  test("应注册全局记忆和单文档索引工具", () => {
    const tools = createSdkMemoryTools({
      workspaceSlug: "demo",
      enabledTools: new Set([
        "memory.searchGlobal",
        "memory.listGlobalCandidates",
        "memory.promoteGlobal",
        "memory.rejectGlobalCandidate",
        "memory.indexDocument"
      ]),
      includeCitations: true
    });
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      "memory.searchGlobal",
      "memory.listGlobalCandidates",
      "memory.promoteGlobal",
      "memory.rejectGlobalCandidate",
      "memory.indexDocument"
    ]);
  });
});
