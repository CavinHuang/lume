import { describe, expect, test } from 'bun:test'
import type { ReadingLibrarySnapshot } from '@lume/shared'
import {
  buildReadingSearchItems,
  buildReadingOverviewStats,
  buildReadingBookRail,
  buildReadingWereadConnectionPrompt,
  buildReadingNoteNavigation,
  buildShareCardFilename,
  buildWereadNotebookView,
  createDefaultWereadRailGroupState,
  extendReadingHoverNavUntil,
  formatReadingProgress,
  formatWereadNotebookBadgeLabel,
  getWereadTabForSelection,
  normalizeWereadReadDataSummary,
  normalizeWereadBookmarks,
  normalizeWereadReviews,
  shouldStartReadingRun,
  shouldShowReadingHoverNav,
  toggleWereadRailGroup,
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

  test('builds a safe default filename for saving a share card through Tauri', () => {
    expect(buildShareCardFilename({
      id: 'note/1',
      title: '普通人的日常 / 雨夜',
    })).toBe('普通人的日常-雨夜-note-1.svg')
  })

  test('includes WeRead highlights in the all notes rail summary', () => {
    const rail = buildReadingBookRail(createSnapshot({ connected: true }), { highlightCount: 57 })

    expect(rail.items[0]).toMatchObject({
      id: '__all__',
      title: '全部笔记',
      subtitle: '2 篇笔记 + 57 条划线',
    })
  })

  test('keeps Lume overview stats separate from synced WeRead shelf books', () => {
    const snapshot = createSnapshot({ connected: true })
    snapshot.books.push({
      id: 'weread-reading',
      title: '微信在读',
      track: 'co_read',
      status: 'reading',
      source: { kind: 'weread', externalId: 'wr-reading' },
      tags: [],
      addedAt: 1,
      updatedAt: 1,
    })
    snapshot.books.push({
      id: 'local-finished',
      title: 'Lume 读完',
      track: 'lume',
      status: 'finished',
      source: { kind: 'manual' },
      tags: [],
      addedAt: 1,
      updatedAt: 1,
    })
    snapshot.stats = {
      ...snapshot.stats,
      readingCount: 999,
      finishedCount: 999,
      noteCount: 3,
    }

    expect(buildReadingOverviewStats(snapshot)).toEqual({
      readingCount: 2,
      noteCount: 3,
      finishedCount: 1,
    })
  })

  test('keeps synced WeRead shelf books out of the local Lume rail unless Lume has notes for them', () => {
    const snapshot = createSnapshot({ connected: true })
    snapshot.books.push({
      id: 'synced-empty',
      title: '只来自微信书架的书',
      author: '作者丙',
      track: 'co_read',
      status: 'reading',
      source: { kind: 'weread', externalId: 'wr-empty' },
      tags: [],
      addedAt: 1,
      updatedAt: 1,
    })
    snapshot.books.push({
      id: 'synced-noted',
      title: 'Lume 写过笔记的微信书',
      author: '作者丁',
      track: 'co_read',
      status: 'reading',
      source: { kind: 'weread', externalId: 'wr-noted' },
      tags: [],
      addedAt: 1,
      updatedAt: 1,
    })
    snapshot.notes.push({
      id: 'lume-note',
      bookId: 'synced-noted',
      title: 'Lume 的笔记',
      depth: 'seed',
      noteKind: 'seed',
      summary: '这本微信书有 Lume 笔记。',
      body: '这本微信书有 Lume 笔记。',
      tags: [],
      evidence: [{ quote: '一句划线', sourceKind: 'weread', sourceId: 'wr-noted', capturedAt: 1 }],
      aiGenerated: true,
      hidden: false,
      deleted: false,
      createdAt: 1,
      updatedAt: 1,
    })

    const rail = buildReadingBookRail(snapshot)

    expect(rail.items.map((item) => item.id)).toEqual([
      '__all__',
      'book-1',
      'book-2',
      'synced-noted',
    ])
    expect(rail.items[3]).toMatchObject({
      title: 'Lume 写过笔记的微信书',
      subtitle: '1篇笔记',
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

  test('formats WeRead notebook count as a visible badge only when the book has notes', () => {
    expect(formatWereadNotebookBadgeLabel(19)).toBe('19条笔记')
    expect(formatWereadNotebookBadgeLabel(0)).toBeNull()
  })

  test('blocks duplicate reading runs while state or a synchronous lock is active', () => {
    expect(shouldStartReadingRun(false, false)).toBeTrue()
    expect(shouldStartReadingRun(true, false)).toBeFalse()
    expect(shouldStartReadingRun(false, true)).toBeFalse()
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

  test('builds Alice-like WeRead notebook rail from connected notebook data', () => {
    const snapshot = createSnapshot({ connected: true })
    snapshot.notes = [
      {
        id: 'note-1',
        bookId: 'book-1',
        title: '身体在场',
        depth: 'seed',
        noteKind: 'seed',
        summary: '普通劳动被写得很具体。',
        body: '普通劳动被写得很具体。',
        tags: [],
        evidence: [{ quote: '普通人', sourceKind: 'weread', sourceId: 'wr-1', capturedAt: 1 }],
        aiGenerated: true,
        hidden: false,
        deleted: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]

    const view = buildWereadNotebookView({
      notebooks: {
        notebooks: [
          {
            bookId: 'wr-1',
            book: {
              title: '好吗好的',
              author: '大冰',
              cover: 'https://cover.example.com/ok.jpg',
            },
            reviewCount: 0,
            noteCount: 15,
            bookmarkCount: 4,
            readingProgress: 19,
            markedStatus: 0,
            sort: 99,
          },
          {
            bookId: 'wr-2',
            title: '龙族Ⅱ：悼亡者之瞳',
            author: '江南',
            bookmarkCount: 4,
            noteCount: 0,
            reviewCount: 0,
            markedStatus: 1,
            sort: 88,
          },
        ],
      },
      snapshot,
    })

    expect(view.books.map((book) => book.id)).toEqual(['weread:wr-1', 'weread:wr-2'])
    expect(view.books[0]).toMatchObject({
      bookId: 'wr-1',
      title: '好吗好的',
      author: '大冰',
      coverUrl: 'https://cover.example.com/ok.jpg',
      noteCount: 19,
      highlightCount: 4,
      thoughtCount: 15,
      progressLabel: '19%',
      status: 'reading',
      localNoteCount: 1,
    })
    expect(view.summary).toEqual({
      localNoteCount: 1,
      highlightCount: 8,
      thoughtCount: 15,
      readingCount: 1,
      finishedCount: 1,
    })
  })

  test('uses the WeRead shelf as the book list and notebooks only as note counts', () => {
    const view = buildWereadNotebookView({
      shelf: {
        books: [
          {
            title: '书架里的在读书',
            author: '作者甲',
            coverUrl: 'https://cover.example.com/reading.jpg',
            status: 'reading',
            progressPercent: 42,
            lastReadAt: 1717100000000,
            source: { kind: 'weread', externalId: 'wr-reading' },
          },
          {
            title: '书架里的已读书',
            author: '作者乙',
            status: 'finished',
            progressPercent: 100,
            lastReadAt: 1717000000000,
            source: { kind: 'weread', externalId: 'wr-finished' },
          },
        ],
      },
      notebooks: {
        notebooks: [
          {
            bookId: 'wr-reading',
            noteCount: 2,
            reviewCount: 3,
            bookmarkCount: 1,
            sort: 10,
          },
          {
            bookId: 'wr-notebook-only',
            title: '只有笔记本没有书架的书',
            noteCount: 9,
            reviewCount: 9,
          },
        ],
      },
      snapshot: createSnapshot({ connected: true }),
    })

    expect(view.books.map((book) => book.bookId)).toEqual(['wr-reading', 'wr-finished'])
    expect(view.books[0]).toMatchObject({
      title: '书架里的在读书',
      author: '作者甲',
      coverUrl: 'https://cover.example.com/reading.jpg',
      noteCount: 6,
      highlightCount: 1,
      thoughtCount: 5,
      bookmarkCount: 0,
      progressLabel: '42%',
      status: 'reading',
    })
    expect(view.books[1]).toMatchObject({
      title: '书架里的已读书',
      status: 'finished',
      noteCount: 0,
      progressLabel: '100%',
    })
    expect(view.summary).toEqual({
      localNoteCount: 0,
      highlightCount: 1,
      thoughtCount: 5,
      readingCount: 1,
      finishedCount: 1,
    })
  })

  test('shows nested WeRead progress and sorts shelf books by latest read time', () => {
    const view = buildWereadNotebookView({
      shelf: {
        books: [
          {
            bookInfo: {
              bookId: 'wr-old',
              title: '旧阅读',
              author: '作者旧',
            },
            readingProgress: 22,
            lastReadTime: 1717000000,
          },
          {
            bookInfo: {
              bookId: 'wr-new',
              title: '最近阅读',
              author: '作者新',
            },
            readingProgress: 59,
            lastReadTime: 1717200000,
          },
        ],
      },
      notebooks: {
        notebooks: [
          {
            bookId: 'wr-new',
            noteCount: 2,
          },
        ],
      },
      snapshot: createSnapshot({ connected: true }),
    })

    expect(view.books.map((book) => book.bookId)).toEqual(['wr-new', 'wr-old'])
    expect(view.books[0]).toMatchObject({
      title: '最近阅读',
      progressLabel: '59%',
      lastReadAt: 1717200000000,
      noteCount: 2,
    })
  })

  test('uses official WeRead readUpdateTime and readInfo progress fields in the connected rail', () => {
    const view = buildWereadNotebookView({
      shelf: {
        books: [
          {
            bookInfo: {
              bookId: 'wr-old',
              title: '旧阅读',
              author: '作者旧',
              readUpdateTime: 1717000000,
            },
            progressInfo: {
              progress: 22,
            },
          },
          {
            bookInfo: {
              bookId: 'wr-new',
              title: '最近阅读',
              author: '作者新',
              readUpdateTime: 1717300000,
            },
            progressInfo: {
              progress: 59,
            },
          },
        ],
      },
      notebooks: {
        notebooks: [
          {
            bookId: 'wr-new',
            noteCount: 4,
            reviewCount: 15,
            readInfo: {
              readingProgress: 59,
            },
          },
        ],
      },
      snapshot: createSnapshot({ connected: true }),
    })

    expect(view.books.map((book) => book.bookId)).toEqual(['wr-new', 'wr-old'])
    expect(view.books[0]).toMatchObject({
      title: '最近阅读',
      progressLabel: '59%',
      lastReadAt: 1717300000000,
      noteCount: 19,
    })
  })

  test('uses Alice WeRead shelf fields for reading status, counts, and recent-read ordering', () => {
    const view = buildWereadNotebookView({
      shelf: {
        books: [
          {
            bookId: 'wr-progress-100',
            title: '进度 100 但未标记读完',
            readUpdateTime: 2000,
            readingProgress: 100,
            finishStatus: 0,
            bookmarkCount: 4,
            noteCount: 15,
            reviewCount: 2,
          },
          {
            bookId: 'wr-finished',
            title: '明确已读完',
            readUpdateTime: 1000,
            readingProgress: 22,
            finishStatus: 1,
            bookmarkCount: 1,
            noteCount: 0,
          },
        ],
      },
      notebooks: { notebooks: [] },
      snapshot: createSnapshot({ connected: true }),
    })

    expect(view.books.map((book) => book.bookId)).toEqual(['wr-progress-100', 'wr-finished'])
    expect(view.books[0]).toMatchObject({
      status: 'reading',
      highlightCount: 4,
      thoughtCount: 17,
      noteCount: 21,
      progressPercent: 100,
    })
    expect(view.books[1]).toMatchObject({
      status: 'finished',
      highlightCount: 1,
      thoughtCount: 0,
      noteCount: 1,
    })
    expect(view.summary).toMatchObject({
      readingCount: 1,
      finishedCount: 1,
      highlightCount: 5,
      thoughtCount: 17,
    })
  })

  test('classifies WeRead notebooks into reading and read groups from common status fields', () => {
    const view = buildWereadNotebookView({
      notebooks: {
        notebooks: [
          { bookId: 'reading-1', title: '仍在读', readingProgress: 42 },
          { bookId: 'progress-100-without-finish', title: '100% 但仍在读', readingProgress: 100 },
          { bookId: 'done-by-finish-status', title: '完成状态', finishStatus: 1 },
          { bookId: 'done-by-flag', title: '标记读完', book: { title: '标记读完', finished: true } },
          { bookId: 'done-by-status', title: '状态读完', readingStatus: 'finished' },
          { bookId: 'done-by-finished-date', title: '完成日期', readInfo: { finishedDate: 1717300000 } },
        ],
      },
      snapshot: createSnapshot({ connected: true }),
    })

    expect(view.books.map((book) => [book.bookId, book.status])).toEqual([
      ['reading-1', 'reading'],
      ['progress-100-without-finish', 'reading'],
      ['done-by-finish-status', 'finished'],
      ['done-by-flag', 'finished'],
      ['done-by-status', 'finished'],
      ['done-by-finished-date', 'finished'],
    ])
    expect(view.summary.readingCount).toBe(2)
    expect(view.summary.finishedCount).toBe(4)
  })

  test('normalizes Alice-style WeRead accumulated read data fields', () => {
    expect(normalizeWereadReadDataSummary({
      readTime: 2_851_200,
      totalDays: 564,
    })).toEqual({
      totalReadTime: 2_851_200,
      readDays: 564,
    })

    expect(normalizeWereadReadDataSummary({
      data: {
        totalReadTime: 3600,
        readDays: 2,
      },
    })).toEqual({
      totalReadTime: 3600,
      readDays: 2,
    })
  })

  test('keeps WeRead rail groups expanded by default and toggles them independently', () => {
    const state = createDefaultWereadRailGroupState()

    expect(state).toEqual({ reading: true, finished: true })
    expect(toggleWereadRailGroup(state, 'reading')).toEqual({ reading: false, finished: true })
    expect(toggleWereadRailGroup(state, 'finished')).toEqual({ reading: true, finished: false })
  })

  test('returns to My Notes when selecting a different WeRead book', () => {
    expect(getWereadTabForSelection('notes', '__all__', 'weread:wr-1')).toBe('mine')
    expect(getWereadTabForSelection('popular', 'weread:wr-1', 'weread:wr-2')).toBe('mine')
    expect(getWereadTabForSelection('notes', 'weread:wr-1', 'weread:wr-1')).toBe('notes')
    expect(getWereadTabForSelection('notes', 'weread:wr-1', '__all__')).toBe('notes')
  })

  test('normalizes WeRead highlights and thoughts for the My Notes tab', () => {
    expect(normalizeWereadBookmarks({
      bookmarks: [
        {
          bookmarkId: 'b1',
          bookId: 'wr-1',
          markText: '没资格谈论理想时，先好好去挣钱。',
          chapterName: '最后一个义工',
          createTime: 1538352000,
        },
        {
          bookmarkId: 'b2',
          markText: '  ',
        },
      ],
    })).toEqual([
      {
        id: 'b1',
        text: '没资格谈论理想时，先好好去挣钱。',
        chapterTitle: '最后一个义工',
        createdAt: 1538352000,
      },
    ])

    expect(normalizeWereadReviews({
      reviews: [
        {
          review: {
            reviewId: 'r1',
            content: '米饭和时间能让你酿出一首属于你自己的歌！',
            chapterName: '我的想法',
            createTime: 1538352000,
          },
        },
      ],
    })).toEqual([
      {
        id: 'r1',
        text: '米饭和时间能让你酿出一首属于你自己的歌！',
        chapterTitle: '我的想法',
        createdAt: 1538352000,
      },
    ])
  })

  test('resolves WeRead bookmark chapter titles from the response chapter list', () => {
    expect(normalizeWereadBookmarks({
      chapters: [
        { chapterUid: 1001, title: '最后一个义工' },
      ],
      updated: [
        {
          bookmarkId: 'b1',
          chapterUid: 1001,
          markText: '没资格谈论理想时，先好好去挣钱。',
          createTime: 1538352000,
        },
      ],
    })).toEqual([
      {
        id: 'b1',
        text: '没资格谈论理想时，先好好去挣钱。',
        chapterTitle: '最后一个义工',
        createdAt: 1538352000,
      },
    ])
  })

  test('normalizes chapter-grouped WeRead bookmark responses', () => {
    expect(normalizeWereadBookmarks({
      chapters: [
        {
          chapterUid: 1001,
          chapterName: '最后一个义工',
          items: [
            {
              bookmarkId: 'b1',
              markText: '没资格谈论理想时，先好好去挣钱。',
              createTime: 1538352000,
            },
          ],
        },
      ],
      items: [{ chapterUid: 1001, title: '最后一个义工' }],
    })).toEqual([
      {
        id: 'b1',
        text: '没资格谈论理想时，先好好去挣钱。',
        chapterTitle: '最后一个义工',
        createdAt: 1538352000,
      },
    ])
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
