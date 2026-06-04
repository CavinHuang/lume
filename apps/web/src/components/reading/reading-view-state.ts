import type { ReadingAddBookInput, ReadingBook, ReadingLibrarySnapshot, ReadingSearchResult } from '@lume/shared'

export type ReadingRailItemKind = 'all' | 'book' | 'poetry'

export interface ReadingRailItem {
  id: string
  kind: ReadingRailItemKind
  title: string
  subtitle?: string
  coverUrl?: string
  progressLabel?: string
  count?: number
}

export interface ReadingBookRail {
  items: ReadingRailItem[]
  showWereadPrompt: boolean
}

export interface ReadingOverviewStats {
  readingCount: number
  noteCount: number
  finishedCount: number
}

export interface ReadingNoteNavigation {
  topId: string | null
  previousId: string | null
  nextId: string | null
  bottomId: string | null
}

export interface ReadingSearchItem {
  id: string
  title: string
  author?: string
  summary?: string
  coverUrl?: string
  alreadyAdded: boolean
  addBookInput: ReadingAddBookInput
}

export interface ReadingWereadConnectionPrompt {
  title: string
  body: string
  actionLabel: string
}

export interface WereadNotebookBook {
  id: string
  bookId: string
  title: string
  author?: string
  coverUrl?: string
  noteCount: number
  highlightCount: number
  thoughtCount: number
  bookmarkCount: number
  progressPercent?: number
  progressLabel?: string
  lastReadAt?: number
  status: 'reading' | 'finished'
  sort?: number
  localBookId?: string
  localNoteCount: number
}

export interface WereadNotebookView {
  books: WereadNotebookBook[]
  summary: {
    localNoteCount: number
    highlightCount: number
    thoughtCount: number
    readingCount: number
    finishedCount: number
  }
}

export interface WereadTextItem {
  id: string
  text: string
  chapterTitle?: string
  createdAt?: number
  totalCount?: number
  authorName?: string
}

export type WereadRailGroupKey = 'reading' | 'finished'

export type WereadRailGroupState = Record<WereadRailGroupKey, boolean>

export type WereadReadingTab = 'mine' | 'popular' | 'notes'

export function createDefaultWereadRailGroupState(): WereadRailGroupState {
  return {
    reading: true,
    finished: true,
  }
}

export function toggleWereadRailGroup(state: WereadRailGroupState, key: WereadRailGroupKey): WereadRailGroupState {
  return {
    ...state,
    [key]: !state[key],
  }
}

export function getWereadTabForSelection(
  currentTab: WereadReadingTab,
  currentSelectedId: string,
  nextSelectedId: string,
): WereadReadingTab {
  if (nextSelectedId.startsWith('weread:') && nextSelectedId !== currentSelectedId) return 'mine'
  return currentTab
}

export function buildReadingBookRail(
  snapshot: ReadingLibrarySnapshot,
  wereadSummary?: Pick<WereadNotebookView['summary'], 'highlightCount'>,
): ReadingBookRail {
  const wereadHighlightCount = wereadSummary?.highlightCount ?? 0
  const poetryItem: ReadingRailItem = {
    id: '__poetry__',
    kind: 'poetry',
    title: '诗词札记',
    subtitle: '公共诗词',
  }
  const noteCountsByBookId = new Map<string, number>()
  for (const note of snapshot.notes) {
    noteCountsByBookId.set(note.bookId, (noteCountsByBookId.get(note.bookId) ?? 0) + 1)
  }
  const currentBookId = snapshot.activity.currentBook?.id
  const localBooks = snapshot.books.filter((book) =>
    book.source.kind !== 'weread'
    || book.id === currentBookId
    || (noteCountsByBookId.get(book.id) ?? 0) > 0
  )
  const items: ReadingRailItem[] = [
    {
      id: '__all__',
      kind: 'all',
      title: '全部笔记',
      subtitle: wereadHighlightCount > 0
        ? `${snapshot.stats.noteCount} 篇笔记 + ${wereadHighlightCount} 条划线`
      : `${snapshot.stats.noteCount} 篇笔记`,
      count: snapshot.stats.noteCount,
    },
    ...localBooks.map((book) => bookToRailItem(book, noteCountsByBookId.get(book.id) ?? 0)),
    ...(hasPoetryNotes(snapshot) ? [poetryItem] : []),
  ]

  return {
    items,
    showWereadPrompt: !snapshot.wereadConnection.connected,
  }
}

