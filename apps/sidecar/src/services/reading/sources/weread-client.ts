import type { ReadingSearchResult } from "@lume/shared";
import type { ReadingSourceBook, ReadingSourceFetch } from "./types";

interface WereadClientInput {
  apiKey: string;
  fetch?: ReadingSourceFetch;
  baseUrl?: string;
}

export class WereadClient {
  private readonly apiKey: string;
  private readonly fetchImpl: ReadingSourceFetch;
  private readonly baseUrl: string;

  constructor(input: WereadClientInput) {
    this.apiKey = input.apiKey.trim();
    this.fetchImpl = input.fetch ?? fetch;
    this.baseUrl = (input.baseUrl ?? "https://weread.qq.com").replace(/\/+$/, "");
  }

  async shelf(): Promise<ReadingSourceBook[]> {
    const payload = await this.getJson("/shelf/sync");
    return extractBookArray(payload).map(mapWereadBook);
  }

  async search(query: string, limit = 10): Promise<ReadingSearchResult[]> {
    const payload = await this.getJson(`/web/search/global?keyword=${encodeURIComponent(query)}&maxIdx=0&count=${limit}`);
    return extractBookArray(payload).map((item) => {
      const book = mapWereadBook(readBookInfo(item));
      return {
        source: "weread",
        externalId: book.source?.externalId,
        title: book.title,
        author: book.author,
        coverUrl: book.coverUrl,
        url: book.source?.url
      };
    });
  }

  async bookmarks(bookId: string): Promise<unknown[]> {
    return extractArray(await this.getJson(`/book/bookmarklist?bookId=${encodeURIComponent(bookId)}`), "bookmarks");
  }

  async notebooks(): Promise<unknown[]> {
    return extractArray(await this.getJson("/notebooklist"), "notebooks");
  }

  async reviews(bookId: string): Promise<unknown[]> {
    return extractArray(await this.getJson(`/review/list/mine?bookid=${encodeURIComponent(bookId)}&count=50&synckey=0`), "reviews");
  }

  async bestBookmarks(bookId: string): Promise<unknown[]> {
    const payload = await this.getJson(`/web/book/bestbookmarks?bookId=${encodeURIComponent(bookId)}`);
    const book: Record<string, unknown> = isRecord(payload) && isRecord(payload.book) ? payload.book : {};
    return extractArrayAny(payload, ["items", "bookmarks"]).filter(isRecord).map((item) => ({
      markText: readString(item.markText) ?? readString(item.text) ?? "",
      totalCount: readNumber(item.totalCount) ?? readNumber(item.count) ?? 0,
      chapterTitle: readString(item.chapterName) ?? readString(item.chapterTitle) ?? "",
      bookTitle: readString(book.title) ?? readString(item.bookTitle) ?? "",
      bookAuthor: readString(book.author) ?? readString(item.bookAuthor) ?? ""
    })).filter((item) => item.markText);
  }

  async publicReviews(bookId: string, listType = "hot"): Promise<unknown[]> {
    const payload = await this.getJson(`/review/list?bookId=${encodeURIComponent(bookId)}&listType=${encodeURIComponent(listType)}`);
    return extractArrayAny(payload, ["reviews", "items"]).filter(isRecord).map((item) => ({
      reviewId: readString(item.reviewId) ?? readString(item.id),
      content: readString(item.content) ?? readString(item.review) ?? readString(item.abstract) ?? "",
      likeCount: readNumber(item.likeCount) ?? readNumber(item.likes) ?? readNumber(item.totalCount) ?? 0,
      authorName: readString(item.authorName) ?? readString(item.nickName)
    })).filter((item) => item.content);
  }

  async readdata(period?: string): Promise<unknown> {
    return this.getJson(period ? `/readdata/detail?mode=${encodeURIComponent(period)}` : "/readdata/detail");
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: {
        authorization: `Bearer ${this.apiKey}`
      }
    });
    if (!response.ok) {
      throw new Error(`WeRead 请求失败: ${response.status}`);
    }
    return response.json();
  }
}

function mapWereadBook(item: Record<string, unknown>): ReadingSourceBook {
  const externalId = readString(item.bookId) ?? readString(item.id);
  const title = readString(item.title) ?? readString(item.name) ?? "未命名微信读书书籍";
  const author = readString(item.author);
  const coverUrl = readString(item.cover) ?? readString(item.coverUrl);
  const progressPercent = readNumber(item.progress) ?? readNumber(item.progressPercent);
  return {
    title,
    author,
    coverUrl,
    track: "co_read",
    status: "reading",
    source: {
      kind: "weread",
      externalId,
      title,
      author,
      url: externalId ? `https://weread.qq.com/web/book/${externalId}` : undefined
    },
    progressPercent
  };
}

function readBookInfo(item: Record<string, unknown>): Record<string, unknown> {
  return isRecord(item.bookInfo) ? item.bookInfo : item;
}

function extractBookArray(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.books)) return payload.books.filter(isRecord);
  if (isRecord(payload.data) && Array.isArray(payload.data.books)) return payload.data.books.filter(isRecord);
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord);
  return [];
}

function extractArray(payload: unknown, key: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  const value = payload[key];
  if (Array.isArray(value)) return value;
  if (isRecord(payload.data) && Array.isArray(payload.data[key])) return payload.data[key];
  return [];
}

function extractArrayAny(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (isRecord(payload.data) && Array.isArray(payload.data[key])) return payload.data[key];
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
