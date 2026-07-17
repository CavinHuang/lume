import type { ReadingSearchResult } from "@lume/shared";
import type { ReadingSourceBook, ReadingSourceFetch } from "./types";

interface WereadClientInput {
  apiKey: string;
  fetch?: ReadingSourceFetch;
  baseUrl?: string;
  skillVersion?: string;
}

const WEREAD_GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
const WEREAD_SKILL_VERSION = "1.0.4";
const WEREAD_RECENT_PROGRESS_LIMIT = 5;

export class WereadClient {
  private readonly apiKey: string;
  private readonly fetchImpl: ReadingSourceFetch;
  private readonly baseUrl: string;
  private readonly skillVersion: string;

  constructor(input: WereadClientInput) {
    this.apiKey = input.apiKey.trim();
    this.fetchImpl = input.fetch ?? fetch;
    this.baseUrl = (input.baseUrl ?? WEREAD_GATEWAY_URL).replace(/\/+$/, "");
    this.skillVersion = input.skillVersion ?? WEREAD_SKILL_VERSION;
  }

  async shelf(): Promise<ReadingSourceBook[]> {
    const payload = await this.shelfSnapshot();
    const shelfItems = extractBookArray(payload);
    const books = shelfItems.map(mapWereadBook);
    const recentBookIds = shelfItems
      .map((item, index) => ({
        bookId: books[index]?.source?.externalId,
        readUpdateTime: readShelfUpdateTime(item)
      }))
      .filter((item): item is { bookId: string; readUpdateTime: number } => Boolean(item.bookId))
      .sort((left, right) => right.readUpdateTime - left.readUpdateTime)
      .slice(0, WEREAD_RECENT_PROGRESS_LIMIT);
    const progressByBookId = new Map(await Promise.all(recentBookIds.map(async ({ bookId }) => {
      const progress = await this.bookProgress(bookId).catch(() => null);
      return [bookId, progress] as const;
    })));
    return books.map((book) => {
      const progress = book.source?.externalId ? progressByBookId.get(book.source.externalId) : undefined;
      return progress ? mergeWereadProgress(book, progress) : book;
    });
  }

  async shelfSnapshot(): Promise<unknown> {
    return this.callGateway("/shelf/sync");
  }

  async shelfStats(): Promise<{ total: number; bookCount: number; albumCount: number; mpCount: number }> {
    return readShelfStats(await this.shelfSnapshot());
  }

  async search(query: string, limit = 10): Promise<ReadingSearchResult[]> {
    const payload = await this.callGateway("/store/search", {
      keyword: query,
      scope: 10,
      maxIdx: 0,
      count: limit
    });
    return extractBookArray(payload).map((item) => {
      const bookInfo = readBookInfo(item);
      const book = mapWereadBook(bookInfo);
      return {
        source: "weread",
        externalId: book.source?.externalId,
        title: book.title,
        author: book.author,
        coverUrl: book.coverUrl,
        url: book.source?.url,
        summary: readString(bookInfo.intro) ?? readString(item.intro),
        rating: readNumber(item.newRating) ?? readNumber(bookInfo.newRating),
        ratingCount: readNumber(item.newRatingCount) ?? readNumber(bookInfo.newRatingCount),
        readingCount: readNumber(item.readingCount) ?? readNumber(bookInfo.readingCount)
      };
    });
  }

  async bookmarks(bookId: string): Promise<unknown[]> {
    const payload = await this.callGateway("/book/bookmarklist", { bookId });
    return withBookmarkDeepLinks(
      withChapterTitles(extractWereadBookmarkItems(payload), readWereadChapterTitles(payload)),
      bookId
    );
  }

  async notebooks(): Promise<unknown[]> {
    const notebooks: unknown[] = [];
    let lastSort: number | undefined;
    for (let page = 0; page < 20; page++) {
      const payload = await this.callGateway("/user/notebooks", {
        count: 500,
        ...(typeof lastSort === "number" ? { lastSort } : {})
      });
      const pageNotebooks = extractArrayAny(payload, ["books", "notebooks"]);
      notebooks.push(...pageNotebooks);
      if (!hasMore(payload)) break;
      const lastNotebook = readLastRecord(pageNotebooks);
      const nextLastSort = lastNotebook ? readNumber(lastNotebook.sort) : undefined;
      if (typeof nextLastSort !== "number" || nextLastSort === lastSort) break;
      lastSort = nextLastSort;
    }
    return notebooks;
  }