export function buildReadingOverviewStats(snapshot: ReadingLibrarySnapshot): ReadingOverviewStats {
  const localBookIds = new Set(snapshot.books
    .filter((book) =>
      book.source.kind !== 'weread'
      || book.id === snapshot.activity.currentBook?.id
      || snapshot.notes.some((note) => note.bookId === book.id)
    )
    .map((book) => book.id))
  const localBooks = snapshot.books.filter((book) => localBookIds.has(book.id))
  return {
    readingCount: localBooks.filter((book) => book.status === 'reading').length,
    noteCount: snapshot.stats.noteCount,
    finishedCount: localBooks.filter((book) => book.status === 'finished').length,
  }
}

export function buildReadingNoteNavigation(noteIds: string[], activeId: string | null): ReadingNoteNavigation {
  if (noteIds.length === 0) {
    return {
      topId: null,
      previousId: null,
      nextId: null,
      bottomId: null,
    }
  }
  const activeIndex = Math.max(0, activeId ? noteIds.indexOf(activeId) : 0)
  return {
    topId: noteIds[0] ?? null,
    previousId: noteIds[Math.max(0, activeIndex - 1)] ?? null,
    nextId: noteIds[Math.min(noteIds.length - 1, activeIndex + 1)] ?? null,
    bottomId: noteIds[noteIds.length - 1] ?? null,
  }
}

export function extendReadingHoverNavUntil(now: number): number {
  return now + 3000
}

export function shouldShowReadingHoverNav(now: number, visibleUntil: number): boolean {
  return visibleUntil > now
}

export function formatReadingProgress(progressPercent: number | undefined): string {
  return typeof progressPercent === 'number' ? `${Math.round(progressPercent)}%` : '在读'
}

export function formatWereadNotebookBadgeLabel(noteCount: number): string | null {
  return noteCount > 0 ? `${noteCount}条笔记` : null
}

export function shouldStartReadingRun(running: boolean, inFlight: boolean): boolean {
  return !running && !inFlight
}

export function buildReadingWereadConnectionPrompt(snapshot: ReadingLibrarySnapshot): ReadingWereadConnectionPrompt | null {
  if (snapshot.wereadConnection.connected) return null
  return {
    title: '连接微信读书',
    body: '看到你的书架和划线，一起聊书',
    actionLabel: '去设置',
  }
}

export function buildReadingSearchItems(results: ReadingSearchResult[], existingBooks: ReadingBook[]): ReadingSearchItem[] {
  const existingKeys = new Set(existingBooks.flatMap((book) => [
    book.source.externalId ? `${book.source.kind}:${book.source.externalId}` : '',
    normalizeBookKey(book.title, book.author),
  ]).filter(Boolean))

  return results
    .filter((result) => result.title.trim())
    .map((result) => {
      const sourceKey = result.externalId ? `${result.source}:${result.externalId}` : ''
      const titleKey = normalizeBookKey(result.title, result.author)
      return {
        id: sourceKey || `${result.source}:${titleKey}`,
        title: result.title,
        ...(result.author ? { author: result.author } : {}),
        ...(result.summary ? { summary: result.summary } : {}),
        ...(result.coverUrl ? { coverUrl: result.coverUrl } : {}),
        alreadyAdded: Boolean((sourceKey && existingKeys.has(sourceKey)) || existingKeys.has(titleKey)),
        addBookInput: {
          title: result.title,
          ...(result.author ? { author: result.author } : {}),
          track: result.source === 'weread' ? 'co_read' : 'lume',
          status: 'reading',
          ...(result.coverUrl ? { coverUrl: result.coverUrl } : {}),
          source: {
            kind: result.source,
            ...(result.externalId ? { externalId: result.externalId } : {}),
            ...(result.url ? { url: result.url } : {}),
            title: result.title,
            ...(result.author ? { author: result.author } : {}),
            ...(result.summary ? { excerpt: result.summary } : {}),
          },
        },
      }
    })
}

