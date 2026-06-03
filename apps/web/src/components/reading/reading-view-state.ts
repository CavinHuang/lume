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

export function buildReadingBookRail(snapshot: ReadingLibrarySnapshot): ReadingBookRail {
  const poetryItem: ReadingRailItem = {
    id: '__poetry__',
    kind: 'poetry',
    title: '诗词札记',
    subtitle: '公共诗词',
  }
  const items: ReadingRailItem[] = [
    {
      id: '__all__',
      kind: 'all',
      title: '全部笔记',
      subtitle: `${snapshot.stats.noteCount} 篇笔记`,
      count: snapshot.stats.noteCount,
    },
    ...snapshot.books.map(bookToRailItem),
    ...(hasPoetryNotes(snapshot) ? [poetryItem] : []),
  ]

  return {
    items,
    showWereadPrompt: !snapshot.wereadConnection.connected,
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

function bookToRailItem(book: ReadingBook): ReadingRailItem {
  return {
    id: book.id,
    kind: 'book',
    title: book.title,
    subtitle: book.author,
    coverUrl: book.localCoverPath ?? book.coverUrl,
    progressLabel: formatReadingProgress(book.progressPercent),
  }
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