  async reviews(bookId: string): Promise<unknown[]> {
    const reviews: unknown[] = [];
    let synckey = 0;
    for (let page = 0; page < 20; page++) {
      const payload = await this.callGateway("/review/list/mine", {
        bookid: bookId,
        count: 50,
        synckey
      });
      reviews.push(...extractArray(payload, "reviews"));
      if (!hasMore(payload)) break;
      const nextSynckey = readNumber(isRecord(payload) ? payload.synckey : undefined);
      if (typeof nextSynckey !== "number" || nextSynckey === synckey) break;
      synckey = nextSynckey;
    }
    return reviews;
  }

  async bestBookmarks(bookId: string): Promise<unknown[]> {
    const payload = await this.callGateway("/book/bestbookmarks", {
      bookId,
      chapterUid: 0,
      synckey: 0
    });
    const book: Record<string, unknown> = isRecord(payload) && isRecord(payload.book) ? payload.book : {};
    const chapterTitles = readWereadChapterTitles(payload);
    return extractArrayAny(payload, ["items", "bookmarks"]).filter(isRecord).map((item) => ({
      markText: readString(item.markText) ?? readString(item.text) ?? "",
      totalCount: readNumber(item.totalCount) ?? readNumber(item.count) ?? 0,
      chapterTitle: readString(item.chapterName)
        ?? readString(item.chapterTitle)
        ?? chapterTitles.get(String(readNumber(item.chapterUid) ?? readString(item.chapterUid) ?? ""))
        ?? "",
      bookTitle: readString(book.title) ?? readString(item.bookTitle) ?? "",
      bookAuthor: readString(book.author) ?? readString(item.bookAuthor) ?? ""
    })).filter((item) => item.markText);
  }

  async publicReviews(bookId: string, listType = "hot"): Promise<unknown[]> {
    const payload = await this.callGateway("/review/list", {
      bookId,
      reviewListType: mapReviewListType(listType),
      count: 20,
      maxIdx: 0,
      synckey: 0
    });
    return extractArrayAny(payload, ["reviews", "items"]).filter(isRecord).map((item) => ({
      reviewId: readString(item.reviewId) ?? readString(item.id),
      content: readPublicReviewContent(item),
      likeCount: readNumber(item.likeCount) ?? readNumber(item.likes) ?? readNumber(item.totalCount) ?? 0,
      authorName: readString(item.authorName) ?? readString(item.nickName)
    })).filter((item) => item.content);
  }

  async readdata(period?: string, baseTime?: number): Promise<unknown> {
    return this.callGateway("/readdata/detail", {
      ...(period ? { mode: normalizeReadDataMode(period) } : {}),
      ...(typeof baseTime === "number" ? { baseTime } : {})
    });
  }

  async bookInfo(bookId: string): Promise<unknown> {
    return this.callGateway("/book/info", { bookId });
  }

  async chapters(bookId: string): Promise<unknown> {
    return this.callGateway("/book/chapterinfo", { bookId });
  }

  async recommendations(count = 12, maxIdx = 0): Promise<unknown> {
    return this.callGateway("/book/recommend", { count, maxIdx });
  }

  async similarBooks(bookId: string, count = 12, maxIdx = 0, sessionId?: string): Promise<unknown> {
    return this.callGateway("/book/similar", {
      bookId,
      count,
      maxIdx,
      ...(sessionId ? { sessionId } : {})
    });
  }

  private async callGateway(apiName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = await this.fetchImpl(this.baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        api_name: apiName,
        ...params,
        skill_version: this.skillVersion
      })
    });
    if (!response.ok) {
      throw new Error(`WeRead 请求失败: ${response.status}`);
    }
    const payload = await response.json();
    if (isRecord(payload)) {
      const errcode = readNumber(payload.errcode);
      if (typeof errcode === "number" && errcode !== 0) {
        throw new Error(readString(payload.errmsg) ?? readString(payload.message) ?? `WeRead 请求失败: ${errcode}`);
      }
      const upgradeInfo = isRecord(payload.upgrade_info) ? payload.upgrade_info : undefined;
      if (upgradeInfo) {
        throw new Error(readString(upgradeInfo.message) ?? "微信读书 Skill 需要升级");
      }
    }
    return payload;
  }

  private async bookProgress(bookId: string): Promise<Record<string, unknown> | null> {
    const payload = await this.callGateway("/book/getprogress", { bookId });
    if (!isRecord(payload)) return null;
    if (isRecord(payload.book)) return payload.book;
    return payload;
  }
}

