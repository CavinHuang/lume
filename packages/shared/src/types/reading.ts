// gutenberg/poetry 书源客户端已删(#529, commit 5a32fab2)；如需恢复从该提交^ 取回并同步以下各处契约
export type ReadingSourceKind = "weread" | "manual" | "generated";
export type ReadingBookTrack = "lume" | "co_read" | "recommended";
export type ReadingBookStatus = "queued" | "reading" | "finished" | "paused";
export type ReadingNoteDepth = "seed" | "deep";
export type ReadingNoteKind = "seed" | "insight" | "review";
export type ReadingTaskStatus = "completed" | "partial" | "skipped" | "failed";
export type ReadingRunTrigger = "manual" | "scheduled" | "progress" | "conversation";
export type ReadingCadence = "off" | "weekly" | "few_times_weekly" | "manual";
export type ReadingLanguage = "zh";
export type ReadingModelMode = "inherit" | "explicit";

export interface ReadingSourceRef {
  kind: ReadingSourceKind;
  externalId?: string;
  url?: string;
  title?: string;
  author?: string;
  location?: string;
  excerpt?: string;
}

export interface ReadingBook {
  id: string;
  title: string;
  author?: string;
  coverUrl?: string;
  localCoverPath?: string;
  track: ReadingBookTrack;
  status: ReadingBookStatus;
  source: ReadingSourceRef;
  progressPercent?: number;
  lastReadAt?: number;
  tags: string[];
  addedAt: number;
  updatedAt: number;
}

export interface ReadingQuoteEvidence {
  quote: string;
  sourceKind: ReadingSourceKind;
  sourceId?: string;
  sourceTitle?: string;
  location?: string;
  excerpt?: string;
  url?: string;
  capturedAt: number;
}

export interface ReadingNoteRevision {
  editedAt: number;
  editReason: string;
  previousBody: string;
  previousSummary?: string;
  modelRef?: string;
}

