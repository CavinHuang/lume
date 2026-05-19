import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  MEMORY_V2_TOOL_NAMES,
  readMemoryTool,
  rememberMemoryTool,
  searchMemoryTool
} from "./tools";

describe("memory-v2 tools", () => {
  test("只暴露 Memory V2 主路径工具名", () => {
    expect(MEMORY_V2_TOOL_NAMES).toEqual(["memory.search", "memory.read", "memory.remember"]);
  });

  test("memory.search/read/remember 使用 Memory V2 主路径", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-v2-tools-"));
    process.env.LUME_CONFIG_DIR = root;
    try {
      const written = await rememberMemoryTool({
        workspaceSlug: "demo",
        scope: "workspace",
        kind: "decision",
        content: "Memory V2 search reads Markdown entries directly.",
        confidence: 1,
        tags: ["memory"]
      });

      const results = await searchMemoryTool({
        workspaceSlug: "demo",
        query: "memory markdown search",
        maxResults: 3
      });
      expect(results[0]).toMatchObject({
        id: written.id,
        kind: "decision",
        scope: "workspace"
      });

      const read = await readMemoryTool({
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
