import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@lume/agent-sdk";
import { connectReadingWeread } from "../../../reading/reading-store";
import { createSdkReadingTools } from "./create-reading-tools";

function resolveTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((item) => item.name === name);
  if (!tool) {
    throw new Error(`工具不存在: ${name}`);
  }
  return tool;
}

async function callTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const result = await tool.call(input, { cwd: process.cwd(), abortSignal: new AbortController().signal });
  const maybeData = result as { data?: unknown; content?: unknown };
  if (maybeData.data !== undefined) return maybeData.data as Record<string, unknown>;
  return JSON.parse(String(maybeData.content)) as Record<string, unknown>;
}

describe("create-reading-tools", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-tools-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("supports snapshot, add book, write note, and hide note", async () => {
    const tools = createSdkReadingTools();
    const addBook = resolveTool(tools, "lume_add_book");
    const writeNote = resolveTool(tools, "lume_write_reading_note");
    const snapshot = resolveTool(tools, "lume_reading_snapshot");
    const hideNote = resolveTool(tools, "lume_hide_reading_note");

    const added = await callTool(addBook, {
      title: "我在北京送快递",
      author: "胡安焉",
      track: "co_read",
      sourceKind: "weread",
      sourceId: "wr-1",
      excerpt: "把自己看作一个普通人，过普通人的生活。"
    }) as { book?: { id?: string } };

    const written = await callTool(writeNote, {
      bookId: added.book?.id,
      body: "Lume 把这句话放在身体和日常的位置上读。",
      quote: "把自己看作一个普通人，过普通人的生活。",
      excerpt: "把自己看作一个普通人，过普通人的生活。",
      tags: ["身体在场"]
    }) as { note?: { id?: string } };

    const beforeHide = await callTool(snapshot, {}) as { stats?: { noteCount?: number } };
    expect(beforeHide.stats?.noteCount).toBe(1);

    await callTool(hideNote, { id: written.note?.id });
    const afterHide = await callTool(snapshot, {}) as { stats?: { noteCount?: number } };
    expect(afterHide.stats?.noteCount).toBe(0);
  });

  test("exposes WeRead source tools through injected source service", async () => {
    connectReadingWeread({ apiKey: "secret-key" });
    const tools = createSdkReadingTools({
      weread: {
        shelf: async () => [{ title: "置身事内", source: { kind: "weread", externalId: "wr-2" } }],
        notebooks: async () => [{ title: "置身事内", noteCount: 3 }],
        bookmarks: async () => [{ chapterTitle: "第一章" }],
        bestBookmarks: async () => [{ markText: "地方政府的行为必须放在制度里理解。", totalCount: 1200 }],
        reviews: async () => [{ content: "很有意思" }],
        publicReviews: async () => [{ content: "这本书讲清楚了制度约束。", likeCount: 88 }],
        readdata: async () => ({ readingTime: 120 }),
        search: async () => [{ source: "weread", title: "置身事内", externalId: "wr-2" }]
      }
    });

    await expect(callTool(resolveTool(tools, "weread_shelf"), {})).resolves.toMatchObject({
      books: [{ title: "置身事内" }]
    });
    await expect(callTool(resolveTool(tools, "weread_bookmarks"), { bookId: "wr-2" })).resolves.toMatchObject({
      bookmarks: [{ chapterTitle: "第一章" }]
    });
    await expect(callTool(resolveTool(tools, "weread_notebooks"), {})).resolves.toMatchObject({
      notebooks: [{ title: "置身事内", noteCount: 3 }]
    });
    await expect(callTool(resolveTool(tools, "weread_best_bookmarks"), { bookId: "wr-2" })).resolves.toMatchObject({
      bookmarks: [{ markText: "地方政府的行为必须放在制度里理解。", totalCount: 1200 }]
    });
    await expect(callTool(resolveTool(tools, "weread_public_reviews"), { bookId: "wr-2", listType: "hot" })).resolves.toMatchObject({
      reviews: [{ content: "这本书讲清楚了制度约束。", likeCount: 88 }]
    });
    await expect(callTool(resolveTool(tools, "weread_search"), { query: "置身事内" })).resolves.toMatchObject({
      results: [{ title: "置身事内" }]
    });
  });

  test("exposes Alice-style WeRead generation and export tools without sending content", async () => {
    const generatedInputs: Array<Record<string, unknown>> = [];
    const tools = createSdkReadingTools({
      generateWereadNote: async (input) => {
        generatedInputs.push(input as unknown as Record<string, unknown>);
        return {
          status: "completed",
          noteId: "note-1",
          bookId: "book-1",
          message: "已生成读书笔记",
          completedAt: 123
        };
      },
      exportAllNotes: async () => ({
        ok: true,
        path: "/tmp/lume-reading-notes.md",
        count: 1
      })
    });

    await expect(callTool(resolveTool(tools, "weread_generate_note"), {
      bookTitle: "我在北京送快递",
      text: "把自己看作一个普通人，过普通人的生活。",
      source: "第 1 章",
      authorName: "胡安焉"
    })).resolves.toMatchObject({
      result: {
        status: "completed",
        noteId: "note-1"
      }
    });
    expect(generatedInputs).toEqual([{
      bookTitle: "我在北京送快递",
      text: "把自己看作一个普通人，过普通人的生活。",
      source: "第 1 章",
      authorName: "胡安焉"
    }]);

    await expect(callTool(resolveTool(tools, "weread_export_all_notes"), {})).resolves.toMatchObject({
      export: {
        ok: true,
        path: "/tmp/lume-reading-notes.md",
        count: 1
      }
    });
  });
});
