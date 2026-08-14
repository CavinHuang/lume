import { invoke } from '@/lib/desktop-runtime/core'
import {
  READING_IPC_CHANNELS,
  WEREAD_IPC_CHANNELS,
  WEREAD_KEY_PAGE_URL,
} from '@lume/shared'
import type {
  ReadingAddBookInput,
  ReadingBook,
  ReadingBookDebugInfo,
  ReadingConnectWereadInput,
  ReadingGenerateShareCardInput,
  ReadingLibrarySnapshot,
  ReadingListNotesInput,
  ReadingNote,
  ReadingNoteReactionResult,
  ReadingNoteRevisionInput,
  ReadingNoteSummary,
  ReadingRunTaskInput,
  ReadingSearchBooksInput,
  ReadingSearchResult,
  ReadingSearchWereadInput,
  ReadingSettings,
  ReadingShareCardResult,
  ReadingTaskResult,
  ReadingUnreadCounts,
  ReadingUpdateBookInput,
  ReadingUpdateSettingsInput,
  ReadingWereadConnection,
  WereadOpenAndFetchKeyResult,
  WereadTestKeyResult,
} from '@lume/shared'
import { sidecarCall } from './system'

const WEREAD_KEY_POLL_INTERVAL_MS = 1500
const WEREAD_KEY_TIMEOUT_MS = 75_000
const WEREAD_API_CACHE_TTL_MS = 5 * 60_000

const wereadApiCache = new Map<string, { expiresAt: number; promise: Promise<unknown> }>()

export interface ReadingGenerateCoverResult {
  ok: boolean
  bookId: string
  path: string
  createdAt: number
}

export interface ReadingRefreshQuotesResult {
  ok: boolean
  refreshed: number
  path: string
}

export const getReadingSnapshot = () =>
  sidecarCall<ReadingLibrarySnapshot>(READING_IPC_CHANNELS.GET_SNAPSHOT, {})

export const updateReadingSettings = (input: ReadingUpdateSettingsInput) =>
  sidecarCall<ReadingSettings>(READING_IPC_CHANNELS.UPDATE_SETTINGS, input)

export const listReadingBooks = () =>
  sidecarCall<ReadingBook[]>(READING_IPC_CHANNELS.LIST_BOOKS, {})

export const listReadingNotes = (input: ReadingListNotesInput = {}) =>
  sidecarCall<ReadingNoteSummary[]>(READING_IPC_CHANNELS.LIST_NOTES, input)

export const getReadingNote = (id: string) =>
  sidecarCall<ReadingNoteSummary | null>(READING_IPC_CHANNELS.GET_NOTE, { id })

export const addReadingBook = (input: ReadingAddBookInput) =>
  sidecarCall<ReadingBook>(READING_IPC_CHANNELS.ADD_BOOK, input)

export const addBookToAlice = (title: string, reason?: string) =>
  sidecarCall<ReadingBook>(READING_IPC_CHANNELS.ADD_BOOK_TO_ALICE, { title, reason })

export const updateReadingBook = (input: ReadingUpdateBookInput) =>
  sidecarCall<ReadingBook>(READING_IPC_CHANNELS.UPDATE_BOOK, input)

export const hideReadingNote = (id: string) =>
  sidecarCall<ReadingNoteSummary>(READING_IPC_CHANNELS.HIDE_NOTE, { id })

export const deleteReadingNote = (id: string) =>
  sidecarCall<ReadingNoteSummary>(READING_IPC_CHANNELS.DELETE_NOTE, { id })

export const markReadingSeen = (noteIds?: string[]) =>
  sidecarCall<{ ok: true }>(READING_IPC_CHANNELS.MARK_SEEN, noteIds ? { noteIds } : {})

export const getReadingUnreadCounts = () =>
  sidecarCall<ReadingUnreadCounts>(READING_IPC_CHANNELS.GET_UNREAD_COUNTS, {})

export const getReadingHighlights = () =>
  sidecarCall<ReadingNoteSummary[]>(READING_IPC_CHANNELS.GET_HIGHLIGHTS, {})

export const removeReadingHighlight = (id: string) =>
  sidecarCall<{ ok: true }>(READING_IPC_CHANNELS.REMOVE_HIGHLIGHT, { id })