function mapWereadBook(item: Record<string, unknown>): ReadingSourceBook {
  const bookInfo = readBookInfo(item);
  const source = isRecord(item.source) ? item.source : isRecord(bookInfo.source) ? bookInfo.source : {};
  const externalId = readString(item.bookId)
    ?? readString(bookInfo.bookId)
    ?? readString(source.externalId)
    ?? readString(item.id)
    ?? readString(bookInfo.id);
  const title = readString(item.title) ?? readString(bookInfo.title) ?? readString(source.title) ?? readString(item.name) ?? "未命名微信读书书籍";
  const author = readString(item.author) ?? readString(bookInfo.author) ?? readString(source.author);
  const coverUrl = readString(item.cover) ?? readString(bookInfo.cover) ?? readString(item.coverUrl) ?? readString(bookInfo.coverUrl);
  const progressPercent = readProgressPercent(item, bookInfo, source);
  const lastReadAt = readWereadTimestamp(item, bookInfo, source);
  const status = readWereadBookStatus(item, bookInfo, progressPercent);
  const deepLink = readString(item.deepLink) ?? readString(bookInfo.deepLink) ?? readString(source.deepLink);
  return {
    title,
    author,
    coverUrl,
    track: "co_read",
    status,
    source: {
      kind: "weread",
      externalId,
      title,
      author,
      url: deepLink ?? (externalId ? `https://weread.qq.com/web/book/${externalId}` : undefined)
    },
    ...(typeof progressPercent === "number" ? { progressPercent } : {}),
    ...(typeof lastReadAt === "number" ? { lastReadAt } : {})
  };
}

function readWereadBookStatus(
  item: Record<string, unknown>,
  bookInfo: Record<string, unknown>,
  _progressPercent?: number
): "reading" | "finished" {
  if (hasFinishStatus(item) || hasFinishStatus(bookInfo)) return "finished";
  if (hasFinishedDate(item) || hasFinishedDate(bookInfo)) return "finished";
  const finishSignals = [
    item.finishReading,
    item.finished,
    item.isFinished,
    item.readFinished,
    bookInfo.finishReading,
    bookInfo.finished,
    bookInfo.isFinished,
    bookInfo.readFinished
  ];
  if (finishSignals.some(isTruthyStatus)) return "finished";

  const textStatus = [
    item.status,
    item.readingStatus,
    item.bookStatus,
    bookInfo.status,
    bookInfo.readingStatus,
    bookInfo.bookStatus
  ].map(readString).find(Boolean);
  if (textStatus) {
    const normalized = textStatus.toLowerCase();
    if (normalized.includes("finish") || normalized.includes("done") || normalized.includes("complete") || normalized.includes("已读")) {
      return "finished";
    }
  }

  return readNumber(item.markedStatus) === 1 || readNumber(bookInfo.markedStatus) === 1 ? "finished" : "reading";
}

function hasFinishedDate(record: Record<string, unknown>): boolean {
  const direct = readNumber(record.finishedDate);
  if (typeof direct === "number" && direct > 0) return true;
  for (const key of ["readInfo", "progressInfo"]) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const value = readNumber(nested.finishedDate);
    if (typeof value === "number" && value > 0) return true;
  }
  return false;
}

function hasFinishStatus(record: Record<string, unknown>): boolean {
  const finishStatus = readNumber(record.finishStatus);
  if (finishStatus === 1) return true;
  for (const key of ["bookInfo", "book", "readInfo", "progressInfo"]) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    if (readNumber(nested.finishStatus) === 1) return true;
  }
  return false;
}

function isTruthyStatus(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "finished" || value === "done";
}

function readBookInfo(item: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(item.bookInfo)) return item.bookInfo;
  if (isRecord(item.book)) return item.book;
  return item;
}

function readProgressPercent(...records: Record<string, unknown>[]): number | undefined {
  for (const record of records) {
    const nestedValue = readNestedProgressPercent(record);
    if (typeof nestedValue === "number") return nestedValue;
    const value = readNumber(record.readingProgress)
      ?? readNumber(record.progressPercent)
      ?? readNumber(record.progress)
      ?? readNumber(record.readProgress);
    if (typeof value === "number") return value > 0 && value < 1 ? value * 100 : value;
  }
  return undefined;
}

