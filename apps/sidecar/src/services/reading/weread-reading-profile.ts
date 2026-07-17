export type WereadReadingDepth = "deep" | "medium" | "light" | "shelved_unread" | "notebook_only";

export interface WereadReadingSignal {
  bookId: string;
  title: string;
  author?: string;
  noteCount: number;
  depth: WereadReadingDepth;
  inShelf: boolean;
  inNotebooks: boolean;
  actuallyRead: boolean;
  progressPercent?: number;
  lastReadAt?: number;
  lastReadDate?: string;
  activeInLast30Days: boolean;
  categories: string[];
  openUrl: string;
}

export interface WereadReadingProfile {
  summary: {
    shelfBookCount: number;
    notebookBookCount: number;
    actuallyReadCount: number;
    shelvedUnreadCount: number;
    hiddenDeepCount: number;
    recentActiveCount: number;
  };
  categories: Array<{ name: string; bookCount: number }>;
  buckets: {
    deep: WereadReadingSignal[];
    medium: WereadReadingSignal[];
    light: WereadReadingSignal[];
    shelvedUnread: WereadReadingSignal[];
    hiddenDeep: WereadReadingSignal[];
    notebookOnly: WereadReadingSignal[];
  };
  recent: WereadReadingSignal[];
  warnings: string[];
}

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ACTUALLY_READ_MIN_NOTES = 5;
const HIDDEN_DEEP_MIN_NOTES = 10;

export function buildWereadReadingProfile(
  shelfPayload: unknown,
  notebookPayload: unknown,
  now = Date.now()
): WereadReadingProfile {
  const shelfBooks = extractArray(shelfPayload, ["books"])
    .filter(isRecord)
    .map(readBookSignalSource)
    .filter((book): book is BookSignalSource => Boolean(book));
  const notebookBooks = extractArray(notebookPayload, ["books", "notebooks"])
    .filter(isRecord)
    .map(readBookSignalSource)
    .filter((book): book is BookSignalSource => Boolean(book));
  const categoriesByBookId = readCategories(shelfPayload);
  const shelfByBookId = new Map(shelfBooks.map((book) => [book.bookId, book]));
  const notebookByBookId = new Map(notebookBooks.map((book) => [book.bookId, book]));
  const bookIds = Array.from(new Set([...shelfByBookId.keys(), ...notebookByBookId.keys()]));

  const signals = bookIds.map((bookId) => {
    const shelf = shelfByBookId.get(bookId);
    const notebook = notebookByBookId.get(bookId);
    const noteCount = notebook ? readNumber(notebook.raw.noteCount) ?? 0 : 0;
    const inShelf = Boolean(shelf);
    const inNotebooks = Boolean(notebook);
    const lastReadAt = readTimestamp(shelf?.raw, shelf?.bookInfo, notebook?.raw, notebook?.bookInfo);
    const progressPercent = readProgressPercent(shelf?.raw, shelf?.bookInfo, notebook?.raw, notebook?.bookInfo);
    return {
      bookId,
      title: shelf?.title ?? notebook?.title ?? "未命名微信读书书籍",
      ...(shelf?.author ?? notebook?.author ? { author: shelf?.author ?? notebook?.author } : {}),
      noteCount,
      depth: readDepth(inShelf, noteCount),
      inShelf,
      inNotebooks,
      actuallyRead: inNotebooks && noteCount >= ACTUALLY_READ_MIN_NOTES,
      ...(typeof progressPercent === "number" ? { progressPercent } : {}),
      ...(typeof lastReadAt === "number" ? { lastReadAt } : {}),
      ...(typeof lastReadAt === "number" ? { lastReadDate: formatDate(lastReadAt) } : {}),
      activeInLast30Days: typeof lastReadAt === "number" && lastReadAt >= now - RECENT_WINDOW_MS && lastReadAt <= now,
      categories: categoriesByBookId.get(bookId) ?? [],
      openUrl: shelf?.openUrl ?? notebook?.openUrl ?? `weread://reading?bId=${encodeURIComponent(bookId)}`
    } satisfies WereadReadingSignal;
  });

  const hiddenDeep = signals.filter((book) => !book.inShelf && book.noteCount >= HIDDEN_DEEP_MIN_NOTES);
  const notebookOnly = signals.filter((book) => !book.inShelf && book.noteCount < HIDDEN_DEEP_MIN_NOTES);
  const recent = signals
    .filter((book) => typeof book.lastReadAt === "number")
    .sort((left, right) => (right.lastReadAt ?? 0) - (left.lastReadAt ?? 0))
    .slice(0, 10);
  const warnings: string[] = [];
  if (shelfBooks.length === 0) {
    warnings.push("微信读书书架为空；推荐时应切换为学习路径，或先让用户补充阅读目标。");
  }
  if (notebookBooks.length === 0) {
    warnings.push("微信读书笔记为空；画像仅依据书架，推荐置信度较低。");
  }

  return {
    summary: {
      shelfBookCount: shelfBooks.length,
      notebookBookCount: notebookBooks.length,
      actuallyReadCount: signals.filter((book) => book.actuallyRead).length,
      shelvedUnreadCount: signals.filter((book) => book.depth === "shelved_unread").length,
      hiddenDeepCount: hiddenDeep.length,
      recentActiveCount: signals.filter((book) => book.activeInLast30Days).length
    },
    categories: summarizeCategories(categoriesByBookId),
    buckets: {
      deep: signals.filter((book) => book.depth === "deep"),
      medium: signals.filter((book) => book.depth === "medium"),
      light: signals.filter((book) => book.depth === "light"),
      shelvedUnread: signals.filter((book) => book.depth === "shelved_unread"),
      hiddenDeep,
      notebookOnly
    },
    recent,
    warnings
  };
}

