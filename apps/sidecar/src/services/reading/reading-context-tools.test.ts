import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSearchTool } from "@lume/agent-sdk";
import type { AgentMessage, AgentThreadMeta, MemorySearchResult, ReadingBook } from "@lume/shared";
import { addReadingBook, createReadingNote } from "./reading-store";
import {
  collectReadingUserContext,
  createReadingContextToolRunner
} from "./reading-context-tools";

describe("reading-context-tools", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-context-"));
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

  test("maps Alice-like memory and journal tools to Lume memory and recent conversations", async () => {
    const calls: unknown[] = [];
    const runner = createReadingContextToolRunner({
      workspaceSlug: "demo-workspace",
      searchMemory: async (input) => {
        calls.push(input);
        return [{
          id: "mem-1",
          path: "/memory/user.md",
          snippet: "用户最近把普通生活和工作消耗联系在一起。",
          score: 0.9,
          source: "memory"
        }] satisfies MemorySearchResult[];
      },
      listThreads: () => [thread("thread-1", 200)],
      getRecentMessages: () => ({
        messages: [
          message("user", "我最近读到普通生活这句话时想到了工作里的消耗。", 100),
          message("assistant", "我们可以把它和身体、劳动一起看。", 101)
        ],
        total: 2,
        hasMore: false
      })
    });

    await expect(runner("alice_user_memory", { query: "普通生活", limit: 2 })).resolves.toContain("用户最近把普通生活和工作消耗联系在一起。");
    await expect(runner("alice_journal_recall", { query: "普通生活", limit: 2 })).resolves.toContain("工作里的消耗");
    expect(calls).toEqual([{
      workspaceSlug: "demo-workspace",
      query: "普通生活",
      maxResults: 2,
      includeWorkspace: true,
      includeGlobal: true,
      sessionType: "main"
    }]);
  });

  test("maps Alice-like web search to the built-in web search tool by default", async () => {
    const originalCall = WebSearchTool.call;
    const calls: unknown[] = [];
    WebSearchTool.call = async (input, context) => {
      calls.push({ input, context });
      return {
        type: "tool_result",
        tool_use_id: "",
        content: "1. 胡安焉访谈 - 作者谈普通生活和劳动经验",
        is_error: false
      };
    };

    try {
      const runner = createReadingContextToolRunner();
      await expect(runner("alice_web_search", { query: "胡安焉 采访", limit: 2 })).resolves.toContain("胡安焉访谈");
      expect(calls).toEqual([{
        input: {
          query: "胡安焉 采访",
          num_results: 2
        },
        context: {
          cwd: process.cwd()
        }
      }]);
    } finally {
      WebSearchTool.call = originalCall;
    }
  });

  test("recalls Lume's recent reading notes as diary context", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "manual",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      progressPercent: 54
    });
    createReadingNote({
      bookId: book.id,
      title: "普通生活的确认",
      summary: "Lume 把普通生活读成一种需要继续确认的位置。",
      body: "这条笔记记录了 Lume 对普通生活和劳动经验的理解。",
      selfContext: "Lume 在这句话旁边停住，想继续辨认普通生活里的重量。",
      tags: ["普通生活"],
      evidence: []
    });

    const runner = createReadingContextToolRunner({
      listThreads: () => [],
      getRecentMessages: () => ({ messages: [], total: 0, hasMore: false })
    });

    const output = await runner("alice_diary_recall", { query: "普通生活", limit: 3 });
    expect(output).toContain("最近读书笔记");
    expect(output).toContain("普通生活的确认");
    expect(output).toContain("Lume 在这句话旁边停住");
  });

  test("collects collaborative reading context from explicit input, memory, and recent conversations", async () => {
    const readingBook = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "manual",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      progressPercent: 54
    });
    createReadingNote({
      bookId: readingBook.id,
      title: "普通生活的确认",
      summary: "Lume 把普通生活读成一种需要继续确认的位置。",
      body: "这条笔记记录了 Lume 对普通生活和劳动经验的理解。",
      selfContext: "Lume 之前已经把这句话和劳动里的身体感连起来。",
      nextPlan: "继续看普通生活如何进入具体关系。",
      tags: ["普通生活"],
      evidence: []
    });

    const context = await collectReadingUserContext({
      book: book(),
      input: {
        userContext: {
          userThoughts: ["这句让我想到普通生活不是失败。"]
        }
      },
      workspaceSlug: "demo-workspace",
      searchMemory: async () => [{
        id: "mem-1",
        path: "/memory/user.md",
        snippet: "用户关注工作消耗和日常尊严。",
        score: 0.8,
        source: "memory"
      }],
      listThreads: () => [thread("thread-1", 200)],
      getRecentMessages: () => ({
        messages: [
          message("user", "我想把这本书里的普通人和自己的工作感受放在一起看。", 100),
          message("assistant", "这会让阅读变成共同确认生活位置的过程。", 101)
        ],
        total: 2,
        hasMore: false
      })
    });

    expect(context).toMatchObject({
      userThoughts: ["这句让我想到普通生活不是失败。"]
    });
    expect(context.memorySnippets).toEqual(["用户关注工作消耗和日常尊严。"]);
    expect(context.recentConversationSnippets?.join("\n")).toContain("用户：我想把这本书里的普通人和自己的工作感受放在一起看。");
    expect(context.recentReadingNoteSnippets?.join("\n")).toContain("普通生活的确认");
    expect(context.recentDiarySummary).toContain("Lume 之前已经把这句话和劳动里的身体感连起来。");
    expect(context.recentConversationSummary).toContain("普通人和自己的工作感受");
    expect(context.recentConversationSummary).toContain("用户关注工作消耗和日常尊严");
  });
});

function book(): ReadingBook {
  return {
    id: "book-1",
    title: "我在北京送快递",
    author: "胡安焉",
    track: "co_read",
    status: "reading",
    source: {
      kind: "weread",
      externalId: "wr-1",
      excerpt: "把自己看作一个普通人，过普通人的生活。"
    },
    progressPercent: 54,
    tags: [],
    addedAt: 1,
    updatedAt: 1
  };
}

function thread(id: string, updatedAt: number): AgentThreadMeta {
  return {
    id,
    title: "最近聊天",
    createdAt: updatedAt - 1,
    updatedAt
  };
}

function message(role: AgentMessage["role"], content: string, createdAt: number): AgentMessage {
  return {
    id: `${role}-${createdAt}`,
    role,
    content,
    createdAt
  };
}
