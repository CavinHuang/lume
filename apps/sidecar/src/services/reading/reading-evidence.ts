import type { ReadingBook, ReadingQuoteEvidence } from "@lume/shared";
import { getReadingWereadApiKey } from "./reading-store";
import { BookDataService } from "./sources/book-data-service";

export interface CollectReadingEvidenceInput {
  book: ReadingBook;
  manualQuoteText?: string;
  manualSource?: string;
  loadBookmarks?: (book: ReadingBook) => Promise<unknown[]> | unknown[];
  loadBestBookmarks?: (book: ReadingBook) => Promise<unknown[]> | unknown[];
  getWereadApiKey?: () => string | null;
  now?: () => number;
}

export async function collectReadingEvidence(input: CollectReadingEvidenceInput): Promise<ReadingQuoteEvidence[]> {
  const now = input.now ?? Date.now;
  return [
    ...manualEvidence(input, now),
    ...await wereadBookmarkEvidence(input, now),
    ...await wereadBestBookmarkEvidence(input, now)
  ];
}

export function mergeReadingEvidence(
  preferred: ReadingQuoteEvidence[],
  fallback: ReadingQuoteEvidence[]
): ReadingQuoteEvidence[] {
  const merged: ReadingQuoteEvidence[] = [];
  const seen = new Set<string>();
  for (const evidence of [...preferred, ...fallback]) {
    const key = normalizeEvidenceKey(evidence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(evidence);
  }
  return merged;
}

function manualEvidence(
  input: CollectReadingEvidenceInput,
  now: () => number
): ReadingQuoteEvidence[] {
  const quote = input.manualQuoteText?.trim();
  if (!quote) return [];
  return [{
    quote,
    sourceKind: "manual",
    sourceId: input.book.id,
    sourceTitle: input.manualSource?.trim() || input.book.title,
    excerpt: quote,
    capturedAt: now()
  }];
}

async function wereadBestBookmarkEvidence(
  input: CollectReadingEvidenceInput,
  now: () => number
): Promise<ReadingQuoteEvidence[]> {
  const bookId = input.book.source.externalId;
  if (input.book.source.kind !== "weread" || !bookId) return [];
  const raw = await loadWereadBestBookmarks(input);
  return raw
    .filter(isRecord)
    .map((item) => mapWereadBestBookmark(input.book, item, now))
    .filter((item): item is ReadingQuoteEvidence => Boolean(item));
}

async function wereadBookmarkEvidence(
  input: CollectReadingEvidenceInput,
  now: () => number
): Promise<ReadingQuoteEvidence[]> {
  const bookId = input.book.source.externalId;
  if (input.book.source.kind !== "weread" || !bookId) return [];
  const raw = await loadWereadBookmarks(input);
  return raw
    .filter(isRecord)
    .map((item) => mapWereadBestBookmark(input.book, item, now))
    .filter((item): item is ReadingQuoteEvidence => Boolean(item));
}

async function loadWereadBookmarks(input: CollectReadingEvidenceInput): Promise<unknown[]> {
  if (input.loadBookmarks) {
    return input.loadBookmarks(input.book);
  }
  const apiKey = (input.getWereadApiKey ?? getReadingWereadApiKey)();
  const bookId = input.book.source.externalId;
  if (!apiKey || !bookId) return [];
  const result = await new BookDataService({ wereadApiKey: apiKey }).loadWereadBookmarks(bookId);
  return result.data;
}

async function loadWereadBestBookmarks(input: CollectReadingEvidenceInput): Promise<unknown[]> {
  if (input.loadBestBookmarks) {
    return input.loadBestBookmarks(input.book);
  }
  const apiKey = (input.getWereadApiKey ?? getReadingWereadApiKey)();
  const bookId = input.book.source.externalId;
  if (!apiKey || !bookId) return [];
  const result = await new BookDataService({ wereadApiKey: apiKey }).loadWereadBestBookmarks(bookId);
  return result.data;
}

function mapWereadBestBookmark(
  book: ReadingBook,
  item: Record<string, unknown>,
  now: () => number
): ReadingQuoteEvidence | null {
  const quote = readString(item.markText) ?? readString(item.text);
  if (!quote) return null;
  const chapterTitle = readString(item.chapterTitle) ?? readString(item.chapterName);
  return {
    quote,
    sourceKind: "weread",
    sourceId: book.source.externalId,
    sourceTitle: readString(item.bookTitle) ?? book.title,
    ...(chapterTitle ? { location: chapterTitle } : {}),
    excerpt: quote,
    url: book.source.url ?? (book.source.externalId ? `https://weread.qq.com/web/book/${book.source.externalId}` : undefined),
    capturedAt: now()
  };
}

function normalizeEvidenceKey(evidence: ReadingQuoteEvidence): string | null {
  const quote = evidence.quote.trim().replace(/\s+/g, "");
  if (!quote) return null;
  return `${evidence.sourceKind}:${evidence.sourceId ?? ""}:${quote}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