export function buildWereadNotebookView(input: {
  shelf?: unknown
  notebooks: unknown
  snapshot: ReadingLibrarySnapshot
}): WereadNotebookView {
  const localByWereadId = new Map(input.snapshot.books
    .filter((book) => book.source.kind === 'weread' && book.source.externalId)
    .map((book) => [book.source.externalId as string, book]))
  const notesByWereadId = new Map<string, number>()
  for (const note of input.snapshot.notes) {
    const wereadIds = new Set<string>()
    if (note.book?.id) {
      const book = input.snapshot.books.find((candidate) => candidate.id === note.book?.id)
      if (book?.source.kind === 'weread' && book.source.externalId) wereadIds.add(book.source.externalId)
    }
    if (note.bookId) {
      const book = input.snapshot.books.find((candidate) => candidate.id === note.bookId)
      if (book?.source.kind === 'weread' && book.source.externalId) wereadIds.add(book.source.externalId)
    }
    for (const evidence of note.evidence) {
      if (evidence.sourceKind === 'weread' && evidence.sourceId) wereadIds.add(evidence.sourceId)
    }
    for (const id of wereadIds) {
      notesByWereadId.set(id, (notesByWereadId.get(id) ?? 0) + 1)
    }
  }

  const notebookRows = extractArrayAny(input.notebooks, ['notebooks', 'books']).filter(isRecord)
  const notebookCountsByBookId = new Map<string, WereadNotebookCounts>()
  for (const raw of notebookRows) {
    const counts = readWereadNotebookCounts(raw)
    if (counts) notebookCountsByBookId.set(counts.bookId, counts)
  }
  const shelfRows = extractArrayAny(input.shelf, ['books']).filter(isRecord)
  const sourceRows = shelfRows.length > 0 ? shelfRows : notebookRows

  const books = sourceRows
    .filter(isRecord)
    .map((raw, index) => notebookToBook(
      raw,
      index,
      localByWereadId,
      notesByWereadId,
      notebookCountsByBookId,
      shelfRows.length === 0,
    ))
    .filter((book): book is WereadNotebookBook => Boolean(book))
    .sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0))

  return {
    books,
    summary: {
      localNoteCount: input.snapshot.notes.length,
      highlightCount: books.reduce((total, book) => total + book.highlightCount + book.bookmarkCount, 0),
      thoughtCount: books.reduce((total, book) => total + book.thoughtCount, 0),
      readingCount: books.filter((book) => book.status === 'reading').length,
      finishedCount: books.filter((book) => book.status === 'finished').length,
    },
  }
}

interface WereadNotebookCounts {
  bookId: string
  highlightCount: number
  thoughtCount: number
  bookmarkCount: number
  progressPercent?: number
  lastReadAt?: number
  sort?: number
}

export function normalizeWereadBookmarks(payload: unknown): WereadTextItem[] {
  const chapterTitles = readWereadChapterTitles(payload)
  return extractWereadBookmarkItems(payload)
    .filter(isRecord)
    .map((item, index) => {
      const text = readString(item.markText) ?? readString(item.text) ?? readString(item.content)
      if (!text) return null
      const chapterTitle = readString(item.chapterName)
        ?? readString(item.chapterTitle)
        ?? chapterTitles.get(String(readNumber(item.chapterUid) ?? readString(item.chapterUid) ?? ''))
      return {
        id: readString(item.bookmarkId) ?? readString(item.id) ?? `bookmark-${index}`,
        text,
        ...(chapterTitle ? { chapterTitle } : {}),
        ...(readNumber(item.createTime) ? { createdAt: readNumber(item.createTime) } : {}),
        ...(readNumber(item.totalCount) ?? readNumber(item.count) ? { totalCount: readNumber(item.totalCount) ?? readNumber(item.count) } : {}),
      }
    })
    .filter((item): item is WereadTextItem => Boolean(item))
}

