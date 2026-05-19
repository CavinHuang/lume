import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory-tools";

describe("memory-tools", () => {
  test("createMemoryTools 应注册 Agent 记忆工具", () => {
    const tools = createMemoryTools();
    expect(Object.keys(tools).sort()).toEqual([...MEMORY_TOOL_NAMES].sort());
  });

  test("memory.writeEpisode 应拆分 episode、decision、preference 和 lesson 写入", async () => {
    const calls: unknown[] = [];
    const tools = createMemoryTools({
      writeWorkspaceMemory: async (input) => {
        calls.push(input);
        return { path: input.path ?? "memory/2026-04-27.md", bytes: input.content.length, itemId: `item-${calls.length}` };
      }
    });

    const result = await tools["memory.writeEpisode"]({
      workspaceSlug: "demo",
      sessionId: "session-1",
      title: "Memory tools implementation",
      summary: "Implemented MVP memory tools.",
      decisions: ["Use dot-name tools for Agent memory."],
      preferences: ["Keep memory visible and auditable."],
      lessons: ["Flush summaries should be searchable."],
      nextSteps: ["Add UI management."]
    });

    expect(result.savedCount).toBe(4);
    expect(calls).toEqual([
      expect.objectContaining({ kind: "episode", scope: "session", source: "manual" }),
      expect.objectContaining({ kind: "decision", scope: "workspace", source: "manual" }),
      expect.objectContaining({ kind: "preference", scope: "workspace", source: "manual" }),
      expect.objectContaining({ kind: "lesson", scope: "workspace", source: "manual" })
    ]);
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

  test("global memory tools 应委托到全局候选和提升服务", async () => {
    const calls: string[] = [];
    const tools = createMemoryTools({
      searchGlobalMemory: async (input) => {
        calls.push(`search:${input.query}`);
        return [];
      },
      listGlobalMemoryCandidates: async (input) => {
        calls.push(`list:${input?.status ?? "all"}`);
        return [];
      },
      promoteGlobalMemory: async (input) => {
        calls.push(`promote:${input.candidateId}`);
        return {
          id: "global-1",
          workspaceSlug: "__global__",
          scope: "global",
          kind: "preference",
          source: "promotion",
          content: input.editedContent ?? "content",
          importance: 4,
          confidence: 1,
          createdAt: 1,
          updatedAt: 1
        };
      },
      rejectGlobalMemoryCandidate: async (candidateId) => {
        calls.push(`reject:${candidateId}`);
        return {
          id: candidateId,
          workspaceSlug: "demo",
          memoryIds: [],
          kind: "preference",
          content: "content",
          reason: "test",
          confidence: 1,
          importance: 4,
          status: "rejected",
          createdAt: 1,
          updatedAt: 1
        };
      }
    });

    await tools["memory.searchGlobal"]({ query: "auditable", maxResults: 3 });
    await tools["memory.listGlobalCandidates"]({ status: "pending" });
    await tools["memory.promoteGlobal"]({ candidateId: "candidate-1", approve: true, editedContent: "edited" });
    await tools["memory.rejectGlobalCandidate"]({ candidateId: "candidate-2" });

    expect(calls).toEqual([
      "search:auditable",
      "list:pending",
      "promote:candidate-1",
      "reject:candidate-2"
    ]);
  });

  test("memory.indexDocument 应重建单个文档索引", async () => {
    const tools = createMemoryTools({
      indexWorkspaceMemoryDocument: async (input) => ({
        indexedChunks: input.filePath === "MEMORY.md" && input.force ? 2 : 0
      })
    });

    await expect(tools["memory.indexDocument"]({
      workspaceSlug: "demo",
      filePath: "MEMORY.md",
      force: true
    })).resolves.toEqual({ indexedChunks: 2 });
  });
});
