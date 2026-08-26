import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import type {
  ReadingAddBookInput,
  ReadingActivity,
  ReadingBook,
  ReadingBookStatus,
  ReadingBookTrack,
  ReadingConnectWereadInput,
  ReadingLibrarySnapshot,
  ReadingListNotesInput,
  ReadingNote,
  ReadingNoteInput,
  ReadingNoteRevisionInput,
  ReadingNoteSummary,
  ReadingSearchResult,
  ReadingSettings,
  ReadingStats,
  ReadingSourceRef,
  ReadingUpdateSettingsInput,
  ReadingWereadConnection
} from "@lume/shared";
import {
  createDefaultReadingSettings,
  normalizeReadingBook,
  normalizeReadingSettings,
  normalizeStringList
} from "@lume/shared";
import {
  getReadingCoversDir,
  getReadingDir,
  getReadingLibraryPath,
  getReadingNotesDir,
  getReadingRunsDir,
  getReadingSettingsPath,
  getReadingShareCardsDir
} from "../infra/config-paths";
import { backupCorruptFile } from "../infra/corrupt-file-backup";
import { decryptSecret, encryptSecret } from "../infra/secret-crypto";
import { parseReadingNoteMarkdown, serializeReadingNoteMarkdown } from "./note-markdown";
import { validateReadingQuoteEvidence } from "./quote-evidence";
import { BookDataService } from "./sources/book-data-service";
import { createLogger } from "../infra/logger";

const log = createLogger("reading");

const LIBRARY_VERSION = 1;
const WEREAD_BOOK_TRACKS = new Set<ReadingBookTrack>(["lume", "co_read", "recommended"]);
const WEREAD_BOOK_STATUSES = new Set<ReadingBookStatus>(["queued", "reading", "finished", "paused"]);
const STARTER_READING_BOOK: ReadingAddBookInput = {
  title: "人间词话",
  author: "王国维",
  track: "lume",
  status: "reading",
  source: {
    kind: "manual",
    title: "人间词话",
    author: "王国维",
    excerpt: "词以境界为最上。有境界则自成高格，自有名句。"
  },
  progressPercent: 1,
  tags: ["Lume 自读", "公共领域"]
};

interface ReadingLibraryIndex {
  version: number;
  books: ReadingBook[];
}

interface StoredReadingSettings extends ReadingSettings {
  encryptedWereadApiKey?: string;
}

export function initReadingStorage(): void {
  mkdirSync(getReadingNotesDir(), { recursive: true });
  mkdirSync(getReadingCoversDir(), { recursive: true });
  mkdirSync(getReadingShareCardsDir(), { recursive: true });
  mkdirSync(getReadingRunsDir(), { recursive: true });
  if (!existsSync(getReadingLibraryPath())) {
    writeLibrary(createEmptyLibrary());
  }
  if (!existsSync(getReadingSettingsPath())) {
    writeSettings(createDefaultReadingSettings());
  }
}

export function getReadingSnapshot(): ReadingLibrarySnapshot {
  initReadingStorage();
  ensureReadingBootstrapBook();
  const books = listReadingBooks();
  const notes = listReadingNotes();
  const settings = getReadingSettings();
  return {
    books,
    notes,
    stats: buildStats(books, notes),
    activity: buildActivity(books, notes),
    settings,
    wereadConnection: toWereadConnection(settings)
  };
}

function getBootstrapMarkerPath(): string {
  return join(getReadingDir(), ".bootstrapped");
}