export function normalizeWereadReviews(payload: unknown): WereadTextItem[] {
  return extractArrayAny(payload, ['reviews', 'items'])
    .filter(isRecord)
    .map((item, index) => {
      const review = isRecord(item.review) ? item.review : item
      const nestedReview = isRecord(review.review) ? review.review : review
      const text = readString(item.content)
        ?? readString(review.content)
        ?? readString(nestedReview.content)
        ?? readString(nestedReview.htmlContent)
        ?? readString(item.abstract)
      if (!text) return null
      return {
        id: readString(item.reviewId) ?? readString(review.reviewId) ?? readString(nestedReview.reviewId) ?? readString(item.id) ?? `review-${index}`,
        text,
        ...(readString(item.chapterName) ?? readString(review.chapterName) ?? readString(nestedReview.chapterName) ? {
          chapterTitle: readString(item.chapterName) ?? readString(review.chapterName) ?? readString(nestedReview.chapterName)
        } : {}),
        ...(readNumber(item.createTime) ?? readNumber(review.createTime) ?? readNumber(nestedReview.createTime) ? {
          createdAt: readNumber(item.createTime) ?? readNumber(review.createTime) ?? readNumber(nestedReview.createTime)
        } : {}),
        ...(readNumber(item.likeCount) ?? readNumber(item.totalCount) ? { totalCount: readNumber(item.likeCount) ?? readNumber(item.totalCount) } : {}),
        ...(readString(item.authorName) ?? readString(item.nickName) ?? readAuthorName(nestedReview.author) ? {
          authorName: readString(item.authorName) ?? readString(item.nickName) ?? readAuthorName(nestedReview.author)
        } : {}),
      }
    })
    .filter((item): item is WereadTextItem => Boolean(item))
}

function bookToRailItem(book: ReadingBook, noteCount: number): ReadingRailItem {
  return {
    id: book.id,
    kind: 'book',
    title: book.title,
    subtitle: noteCount > 0 ? `${noteCount}篇笔记` : book.author,
    coverUrl: book.localCoverPath ?? book.coverUrl,
    progressLabel: formatReadingProgress(book.progressPercent),
    ...(noteCount > 0 ? { count: noteCount } : {}),
  }
}

function notebookToBook(
  raw: Record<string, unknown>,
  index: number,
  localByWereadId: Map<string, ReadingBook>,
  notesByWereadId: Map<string, number>,
  notebookCountsByBookId: Map<string, WereadNotebookCounts>,
  useNotebookSort: boolean,
): WereadNotebookBook | null {
  const bookInfo = isRecord(raw.bookInfo) ? raw.bookInfo : isRecord(raw.book) ? raw.book : raw
  const source = isRecord(bookInfo.source) ? bookInfo.source : isRecord(raw.source) ? raw.source : undefined
  const bookId = readString(raw.bookId) ?? readString(bookInfo.bookId) ?? readString(bookInfo.id) ?? readString(source?.externalId)
  const title = readString(bookInfo.title) ?? readString(raw.title) ?? readString(source?.title)
  if (!bookId || !title) return null
  const notebookCounts = notebookCountsByBookId.get(bookId)
  const highlightCount = notebookCounts?.highlightCount ?? readNumber(raw.noteCount) ?? readNumber(raw.highlightCount) ?? 0
  const thoughtCount = notebookCounts?.thoughtCount ?? readNumber(raw.reviewCount) ?? 0
  const bookmarkCount = notebookCounts?.bookmarkCount ?? readNumber(raw.bookmarkCount) ?? 0
  const progressPercent = readProgressPercent(raw, bookInfo, source) ?? notebookCounts?.progressPercent
  const lastReadAt = readWereadTimestamp(raw, bookInfo, source) ?? notebookCounts?.lastReadAt
  const localBook = localByWereadId.get(bookId)
  const localNoteCount = notesByWereadId.get(bookId) ?? 0
  const status = readWereadBookStatus(raw, bookInfo, progressPercent)
  const sort = lastReadAt
    ?? readNumber(raw.sort)
    ?? (useNotebookSort ? notebookCounts?.sort : undefined)
    ?? readWereadTimestamp(raw)
    ?? (Number.MAX_SAFE_INTEGER - index)
  return {
    id: `weread:${bookId}`,
    bookId,
    title,
    ...(readString(bookInfo.author) ?? readString(raw.author) ?? readString(source?.author) ? {
      author: readString(bookInfo.author) ?? readString(raw.author) ?? readString(source?.author)
    } : {}),
    ...(readString(bookInfo.cover) ?? readString(bookInfo.coverUrl) ?? readString(raw.cover) ?? readString(raw.coverUrl) ? {
      coverUrl: readString(bookInfo.cover) ?? readString(bookInfo.coverUrl) ?? readString(raw.cover) ?? readString(raw.coverUrl)
    } : {}),
    noteCount: highlightCount + thoughtCount + bookmarkCount,
    highlightCount,
    thoughtCount,
    bookmarkCount,
    ...(typeof progressPercent === 'number' ? { progressPercent, progressLabel: `${Math.round(progressPercent)}%` } : {}),
    ...(typeof lastReadAt === 'number' ? { lastReadAt } : {}),
    status,
    sort,
    ...(localBook ? { localBookId: localBook.id } : {}),
    localNoteCount,
  }
}