function readWereadTimestamp(...records: Record<string, unknown>[]): number | undefined {
  for (const record of records) {
    const nestedValue = readNestedWereadTimestamp(record);
    if (typeof nestedValue === "number") return nestedValue;
    const value = readNumber(record.lastReadAt)
      ?? readNumber(record.readUpdateTime)
      ?? readNumber(record.lectureReadUpdateTime)
      ?? readNumber(record.lastReadTime)
      ?? readNumber(record.readAt)
      ?? readNumber(record.readTime)
      ?? readNumber(record.readingTime)
      ?? readNumber(record.updateTime)
      ?? readNumber(record.updatedAt)
      ?? readNumber(record.finishedDate);
    if (typeof value === "number" && value > 0) return normalizeWereadTimestamp(value);
  }
  return undefined;
}

function mergeWereadProgress(book: ReadingSourceBook, progress: Record<string, unknown>): ReadingSourceBook {
  const progressPercent = readProgressPercent(progress);
  const lastReadAt = readWereadTimestamp(progress) ?? book.lastReadAt;
  const progressStatus = readWereadBookStatus(progress, progress, progressPercent);
  return {
    ...book,
    status: progressStatus === "finished" ? "finished" : book.status,
    ...(typeof progressPercent === "number" ? { progressPercent } : {}),
    ...(typeof lastReadAt === "number" ? { lastReadAt } : {})
  };
}

function readNestedProgressPercent(record: Record<string, unknown>): number | undefined {
  for (const key of ["readInfo", "progressInfo"]) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const value = readNumber(nested.readingProgress)
      ?? readNumber(nested.progressPercent)
      ?? readNumber(nested.progress)
      ?? readNumber(nested.readProgress);
    if (typeof value === "number") return value > 0 && value < 1 ? value * 100 : value;
  }
  return undefined;
}

function readNestedWereadTimestamp(record: Record<string, unknown>): number | undefined {
  for (const key of ["readInfo", "progressInfo"]) {
    const nested = record[key];
    if (!isRecord(nested)) continue;
    const value = readNumber(nested.lastReadAt)
      ?? readNumber(nested.readUpdateTime)
      ?? readNumber(nested.lectureReadUpdateTime)
      ?? readNumber(nested.lastReadTime)
      ?? readNumber(nested.readAt)
      ?? readNumber(nested.readTime)
      ?? readNumber(nested.readingTime)
      ?? readNumber(nested.updateTime)
      ?? readNumber(nested.updatedAt)
      ?? readNumber(nested.finishedDate);
    if (typeof value === "number" && value > 0) return normalizeWereadTimestamp(value);
  }
  return undefined;
}

function normalizeWereadTimestamp(value: number): number {
  return value < 100_000_000_000 ? value * 1000 : value;
}

function extractBookArray(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.books)) return payload.books.filter(isRecord);
  if (isRecord(payload.data) && Array.isArray(payload.data.books)) return payload.data.books.filter(isRecord);
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord);
  const results = extractArrayAny(payload, ["results"]).filter(isRecord);
  if (results.length) {
    return results.flatMap((result) => extractArrayAny(result, ["books"]).filter(isRecord));
  }
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

function readLastRecord(items: unknown[]): Record<string, unknown> | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (isRecord(item)) return item;
  }
  return undefined;
}

function withChapterTitles(items: unknown[], chapterTitles: Map<string, string>): unknown[] {
  if (chapterTitles.size === 0) return items;
  return items.map((item) => {
    if (!isRecord(item) || readString(item.chapterName) || readString(item.chapterTitle)) return item;
    const chapterId = readNumber(item.chapterUid) ?? readString(item.chapterUid);
    const chapterTitle = chapterId !== undefined ? chapterTitles.get(String(chapterId)) : undefined;
    return chapterTitle ? { ...item, chapterTitle } : item;
  });
}