export const getReadingBlurs = () =>
  sidecarCall<ReadingNoteSummary[]>(READING_IPC_CHANNELS.GET_BLURS, {})

export const addReadingBlur = (id: string) =>
  sidecarCall<ReadingNoteSummary>(READING_IPC_CHANNELS.ADD_BLUR, { id })

export const removeReadingBlur = (id: string) =>
  sidecarCall<{ ok: true }>(READING_IPC_CHANNELS.REMOVE_BLUR, { id })

export const reactPlusOneReadingNote = (id: string) =>
  sidecarCall<ReadingNoteReactionResult>(READING_IPC_CHANNELS.REACT_PLUS_ONE, { id })

export const runReadingTask = (input: ReadingRunTaskInput = {}) =>
  sidecarCall<ReadingTaskResult>(READING_IPC_CHANNELS.RUN_TASK, input)

export const forceGenerateReadingNote = (input: ReadingRunTaskInput = {}) =>
  sidecarCall<ReadingTaskResult>(READING_IPC_CHANNELS.FORCE_GENERATE_NOTE, input)

export const manualGenerateReadingNote = (input: ReadingRunTaskInput = {}) =>
  sidecarCall<ReadingTaskResult>(READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE, input)

export const reviseReadingNote = (input: ReadingNoteRevisionInput) =>
  sidecarCall<ReadingNote>(READING_IPC_CHANNELS.REVISE_NOTE, input)

export const connectReadingWeread = async (input: ReadingConnectWereadInput) => {
  const connection = await sidecarCall<ReadingWereadConnection>(READING_IPC_CHANNELS.CONNECT_WEREAD, input)
  clearWereadApiCache()
  return connection
}

export const disconnectReadingWeread = async () => {
  const connection = await sidecarCall<ReadingWereadConnection>(READING_IPC_CHANNELS.DISCONNECT_WEREAD, {})
  clearWereadApiCache()
  return connection
}

export const searchReadingWeread = (input: ReadingSearchWereadInput) =>
  sidecarCall<ReadingSearchResult[]>(READING_IPC_CHANNELS.SEARCH_WEREAD, input)

export const searchReadingBooks = (input: ReadingSearchBooksInput) =>
  sidecarCall<ReadingSearchResult[]>(READING_IPC_CHANNELS.SEARCH_BOOKS, input)

export const generateReadingShareCard = (input: ReadingGenerateShareCardInput) =>
  sidecarCall<ReadingShareCardResult>(READING_IPC_CHANNELS.GENERATE_SHARE_CARD, input)

export const generateReadingCover = (bookId: string) =>
  sidecarCall<ReadingGenerateCoverResult>(READING_IPC_CHANNELS.GENERATE_COVER, { bookId })

export const deleteReadingCover = (bookId: string) =>
  sidecarCall<ReadingBook>(READING_IPC_CHANNELS.DELETE_COVER, { bookId })

export const refreshReadingQuotes = (bookId: string) =>
  sidecarCall<ReadingRefreshQuotesResult>(READING_IPC_CHANNELS.REFRESH_QUOTES, { bookId })

export const getReadingBookDebugInfo = (bookId: string) =>
  sidecarCall<ReadingBookDebugInfo>(READING_IPC_CHANNELS.GET_BOOK_DEBUG_INFO, { bookId })

export async function readWereadKeyFromClipboard(): Promise<WereadOpenAndFetchKeyResult> {
  const desktopText = await readDesktopClipboardText()
  if (desktopText !== null) {
    return parseWereadClipboardText(desktopText)
  }

  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard?.readText) {
    return {
      ok: false,
      reason: 'clipboard_unavailable',
      url: WEREAD_KEY_PAGE_URL,
    }
  }

  let text = ''
  try {
    text = await clipboard.readText()
  } catch (error) {
    return {
      ok: false,
      reason: 'clipboard_unavailable',
      url: WEREAD_KEY_PAGE_URL,
      message: getErrorMessage(error),
    }
  }

  return parseWereadClipboardText(text)
}

