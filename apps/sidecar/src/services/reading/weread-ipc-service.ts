import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WEREAD_KEY_PAGE_URL,
  type ReadingBook,
  type ReadingRunTaskInput,
  type ReadingTaskResult,
  type WereadExportProgress
} from "@lume/shared";
import { getReadingExportsDir } from "../infra/config-paths";
import {
  addReadingBook,
  getReadingWereadApiKey,
  listReadingBooks,
  listReadingNotes
} from "./reading-store";
import { runReadingTaskAsync } from "./reading-task-runner";
import { WereadClient } from "./sources/weread-client";

export interface WereadIpcSource {
  openAndFetchKey: () => Promise<unknown>;
  testKey: (apiKey: string) => Promise<unknown>;
  shelf: () => Promise<unknown>;
  notebooks: () => Promise<unknown>;
  bookmarks: (bookId: string) => Promise<unknown>;
  readdata: (period?: string) => Promise<unknown>;
  bestBookmarks: (bookId: string, bookTitle?: string) => Promise<unknown>;
  publicReviews: (bookId: string, listType?: string, bookTitle?: string) => Promise<unknown>;
  search: (keyword: string, limit?: number) => Promise<unknown>;
}

export interface WereadGenerateNoteInput {
  bookTitle: string;
  text: string;
  source?: string;
  authorName?: string;
}

export interface WereadExportAllNotesResult {
  ok: true;
  path: string;
  count: number;
}

export interface WereadExportAllNotesOptions {
  onProgress?: (progress: WereadExportProgress) => void;
}

export function createDefaultWereadIpcSource(): WereadIpcSource {
  return {
    async openAndFetchKey() {
      return {
        ok: false,
        reason: "desktop_required",
        url: WEREAD_KEY_PAGE_URL,
        message: "请由 Lume 桌面端打开微信读书授权页，并在复制 API Key 后连接。"
      };
    },
    async testKey(apiKey) {
      const client = new WereadClient({ apiKey });
      await client.shelf();
      return { ok: true };
    },
    async shelf() {
      return getConnectedWereadClient().shelf();
    },
    async notebooks() {
      return getConnectedWereadClient().notebooks();
    },
    async bookmarks(bookId) {
      return getConnectedWereadClient().bookmarks(bookId);
    },
    async readdata(period) {
      return getConnectedWereadClient().readdata(period);
    },
    async bestBookmarks(bookId) {
      return getConnectedWereadClient().bestBookmarks(bookId);
    },
    async publicReviews(bookId, listType) {
      return getConnectedWereadClient().publicReviews(bookId, listType);
    },
    async search(keyword, limit) {
      return getConnectedWereadClient().search(keyword, limit);
    }
  };
}

export async function generateWereadReadingNote(input: WereadGenerateNoteInput): Promise<ReadingTaskResult> {
  const bookTitle = input.bookTitle.trim();
  const text = input.text.trim();
  if (!bookTitle) throw new Error("bookTitle 必填");
  if (!text) throw new Error("text 必填");

  const book = findOrAddWereadBook({
    title: bookTitle,
    author: input.authorName,
    excerpt: text,
    source: input.source
  });
  const taskInput: ReadingRunTaskInput = {
    trigger: "manual",
    bookId: book.id,
    depth: "seed",
    manualQuoteText: text,
    manualSource: input.source ?? bookTitle
  };
  return runReadingTaskAsync(taskInput);
}

export function exportAllReadingNotes(options: WereadExportAllNotesOptions = {}): WereadExportAllNotesResult {
  const notes = listReadingNotes({ includeHidden: true });
  const path = join(getReadingExportsDir(), `reading-notes-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  options.onProgress?.({
    status: "started",
    total: notes.length,
    exported: 0,
    updatedAt: Date.now()
  });
  const body = [
    "# Lume Reading Notes",
    "",
    ...notes.map((note) => [
      `## ${note.book?.title ?? note.title}`,
      "",
      note.book?.author ? `作者：${note.book.author}` : "",
      `笔记：${note.title}`,
      note.summary ? `摘要：${note.summary}` : "",
      note.originalQuote ? `引用：${note.originalQuote}` : "",
      "",
      note.body.trim(),
      "",
      note.tags.length ? `标签：${note.tags.join("、")}` : "",
      ""
    ].filter(Boolean).join("\n"))
  ].join("\n");
  try {
    writeFileSync(path, body, "utf-8");
  } catch (error) {
    options.onProgress?.({
      status: "failed",
      total: notes.length,
      exported: 0,
      path,
      message: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now()
    });
    throw error;
  }
  options.onProgress?.({
    status: "completed",
    total: notes.length,
    exported: notes.length,
    path,
    updatedAt: Date.now()
  });
  return {
    ok: true,
    path,
    count: notes.length
  };
}

function getConnectedWereadClient(): WereadClient {
  const apiKey = getReadingWereadApiKey();
  if (!apiKey) {
    throw new Error("尚未连接微信读书 API Key");
  }
  return new WereadClient({ apiKey });
}

function findOrAddWereadBook(input: {
  title: string;
  author?: string;
  excerpt: string;
  source?: string;
}): ReadingBook {
  const existing = listReadingBooks().find((book) =>
    book.title === input.title && book.source.kind === "weread"
  ) ?? listReadingBooks().find((book) => book.title === input.title);
  if (existing) return existing;

  return addReadingBook({
    title: input.title,
    author: input.author,
    track: "co_read",
    status: "reading",
    source: {
      kind: "weread",
      title: input.title,
      author: input.author,
      location: input.source,
      excerpt: input.excerpt
    }
  });
}
