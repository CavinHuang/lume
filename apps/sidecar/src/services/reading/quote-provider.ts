import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import type { ReadingBook, ReadingNoteSummary } from "@lume/shared";
import { getReadingQuotesPath } from "../infra/config-paths";
import {
  getReadingWereadApiKey,
  listReadingBooks,
  listReadingNotes
} from "./reading-store";
import { BookDataService } from "./sources/book-data-service";
import { createLogger } from "../infra/logger";

const log = createLogger("reading-quotes");

export interface ReadingQuoteRecord {
  id: string;
  text: string;
  source: string;
  author?: string;
  origin: "reading_note" | "weread";
  highlightCount?: number;
  bookId: string;
  tags: string[];
  usedCount: number;
  createdAt: number;
  chapterTitle?: string;
}

export interface RefreshReadingQuotesInput {
  bookId?: string;
  loadBestBookmarks?: (book: ReadingBook) => Promise<unknown[]>;
}

export interface RefreshReadingQuotesResult {
  ok: true;
  bookId?: string;
  refreshed: number;
  path: string;
}

export function listReadingQuotes(input: { bookId?: string; limit?: number } = {}): ReadingQuoteRecord[] {
  return readQuoteBank()
    .filter((quote) => !input.bookId || quote.bookId === input.bookId)
    .sort((a, b) => (b.highlightCount ?? 0) - (a.highlightCount ?? 0) || b.createdAt - a.createdAt)
    .slice(0, normalizeLimit(input.limit));
}

export async function refreshReadingQuotes(input: RefreshReadingQuotesInput = {}): Promise<RefreshReadingQuotesResult> {
  const books = listReadingBooks().filter((book) => !input.bookId || book.id === input.bookId);
  const existing = readQuoteBank().filter((quote) => !input.bookId || quote.bookId !== input.bookId);
  const next: ReadingQuoteRecord[] = [...existing];
  const seen = new Set(existing.map(quoteKey));

  for (const book of books) {
    const quotes = [
      ...quotesFromNotes(book, listReadingNotes({ bookId: book.id, includeHidden: true })),
      ...await quotesFromWeread(book, input.loadBestBookmarks)
    ];
    for (const quote of quotes) {
      const key = quoteKey(quote);
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(quote);
    }
  }

  writeQuoteBank(next);
  return {
    ok: true,
    ...(input.bookId ? { bookId: input.bookId } : {}),
    refreshed: next.length - existing.length,
    path: getReadingQuotesPath()
  };
}

function quotesFromNotes(book: ReadingBook, notes: ReadingNoteSummary[]): ReadingQuoteRecord[] {
  const now = Date.now();
  return notes.flatMap((note) =>
    note.evidence.map((evidence) => ({
      id: `rq-${randomUUID()}`,
      text: evidence.quote,
      source: formatSource(book.title),
      ...(book.author ? { author: book.author } : {}),
      origin: "reading_note" as const,
      bookId: book.id,
      tags: note.tags,
      usedCount: 0,
      createdAt: now
    }))
  ).filter((quote) => quote.text.trim().length > 0);
}

async function quotesFromWeread(
  book: ReadingBook,
  loadBestBookmarks?: (book: ReadingBook) => Promise<unknown[]>
): Promise<ReadingQuoteRecord[]> {
  if (book.source.kind !== "weread" || !book.source.externalId) return [];
  const raw = await loadWereadBestBookmarks(book, loadBestBookmarks);
  const now = Date.now();
  return raw
    .map((item) => normalizeRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => {
      const chapterTitle = readString(item.chapterTitle) ?? readString(item.chapterName);
      return {
        id: `rq-${randomUUID()}`,
        text: readString(item.markText) ?? readString(item.text) ?? "",
        source: formatSource(readString(item.bookTitle) ?? book.title, chapterTitle),
        author: readString(item.bookAuthor) ?? book.author,
        origin: "weread" as const,
        highlightCount: readNumber(item.totalCount) ?? readNumber(item.highlightCount) ?? 0,
        bookId: book.id,
        tags: [],
        usedCount: 0,
        createdAt: now,
        ...(chapterTitle ? { chapterTitle } : {})
      };
    })
    .filter((quote) => quote.text.trim().length > 0);
}

async function loadWereadBestBookmarks(
  book: ReadingBook,
  loadBestBookmarks?: (book: ReadingBook) => Promise<unknown[]>
): Promise<unknown[]> {
  if (loadBestBookmarks) return loadBestBookmarks(book);
  const apiKey = getReadingWereadApiKey();
  if (!apiKey || !book.source.externalId) return [];
  const result = await new BookDataService({ wereadApiKey: apiKey }).loadWereadBestBookmarks(book.source.externalId);
  return result.data;
}

function readQuoteBank(): ReadingQuoteRecord[] {
  if (!existsSync(getReadingQuotesPath())) return [];
  try {
    const parsed = JSON.parse(readFileSync(getReadingQuotesPath(), "utf-8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isQuoteRecord) : [];
  } catch (error) {
    log.error("failed to read reading quote bank", { error });
    return [];
  }
}

function writeQuoteBank(quotes: ReadingQuoteRecord[]): void {
  const path = getReadingQuotesPath();
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(quotes, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

function isQuoteRecord(value: unknown): value is ReadingQuoteRecord {
  return Boolean(value)
    && typeof value === "object"
    && typeof (value as ReadingQuoteRecord).id === "string"
    && typeof (value as ReadingQuoteRecord).text === "string"
    && typeof (value as ReadingQuoteRecord).bookId === "string";
}

function normalizeRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === "object" ? value as Record<string, unknown> : null;
}

function quoteKey(quote: Pick<ReadingQuoteRecord, "bookId" | "text">): string {
  return `${quote.bookId}:${quote.text.trim()}`;
}

function formatSource(title: string, chapterTitle?: string): string {
  return `《${title}》${chapterTitle ? `·${chapterTitle}` : ""}`;
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.min(200, Math.round(limit)));
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