function extractWereadBookmarkItems(payload: unknown): unknown[] {
  if (!isRecord(payload)) return extractArrayAny(payload, ["updated", "bookmarks"]);
  const chapterTitles = readWereadChapterTitles(payload);
  const chapterGroups = extractArrayAny(payload, ["chapters"]).filter(isRecord);
  const groupedItems = chapterGroups.flatMap((chapter) => {
    const items = Array.isArray(chapter.items) ? chapter.items.filter(isRecord) : [];
    if (items.length === 0) return [];
    const chapterId = readNumber(chapter.chapterUid) ?? readString(chapter.chapterUid);
    const chapterTitle = readString(chapter.chapterName)
      ?? readString(chapter.title)
      ?? readString(chapter.chapterTitle)
      ?? (chapterId !== undefined ? chapterTitles.get(String(chapterId)) : undefined);
    return items.map((item) => ({
      ...item,
      ...(chapterId !== undefined && !("chapterUid" in item) ? { chapterUid: chapterId } : {}),
      ...(chapterTitle ? { chapterTitle } : {})
    }));
  });
  return groupedItems.length > 0 ? groupedItems : extractArrayAny(payload, ["updated", "bookmarks"]);
}

function readWereadChapterTitles(payload: unknown): Map<string, string> {
  const chapters = extractArrayAny(payload, ["chapters"]).filter(isRecord);
  return new Map(chapters.flatMap((chapter) => {
    const id = readNumber(chapter.chapterUid)
      ?? readNumber(chapter.uid)
      ?? readNumber(chapter.chapterId)
      ?? readString(chapter.chapterUid)
      ?? readString(chapter.uid)
      ?? readString(chapter.chapterId);
    const title = readString(chapter.title) ?? readString(chapter.chapterTitle) ?? readString(chapter.chapterName) ?? readString(chapter.name);
    return id !== undefined && title ? [[String(id), title] as const] : [];
  }));
}

function hasMore(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  const value = payload.hasMore;
  return value === true || value === 1 || value === "1" || value === "true";
}

function readShelfStats(payload: unknown): { total: number; bookCount: number; albumCount: number; mpCount: number } {
  const bookCount = extractArrayAny(payload, ["books"]).length;
  const albumCount = extractArrayAny(payload, ["albums"]).length;
  const mp = isRecord(payload) && isRecord(payload.mp)
    ? payload.mp
    : isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.mp)
      ? payload.data.mp
      : undefined;
  const mpCount = mp && Object.keys(mp).length ? 1 : 0;
  return {
    total: bookCount + albumCount + mpCount,
    bookCount,
    albumCount,
    mpCount
  };
}

function normalizeReadDataMode(period: string): string {
  switch (period) {
    case "week":
    case "weekly":
    case "本周":
      return "weekly";
    case "month":
    case "monthly":
    case "本月":
      return "monthly";
    case "year":
    case "annually":
    case "今年":
      return "annually";
    case "all":
    case "overall":
    case "total":
    case "总计":
      return "overall";
    default:
      return period;
  }
}

function withBookmarkDeepLinks(items: unknown[], bookId: string): unknown[] {
  return items.map((item) => {
    if (!isRecord(item) || readString(item.openUrl)) return item;
    const chapterUid = readNumber(item.chapterUid) ?? readString(item.chapterUid);
    const range = readString(item.range);
    const separator = range?.lastIndexOf("-") ?? -1;
    if (chapterUid === undefined || !range || separator <= 0 || separator === range.length - 1) return item;
    const params = new URLSearchParams({
      bookId,
      chapterUid: String(chapterUid),
      rangeStart: range.slice(0, separator),
      rangeEnd: range.slice(separator + 1)
    });
    return { ...item, openUrl: `weread://bestbookmark?${params.toString()}` };
  });
}

function readShelfUpdateTime(item: Record<string, unknown>): number {
  const bookInfo = readBookInfo(item);
  return readNumber(item.readUpdateTime)
    ?? readNumber(bookInfo.readUpdateTime)
    ?? readNumber(item.lectureReadUpdateTime)
    ?? readNumber(bookInfo.lectureReadUpdateTime)
    ?? 0;
}

function mapReviewListType(listType: string): number {
  switch (listType) {
    case "hot":
    case "recommend":
    case "recommended":
      return 1;
    case "bad":
      return 2;
    case "latest":
    case "recent":
      return 3;
    case "general":
    case "average":
      return 4;
    case "all":
    default:
      return 0;
  }
}

function readPublicReviewContent(item: Record<string, unknown>): string {
  const review = isRecord(item.review) ? item.review : item;
  const nestedReview = isRecord(review.review) ? review.review : review;
  return readString(item.content)
    ?? readString(item.review)
    ?? readString(item.abstract)
    ?? readString(review.content)
    ?? readString(nestedReview.content)
    ?? readString(nestedReview.htmlContent)
    ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