export function ensureReadingBootstrapBook(): ReadingBook | null {
  initReadingStorage();
  // 用独立标记文件保证 bootstrap 一生只发生一次。旧实现仅以 `library.books.length === 0`
  // 为播种条件，而 readLibrary 在解析失败时回退空库、且快照与阅读任务都会触发本函数，
  // 一旦库「瞬时为空」（跨进程/读失败）就会重新种入《人间词话》，历史累积出多本重复种子书。
  // 标记存在后即便库被清空也不再种，根治重复。
  if (existsSync(getBootstrapMarkerPath())) return null;
  const library = readLibrary();
  // 已有书（无论是否 starter）：标记为已 bootstrap，不再强塞 starter。
  if (library.books.length > 0) {
    writeFileSync(getBootstrapMarkerPath(), String(Date.now()), "utf-8");
    return null;
  }
  const now = Date.now();
  const book = normalizeReadingBook({
    id: randomUUID(),
    ...STARTER_READING_BOOK,
    addedAt: now,
    updatedAt: now
  });
  writeLibrary({
    ...library,
    books: [book]
  });
  writeFileSync(getBootstrapMarkerPath(), String(Date.now()), "utf-8");
  return book;
}

export function listReadingBooks(): ReadingBook[] {
  initReadingStorage();
  return readLibrary().books
    .map((book) => normalizeReadingBook(book))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function addReadingBook(input: ReadingAddBookInput): ReadingBook {
  initReadingStorage();
  const library = readLibrary();

  // Dedup: update existing book if already on shelf
  const existingIndex = findShelfBookIndex(library.books, input);
  if (existingIndex >= 0) {
    const existing = library.books[existingIndex] as ReadingBook;
    const updated = normalizeReadingBook({
      ...existing,
      title: input.title,
      ...(input.author ? { author: input.author } : {}),
      ...(input.coverUrl ? { coverUrl: input.coverUrl } : {}),
      track: input.track ?? existing.track,
      status: input.status ?? existing.status,
      source: { ...existing.source, ...(input.source ?? {}) },
      ...(typeof input.progressPercent === "number" ? { progressPercent: input.progressPercent } : {}),
      tags: input.tags ?? existing.tags,
      updatedAt: Date.now()
    });
    library.books[existingIndex] = updated;
    writeLibrary(library);
    return updated;
  }

  const now = Date.now();
  const book = normalizeReadingBook({
    id: randomUUID(),
    title: input.title,
    author: input.author,
    coverUrl: input.coverUrl,
    track: input.track,
    status: input.status,
    source: input.source,
    progressPercent: input.progressPercent,
    lastReadAt: input.lastReadAt,
    tags: input.tags,
    addedAt: now,
    updatedAt: now
  });
  library.books.push(book);
  writeLibrary(library);
  return book;
}

export function syncReadingWereadShelf(rawShelf: unknown, syncedAt = Date.now()): ReadingBook[] {
  initReadingStorage();
  const incomingBooks = readWereadShelfBooks(rawShelf);
  if (incomingBooks.length === 0) return listReadingBooks();

  log.info("开始同步微信读书书架", { incomingCount: incomingBooks.length });

  const library = readLibrary();
  const books = [...library.books];

  incomingBooks.forEach((input, index) => {
    const updatedAt = syncedAt + index;
    const existingIndex = findShelfBookIndex(books, input);
    const source = normalizeWereadSource(input);
    if (existingIndex >= 0) {
      const existing = books[existingIndex] as ReadingBook;
      books[existingIndex] = normalizeReadingBook({
        ...existing,
        title: input.title,
        ...(input.author ? { author: input.author } : {}),
        ...(input.coverUrl ? { coverUrl: input.coverUrl } : {}),
        track: input.track ?? existing.track,
        status: input.status ?? existing.status,
        source: {
          ...existing.source,
          ...source
        },
        ...(typeof input.progressPercent === "number" ? { progressPercent: input.progressPercent } : {}),
        ...(typeof input.lastReadAt === "number" ? { lastReadAt: input.lastReadAt } : {}),
        tags: existing.tags,
        addedAt: existing.addedAt,
        updatedAt
      });
      return;
    }

    books.push(normalizeReadingBook({
      id: randomUUID(),
      title: input.title,
      ...(input.author ? { author: input.author } : {}),
      ...(input.coverUrl ? { coverUrl: input.coverUrl } : {}),
      track: input.track ?? "co_read",
      status: input.status ?? "reading",
      source,
      ...(typeof input.progressPercent === "number" ? { progressPercent: input.progressPercent } : {}),
      ...(typeof input.lastReadAt === "number" ? { lastReadAt: input.lastReadAt } : {}),
      tags: input.tags,
      addedAt: updatedAt,
      updatedAt
    }));
  });

  writeLibrary({
    ...library,
    books
  });
  log.info("微信读书书架同步完成", { totalBooks: books.length, incoming: incomingBooks.length });
  return listReadingBooks();
}


export function recordReadingBookProgress(input: {
  bookId: string;
  readAt: number;
  progressPercent?: number;
}): ReadingBook {
  initReadingStorage();
  const library = readLibrary();
  const index = library.books.findIndex((book) => book.id === input.bookId);
  if (index < 0) {
    throw new Error(`读书书籍不存在: ${input.bookId}`);
  }
  const existing = library.books[index] as ReadingBook;
  const updated = normalizeReadingBook({
    ...existing,
    status: existing.status === "queued" ? "reading" : existing.status,
    ...(typeof input.progressPercent === "number" ? { progressPercent: input.progressPercent } : {}),
    lastReadAt: input.readAt,
    updatedAt: input.readAt
  });
  library.books[index] = updated;
  writeLibrary(library);
  return updated;
}

export function autoAdvanceProgress(): { bookId: string; title: string; oldProgress: number; newProgress: number }[] {
  initReadingStorage();
  const library = readLibrary();
  const now = Date.now();
  const results: { bookId: string; title: string; oldProgress: number; newProgress: number }[] = [];

  for (const book of library.books) {
    if (book.status === "finished") continue;

    const currentProgress = typeof book.progressPercent === "number" ? book.progressPercent : 0;
    const dailyIncrement = 100 / 14;
    const newProgress = Math.min(100, Math.round((currentProgress + dailyIncrement) * 10) / 10);

    book.progressPercent = newProgress;
    book.updatedAt = now;

    if (newProgress >= 100) {
      book.status = "finished";
    }

    results.push({
      bookId: book.id,
      title: book.title,
      oldProgress: currentProgress,
      newProgress,
    });
  }

  if (results.length > 0) {
    writeLibrary(library);
    log.info("自动推进阅读进度", { count: results.length });
  }
  return results;
}

export function autoPickNextBook(): ReadingBook | null {
  initReadingStorage();
  const library = readLibrary();
  // active 只计「在读/暂停」：queued 是候选而非在读，若计入会导致只要有 queued 书就提前
  // return null，queued 永远无法被晋升为 reading。
  const activeBooks = library.books.filter((b) => b.status === "reading" || b.status === "paused");

  if (activeBooks.length > 0) return null;

  const finishedBooks = library.books
    .filter((b) => b.status === "finished" && b.updatedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const lastFinished = finishedBooks[0];
  const daysSinceFinish = lastFinished
    ? (Date.now() - lastFinished.updatedAt) / (24 * 3600_000)
    : Infinity;

  if (daysSinceFinish < 2) return null;

  const queuedBook = library.books.find((b) => b.status === "queued");
  if (queuedBook) {
    queuedBook.status = "reading";
    queuedBook.progressPercent = 0;
    queuedBook.updatedAt = Date.now();
    writeLibrary(library);
    return normalizeReadingBook(queuedBook);
  }

  return null;
}

export function setReadingBookLocalCover(bookId: string, localCoverPath: string): ReadingBook {
  initReadingStorage();
  const library = readLibrary();
  const index = library.books.findIndex((book) => book.id === bookId);
  if (index < 0) {
    throw new Error(`读书书籍不存在: ${bookId}`);
  }
  const existing = library.books[index] as ReadingBook;
  const updated = normalizeReadingBook({
    ...existing,
    localCoverPath,
    updatedAt: Date.now()
  });
  library.books[index] = updated;
  writeLibrary(library);
  return updated;
}


export function listReadingNotes(input: ReadingListNotesInput = {}): ReadingNoteSummary[] {
  initReadingStorage();
  const books = listReadingBooks();
  return readAllNotes()
    .filter((note) => !input.bookId || note.bookId === input.bookId)
    .filter((note) => input.includeHidden || !note.hidden)
    .filter((note) => input.includeDeleted || !note.deleted)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, normalizeLimit(input.limit))
    .map((note) => ({
      ...note,
      book: books.find((book) => book.id === note.bookId)
    }));
}

export function createReadingNote(input: ReadingNoteInput): ReadingNote {
  initReadingStorage();
  const book = listReadingBooks().find((item) => item.id === input.bookId);
  if (!book) {
    throw new Error(`读书书籍不存在: ${input.bookId}`);
  }
  const body = input.body.trim();
  if (!body) {
    throw new Error("读书笔记正文不能为空");
  }

  // Dedup: skip if a note with the same bookId and body already exists
  const existingNote = readAllNotes()
    .find((n) => n.bookId === input.bookId && n.body.trim() === body && !n.deleted);
  if (existingNote) {
    return existingNote;
  }
  const evidence = input.evidence ?? [];
  const evidenceValidation = validateReadingQuoteEvidence(evidence);
  if (!evidenceValidation.ok) {
    throw new Error(evidenceValidation.reason);
  }
  const now = Date.now();
  const depth = input.depth ?? "seed";
  const note: ReadingNote = {
    id: randomUUID(),
    bookId: input.bookId,
    title: input.title?.trim() || book.title,
    depth,
    noteKind: input.noteKind ?? (depth === "seed" ? "seed" : input.progressPercent === 100 ? "review" : "insight"),
    ...(input.chapterTitle?.trim() ? { chapterTitle: input.chapterTitle.trim() } : {}),
    summary: input.summary?.trim() || summarizeBody(body),
    body,
    ...(input.originalQuote?.trim() ? { originalQuote: input.originalQuote.trim() } : {}),
    ...(input.excerpt?.trim() ? { excerpt: input.excerpt.trim() } : {}),
    ...(typeof input.progressPercent === "number" ? { progressPercent: clampProgress(input.progressPercent) } : {}),
    tags: normalizeStringList(input.tags),
    evidence,
    ...(input.mood?.trim() ? { mood: input.mood.trim() } : {}),
    ...(input.userContext?.trim() ? { userContext: input.userContext.trim() } : {}),
    ...(input.selfContext?.trim() ? { selfContext: input.selfContext.trim() } : {}),
    ...(typeof input.rating === "number" ? { rating: clampRating(input.rating) } : {}),
    ...(typeof input.cost === "number" && Number.isFinite(input.cost) ? { cost: Math.max(0, input.cost) } : {}),
    ...(input.modelUsage ? { modelUsage: input.modelUsage } : {}),
    revisions: [],
    aiGenerated: Boolean(input.modelUsage),
    hidden: false,
    deleted: false,
    createdAt: now,
    updatedAt: now,
    ...(input.nextPlan?.trim() ? { nextPlan: input.nextPlan.trim() } : {})
  };
  writeNote(note);
  return note;
}

export function reviseReadingNote(input: ReadingNoteRevisionInput): ReadingNote {
  const note = getRequiredNote(input.id);
  const body = input.body.trim();
  if (!body) {
    throw new Error("读书笔记正文不能为空");
  }
  const editReason = input.editReason.trim();
  if (!editReason) {
    throw new Error("读书笔记修订原因不能为空");
  }
  const editedAt = Date.now();
  const updated: ReadingNote = {
    ...note,
    body,
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    revisions: [
      ...(note.revisions ?? []),
      {
        editedAt,
        editReason,
        previousBody: note.body,
        ...(note.summary ? { previousSummary: note.summary } : {}),
        ...(input.modelRef?.trim() ? { modelRef: input.modelRef.trim() } : {})
      }
    ],
    lastEditedAt: editedAt,
    updatedAt: editedAt
  };
  writeNote(updated);
  return updated;
}

export function hideReadingNote(id: string): ReadingNote {
  const note = getRequiredNote(id);
  const updated = { ...note, hidden: true, updatedAt: Date.now() };
  writeNote(updated);
  return updated;
}


export function getReadingNote(id: string): ReadingNoteSummary | null {
  const note = readNoteById(id);
  if (!note) return null;
  const book = listReadingBooks().find((item) => item.id === note.bookId);
  return { ...note, book };
}

export function setReadingNoteShareCard(noteId: string, shareCardPath: string): ReadingNote {
  const note = getRequiredNote(noteId);
  const updated = { ...note, shareCardPath, updatedAt: Date.now() };
  writeNote(updated);
  return updated;
}


/**
 * #637：把存量 legacy 弱种子 weread apiKey 密文一次性升级为 v2。返回迁移条数。
 */
export function reencryptWereadApiKeyWithInstalledKey(): number {
  const stored = readSettings();
  const value = stored?.encryptedWereadApiKey;
  if (!value || value.startsWith("enc:v2:")) return 0;
  writeSettings({
    ...normalizeReadingSettings(readSettings()),
    encryptedWereadApiKey: encryptSecret(decryptSecret(value)),
    updatedAt: Date.now()
  });
  return 1;
}

export function getReadingSettings(): ReadingSettings {
  initReadingStorage();
  return normalizeReadingSettings(readSettings());
}

export function updateReadingSettings(input: ReadingUpdateSettingsInput): ReadingSettings {
  const stored = readSettings();
  const existing = getReadingSettings();
  const updated = normalizeReadingSettings({
    ...existing,
    ...input,
    advanced: {
      ...existing.advanced,
      ...input.advanced
    },
    textModelRef: input.textModelRef === null ? undefined : input.textModelRef ?? existing.textModelRef,
    imageModelRef: input.imageModelRef === null ? undefined : input.imageModelRef ?? existing.imageModelRef,
    updatedAt: Date.now()
  });
  writeSettings({
    ...updated,
    ...(stored?.encryptedWereadApiKey ? { encryptedWereadApiKey: stored.encryptedWereadApiKey } : {})
  });
  return updated;
}

export function connectReadingWeread(input: ReadingConnectWereadInput): ReadingWereadConnection {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    throw new Error("微信读书 API Key 不能为空");
  }
  const existing = getReadingSettings();
  const updated: StoredReadingSettings = {
    ...existing,
    weread: {
      apiKeySet: true,
      ...(input.accountName?.trim() ? { accountName: input.accountName.trim() } : {}),
      lastSyncAt: Date.now()
    },
    encryptedWereadApiKey: encryptSecret(apiKey),
    updatedAt: Date.now()
  };
  writeSettings(updated);
  return toWereadConnection(updated);
}


