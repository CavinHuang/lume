import type { ToolDefinition } from "@lume/agent-sdk";
import type { ReadingSourceKind, ReadingTaskResult } from "@lume/shared";
import {
  addReadingBook,
  autoAdvanceProgress,
  autoPickNextBook,
  createReadingNote,
  getReadingSnapshot,
  getReadingWereadApiKey,
  hideReadingNote,
  reviseReadingNote
} from "../../../reading/reading-store";
import { WereadClient } from "../../../reading/sources/weread-client";
import { buildWereadReadingProfile } from "../../../reading/weread-reading-profile";
import { generateReadingShareCard } from "../../../reading/share-card-service";
import {
  exportAllReadingNotes,
  generateWereadReadingNote,
  type WereadExportAllNotesResult,
  type WereadGenerateNoteInput
} from "../../../reading/weread-ipc-service";
import { createSdkJsonResultTool } from "../sdk-tool-result";

interface WereadToolSource {
  shelf: () => Promise<unknown>;
  shelfSnapshot: () => Promise<unknown>;
  notebooks: () => Promise<unknown>;
  bookmarks: (bookId: string) => Promise<unknown>;
  bestBookmarks: (bookId: string) => Promise<unknown>;
  reviews: (bookId: string) => Promise<unknown>;
  publicReviews: (bookId: string, listType?: string) => Promise<unknown>;
  readdata: (period?: string, baseTime?: number) => Promise<unknown>;
  search: (query: string, limit?: number) => Promise<unknown>;
  bookInfo: (bookId: string) => Promise<unknown>;
  chapters: (bookId: string) => Promise<unknown>;
  recommendations: (count?: number, maxIdx?: number) => Promise<unknown>;
  similarBooks: (bookId: string, count?: number, maxIdx?: number, sessionId?: string) => Promise<unknown>;
}

export interface CreateReadingToolsInput {
  weread?: WereadToolSource;
  generateWereadNote?: (input: WereadGenerateNoteInput) => Promise<ReadingTaskResult>;
  exportAllNotes?: () => Promise<WereadExportAllNotesResult>;
}