export interface ReadingModelUsage {
  modelRef?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ReadingNote {
  id: string;
  bookId: string;
  title: string;
  depth: ReadingNoteDepth;
  noteKind?: ReadingNoteKind;
  chapterTitle?: string;
  summary: string;
  body: string;
  originalQuote?: string;
  excerpt?: string;
  progressPercent?: number;
  tags: string[];
  evidence: ReadingQuoteEvidence[];
  mood?: string;
  userContext?: string;
  selfContext?: string;
  rating?: number;
  cost?: number;
  modelUsage?: ReadingModelUsage;
  revisions?: ReadingNoteRevision[];
  lastEditedAt?: number;
  aiGenerated: boolean;
  hidden: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  nextPlan?: string;
  shareCardPath?: string;
}

export interface ReadingNoteSummary extends ReadingNote {
  book?: Pick<ReadingBook, "id" | "title" | "author" | "coverUrl" | "localCoverPath" | "progressPercent">;
}

export interface ReadingAdvancedModelSettings {
  selectionModelRef?: string;
  seedModelRef?: string;
  deepModelRef?: string;
  companionModelRef?: string;
}

export interface ReadingWereadSettings {
  apiKeySet: boolean;
  accountName?: string;
  lastSyncAt?: number;
}

export interface ReadingSettings {
  version: 1;
  language: ReadingLanguage;
  cadence: ReadingCadence;
  quiet: boolean;
  maxDeepNotesPerWeek: number;
  textModelMode: ReadingModelMode;
  textModelRef?: string;
  imageModelRef?: string;
  advanced: ReadingAdvancedModelSettings;
  weread: ReadingWereadSettings;
  updatedAt: number;
}

export interface ReadingStats {
  readingCount: number;
  noteCount: number;
  finishedCount: number;
}

export interface ReadingWereadConnection {
  connected: boolean;
  accountName?: string;
  lastSyncAt?: number;
}

export interface ReadingActivity {
  currentBook?: Pick<ReadingBook, "id" | "title" | "author" | "coverUrl" | "localCoverPath" | "track" | "status" | "progressPercent">;
  latestNote?: Pick<ReadingNoteSummary, "id" | "bookId" | "title" | "summary" | "createdAt" | "nextPlan"> & {
    bookTitle?: string;
  };
  currentThought?: string;
  nextPlan?: string;
}

export interface ReadingLibrarySnapshot {
  books: ReadingBook[];
  notes: ReadingNoteSummary[];
  stats: ReadingStats;
  activity: ReadingActivity;
  settings: ReadingSettings;
  wereadConnection: ReadingWereadConnection;
}

export interface ReadingListNotesInput {
  bookId?: string;
  includeHidden?: boolean;
  includeDeleted?: boolean;
  limit?: number;
}

export interface ReadingUpdateSettingsInput {
  cadence?: ReadingCadence;
  quiet?: boolean;
  maxDeepNotesPerWeek?: number;
  textModelMode?: ReadingModelMode;
  textModelRef?: string | null;
  imageModelRef?: string | null;
  advanced?: Partial<ReadingAdvancedModelSettings>;
}

export interface ReadingAddBookInput {
  title: string;
  author?: string;
  track?: ReadingBookTrack;
  status?: ReadingBookStatus;
  source?: Partial<ReadingSourceRef>;
  coverUrl?: string;
  progressPercent?: number;
  lastReadAt?: number;
  tags?: string[];
}

export interface ReadingNoteInput {
  bookId: string;
  title?: string;
  depth?: ReadingNoteDepth;
  noteKind?: ReadingNoteKind;
  chapterTitle?: string;
  summary?: string;
  body: string;
  originalQuote?: string;
  excerpt?: string;
  progressPercent?: number;
  tags?: string[];
  evidence?: ReadingQuoteEvidence[];
  mood?: string;
  userContext?: string;
  selfContext?: string;
  rating?: number;
  cost?: number;
  modelUsage?: ReadingModelUsage;
  nextPlan?: string;
}

export interface ReadingNoteRevisionInput {
  id: string;
  body: string;
  summary?: string;
  editReason: string;
  modelRef?: string;
}

export interface ReadingUserHighlightContext {
  quote: string;
  note?: string;
  sourceId?: string;
  chapterTitle?: string;
}

export interface ReadingUserReadingContext {
  userHighlights?: ReadingUserHighlightContext[];
  userThoughts?: string[];
  memorySnippets?: string[];
  recentConversationSnippets?: string[];
  recentReadingNoteSnippets?: string[];
  recentConversationSummary?: string;
  recentDiarySummary?: string;
}

export interface ReadingRunTaskInput {
  trigger?: ReadingRunTrigger;
  bookId?: string;
  depth?: ReadingNoteDepth;
  workspaceSlug?: string;
  userContext?: ReadingUserReadingContext;
  manualQuoteText?: string;
  manualSource?: string;
}

export interface ReadingTaskResult {
  status: ReadingTaskStatus;
  noteId?: string;
  bookId?: string;
  message: string;
  warnings?: string[];
  completedAt: number;
}

export interface ReadingNoteGenerationNotification extends ReadingTaskResult {
  bookTitle?: string;
  trigger?: ReadingRunTrigger;
  depth?: ReadingNoteDepth;
}

export interface ReadingConnectWereadInput {
  apiKey: string;
  accountName?: string;
}

export const WEREAD_KEY_PAGE_URL = "https://weread.qq.com/r/weread-skills";

export type WereadOpenAndFetchKeyFailureReason =
  | "awaiting_copy"
  | "clipboard_unavailable"
  | "clipboard_empty"
  | "invalid_clipboard"
  | "open_failed"
  | "desktop_required"
  | "timeout";

export type WereadOpenAndFetchKeyResult =
  | {
      ok: true;
      key: string;
      url: string;
    }
  | {
      ok: false;
      reason: WereadOpenAndFetchKeyFailureReason;
      url: string;
      message?: string;
    };

export interface WereadTestKeyResult {
  ok: boolean;
  total?: number;
  bookCount?: number;
  albumCount?: number;
  error?: string;
}

export interface ReadingSearchBooksInput {
  query: string;
  limit?: number;
}

export interface ReadingSearchResult {
  source: ReadingSourceKind;
  externalId?: string;
  title: string;
  author?: string;
  coverUrl?: string;
  url?: string;
  summary?: string;
  rating?: number;
  ratingCount?: number;
  readingCount?: number;
}

export interface ReadingGenerateShareCardInput {
  noteId: string;
  theme?: "light" | "dark";
  outputPath?: string;
}

export interface ReadingShareCardResult {
  noteId: string;
  path: string;
  createdAt: number;
}

export interface WereadExportProgress {
  status: "started" | "completed" | "failed";
  total: number;
  exported: number;
  path?: string;
  message?: string;
  updatedAt: number;
}

export const READING_IPC_CHANNELS = {
  GET_SNAPSHOT: "reading:get-snapshot",
  UPDATE_SETTINGS: "reading:update-settings",
  ADD_BOOK: "reading:add-book",
  MANUAL_GENERATE_NOTE: "reading:manual-generate-note",
  CONNECT_WEREAD: "reading:connect-weread",
  SEARCH_BOOKS: "reading:search-books",
  NOTE_GEN_DONE: "reading:noteGenDone",
  NOTE_GEN_FAILED: "reading:noteGenFailed"
} as const;

export const WEREAD_IPC_CHANNELS = {
  GET_KEY: "weread:getKey",
  TEST_KEY: "weread:testKey",
  GET_SHELF: "weread:getShelf",
  GET_NOTEBOOKS: "weread:getNotebooks",
  GET_BOOKMARKS: "weread:getBookmarks",
  GET_REVIEWS: "weread:getReviews",
  GET_READ_DATA: "weread:getReadData",
  GET_BEST_BOOKMARKS: "weread:getBestBookmarks",
  GET_PUBLIC_REVIEWS: "weread:getPublicReviews"
} as const;

const SOURCE_KINDS = new Set<ReadingSourceKind>(["weread", "manual", "generated"]);
const BOOK_TRACKS = new Set<ReadingBookTrack>(["lume", "co_read", "recommended"]);
const BOOK_STATUSES = new Set<ReadingBookStatus>(["queued", "reading", "finished", "paused"]);
const CADENCES = new Set<ReadingCadence>(["off", "weekly", "few_times_weekly", "manual"]);

export function createDefaultReadingSettings(now = Date.now()): ReadingSettings {
  return {
    version: 1,
    language: "zh",
    cadence: "weekly",
    quiet: true,
    maxDeepNotesPerWeek: 1,
    textModelMode: "inherit",
    advanced: {},
    weread: {
      apiKeySet: false
    },
    updatedAt: now
  };
}

export function normalizeReadingSettings(input?: Partial<ReadingSettings> | null): ReadingSettings {
  const base = createDefaultReadingSettings(isNumber(input?.updatedAt) ? input.updatedAt : Date.now());
  const advanced: Partial<ReadingAdvancedModelSettings> = input?.advanced ?? {};
  const weread: Partial<ReadingWereadSettings> = input?.weread ?? {};
  const textModelMode = input?.textModelMode === "explicit" ? "explicit" : "inherit";
  const textModelRef = normalizeOptionalString(input?.textModelRef);

  return {
    ...base,
    cadence: CADENCES.has(input?.cadence as ReadingCadence) ? input!.cadence! : base.cadence,
    quiet: typeof input?.quiet === "boolean" ? input.quiet : base.quiet,
    maxDeepNotesPerWeek: clampInteger(input?.maxDeepNotesPerWeek, 1, 4, base.maxDeepNotesPerWeek),
    textModelMode,
    ...(textModelMode === "explicit" && textModelRef ? { textModelRef } : {}),
    ...(normalizeOptionalString(input?.imageModelRef) ? { imageModelRef: normalizeOptionalString(input?.imageModelRef) } : {}),
    advanced: {
      ...(normalizeOptionalString(advanced.selectionModelRef) ? { selectionModelRef: normalizeOptionalString(advanced.selectionModelRef) } : {}),
      ...(normalizeOptionalString(advanced.seedModelRef) ? { seedModelRef: normalizeOptionalString(advanced.seedModelRef) } : {}),
      ...(normalizeOptionalString(advanced.deepModelRef) ? { deepModelRef: normalizeOptionalString(advanced.deepModelRef) } : {}),
      ...(normalizeOptionalString(advanced.companionModelRef) ? { companionModelRef: normalizeOptionalString(advanced.companionModelRef) } : {})
    },
    weread: {
      apiKeySet: typeof weread.apiKeySet === "boolean" ? weread.apiKeySet : base.weread.apiKeySet,
      ...(normalizeOptionalString(weread.accountName) ? { accountName: normalizeOptionalString(weread.accountName) } : {}),
      ...(isNumber(weread.lastSyncAt) ? { lastSyncAt: weread.lastSyncAt } : {})
    },
    updatedAt: isNumber(input?.updatedAt) ? input.updatedAt : base.updatedAt
  };
}

export function normalizeReadingBook(
  input: Partial<Omit<ReadingBook, "source">> & { title?: string; source?: Partial<ReadingSourceRef> | null }
): ReadingBook {
  const now = Date.now();
  return {
    id: normalizeOptionalString(input.id) ?? randomReadingId("book"),
    title: normalizeOptionalString(input.title) ?? "未命名书籍",
    ...(normalizeOptionalString(input.author) ? { author: normalizeOptionalString(input.author) } : {}),
    ...(normalizeOptionalString(input.coverUrl) ? { coverUrl: normalizeOptionalString(input.coverUrl) } : {}),
    ...(normalizeOptionalString(input.localCoverPath) ? { localCoverPath: normalizeOptionalString(input.localCoverPath) } : {}),
    track: BOOK_TRACKS.has(input.track as ReadingBookTrack) ? input.track! : "lume",
    status: BOOK_STATUSES.has(input.status as ReadingBookStatus) ? input.status! : "reading",
    source: normalizeReadingSourceRef(input.source),
    ...(isNumber(input.progressPercent) ? { progressPercent: clampNumber(input.progressPercent, 0, 100) } : {}),
    ...(isNumber(input.lastReadAt) ? { lastReadAt: input.lastReadAt } : {}),
    tags: normalizeStringList(input.tags),
    addedAt: isNumber(input.addedAt) ? input.addedAt : now,
    updatedAt: isNumber(input.updatedAt) ? input.updatedAt : now
  };
}

export function normalizeReadingSourceRef(input?: Partial<ReadingSourceRef> | null): ReadingSourceRef {
  const kind = SOURCE_KINDS.has(input?.kind as ReadingSourceKind) ? input!.kind! : "manual";
  return {
    kind,
    ...(normalizeOptionalString(input?.externalId) ? { externalId: normalizeOptionalString(input?.externalId) } : {}),
    ...(normalizeOptionalString(input?.url) ? { url: normalizeOptionalString(input?.url) } : {}),
    ...(normalizeOptionalString(input?.title) ? { title: normalizeOptionalString(input?.title) } : {}),
    ...(normalizeOptionalString(input?.author) ? { author: normalizeOptionalString(input?.author) } : {}),
    ...(normalizeOptionalString(input?.location) ? { location: normalizeOptionalString(input?.location) } : {}),
    ...(normalizeOptionalString(input?.excerpt) ? { excerpt: normalizeOptionalString(input?.excerpt) } : {})
  };
}

export function normalizeStringList(input?: string[]): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((item) => item.trim()).filter(Boolean))];
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (!isNumber(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function randomReadingId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random}`;
}