export function getReadingWereadApiKey(): string | null {
  const stored = readSettings();
  if (!stored?.encryptedWereadApiKey) return null;
  return decryptSecret(stored.encryptedWereadApiKey);
}


const SEARCH_SOURCE_TIMEOUT_MS = 8_000;

export async function searchReadingBooks(query: string, limit = 10): Promise<ReadingSearchResult[]> {
  const apiKey = getReadingWereadApiKey();
  if (apiKey) {
    // #596：apiKey 分支与公共分支同口径包超时，避免 weread 慢调用挂住搜索
    const result = await withSearchTimeout(
      new BookDataService({ wereadApiKey: apiKey }).searchWeread(query, limit), { ok: true, data: [] }
    );
    return result.ok ? result.data : [];
  }
  return withSearchTimeout(
    new BookDataService({}).searchWereadPublic(query, limit).then((r) => r.data), []
  );
}

function withSearchTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), SEARCH_SOURCE_TIMEOUT_MS)),
  ]);
}

function backupCorruptLibrary(libraryPath: string): void {
  const backupPath = backupCorruptFile(libraryPath);
  if (backupPath) log.warn("书架文件损坏，已备份现场后重建空库", { backupPath });
}

function readLibrary(): ReadingLibraryIndex {
  initBaseDirs();
  const libraryPath = getReadingLibraryPath();
  if (!existsSync(libraryPath)) {
    return createEmptyLibrary();
  }
  try {
    const contents = readFileSync(getReadingLibraryPath(), "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(contents) as Partial<ReadingLibraryIndex>;
    // \u7ED3\u6784\u6F02\u79FB\uFF08\u5408\u6CD5 JSON \u4F46 books \u975E\u6570\u7EC4\uFF09\u4E0E\u89E3\u6790\u5931\u8D25\u540C\u8D23\uFF1A\u9759\u9ED8\u56DE\u9000\u7A7A\u5E93\u4F1A\u8BA9
    // \u4E0B\u4E00\u6B21\u5199\u5165\u7269\u7406\u8986\u76D6\u6574\u4E2A\u4E66\u67B6\uFF0C\u5FC5\u987B\u540C\u6837\u8D70\u5907\u4EFD\uFF08#592\uFF09
    if (!Array.isArray(parsed.books)) {
      throw new Error("books \u5B57\u6BB5\u7F3A\u5931\u6216\u975E\u6570\u7EC4");
    }
    return {
      version: LIBRARY_VERSION,
      books: parsed.books.map((book) => normalizeReadingBook(book))
    };
  } catch (error) {
    // 解析失败必须先把损坏文件改名保留：直接回退空库的话，下一次写入会把
    // 损坏前的整个书架物理覆盖为「空库+新书」，不可逆（#592）
    log.warn("读取书架文件失败", { error: error instanceof Error ? error.message : String(error) });
    backupCorruptLibrary(libraryPath);
    return createEmptyLibrary();
  }
}

function writeLibrary(library: ReadingLibraryIndex): void {
  initBaseDirs();
  writeJsonAtomic(getReadingLibraryPath(), JSON.stringify({
    version: LIBRARY_VERSION,
    books: library.books
  }, null, 2));
}

function createEmptyLibrary(): ReadingLibraryIndex {
  return {
    version: LIBRARY_VERSION,
    books: []
  };
}

function readSettings(): Partial<StoredReadingSettings> | null {
  initBaseDirs();
  if (!existsSync(getReadingSettingsPath())) return null;
  try {
    return JSON.parse(readFileSync(getReadingSettingsPath(), "utf-8")) as Partial<StoredReadingSettings>;
  } catch (error) {
    log.warn("读取设置文件失败", { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function writeSettings(settings: ReadingSettings | StoredReadingSettings): void {
  initBaseDirs();
  writeJsonAtomic(getReadingSettingsPath(), JSON.stringify(settings, null, 2));
}

function readAllNotes(): ReadingNote[] {
  initBaseDirs();
  return readdirSync(getReadingNotesDir())
    .filter((name) => name.endsWith(".md"))
    .map((name) => {
      try {
        return parseReadingNoteMarkdown(readFileSync(join(getReadingNotesDir(), name), "utf-8"));
      } catch (error) {
        log.warn("读取笔记文件失败", { name, error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    })
    .filter((note): note is ReadingNote => Boolean(note));
}

function readVisibleNotes(): ReadingNote[] {
  return readAllNotes().filter((note) => !note.hidden && !note.deleted);
}

function readNoteById(id: string): ReadingNote | null {
  // id 即文件名且有白名单校验，单文件直读即可，无需全目录扫描（#597）
  let path: string;
  try {
    path = getNotePath(id);
  } catch {
    return null;
  }
  try {
    return parseReadingNoteMarkdown(readFileSync(path, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    log.warn("读取笔记文件失败", { id, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

function getRequiredNote(id: string): ReadingNote {
  const note = readNoteById(id);
  if (!note) {
    throw new Error(`读书笔记不存在: ${id}`);
  }
  return note;
}

function writeNote(note: ReadingNote): void {
  initBaseDirs();
  // 原子写：直写被崩溃截断的笔记会在重启后从列表静默消失且被下次同名写入
  // 覆盖残骸（#597）
  writeJsonAtomic(getNotePath(note.id), serializeReadingNoteMarkdown(note));
}

function getNotePath(id: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error(`读书笔记 id 非法: ${id}`);
  }
  return join(getReadingNotesDir(), `${id}.md`);
}

function initBaseDirs(): void {
  mkdirSync(getReadingNotesDir(), { recursive: true });
}

function buildStats(books: ReadingBook[], notes: ReadingNote[]): ReadingStats {
  const visibleNotes = notes.filter((note) => !note.hidden && !note.deleted);
  return {
    readingCount: books.filter((book) => book.status === "reading").length,
    noteCount: visibleNotes.length,
    finishedCount: books.filter((book) => book.status === "finished").length
  };
}

function buildActivity(books: ReadingBook[], notes: ReadingNoteSummary[]): ReadingActivity {
  const visibleNotes = notes.filter((note) => !note.hidden && !note.deleted);
  const latestNote = visibleNotes[0];
  const currentBook = latestNote
    ? books.find((book) => book.id === latestNote.bookId)
    : books.find((book) => book.status === "reading") ?? books[0];

  return {
    ...(currentBook ? {
      currentBook: {
        id: currentBook.id,
        title: currentBook.title,
        ...(currentBook.author ? { author: currentBook.author } : {}),
        ...(currentBook.coverUrl ? { coverUrl: currentBook.coverUrl } : {}),
        ...(currentBook.localCoverPath ? { localCoverPath: currentBook.localCoverPath } : {}),
        track: currentBook.track,
        status: currentBook.status,
        ...(typeof currentBook.progressPercent === "number" ? { progressPercent: currentBook.progressPercent } : {})
      }
    } : {}),
    ...(latestNote ? {
      latestNote: {
        id: latestNote.id,
        bookId: latestNote.bookId,
        title: latestNote.title,
        summary: latestNote.summary,
        createdAt: latestNote.createdAt,
        ...(latestNote.nextPlan ? { nextPlan: latestNote.nextPlan } : {}),
        ...(latestNote.book?.title ? { bookTitle: latestNote.book.title } : {})
      },
      currentThought: latestNote.selfContext?.trim() || latestNote.summary,
      ...(latestNote.nextPlan ? { nextPlan: latestNote.nextPlan } : {})
    } : {})
  };
}

function toWereadConnection(settings: ReadingSettings): ReadingWereadConnection {
  return {
    connected: settings.weread.apiKeySet,
    ...(settings.weread.accountName ? { accountName: settings.weread.accountName } : {}),
    ...(settings.weread.lastSyncAt ? { lastSyncAt: settings.weread.lastSyncAt } : {})
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.min(200, Math.round(limit)));
}

function summarizeBody(body: string): string {
  return body.length > 80 ? `${body.slice(0, 80)}...` : body;
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function clampRating(value: number): number {
  return Math.max(0, Math.min(5, value));
}

function writeJsonAtomic(path: string, payload: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, payload, "utf-8");
  renameSync(tmpPath, path);
}

function readWereadShelfBooks(rawShelf: unknown): ReadingAddBookInput[] {
  return extractShelfArray(rawShelf)
    .map(readWereadShelfBook)
    .filter((book): book is ReadingAddBookInput => Boolean(book));
}

function readWereadShelfBook(raw: unknown): ReadingAddBookInput | null {
  if (!isRecord(raw)) return null;
  const bookInfo = isRecord(raw.bookInfo) ? raw.bookInfo : isRecord(raw.book) ? raw.book : {};
  const source = isRecord(raw.source) ? raw.source : isRecord(bookInfo.source) ? bookInfo.source : {};
  const title = readString(raw.title) ?? readString(bookInfo.title) ?? readString(raw.name) ?? readString(source.title);
  if (!title) return null;
  const author = readString(raw.author) ?? readString(bookInfo.author) ?? readString(source.author);
  const externalId = readString(source.externalId)
    ?? readString(raw.externalId)
    ?? readString(bookInfo.externalId)
    ?? readString(raw.bookId)
    ?? readString(bookInfo.bookId)
    ?? readString(raw.id)
    ?? readString(bookInfo.id);
  const coverUrl = readString(raw.coverUrl)
    ?? readString(bookInfo.coverUrl)
    ?? readString(raw.cover)
    ?? readString(bookInfo.cover);
  const progressPercent = readProgressPercent(raw, bookInfo, source);
  const lastReadAt = readWereadTimestamp(raw, bookInfo, source);
  const status = readWereadBookStatus(raw, bookInfo, progressPercent);
  return {
    title,
    ...(author ? { author } : {}),
    track: readBookTrack(raw.track) ?? "co_read",
    status,
    ...(coverUrl ? { coverUrl } : {}),
    ...(typeof progressPercent === "number" ? { progressPercent } : {}),
    ...(typeof lastReadAt === "number" ? { lastReadAt } : {}),
    tags: Array.isArray(raw.tags) ? normalizeStringList(raw.tags.filter((tag): tag is string => typeof tag === "string")) : [],
    source: {
      kind: "weread",
      ...(externalId ? { externalId } : {}),
      ...(readString(source.url) ? { url: readString(source.url) } : externalId ? { url: `https://weread.qq.com/web/book/${externalId}` } : {}),
      title,
      ...(author ? { author } : {})
    }
  };
}

function readWereadBookStatus(
  raw: Record<string, unknown>,
  bookInfo: Record<string, unknown>,
  _progressPercent?: number
): ReadingBookStatus {
  const explicitStatus = readBookStatus(raw.status) ?? readBookStatus(bookInfo.status);
  if (explicitStatus === "finished") return "finished";
  if (hasFinishStatus(raw) || hasFinishStatus(bookInfo)) return "finished";
  if (hasFinishedDate(raw) || hasFinishedDate(bookInfo)) return "finished";
  const finishSignals = [
    raw.finishReading,
    raw.finished,
    raw.isFinished,
    raw.readFinished,
    bookInfo.finishReading,
    bookInfo.finished,
    bookInfo.isFinished,
    bookInfo.readFinished
  ];
  if (finishSignals.some(isTruthyStatus)) return "finished";

  const textStatus = [
    raw.status,
    raw.readingStatus,
    raw.bookStatus,
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

  if (readNumber(raw.markedStatus) === 1 || readNumber(bookInfo.markedStatus) === 1) return "finished";
  return explicitStatus ?? "reading";
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

function isTruthyStatus(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true" || value === "finished" || value === "done";
}

function normalizeWereadTimestamp(value: number): number {
  return value < 100_000_000_000 ? value * 1000 : value;
}

function extractShelfArray(rawShelf: unknown): unknown[] {
  if (Array.isArray(rawShelf)) return rawShelf;
  if (!isRecord(rawShelf)) return [];
  if (Array.isArray(rawShelf.books)) return rawShelf.books;
  if (Array.isArray(rawShelf.data)) return rawShelf.data;
  if (isRecord(rawShelf.data) && Array.isArray(rawShelf.data.books)) return rawShelf.data.books;
  return [];
}

function findShelfBookIndex(books: ReadingBook[], input: ReadingAddBookInput): number {
  const externalId = input.source?.externalId?.trim();
  if (externalId) {
    const index = books.findIndex((book) => book.source.kind === "weread" && book.source.externalId === externalId);
    if (index >= 0) return index;
  }
  const key = normalizeBookKey(input.title, input.author);
  return books.findIndex((book) => normalizeBookKey(book.title, book.author) === key);
}

function normalizeWereadSource(input: ReadingAddBookInput): ReadingSourceRef {
  return {
    kind: "weread",
    ...(input.source?.externalId ? { externalId: input.source.externalId } : {}),
    ...(input.source?.url ? { url: input.source.url } : input.source?.externalId ? { url: `https://weread.qq.com/web/book/${input.source.externalId}` } : {}),
    title: input.title,
    ...(input.author ? { author: input.author } : {})
  };
}

function normalizeBookKey(title: string, author?: string): string {
  return `${title.trim().toLowerCase()}::${author?.trim().toLowerCase() ?? ""}`;
}

function readBookTrack(value: unknown): ReadingBookTrack | undefined {
  return WEREAD_BOOK_TRACKS.has(value as ReadingBookTrack) ? value as ReadingBookTrack : undefined;
}

function readBookStatus(value: unknown): ReadingBookStatus | undefined {
  return WEREAD_BOOK_STATUSES.has(value as ReadingBookStatus) ? value as ReadingBookStatus : undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
