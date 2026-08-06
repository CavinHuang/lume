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
    expect(MEMORY_V2_TOOL_NAMES).toEqual(["memory.search", "memory.read", "memory.remember", "memory.forget"]);
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

  test("memory.remember normalizes raw preferred-name writes into claim entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-v2-tools-"));
    process.env.LUME_CONFIG_DIR = root;
    try {
      const written = await rememberMemoryTool({
        workspaceSlug: "demo",
        scope: "global",
        kind: "preference",
        content: "叫我 Mason",
        confidence: 1
      });

      const results = await searchMemoryTool({
        workspaceSlug: "demo",
        query: "我叫什么名字？",
        maxResults: 3
      });
      expect(results[0]).toMatchObject({
        id: written.id,
        snippet: "用户希望被称呼为 Mason",
        claim: {
          subject: "user/self",
          predicate: "preferred_name",
          object: "Mason"
        }
      });

      const read = await readMemoryTool({
        workspaceSlug: "demo",
        id: written.id
      });
      expect(read.text).toBe("用户希望被称呼为 Mason");
      expect(read.metadata?.claim).toEqual({
        subject: "user/self",
        predicate: "preferred_name",
        object: "Mason"
      });
    } finally {
      delete process.env.LUME_CONFIG_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("memory.remember accepts explicit assistant claim without rewriting identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "lume-memory-v2-tools-"));
    process.env.LUME_CONFIG_DIR = root;
    try {
      const written = await rememberMemoryTool({
        workspaceSlug: "demo",
        scope: "global",
        kind: "preference",
        content: "用户希望用 Alice 称呼助手",
        confidence: 1,
        claim: {
          subject: "assistant/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      });

      const results = await searchMemoryTool({
        workspaceSlug: "demo",
        query: "你是谁？",
        maxResults: 3
      });

      expect(results[0]).toMatchObject({
        id: written.id,
        claim: {
          subject: "assistant/self",
          predicate: "preferred_name",
          object: "Alice"
        }
      });
    } finally {
      delete process.env.LUME_CONFIG_DIR;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
