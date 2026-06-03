import { describe, expect, test } from 'bun:test'
import type { ReadingLibrarySnapshot } from '@lume/shared'
import {
  buildReadingSearchItems,
  buildReadingBookRail,
  buildReadingWereadConnectionPrompt,
  buildReadingNoteNavigation,
  extendReadingHoverNavUntil,
  formatReadingProgress,
  shouldShowReadingHoverNav,
} from './reading-view-state'

describe('reading view state', () => {
  test('builds compact book rail with all notes, vertical books, and WeRead prompt', () => {
    const rail = buildReadingBookRail(createSnapshot({ connected: false }))

    expect(rail.showWereadPrompt).toBeTrue()
    expect(rail.items.map((item) => item.id)).toEqual([
      '__all__',
      'book-1',
      'book-2',
    ])
    expect(rail.items[1]).toMatchObject({
      kind: 'book',
      title: '我在北京送快递',
      progressLabel: '54%'
    })
  })

  test('adds the poetry rail only when poetry notes exist', () => {
    const snapshot = createSnapshot({ connected: true })
    snapshot.notes = [
      {
        id: 'poem-note',
        bookId: 'book-2',
        title: '雨夜',
        depth: 'seed',
        noteKind: 'seed',
        summary: '雨夜的声音。',
        body: '雨夜的声音让 Lume 想到等待。',
        tags: ['诗词'],
        evidence: [{ quote: '雨', sourceKind: 'poetry', capturedAt: 1 }],
        aiGenerated: true,
        hidden: false,
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    expect(buildReadingBookRail(snapshot).items.map((item) => item.id)).toEqual([
      '__all__',
      'book-1',
      'book-2',
      '__poetry__',
    ])
  })

  test('keeps the WeRead rail prompt compact and routes connection through settings', () => {
    expect(buildReadingWereadConnectionPrompt(createSnapshot({ connected: false }))).toEqual({
      title: '连接微信读书',
      body: '看到你的书架和划线，一起聊书',
      actionLabel: '去设置',
    })
    expect(buildReadingWereadConnectionPrompt(createSnapshot({ connected: true }))).toBeNull()
  })

  test('computes note navigation targets', () => {
    expect(buildReadingNoteNavigation(['n1', 'n2', 'n3'], 'n2')).toEqual({
      topId: 'n1',
      previousId: 'n1',
      nextId: 'n3',
      bottomId: 'n3'
    })
  })

  test('keeps hover navigation visible for three seconds', () => {
    expect(extendReadingHoverNavUntil(100)).toBe(3100)
    expect(shouldShowReadingHoverNav(2000, 3100)).toBeTrue()
    expect(shouldShowReadingHoverNav(3200, 3100)).toBeFalse()
  })

  test('formats reading progress compactly', () => {
    expect(formatReadingProgress(54.4)).toBe('54%')
    expect(formatReadingProgress(undefined)).toBe('在读')
  })

  test('maps WeRead search results into add-book payloads and marks existing books', () => {
    const items = buildReadingSearchItems([
      {
        source: 'weread',
        externalId: 'wr-1',
        title: '我在北京送快递',
        author: '胡安焉',
        coverUrl: 'https://cover.example.com/wr-1.jpg',
        url: 'https://weread.qq.com/web/book/wr-1',
        summary: '普通劳动的生活记录'
      },
      {
        source: 'weread',
        externalId: 'wr-3',
        title: '置身事内',
        author: '兰小欢'
      }
    ], createSnapshot({ connected: true }).books)

    expect(items[0]).toMatchObject({
      id: 'weread:wr-1',
      alreadyAdded: true,
      addBookInput: {
        title: '我在北京送快递',
        author: '胡安焉',
        track: 'co_read',
        status: 'reading',
        coverUrl: 'https://cover.example.com/wr-1.jpg',
        source: {
          kind: 'weread',
          externalId: 'wr-1',
          url: 'https://weread.qq.com/web/book/wr-1',
          title: '我在北京送快递',
          author: '胡安焉',
          excerpt: '普通劳动的生活记录'
        }
      }
    })
    expect(items[1]).toMatchObject({
      id: 'weread:wr-3',
      alreadyAdded: false,
      addBookInput: {
        title: '置身事内',
        track: 'co_read',
        source: {
          kind: 'weread',
          externalId: 'wr-3'
        }
      }
    })
  })
})

function createSnapshot(input: { connected: boolean }): ReadingLibrarySnapshot {
  return {
    books: [
      {
        id: 'book-1',
        title: '我在北京送快递',
        author: '胡安焉',
        track: 'co_read',
        status: 'reading',
        source: { kind: 'weread' },
        progressPercent: 54,
        tags: [],
        addedAt: 1,
        updatedAt: 2
      },
      {
        id: 'book-2',
        title: 'Frankenstein',
        author: 'Mary Shelley',
        track: 'lume',
        status: 'reading',
        source: { kind: 'gutenberg' },
        tags: [],
        addedAt: 1,
        updatedAt: 1
      }
    ],
    notes: [],
    activity: {
      currentBook: {
        id: 'book-1',
        title: '我在北京送快递',
        author: '胡安焉',
        track: 'co_read',
        status: 'reading',
        progressPercent: 54
      },
      latestNote: {
        id: 'note-1',
        bookId: 'book-1',
        title: '身体在场',
        summary: '普通劳动被写成具体生活。',
        createdAt: 3,
        nextPlan: '继续看身体经验如何变成关系经验。',
        bookTitle: '我在北京送快递'
      },
      currentThought: 'Lume 想把它和自己最近的等待感连起来。',
      nextPlan: '继续看身体经验如何变成关系经验。'
    },
    stats: {
      readingCount: 2,
      noteCount: 2,
      finishedCount: 0,
      unseenNoteCount: 1
    },
    settings: {
      version: 1,
      language: 'zh',
      cadence: 'weekly',
      quiet: true,
      maxDeepNotesPerWeek: 1,
      textModelMode: 'inherit',
      advanced: {},
      weread: { apiKeySet: input.connected },
      updatedAt: 1
    },
    wereadConnection: {
      connected: input.connected
    }
  }
}