interface BookSignalSource {
  bookId: string;
  title: string;
  author?: string;
  openUrl?: string;
  raw: Record<string, unknown>;
  bookInfo: Record<string, unknown>;
}

function readBookSignalSource(raw: Record<string, unknown>): BookSignalSource | null {
  const bookInfo = isRecord(raw.bookInfo) ? raw.bookInfo : isRecord(raw.book) ? raw.book : raw;
  const source = isRecord(bookInfo.source) ? bookInfo.source : isRecord(raw.source) ? raw.source : undefined;
  const bookId = readString(raw.bookId)
    ?? readString(bookInfo.bookId)
    ?? readString(bookInfo.id)
    ?? readString(source?.externalId);
  if (!bookId) return null;
  const title = readString(bookInfo.title) ?? readString(raw.title) ?? readString(source?.title) ?? "未命名微信读书书籍";
  return {
    bookId,
    title,
    ...(readString(bookInfo.author) ?? readString(raw.author) ?? readString(source?.author) ? {
      author: readString(bookInfo.author) ?? readString(raw.author) ?? readString(source?.author)
    } : {}),
    ...(readString(raw.deepLink)
      ?? readString(bookInfo.deepLink)
      ?? readString(source?.deepLink)
      ?? readString(source?.url) ? {
      openUrl: readString(raw.deepLink)
        ?? readString(bookInfo.deepLink)
        ?? readString(source?.deepLink)
        ?? readString(source?.url)
    } : {}),
    raw,
    bookInfo
  };
}

function readDepth(inShelf: boolean, noteCount: number): WereadReadingDepth {
  if (!inShelf) return "notebook_only";
  if (noteCount >= 10) return "deep";
  if (noteCount >= 3) return "medium";
  if (noteCount >= 1) return "light";
  return "shelved_unread";
}

function readCategories(payload: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const item of extractArray(payload, ["archive", "archives"]).filter(isRecord)) {
    const name = readString(item.name) ?? readString(item.title) ?? readString(item.archiveName);
    if (!name) continue;
    const books = Array.isArray(item.books)
      ? item.books
      : Array.isArray(item.bookIds)
        ? item.bookIds
        : Array.isArray(item.bookIdList)
          ? item.bookIdList
          : [];
    for (const book of books) {
      const bookId = typeof book === "string"
        ? readString(book)
        : isRecord(book)
          ? readString(book.bookId) ?? readString(book.id)
          : undefined;
      if (!bookId) continue;
      result.set(bookId, [...(result.get(bookId) ?? []), name]);
    }
  }
  return result;
}

function summarizeCategories(categoriesByBookId: Map<string, string[]>): Array<{ name: string; bookCount: number }> {
  const counts = new Map<string, number>();
  for (const categories of categoriesByBookId.values()) {
    for (const name of new Set(categories)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([name, bookCount]) => ({ name, bookCount }))
    .sort((left, right) => right.bookCount - left.bookCount || left.name.localeCompare(right.name, "zh-CN"));
}

function readProgressPercent(...records: Array<Record<string, unknown> | undefined>): number | undefined {
  for (const record of records) {
    if (!record) continue;
    const value = readNumber(record.readingProgress)
      ?? readNumber(record.progressPercent)
      ?? readNumber(record.progress)
      ?? readNumber(record.readProgress);
    if (typeof value === "number") return value > 0 && value < 1 ? value * 100 : value;
  }
  return undefined;
}

function readTimestamp(...records: Array<Record<string, unknown> | undefined>): number | undefined {
  for (const record of records) {
    if (!record) continue;
    const value = readNumber(record.lastReadAt)
      ?? readNumber(record.readUpdateTime)
      ?? readNumber(record.lectureReadUpdateTime)
      ?? readNumber(record.lastReadTime)
      ?? readNumber(record.updateTime)
      ?? readNumber(record.updatedAt);
    if (typeof value === "number" && value > 0) return value < 100_000_000_000 ? value * 1000 : value;
  }
  return undefined;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function extractArray(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    if (Array.isArray(payload[key])) return payload[key];
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
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