function readWereadNotebookCounts(raw: Record<string, unknown>): WereadNotebookCounts | null {
  const bookInfo = isRecord(raw.bookInfo) ? raw.bookInfo : isRecord(raw.book) ? raw.book : raw
  const source = isRecord(bookInfo.source) ? bookInfo.source : isRecord(raw.source) ? raw.source : undefined
  const bookId = readString(raw.bookId) ?? readString(bookInfo.bookId) ?? readString(bookInfo.id) ?? readString(source?.externalId)
  if (!bookId) return null
  const progressPercent = readProgressPercent(raw, bookInfo, source)
  const lastReadAt = readWereadTimestamp(raw, bookInfo, source)
  return {
    bookId,
    highlightCount: readNumber(raw.noteCount) ?? readNumber(raw.highlightCount) ?? 0,
    thoughtCount: readNumber(raw.reviewCount) ?? 0,
    bookmarkCount: readNumber(raw.bookmarkCount) ?? 0,
    ...(typeof progressPercent === 'number' ? { progressPercent } : {}),
    ...(typeof lastReadAt === 'number' ? { lastReadAt } : {}),
    ...(readNumber(raw.sort) ?? readNumber(raw.updateTime) ? { sort: readNumber(raw.sort) ?? readNumber(raw.updateTime) } : {}),
  }
}

function readProgressPercent(...records: Array<Record<string, unknown> | undefined>): number | undefined {
  for (const record of records) {
    if (!record) continue
    const nestedValue = readNestedProgressPercent(record)
    if (typeof nestedValue === 'number') return nestedValue
    const value = readNumber(record.readingProgress)
      ?? readNumber(record.progressPercent)
      ?? readNumber(record.progress)
      ?? readNumber(record.readProgress)
    if (typeof value === 'number') return value > 0 && value < 1 ? value * 100 : value
  }
  return undefined
}

function readWereadTimestamp(...records: Array<Record<string, unknown> | undefined>): number | undefined {
  for (const record of records) {
    if (!record) continue
    const nestedValue = readNestedWereadTimestamp(record)
    if (typeof nestedValue === 'number') return nestedValue
    const value = readNumber(record.lastReadAt)
      ?? readNumber(record.readUpdateTime)
      ?? readNumber(record.lectureReadUpdateTime)
      ?? readNumber(record.lastReadTime)
      ?? readNumber(record.readAt)
      ?? readNumber(record.readTime)
      ?? readNumber(record.readingTime)
      ?? readNumber(record.updateTime)
      ?? readNumber(record.updatedAt)
      ?? readNumber(record.finishedDate)
    if (typeof value === 'number' && value > 0) return normalizeWereadTimestamp(value)
  }
  return undefined
}

function readNestedProgressPercent(record: Record<string, unknown>): number | undefined {
  for (const key of ['readInfo', 'progressInfo']) {
    const nested = record[key]
    if (!isRecord(nested)) continue
    const value = readNumber(nested.readingProgress)
      ?? readNumber(nested.progressPercent)
      ?? readNumber(nested.progress)
      ?? readNumber(nested.readProgress)
    if (typeof value === 'number') return value > 0 && value < 1 ? value * 100 : value
  }
  return undefined
}

function readNestedWereadTimestamp(record: Record<string, unknown>): number | undefined {
  for (const key of ['readInfo', 'progressInfo']) {
    const nested = record[key]
    if (!isRecord(nested)) continue
    const value = readNumber(nested.lastReadAt)
      ?? readNumber(nested.readUpdateTime)
      ?? readNumber(nested.lectureReadUpdateTime)
      ?? readNumber(nested.lastReadTime)
      ?? readNumber(nested.readAt)
      ?? readNumber(nested.readTime)
      ?? readNumber(nested.readingTime)
      ?? readNumber(nested.updateTime)
      ?? readNumber(nested.updatedAt)
      ?? readNumber(nested.finishedDate)
    if (typeof value === 'number' && value > 0) return normalizeWereadTimestamp(value)
  }
  return undefined
}

function normalizeWereadTimestamp(value: number): number {
  return value < 100_000_000_000 ? value * 1000 : value
}

