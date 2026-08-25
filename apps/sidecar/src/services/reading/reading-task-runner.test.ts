import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addReadingBook, createReadingNote, listReadingBooks, listReadingNotes, updateReadingSettings } from "./reading-store";
import { runReadingTaskAsync } from "./reading-task-runner";

describe("reading-task-runner", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-task-"));
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

  test("bootstraps a starter book when a reading task starts from an empty library", async () => {
    const result = await runReadingTaskAsync({ trigger: "manual", depth: "seed" }, { generateNote: () => ({}) });

    expect(result).toMatchObject({
      status: "completed",
      message: "已写下读书种子札记"
    });
    const books = listReadingBooks();
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({
      title: "人间词话",
      author: "王国维",
      track: "lume",
      status: "reading"
    });
    const note = listReadingNotes({ includeHidden: true })[0];
    expect(note).toMatchObject({
      bookId: books[0]?.id,
      depth: "seed",
      excerpt: "词以境界为最上。有境界则自成高格，自有名句。"
    });
  });

  test("creates a seed note from saved source evidence", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      track: "co_read",
      progressPercent: 54
    });

    const result = await runReadingTaskAsync({ trigger: "manual", bookId: book.id, depth: "seed" }, { generateNote: () => ({}) });
    expect(result).toMatchObject({
      status: "completed",
      bookId: book.id
    });
    const note = listReadingNotes({ includeHidden: true })[0];
    expect(note).toMatchObject({
      bookId: book.id,
      depth: "seed",
      excerpt: "把自己看作一个普通人，过普通人的生活。"
    });
    expect(note?.evidence[0]?.quote).toBe("把自己看作一个普通人，过普通人的生活。");
  });

  test("does not store duplicate manual notes for the same book and content", async () => {
    const book = addReadingBook({
      title: "人间词话",
      author: "王国维",
      source: {
        kind: "manual",
        excerpt: "词以境界为最上。有境界则自成高格，自有名句。"
      },
      track: "lume",
      progressPercent: 1
    });

    const input = { trigger: "manual" as const, bookId: book.id, depth: "seed" as const };
    const first = await runReadingTaskAsync(input, { generateNote: () => ({}) });
    const second = await runReadingTaskAsync(input, { generateNote: () => ({}) });
    const third = await runReadingTaskAsync(input, { generateNote: () => ({}) });

    expect(first.status).toBe("completed");
    expect(second).toMatchObject({
      status: "skipped",
      bookId: book.id,
      noteId: first.noteId,
      message: "这条读书笔记已经写过"
    });
    expect(third.noteId).toBe(first.noteId);
    expect(listReadingNotes({ bookId: book.id, includeHidden: true })).toHaveLength(1);
  });

  test("records book reading state after generating a note", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      status: "queued",
      track: "co_read",
      progressPercent: 12
    });

    const result = await runReadingTaskAsync({
      trigger: "manual",
      bookId: book.id,
      depth: "seed"
    }, {
      generateNote() {
        return {
          title: "普通生活的重量",
          summary: "Lume 读到普通生活的确认。",
          body: "Lume 这次读到这里时，把普通生活理解成一种需要持续确认的位置。",
          progressPercent: 54,
          tags: ["普通生活"]
        };
      }
    });

    expect(result.status).toBe("completed");
    expect(listReadingBooks().find((item) => item.id === book.id)).toMatchObject({
      id: book.id,
      status: "reading",
      progressPercent: 54,
      lastReadAt: result.completedAt
    });
  });

  test("creates a bounded deep note with nextPlan and respects weekly limit", async () => {
    updateReadingSettings({ maxDeepNotesPerWeek: 1 });
    const book = addReadingBook({
      title: "置身事内",
      author: "兰小欢",
      source: {
        kind: "weread",
        externalId: "wr-2",
        excerpt: "地方政府的行为，必须放在制度激励和财政约束里理解。"
      },
      track: "co_read",
      progressPercent: 32
    });

    const first = await runReadingTaskAsync({ trigger: "manual", bookId: book.id, depth: "deep" }, { generateNote: () => ({}) });
    expect(first.status).toBe("completed");
    const note = listReadingNotes({ includeHidden: true })[0];
    expect(note?.depth).toBe("deep");
    expect(note?.body.length).toBeGreaterThan(0);
    expect(note?.nextPlan).toContain("继续读");
    await expect(runReadingTaskAsync({ trigger: "manual", bookId: book.id, depth: "deep" }, { generateNote: () => ({}) })).resolves.toMatchObject({
      status: "skipped",
      message: "本周深度读书笔记已达上限"
    });
  });

  test("passes collaborative user reading context into the note generator", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      track: "co_read",
      progressPercent: 54
    });

    const seen: unknown[] = [];
    const result = await runReadingTaskAsync({
      trigger: "conversation",
      bookId: book.id,
      depth: "deep",
      userContext: {
        userHighlights: [
          {
            quote: "把自己看作一个普通人，过普通人的生活。",
            note: "这里像是在确认普通生活不是失败。"
          }
        ],
        userThoughts: ["我也常常被这种普通感打动。"],
        recentConversationSummary: "用户最近聊过工作里的消耗和具体生活。"
      }
    }, {
      generateNote(context) {
        seen.push(context);
        return {
          title: "普通人的日常",
          summary: "Lume 把用户的划线和自己的阅读连在一起。",
          body: "这次读到这里时，Lume 没有只把它当成胡安焉的个人经验，而是把用户在划线旁边停下来的动作也看进去了。普通生活不是被降低的生活，它更像一种需要反复确认的位置。",
          noteKind: "insight",
          mood: "安静",
          userContext: "用户把这句话和工作消耗、普通生活的确认联系在一起。",
          selfContext: "Lume 也在这句话旁边停住，想继续辨认普通生活里的重量。",
          nextPlan: "下一次继续看书里如何处理身体、工作和关系。",
          tags: ["共同阅读", "普通生活"],
          modelUsage: {
            modelRef: "test/deep-reader",
            promptTokens: 64,
            completionTokens: 48,
            totalTokens: 112
          }
        };
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      bookId: book.id
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      book: {
        id: book.id,
        title: "我在北京送快递"
      },
      depth: "deep",
      userContext: {
        recentConversationSummary: "用户最近聊过工作里的消耗和具体生活。"
      },
      existingNoteSummaries: []
    });

    const note = listReadingNotes({ includeHidden: true })[0];
    expect(note).toMatchObject({
      noteKind: "insight",
      mood: "安静",
      userContext: "用户把这句话和工作消耗、普通生活的确认联系在一起。",
      selfContext: "Lume 也在这句话旁边停住，想继续辨认普通生活里的重量。",
      modelUsage: {
        modelRef: "test/deep-reader",
        totalTokens: 112
      }
    });
  });

  test("async runner can use the Alice-like note generator path", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      track: "co_read",
      progressPercent: 54
    });

    const result = await runReadingTaskAsync({
      trigger: "manual",
      bookId: book.id,
      depth: "deep",
      userContext: {
        recentConversationSummary: "用户最近聊过工作里的消耗和普通生活。"
      }
    }, {
      async generateNote(context) {
        return {
          title: "普通生活的确认",
          summary: `${context.book.title} 和用户最近的工作感受发生了连接。`,
          body: "Lume 这次没有只把划线当作漂亮句子，而是把它放回用户最近聊到的工作消耗里看。普通生活不是退场，而是一种需要继续确认的站位。",
          originalQuote: context.evidence[0]?.quote,
          evidence: context.evidence,
          noteKind: "insight",
          tags: ["共同阅读", "普通生活"],
          userContext: context.userContext.recentConversationSummary,
          selfContext: "Lume 在这句旁边停住。"
        };
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      bookId: book.id
    });
    expect(listReadingNotes({ includeHidden: true })[0]).toMatchObject({
      title: "普通生活的确认",
      noteKind: "insight",
      userContext: "用户最近聊过工作里的消耗和普通生活。"
    });
  });

  test("async runner fails instead of saving a fallback template when no reading model is available", async () => {
    const book = addReadingBook({
      title: "踏星",
      author: "随散飘风",
      source: {
        kind: "weread",
        externalId: "wr-star",
        excerpt: "踏星"
      },
      track: "co_read",
      progressPercent: 1
    });

    const result = await runReadingTaskAsync({
      trigger: "manual",
      bookId: book.id,
      depth: "deep"
    }, {
      collectUserContext() {
        return {};
      },
      createLlmAttempt() {
        return null;
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      bookId: book.id,
      message: "读书模型未配置，无法生成读书笔记"
    });
    expect(listReadingNotes({ includeHidden: true })).toEqual([]);
  });

  test("passes previous note quote, tags, self context and next plan into generation context", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      track: "co_read",
      progressPercent: 54
    });
    createReadingNote({
      bookId: book.id,
      title: "普通生活的确认",
      depth: "deep",
      summary: "Lume 留意到普通生活不是退场。",
      body: "上一条笔记先把普通生活放回身体和劳动里看。",
      originalQuote: "把自己看作一个普通人，过普通人的生活。",
      evidence: [{
        quote: "把自己看作一个普通人，过普通人的生活。",
        sourceKind: "weread",
        sourceId: "wr-1",
        sourceTitle: "我在北京送快递",
        location: "54%",
        excerpt: "把自己看作一个普通人，过普通人的生活。",
        capturedAt: 1
      }],
      progressPercent: 54,
      tags: ["普通生活", "身体劳动"],
      selfContext: "Lume 在这句话旁边停住，想继续辨认普通生活里的重量。",
      nextPlan: "继续看身体和劳动如何被平台关系塑形。"
    });

    const seenSummaries: string[][] = [];
    const result = await runReadingTaskAsync({
      trigger: "manual",
      bookId: book.id,
      depth: "seed"
    }, {
      generateNote(context) {
        seenSummaries.push(context.existingNoteSummaries);
        return {
          title: "继续读普通生活",
          summary: "Lume 沿着上一条线索继续读。",
          body: "这次读书笔记接着上一条笔记留下的问题，继续看身体和劳动如何被平台关系塑形。",
          tags: ["普通生活"]
        };
      }
    });

    expect(result.status).toBe("completed");
    expect(seenSummaries).toHaveLength(1);
    expect(seenSummaries[0]?.join("\n")).toContain("把自己看作一个普通人，过普通人的生活。");
    expect(seenSummaries[0]?.join("\n")).toContain("普通生活, 身体劳动");
    expect(seenSummaries[0]?.join("\n")).toContain("Lume 在这句话旁边停住");
    expect(seenSummaries[0]?.join("\n")).toContain("nextPlan：继续看身体和劳动如何被平台关系塑形。");
  });

  test("async runner enriches generation context with collected collaborative context", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      track: "co_read",
      progressPercent: 54
    });

    const seen: unknown[] = [];
    const result = await runReadingTaskAsync({
      trigger: "scheduled",
      bookId: book.id,
      depth: "deep"
    }, {
      async collectUserContext() {
        return {
          recentConversationSummary: "用户最近把普通生活和工作消耗联系起来。",
          userThoughts: ["普通生活不是失败。"]
        };
      },
      async generateNote(context) {
        seen.push(context.userContext);
        return {
          title: "被共同读到的位置",
          summary: "Lume 把自动收集到的协作上下文带进读书笔记。",
          body: "这次读书笔记不是孤立地产生的，Lume 把用户最近关于普通生活和工作消耗的表达带进来，一起确认这句话为什么会停住。",
          tags: ["共同阅读"],
          userContext: context.userContext.recentConversationSummary
        };
      }
    });

    expect(result.status).toBe("completed");
    expect(seen).toEqual([{
      recentConversationSummary: "用户最近把普通生活和工作消耗联系起来。",
      userThoughts: ["普通生活不是失败。"]
    }]);
    expect(listReadingNotes({ includeHidden: true })[0]).toMatchObject({
      title: "被共同读到的位置",
      userContext: "用户最近把普通生活和工作消耗联系起来。"
    });
  });

  test("async runner passes workspace context tools into collaborative context collection", async () => {
    const book = addReadingBook({
      title: "置身事内",
      author: "兰小欢",
      source: {
        kind: "weread",
        externalId: "wr-2",
        excerpt: "地方政府的行为，必须放在制度激励和财政约束里理解。"
      },
      track: "co_read",
      progressPercent: 32
    });
    const memoryCalls: unknown[] = [];
    const seenSummaries: Array<string | undefined> = [];

    const result = await runReadingTaskAsync({
      trigger: "scheduled",
      bookId: book.id,
      depth: "seed"
    }, {
      contextTools: {
        workspaceSlug: "demo-workspace",
        searchMemory: async (input) => {
          memoryCalls.push(input);
          return [{
            id: "mem-1",
            path: "/memory/user.md",
            snippet: "用户最近关心制度约束和日常生活之间的关系。",
            score: 0.8,
            source: "memory"
          }];
        },
        listThreads: () => [],
        getRecentMessages: () => ({ messages: [], total: 0, hasMore: false })
      },
      generateNote(context) {
        seenSummaries.push(context.userContext.recentConversationSummary);
        return {
          title: "制度和日常",
          summary: "Lume 把工作区记忆带进读书笔记。",
          body: "这条读书笔记不只从书里的制度解释出发，也把用户最近关心制度约束和日常生活之间关系的线索带进来。",
          userContext: context.userContext.recentConversationSummary,
          tags: ["共同阅读", "制度"]
        };
      }
    });

    expect(result.status).toBe("completed");
    expect(memoryCalls).toEqual([expect.objectContaining({
      workspaceSlug: "demo-workspace",
      query: expect.stringContaining("置身事内"),
      includeWorkspace: true,
      includeGlobal: true
    })]);
    expect(seenSummaries[0]).toContain("用户最近关心制度约束和日常生活之间的关系");
    expect(listReadingNotes({ includeHidden: true })[0]).toMatchObject({
      title: "制度和日常",
      userContext: expect.stringContaining("用户最近关心制度约束")
    });
  });

  test("async runner injects a reading LLM attempt into the Alice-like generator path", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      },
      track: "co_read",
      progressPercent: 54
    });
    const modelRefs: string[] = [];

    const result = await runReadingTaskAsync({
      trigger: "manual",
      bookId: book.id,
      depth: "deep"
    }, {
      collectUserContext() {
        return {
          recentConversationSummary: "用户最近聊过普通生活和工作消耗。"
        };
      },
      createLlmAttempt({ depth }) {
        expect(depth).toBe("deep");
        return {
          modelRef: "test/deep-reader",
          llm: {
            async *stream(request) {
              modelRefs.push(request.modelRef);
              expect(request.tools.map((tool) => tool.name)).toContain("alice_user_memory");
              yield {
                type: "text",
                text: JSON.stringify({
                  title: "普通生活的确认",
                  reflection: "Lume 通过真实模型生成路径，把书里的普通生活和用户最近的工作消耗连在一起。",
                  summary: "Lume 把阅读和协作上下文连起来。",
                  quote: "把自己看作一个普通人，过普通人的生活。",
                  tags: ["共同阅读", "普通生活"],
                  userContext: "用户最近聊过普通生活和工作消耗。",
                  selfContext: "Lume 在读这句话时停住。",
                  nextPlan: "继续看身体、劳动和关系如何展开。"
                })
              };
              yield {
                type: "usage",
                usage: {
                  modelRef: "test/deep-reader",
                  promptTokens: 24,
                  completionTokens: 36,
                  totalTokens: 60
                }
              };
            }
          }
        };
      }
    });

    expect(result).toMatchObject({
      status: "completed",
      bookId: book.id
    });
    expect(modelRefs).toEqual(["test/deep-reader"]);
    expect(listReadingNotes({ includeHidden: true })[0]).toMatchObject({
      title: "普通生活的确认",
      modelUsage: {
        modelRef: "test/deep-reader",
        totalTokens: 60
      }
    });
  });

  test("async runner enriches generation evidence from Alice-like WeRead best bookmarks", async () => {
    const book = addReadingBook({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "旧的本地摘要，不应该压过高赞划线。"
      },
      track: "co_read",
      progressPercent: 54
    });
    const seenQuotes: string[][] = [];

    const result = await runReadingTaskAsync({
      trigger: "manual",
      bookId: book.id,
      depth: "deep"
    }, {
      async collectEvidence({ book: inputBook }) {
        expect(inputBook.id).toBe(book.id);
        return [{
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "weread",
          sourceId: "wr-1",
          sourceTitle: "我在北京送快递",
          location: "第一章",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          capturedAt: 123
        }];
      },
      generateNote(context) {
        seenQuotes.push(context.evidence.map((item) => item.quote));
        return {
          title: "从高赞划线开始",
          summary: "Lume 使用微信读书高赞划线作为读书证据。",
          body: "这条笔记从高赞划线开始，而不是只从书架上的本地摘要开始。Lume 因此能更接近 Alice 那种先读材料、再写笔记的流程。",
          originalQuote: context.evidence[0]?.quote,
          evidence: context.evidence,
          tags: ["高赞划线"]
        };
      }
    });

    expect(result.status).toBe("completed");
    expect(seenQuotes).toEqual([[
      "把自己看作一个普通人，过普通人的生活。",
      "旧的本地摘要，不应该压过高赞划线。"
    ]]);
    expect(listReadingNotes({ includeHidden: true })[0]).toMatchObject({
      originalQuote: "把自己看作一个普通人，过普通人的生活。",
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          location: "第一章"
        },
        {
          quote: "旧的本地摘要，不应该压过高赞划线。"
        }
      ]
    });
  });
});