export async function openAndFetchWereadKey(): Promise<WereadOpenAndFetchKeyResult> {
  try {
    await invoke('open_weread_key_webview', { url: WEREAD_KEY_PAGE_URL })
  } catch (error) {
    return {
      ok: false,
      reason: 'open_failed',
      url: WEREAD_KEY_PAGE_URL,
      message: getErrorMessage(error),
    }
  }

  const startedAt = Date.now()
  while (Date.now() - startedAt < WEREAD_KEY_TIMEOUT_MS) {
    const clipboardResult = await readWereadKeyFromClipboard()
    if (clipboardResult.ok || clipboardResult.reason === 'clipboard_unavailable') {
      return clipboardResult
    }
    await sleep(WEREAD_KEY_POLL_INTERVAL_MS)
  }

  return {
    ok: false,
    reason: 'timeout',
    url: WEREAD_KEY_PAGE_URL,
  }
}

export const getWereadApiKey = () =>
  sidecarCall<{ apiKey: string | null }>(WEREAD_IPC_CHANNELS.GET_KEY, {})

export const testWereadKey = (apiKey: string) =>
  sidecarCall<WereadTestKeyResult>(WEREAD_IPC_CHANNELS.TEST_KEY, { apiKey })

function parseWereadClipboardText(value: string): WereadOpenAndFetchKeyResult {
  const text = value.trim()
  if (!text) {
    return {
      ok: false,
      reason: 'clipboard_empty',
      url: WEREAD_KEY_PAGE_URL,
    }
  }

  if (!isWereadApiKey(text)) {
    return {
      ok: false,
      reason: 'invalid_clipboard',
      url: WEREAD_KEY_PAGE_URL,
    }
  }

  return {
    ok: true,
    key: text,
    url: WEREAD_KEY_PAGE_URL,
  }
}

async function readDesktopClipboardText(): Promise<string | null> {
  try {
    const text = await invoke<string>('read_clipboard_text')
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

export function clearWereadApiCache(): void {
  wereadApiCache.clear()
}

function cachedWereadCall<T>(key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now()
  const cached = wereadApiCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise as Promise<T>

  const promise = load().catch((error) => {
    if (wereadApiCache.get(key)?.promise === promise) wereadApiCache.delete(key)
    throw error
  })
  wereadApiCache.set(key, {
    expiresAt: now + WEREAD_API_CACHE_TTL_MS,
    promise,
  })
  return promise
}

export const getWereadShelf = () =>
  cachedWereadCall('shelf', () => sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_SHELF, {}))

export const getWereadNotebooks = () =>
  cachedWereadCall('notebooks', () => sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_NOTEBOOKS, {}))

export const getWereadBookmarks = (bookId: string) =>
  cachedWereadCall(`bookmarks:${bookId}`, () => sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_BOOKMARKS, { bookId }))

export const getWereadReviews = (bookId: string) =>
  cachedWereadCall(`reviews:${bookId}`, () => sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_REVIEWS, { bookId }))

export const getWereadReadData = (period?: string) =>
  cachedWereadCall(`readData:${period ?? 'default'}`, () => sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_READ_DATA, period ? { period } : {}))

export const getWereadBestBookmarks = (bookId: string, bookTitle?: string) =>
  cachedWereadCall(`bestBookmarks:${bookId}:${bookTitle ?? ''}`, () => sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_BEST_BOOKMARKS, { bookId, bookTitle }))

export const getWereadPublicReviews = (bookId: string, listType?: string, bookTitle?: string) =>
  cachedWereadCall(`publicReviews:${bookId}:${listType ?? ''}:${bookTitle ?? ''}`, () => sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_PUBLIC_REVIEWS, { bookId, listType, bookTitle }))

export const generateWereadNote = (input: {
  bookTitle: string
  text: string
  source?: string
  authorName?: string
}) => sidecarCall<ReadingTaskResult>(WEREAD_IPC_CHANNELS.GENERATE_NOTE, input)

export const exportAllWereadNotes = () =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.EXPORT_ALL_NOTES, {})

export const searchWereadBooks = (keyword: string, limit?: number) =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.SEARCH_BOOKS, { keyword, limit })

function isWereadApiKey(value: string): boolean {
  return /^(wrk-|wr_)[A-Za-z0-9_-]{8,}$/.test(value)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