export function createSdkReadingTools(input: CreateReadingToolsInput = {}): ToolDefinition[] {
  return [
    createSdkJsonResultTool({
      name: "lume_reading_snapshot",
      description: "读取 Lume Reading 当前书架、最近读书笔记、统计和微信读书连接状态。只读，不会发送或分享内容。",
      inputSchema: {
        type: "object",
        properties: {}
      },
      isReadOnly: true,
      isConcurrencySafe: true,
      async call() {
        return getReadingSnapshot();
      }
    }),
    createSdkJsonResultTool({
      name: "lume_reading_advance_progress",
      description: "推进所有在读书籍的阅读进度。每本在读书自动增加约 7.14%（相当于 14 天读完一本书）。进度达到 100% 的书籍自动标记为 finished。",
      inputSchema: {
        type: "object",
        properties: {}
      },
      async call() {
        const results = autoAdvanceProgress();
        return { ok: true, advanced: results.length, results };
      }
    }),
    createSdkJsonResultTool({
      name: "lume_reading_pick_next",
      description: "在所有在读书籍都完成后，自动从 queued 状态的书中挑选下一本开始阅读，进度归零。如果没有合适的书可读则返回 null。",
      inputSchema: {
        type: "object",
        properties: {}
      },
      async call() {
        const next = autoPickNextBook();
        return { ok: true, picked: next ? { id: next.id, title: next.title } : null };
      }
    }),
    createSdkJsonResultTool({
      name: "lume_add_book",
      description: "向 Lume Reading 书架添加一本书。用于记录 Lume 正在读、共同阅读或用户推荐的书。status 省略时默认 reading；推荐待读可设为 queued，再由 lume_reading_pick_next 晋升。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          author: { type: "string" },
          track: { type: "string", enum: ["lume", "co_read", "recommended"] },
          status: { type: "string", enum: ["queued", "reading", "finished", "paused"] },
          sourceKind: { type: "string", enum: ["weread", "gutenberg", "poetry", "manual", "generated"] },
          sourceId: { type: "string" },
          sourceUrl: { type: "string" },
          excerpt: { type: "string" },
          progressPercent: { type: "number", minimum: 0, maximum: 100 },
          tags: { type: "array", items: { type: "string" } }
        },
        required: ["title"]
      },
      async call(args) {
        const book = addReadingBook({
          title: requiredString(args.title, "title"),
          author: optionalString(args.author),
          track: args.track === "co_read" || args.track === "recommended" ? args.track : "lume",
          status:
            args.status === "queued" || args.status === "reading" || args.status === "finished" || args.status === "paused"
              ? args.status
              : undefined,
          source: {
            kind: readingSourceKind(args.sourceKind),
            externalId: optionalString(args.sourceId),
            url: optionalString(args.sourceUrl),
            excerpt: optionalString(args.excerpt)
          },
          progressPercent: optionalNumber(args.progressPercent),
          tags: optionalStringArray(args.tags)
        });
        return { ok: true, book };
      }
    }),
    createSdkJsonResultTool({
      name: "lume_write_reading_note",
      description: "写入一条 Lume Reading 笔记。引用必须提供 quote 和包含该 quote 的 excerpt；不要把摘要伪装成原文引用。",
      inputSchema: {
        type: "object",
        properties: {
          bookId: { type: "string", minLength: 1 },
          title: { type: "string" },
          depth: { type: "string", enum: ["seed", "deep"] },
          noteKind: { type: "string", enum: ["seed", "insight", "review"] },
          chapterTitle: { type: "string" },
          summary: { type: "string" },
          body: { type: "string", minLength: 1 },
          quote: { type: "string" },
          originalQuote: { type: "string" },
          excerpt: { type: "string" },
          sourceKind: { type: "string", enum: ["weread", "gutenberg", "poetry", "manual", "generated"] },
          sourceId: { type: "string" },
          progressPercent: { type: "number", minimum: 0, maximum: 100 },
          tags: { type: "array", items: { type: "string" } },
          mood: { type: "string" },
          userContext: { type: "string" },
          selfContext: { type: "string" },
          rating: { type: "number", minimum: 0, maximum: 5 },
          cost: { type: "number", minimum: 0 },
          nextPlan: { type: "string" }
        },
        required: ["bookId", "body"]
      },
      async call(args) {
        const quote = optionalString(args.quote);
        const excerpt = optionalString(args.excerpt);
        const note = createReadingNote({
          bookId: requiredString(args.bookId, "bookId"),
          title: optionalString(args.title),
          depth: args.depth === "deep" ? "deep" : "seed",
          noteKind: args.noteKind === "review" || args.noteKind === "insight" ? args.noteKind : args.noteKind === "seed" ? "seed" : undefined,
          chapterTitle: optionalString(args.chapterTitle),
          summary: optionalString(args.summary),
          body: requiredString(args.body, "body"),
          originalQuote: optionalString(args.originalQuote) ?? quote,
          excerpt,
          progressPercent: optionalNumber(args.progressPercent),
          tags: optionalStringArray(args.tags),
          evidence: quote && excerpt ? [{
            quote,
            sourceKind: readingSourceKind(args.sourceKind),
            sourceId: optionalString(args.sourceId),
            excerpt,
            capturedAt: Date.now()
          }] : [],
          mood: optionalString(args.mood),
          userContext: optionalString(args.userContext),
          selfContext: optionalString(args.selfContext),
          rating: optionalNumber(args.rating),
          cost: optionalNumber(args.cost),
          nextPlan: optionalString(args.nextPlan)
        });
        return { ok: true, note };
      }
    }),
    createSdkJsonResultTool({
      name: "lume_hide_reading_note",
      description: "隐藏一条 Lume Reading 笔记。隐藏后普通 Reading 页面不再展示，但仍可审计。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 }
        },
        required: ["id"]
      },
      async call(args) {
        return { ok: true, note: hideReadingNote(requiredString(args.id, "id")) };
      }
    }),
    createSdkJsonResultTool({
      name: "lume_revise_reading_note",
      description: "修订一条 Lume Reading 笔记，并保留修订原因和旧正文用于审计。",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          summary: { type: "string" },
          editReason: { type: "string", minLength: 1 },
          modelRef: { type: "string" }
        },
        required: ["id", "body", "editReason"]
      },
      async call(args) {
        return {
          ok: true,
          note: reviseReadingNote({
            id: requiredString(args.id, "id"),
            body: requiredString(args.body, "body"),
            summary: optionalString(args.summary),
            editReason: requiredString(args.editReason, "editReason"),
            modelRef: optionalString(args.modelRef)
          })
        };
      }
    }),
    createSdkJsonResultTool({
      name: "lume_generate_share_card",
      description: "为一条 Reading 笔记手动生成分享卡片。此工具只生成本地资产，不会发送。",
      inputSchema: {
        type: "object",
        properties: {
          noteId: { type: "string", minLength: 1 },
          theme: { type: "string", enum: ["light", "dark"] }
        },
        required: ["noteId"]
      },
      async call(args) {
        return {
          ok: true,
          card: generateReadingShareCard({
            noteId: requiredString(args.noteId, "noteId"),
            theme: args.theme === "dark" ? "dark" : "light"
          })
        };
      }
    }),
    createSdkJsonResultTool({
      name: "weread_generate_note",
      description: "基于微信读书划线、想法或书评生成一条 Lume Reading 笔记。只写入本地读书笔记，不会发送或分享内容。",
      inputSchema: {
        type: "object",
        properties: {
          bookTitle: { type: "string", minLength: 1 },
          text: { type: "string", minLength: 1 },
          source: { type: "string" },
          authorName: { type: "string" },
          bookId: { type: "string" }
        },
        required: ["bookTitle", "text"]
      },
      async call(args) {
        const generate = input.generateWereadNote ?? generateWereadReadingNote;
        const result = await generate({
          bookTitle: requiredString(args.bookTitle, "bookTitle"),
          text: requiredString(args.text, "text"),
          ...(optionalString(args.source) ? { source: optionalString(args.source) } : {}),
          ...(optionalString(args.authorName) ? { authorName: optionalString(args.authorName) } : {}),
          ...(optionalString(args.bookId) ? { bookId: optionalString(args.bookId) } : {})
        });
        return { result };
      }
    }),
    createSdkJsonResultTool({
      name: "weread_export_all_notes",
      description: "导出所有 Lume Reading 笔记为本地 Markdown 文件。只生成本地文件，不会发送。",
      inputSchema: {
        type: "object",
        properties: {}
      },
      async call() {
        const exportAll = input.exportAllNotes ?? exportAllReadingNotes;
        return { export: await exportAll() };
      }
    }),
    createWereadTool("weread_shelf", "读取已连接微信读书书架。", {}, async () => ({
      books: await resolveWeread(input).shelf()
    })),
    createWereadTool("weread_notebooks", "读取已连接微信读书笔记本列表。", {}, async () => ({
      notebooks: await resolveWeread(input).notebooks()
    })),
    createWereadTool(
      "weread_reading_profile",
      "交叉分析微信读书书架、分类、笔记深度和最近 30 天活动。推荐下一本、规划学习路径或生成阅读复盘前优先调用；会区分真读、浅尝、收藏未读和隐藏深读，并明确空数据降级提示。",
      {},
      async () => {
        const source = resolveWeread(input);
        const [shelf, notebooks] = await Promise.all([source.shelfSnapshot(), source.notebooks()]);
        return { profile: buildWereadReadingProfile(shelf, notebooks) };
      }
    ),
    createWereadTool("weread_bookmarks", "读取指定微信读书书籍的划线。", {
      bookId: { type: "string", minLength: 1 }
    }, async (args) => ({
      bookmarks: await resolveWeread(input).bookmarks(requiredString(args.bookId, "bookId"))
    }), ["bookId"]),
    createWereadTool("weread_best_bookmarks", "读取指定微信读书书籍的公开高赞划线。", {
      bookId: { type: "string", minLength: 1 }
    }, async (args) => ({
      bookmarks: await resolveWeread(input).bestBookmarks(requiredString(args.bookId, "bookId"))
    }), ["bookId"]),
    createWereadTool("weread_reviews", "读取指定微信读书书籍的想法/评论。", {
      bookId: { type: "string", minLength: 1 }
    }, async (args) => ({
      reviews: await resolveWeread(input).reviews(requiredString(args.bookId, "bookId"))
    }), ["bookId"]),
    createWereadTool("weread_public_reviews", "读取指定微信读书书籍的公开书评。", {
      bookId: { type: "string", minLength: 1 },
      listType: { type: "string" }
    }, async (args) => ({
      reviews: await resolveWeread(input).publicReviews(
        requiredString(args.bookId, "bookId"),
        optionalString(args.listType)
      )
    }), ["bookId"]),
    createWereadTool("weread_readdata", "读取微信读书阅读统计，支持自然周、月、年和总计。", {
      period: { type: "string", enum: ["weekly", "monthly", "annually", "overall"] },
      baseTime: { type: "number", minimum: 0 }
    }, async (args) => ({
      readdata: await resolveWeread(input).readdata(
        optionalString(args.period),
        optionalNumber(args.baseTime)
      )
    })),
    createWereadTool("weread_search", "搜索微信读书书籍。", {
      query: { type: "string", minLength: 1 },
      limit: { type: "number", minimum: 1, maximum: 20 }
    }, async (args) => ({
      results: await resolveWeread(input).search(requiredString(args.query, "query"), optionalNumber(args.limit))
    }), ["query"]),
    createWereadTool("weread_book_info", "读取微信读书书籍详情。", {
      bookId: { type: "string", minLength: 1 }
    }, async (args) => ({
      book: await resolveWeread(input).bookInfo(requiredString(args.bookId, "bookId"))
    }), ["bookId"]),
    createWereadTool("weread_chapters", "读取微信读书书籍章节目录。", {
      bookId: { type: "string", minLength: 1 }
    }, async (args) => ({
      chapters: await resolveWeread(input).chapters(requiredString(args.bookId, "bookId"))
    }), ["bookId"]),
    createWereadTool(
      "weread_book_context",
      "一次读取指定书籍的详情、章节、个人划线和想法，用于按章节整理结构化读书笔记；不包含公开书评，避免把他人观点混入用户笔记。",
      { bookId: { type: "string", minLength: 1 } },
      async (args) => {
        const bookId = requiredString(args.bookId, "bookId");
        const source = resolveWeread(input);
        const [book, chapters, bookmarks, reviews] = await Promise.all([
          source.bookInfo(bookId),
          source.chapters(bookId),
          source.bookmarks(bookId),
          source.reviews(bookId)
        ]);
        const bookmarkCount = Array.isArray(bookmarks) ? bookmarks.length : 0;
        const reviewCount = Array.isArray(reviews) ? reviews.length : 0;
        const personalNoteCount = bookmarkCount + reviewCount;
        return {
          bookId,
          book,
          chapters,
          bookmarks,
          reviews,
          contextSummary: {
            bookmarkCount,
            reviewCount,
            personalNoteCount,
            readiness: personalNoteCount === 0 ? "empty" : personalNoteCount < 5 ? "sparse" : "ready",
            guidance: personalNoteCount === 0
              ? "没有个人划线或想法，无法可靠提炼个人读书笔记；可询问是否改看公开高赞划线。"
              : personalNoteCount < 5
                ? "个人材料较少，生成的笔记会偏短；可先询问是否补充公开高赞划线作为参考。"
                : "个人材料足够，可按章节归位后提炼核心论点。"
          }
        };
      },
      ["bookId"]
    ),
    createWereadTool("weread_recommend", "读取微信读书个性化推荐。", {
      count: { type: "number", minimum: 1, maximum: 20 },
      maxIdx: { type: "number", minimum: 0 }
    }, async (args) => ({
      recommendations: await resolveWeread(input).recommendations(
        optionalNumber(args.count),
        optionalNumber(args.maxIdx)
      )
    })),
    createWereadTool("weread_similar", "根据指定微信读书书籍读取相似推荐。", {
      bookId: { type: "string", minLength: 1 },
      count: { type: "number", minimum: 1, maximum: 20 },
      maxIdx: { type: "number", minimum: 0 },
      sessionId: { type: "string" }
    }, async (args) => ({
      recommendations: await resolveWeread(input).similarBooks(
        requiredString(args.bookId, "bookId"),
        optionalNumber(args.count),
        optionalNumber(args.maxIdx),
        optionalString(args.sessionId)
      )
    }), ["bookId"])
  ];
}

function createWereadTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  call: (args: Record<string, unknown>) => Promise<unknown>,
  required: string[] = []
): ToolDefinition {
  return createSdkJsonResultTool({
    name,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {})
    },
    isReadOnly: true,
    isConcurrencySafe: true,
    call
  });
}

function resolveWeread(input: CreateReadingToolsInput): WereadToolSource {
  if (input.weread) return input.weread;
  const apiKey = getReadingWereadApiKey();
  if (!apiKey) {
    throw new Error("尚未连接微信读书 API Key");
  }
  return new WereadClient({ apiKey });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} 必填`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function readingSourceKind(value: unknown): ReadingSourceKind {
  return value === "weread"
    || value === "gutenberg"
    || value === "poetry"
    || value === "generated"
    ? value
    : "manual";
}