function readWereadBookStatus(
  raw: Record<string, unknown>,
  bookInfo: Record<string, unknown>,
  progressPercent?: number,
): 'reading' | 'finished' {
  if (progressPercent !== undefined && progressPercent >= 100) return 'finished'
  if (hasFinishedDate(raw) || hasFinishedDate(bookInfo)) return 'finished'
  const finishSignals = [
    raw.finishReading,
    raw.finished,
    raw.isFinished,
    raw.readFinished,
    bookInfo.finishReading,
    bookInfo.finished,
    bookInfo.isFinished,
    bookInfo.readFinished,
  ]
  if (finishSignals.some(isTruthyStatus)) return 'finished'

  const textStatus = [
    raw.status,
    raw.readingStatus,
    raw.bookStatus,
    bookInfo.status,
    bookInfo.readingStatus,
    bookInfo.bookStatus,
  ].map(readString).find(Boolean)
  if (textStatus) {
    const normalized = textStatus.toLowerCase()
    if (normalized.includes('finish') || normalized.includes('done') || normalized.includes('complete') || normalized.includes('已读')) {
      return 'finished'
    }
  }

  return readNumber(raw.markedStatus) === 1 || readNumber(bookInfo.markedStatus) === 1 ? 'finished' : 'reading'
}

function hasFinishedDate(record: Record<string, unknown>): boolean {
  const direct = readNumber(record.finishedDate)
  if (typeof direct === 'number' && direct > 0) return true
  for (const key of ['readInfo', 'progressInfo']) {
    const nested = record[key]
    if (!isRecord(nested)) continue
    const value = readNumber(nested.finishedDate)
    if (typeof value === 'number' && value > 0) return true
  }
  return false
}

function isTruthyStatus(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'finished' || value === 'done'
}

function extractArrayAny(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload
  if (!isRecord(payload)) return []
  for (const key of keys) {
    const value = payload[key]
    if (Array.isArray(value)) return value
    if (isRecord(payload.data) && Array.isArray(payload.data[key])) return payload.data[key]
  }
  return []
}

function extractWereadBookmarkItems(payload: unknown): unknown[] {
  if (!isRecord(payload)) return extractArrayAny(payload, ['bookmarks', 'updated', 'items'])
  const chapterTitles = readWereadChapterTitles(payload)
  const chapterGroups = extractArrayAny(payload, ['chapters']).filter(isRecord)
  const groupedItems = chapterGroups.flatMap((chapter) => {
    const items = Array.isArray(chapter.items) ? chapter.items.filter(isRecord) : []
    if (items.length === 0) return []
    const chapterId = readNumber(chapter.chapterUid) ?? readString(chapter.chapterUid)
    const chapterTitle = readString(chapter.chapterName)
      ?? readString(chapter.title)
      ?? readString(chapter.chapterTitle)
      ?? (chapterId !== undefined ? chapterTitles.get(String(chapterId)) : undefined)
    return items.map((item) => ({
      ...item,
      ...(chapterId !== undefined && !('chapterUid' in item) ? { chapterUid: chapterId } : {}),
      ...(chapterTitle ? { chapterTitle } : {}),
    }))
  })
  return groupedItems.length > 0 ? groupedItems : extractArrayAny(payload, ['bookmarks', 'updated', 'items'])
}

function readWereadChapterTitles(payload: unknown): Map<string, string> {
  const chapters = extractArrayAny(payload, ['chapters']).filter(isRecord)
  return new Map(chapters.flatMap((chapter) => {
    const id = readNumber(chapter.chapterUid)
      ?? readNumber(chapter.uid)
      ?? readNumber(chapter.chapterId)
      ?? readString(chapter.chapterUid)
      ?? readString(chapter.uid)
      ?? readString(chapter.chapterId)
    const title = readString(chapter.title) ?? readString(chapter.chapterTitle) ?? readString(chapter.chapterName) ?? readString(chapter.name)
    return id !== undefined && title ? [[String(id), title] as const] : []
  }))
}

function readAuthorName(value: unknown): string | undefined {
  return isRecord(value) ? readString(value.name) ?? readString(value.nickName) : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasPoetryNotes(snapshot: ReadingLibrarySnapshot): boolean {
  return snapshot.notes.some((note) =>
    note.evidence.some((item) => item.sourceKind === 'poetry')
    || note.book?.title.includes('诗')
  )
}

function normalizeBookKey(title: string, author?: string): string {
  return `${title.trim().toLowerCase()}::${author?.trim().toLowerCase() ?? ''}`
}
