import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory-tools";

describe("memory-tools", () => {
  test("createMemoryTools 只注册 Memory V2 主路径工具", () => {
    const tools = createMemoryTools();
    expect(MEMORY_TOOL_NAMES).toEqual(["memory.search", "memory.read", "memory.remember"]);
    expect(Object.keys(tools)).toEqual(["memory.search", "memory.read", "memory.remember"]);
  });

  test("memory.search/read/remember 使用 Memory V2 主路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-v2-tools-"));
    process.env.LUME_CONFIG_DIR = root;
    try {
      const tools = createMemoryTools();
      const written = await tools["memory.remember"]({
        workspaceSlug: "demo",
        scope: "workspace",
        kind: "decision",
        content: "Memory V2 search reads Markdown entries directly.",
        confidence: 1,
        tags: ["memory"]
      });

      const results = await tools["memory.search"]({
        workspaceSlug: "demo",
        query: "memory markdown search",
        maxResults: 3
      });
      expect(results[0]).toMatchObject({
        id: written.id,
        kind: "decision",
        scope: "workspace"
      });

      const read = await tools["memory.read"]({
        workspaceSlug: "demo",
        id: written.id
      });
      expect(read.text).toBe("Memory V2 search reads Markdown entries directly.");
    } finally {
      delete process.env.LUME_CONFIG_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
