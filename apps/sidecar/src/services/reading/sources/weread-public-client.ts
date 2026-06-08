import type { ReadingSearchResult } from "@lume/shared";
import type { ReadingSourceFetch } from "./types";

interface WereadPublicClientInput {
  fetch?: ReadingSourceFetch;
}

const MIN_REQUEST_INTERVAL_MS = 2_000;

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  "Cookie": "wr_gid=262390826; wr_fp=123027671",
};

let lastRequestAt = 0;

export class WereadPublicClient {
  private readonly fetchImpl: ReadingSourceFetch;

  constructor(input: WereadPublicClientInput = {}) {
    this.fetchImpl = input.fetch ?? fetch;
  }

  async search(query: string, limit = 10): Promise<ReadingSearchResult[]> {
    const fetchCount = Math.max(limit * 3, 30);
    const url = `https://weread.qq.com/web/search/global?keyword=${encodeURIComponent(query)}&maxIdx=0&count=${fetchCount}`;
    const response = await this.rateLimitedFetch(url);
    if (!response.ok) {
      throw new Error(`微信读书公开搜索失败: ${response.status}`);
    }
    const payload = await response.json();
    const items = isRecord(payload) && Array.isArray(payload.books) ? payload.books : [];
    return items
      .filter(isRecord)
      .sort(byPopularity)
      .map(mapWereadPublicBook)
      .filter((book) => book.title)
      .slice(0, limit);
  }

  private async rateLimitedFetch(url: string, init?: RequestInit): Promise<Response> {
    const now = Date.now();
    const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (now - lastRequestAt));
    if (wait > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
    lastRequestAt = Date.now();
    return this.fetchImpl(url, {
      ...init,
      headers: { ...DEFAULT_HEADERS, ...(init?.headers as Record<string, string> ?? {}) },
    });
  }
}

function mapWereadPublicBook(item: Record<string, unknown>): ReadingSearchResult {
  const bookInfo = isRecord(item.bookInfo) ? item.bookInfo : item;
  const bookId = readString(bookInfo.bookId) ?? readString(item.bookId) ?? "";
  const title = readString(bookInfo.title) ?? readString(item.title) ?? "";
  const author = readString(bookInfo.author) ?? readString(item.author);
  const coverUrl = readString(bookInfo.cover) ?? readString(item.cover);
  const intro = readString(bookInfo.intro) ?? readString(item.intro);
  return {
    source: "weread",
    externalId: bookId || undefined,
    title,
    author,
    coverUrl,
    url: bookId ? `https://weread.qq.com/web/book/${bookId}` : undefined,
    summary: intro,
    rating: readNumber(item.newRating) ?? readNumber(bookInfo.newRating),
    ratingCount: readNumber(item.newRatingCount) ?? readNumber(bookInfo.newRatingCount),
    readingCount: readNumber(item.readingCount) ?? readNumber(bookInfo.readingCount)
  };
}

function byPopularity(a: Record<string, unknown>, b: Record<string, unknown>): number {
  const aInfo = isRecord(a.bookInfo) ? a.bookInfo : a;
  const bInfo = isRecord(b.bookInfo) ? b.bookInfo : b;
  const aRead = (typeof a.readingCount === "number" ? a.readingCount : 0);
  const bRead = (typeof b.readingCount === "number" ? b.readingCount : 0);
  if (aRead !== bRead) return bRead - aRead;
  const aCount = (typeof aInfo.newRatingCount === "number" ? aInfo.newRatingCount : 0);
  const bCount = (typeof bInfo.newRatingCount === "number" ? bInfo.newRatingCount : 0);
  return bCount - aCount;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}
