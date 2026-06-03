import { invoke } from '@tauri-apps/api/core'
import {
  ALICE_READING_IPC_CHANNELS,
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
} from '@lume/shared'
import { sidecarCall } from './system'

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

export const connectReadingWeread = (input: ReadingConnectWereadInput) =>
  sidecarCall<ReadingWereadConnection>(READING_IPC_CHANNELS.CONNECT_WEREAD, input)

export const disconnectReadingWeread = () =>
  sidecarCall<ReadingWereadConnection>(READING_IPC_CHANNELS.DISCONNECT_WEREAD, {})

export const searchReadingWeread = (input: ReadingSearchWereadInput) =>
  sidecarCall<ReadingSearchResult[]>(READING_IPC_CHANNELS.SEARCH_WEREAD, input)

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

export const readingGetBooks = () =>
  sidecarCall<ReadingBook[]>(ALICE_READING_IPC_CHANNELS.GET_BOOKS, {})

export const readingGetNotes = (input: ReadingListNotesInput = {}) =>
  sidecarCall<ReadingNoteSummary[]>(ALICE_READING_IPC_CHANNELS.GET_NOTES, input)

export const readingGetNote = (noteId: string) =>
  sidecarCall<ReadingNoteSummary | null>(ALICE_READING_IPC_CHANNELS.GET_NOTE, { noteId })

export const readingGetStats = () =>
  sidecarCall<ReadingLibrarySnapshot['stats']>(ALICE_READING_IPC_CHANNELS.GET_STATS, {})

export const readingForceGenerateNote = (interestId?: string) =>
  sidecarCall<ReadingTaskResult>(ALICE_READING_IPC_CHANNELS.FORCE_GENERATE_NOTE, interestId ? { interestId } : {})

export const readingManualGenerateNote = (input: ReadingRunTaskInput = {}) =>
  sidecarCall<ReadingTaskResult>(ALICE_READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE, input)

export const readingDeleteNote = (noteId: string) =>
  sidecarCall<ReadingNoteSummary>(ALICE_READING_IPC_CHANNELS.DELETE_NOTE, { noteId })

export const readingGenerateCover = (interestId: string) =>
  sidecarCall<ReadingGenerateCoverResult>(ALICE_READING_IPC_CHANNELS.GENERATE_COVER, { interestId })

export const readingDeleteCover = (interestId: string) =>
  sidecarCall<ReadingBook>(ALICE_READING_IPC_CHANNELS.DELETE_COVER, { interestId })

export const readingRefreshQuotes = (interestId: string) =>
  sidecarCall<ReadingRefreshQuotesResult>(ALICE_READING_IPC_CHANNELS.REFRESH_QUOTES, { interestId })

export const readingGetUnreadCounts = () =>
  sidecarCall<ReadingUnreadCounts>(ALICE_READING_IPC_CHANNELS.GET_UNREAD_COUNTS, {})

export const readingMarkNotesRead = (noteIds?: string[]) =>
  sidecarCall<{ ok: true }>(ALICE_READING_IPC_CHANNELS.MARK_NOTES_READ, noteIds ?? {})

export const readingGetHighlights = (noteIds?: string[]) =>
  sidecarCall<ReadingNoteSummary[]>(ALICE_READING_IPC_CHANNELS.GET_HIGHLIGHTS, noteIds ? { noteIds } : {})

export const readingRemoveHighlight = (noteId: string) =>
  sidecarCall<{ ok: true }>(ALICE_READING_IPC_CHANNELS.REMOVE_HIGHLIGHT, { noteId })

export const readingGetBlurs = (noteIds?: string[]) =>
  sidecarCall<ReadingNoteSummary[]>(ALICE_READING_IPC_CHANNELS.GET_BLURS, noteIds ? { noteIds } : {})

export const readingAddBlur = (noteId: string) =>
  sidecarCall<ReadingNoteSummary>(ALICE_READING_IPC_CHANNELS.ADD_BLUR, { noteId })

export const readingRemoveBlur = (noteId: string) =>
  sidecarCall<{ ok: true }>(ALICE_READING_IPC_CHANNELS.REMOVE_BLUR, { noteId })

export const readingReactPlusOne = (noteId: string) =>
  sidecarCall<ReadingNoteReactionResult>(ALICE_READING_IPC_CHANNELS.REACT_PLUS_ONE, { noteId })

export const readingGetBookDebugInfo = (interestId: string, wereadBookId?: string) =>
  sidecarCall<ReadingBookDebugInfo>(ALICE_READING_IPC_CHANNELS.GET_BOOK_DEBUG_INFO, { interestId, wereadBookId })

export async function readWereadKeyFromClipboard(): Promise<WereadOpenAndFetchKeyResult> {
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
    text = (await clipboard.readText()).trim()
  } catch (error) {
    return {
      ok: false,
      reason: 'clipboard_unavailable',
      url: WEREAD_KEY_PAGE_URL,
      message: getErrorMessage(error),
    }
  }

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

export async function openAndFetchWereadKey(): Promise<WereadOpenAndFetchKeyResult> {
  try {
    await invoke('open_external', { url: WEREAD_KEY_PAGE_URL })
  } catch (error) {
    return {
      ok: false,
      reason: 'open_failed',
      url: WEREAD_KEY_PAGE_URL,
      message: getErrorMessage(error),
    }
  }

  const clipboardResult = await readWereadKeyFromClipboard()
  if (clipboardResult.ok || clipboardResult.reason === 'clipboard_unavailable') {
    return clipboardResult
  }

  return {
    ok: false,
    reason: 'awaiting_copy',
    url: WEREAD_KEY_PAGE_URL,
  }
}

export const testWereadKey = (apiKey: string) =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.TEST_KEY, { apiKey })

export const getWereadShelf = () =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_SHELF, {})

export const getWereadNotebooks = () =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_NOTEBOOKS, {})

export const getWereadBookmarks = (bookId: string) =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_BOOKMARKS, { bookId })

export const getWereadReadData = (period?: string) =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_READ_DATA, period ? { period } : {})

export const getWereadBestBookmarks = (bookId: string, bookTitle?: string) =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_BEST_BOOKMARKS, { bookId, bookTitle })

export const getWereadPublicReviews = (bookId: string, listType?: string, bookTitle?: string) =>
  sidecarCall<unknown>(WEREAD_IPC_CHANNELS.GET_PUBLIC_REVIEWS, { bookId, listType, bookTitle })

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
  return value.startsWith('wr_') && value.length > 10
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
