import type { ToolDefinition } from "@lume/agent-sdk";
import type { ReadingSourceKind, ReadingTaskResult } from "@lume/shared";
import {
  addReadingBook,
  createReadingNote,
  getReadingSnapshot,
  getReadingWereadApiKey,
  hideReadingNote,
  reviseReadingNote
} from "../../../reading/reading-store";
import { WereadClient } from "../../../reading/sources/weread-client";
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
  notebooks: () => Promise<unknown>;
  bookmarks: (bookId: string) => Promise<unknown>;
  bestBookmarks: (bookId: string) => Promise<unknown>;
  reviews: (bookId: string) => Promise<unknown>;
  publicReviews: (bookId: string, listType?: string) => Promise<unknown>;
  readdata: (period?: string) => Promise<unknown>;
  search: (query: string, limit?: number) => Promise<unknown>;
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
      name: "lume_add_book",
      description: "向 Lume Reading 书架添加一本书。用于记录 Lume 正在读、共同阅读或用户推荐的书。",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1 },
          author: { type: "string" },
          track: { type: "string", enum: ["lume", "co_read", "recommended"] },
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
          authorName: { type: "string" }
        },
        required: ["bookTitle", "text"]
      },
      async call(args) {
        const generate = input.generateWereadNote ?? generateWereadReadingNote;
        const result = await generate({
          bookTitle: requiredString(args.bookTitle, "bookTitle"),
          text: requiredString(args.text, "text"),
          ...(optionalString(args.source) ? { source: optionalString(args.source) } : {}),
          ...(optionalString(args.authorName) ? { authorName: optionalString(args.authorName) } : {})
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
    createWereadTool("weread_readdata", "读取微信读书阅读统计。", {}, async () => ({
      readdata: await resolveWeread(input).readdata()
    })),
    createWereadTool("weread_search", "搜索微信读书书籍。", {
      query: { type: "string", minLength: 1 },
      limit: { type: "number", minimum: 1, maximum: 20 }
    }, async (args) => ({
      results: await resolveWeread(input).search(requiredString(args.query, "query"), optionalNumber(args.limit))
    }), ["query"])
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
