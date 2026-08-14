import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READING_IPC_CHANNELS, WEREAD_IPC_CHANNELS } from "@lume/shared";
import { createReadingHandlers } from "./reading-handlers";
import { createReadingNote } from "../services/reading/reading-store";
import type { WereadIpcSource } from "../services/reading/weread-ipc-service";

describe("reading-handlers", () => {
  let prevConfigDir: string | undefined;
  let tempConfigDir = "";

  beforeEach(() => {
    prevConfigDir = process.env.LUME_CONFIG_DIR;
    tempConfigDir = mkdtempSync(join(tmpdir(), "lume-reading-rpc-"));
    process.env.LUME_CONFIG_DIR = tempConfigDir;
  });

  afterEach(() => {
    if (prevConfigDir === undefined) {
      delete process.env.LUME_CONFIG_DIR;
    } else {
      process.env.LUME_CONFIG_DIR = prevConfigDir;
    }
    if (tempConfigDir) {
      rmSync(tempConfigDir, { recursive: true, force: true });
      tempConfigDir = "";
    }
  });

  test("returns default Reading snapshot with a starter Lume book", async () => {
    const handlers = createReadingHandlers({
      weread: createTestWereadSource()
    });
    await expect(handlers[READING_IPC_CHANNELS.GET_SNAPSHOT]?.({})).resolves.toMatchObject({
      books: [
        expect.objectContaining({
          title: "人间词话",
          author: "王国维",
          track: "lume",
          status: "reading"
        })
      ],
      notes: [],
      stats: {
        readingCount: 1,
        noteCount: 0,
        finishedCount: 0,
        unseenNoteCount: 0
      },
      settings: {
        cadence: "weekly",
        language: "zh",
        textModelMode: "inherit"
      },
      wereadConnection: {
        connected: false
      }
    });
  });

  test("updates settings and connects WeRead without leaking API Key", async () => {
    const handlers = createReadingHandlers({
      weread: createTestWereadSource()
    });
    const settings = await handlers[READING_IPC_CHANNELS.UPDATE_SETTINGS]?.({
      cadence: "few_times_weekly",
      textModelMode: "explicit",
      textModelRef: " openai/gpt-5-mini "
    });
    expect(settings).toMatchObject({
      cadence: "few_times_weekly",
      textModelMode: "explicit",
      textModelRef: "openai/gpt-5-mini"
    });

    const connected = await handlers[READING_IPC_CHANNELS.CONNECT_WEREAD]?.({
      apiKey: "secret-weread-key",
      accountName: "Cavin"
    });
    expect(connected).toMatchObject({
      connected: true,
      accountName: "Cavin"
    });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_KEY]?.({})).resolves.toEqual({
      apiKey: "secret-weread-key"
    });
    expect(JSON.stringify(await handlers[READING_IPC_CHANNELS.GET_SNAPSHOT]?.({}))).not.toContain("secret-weread-key");
  });

  test("syncs WeRead shelf into the Reading library when connecting", async () => {
    const handlers = createReadingHandlers({
      weread: createTestWereadSource({
        shelf: async () => [
          {
            title: "我在北京送快递",
            author: "胡安焉",
            coverUrl: "https://img.example/book.jpg",
            progressPercent: 54,
            source: {
              kind: "weread",
              externalId: "wr-1",
              url: "https://weread.qq.com/web/book/wr-1"
            }
          },
          {
            title: "置身事内",
            author: "兰小欢",
            progressPercent: 12,
            source: {
              kind: "weread",
              externalId: "wr-2"
            }
          }
        ],
      })
    });

    await expect(handlers[READING_IPC_CHANNELS.CONNECT_WEREAD]?.({
      apiKey: "valid-key"
    })).resolves.toMatchObject({
      connected: true
    });

    await expect(handlers[READING_IPC_CHANNELS.GET_SNAPSHOT]?.({})).resolves.toMatchObject({
      books: [
        expect.objectContaining({
          title: "置身事内",
          author: "兰小欢",
          progressPercent: 12,
          track: "co_read",
          status: "reading",
          source: expect.objectContaining({
            kind: "weread",
            externalId: "wr-2"
          })
        }),
        expect.objectContaining({
          title: "我在北京送快递",
          author: "胡安焉",
          coverUrl: "https://img.example/book.jpg",
          progressPercent: 54,
          source: expect.objectContaining({
            kind: "weread",
            externalId: "wr-1"
          })
        })
      ],
      stats: {
        readingCount: 2
      },
      wereadConnection: {
        connected: true
      }
    });
  });

  test("adds books and hides or deletes notes", async () => {
    const handlers = createReadingHandlers();
    const book = await handlers[READING_IPC_CHANNELS.ADD_BOOK]?.({
      title: "我在北京送快递",
      author: "胡安焉",
      track: "co_read",
      progressPercent: 54,
      source: {
        kind: "weread",
        externalId: "wr-1"
      }
    }) as { id: string };

    const note = createReadingNote({
      bookId: book.id,
      body: "普通人的日常在这里有了具体重量。",
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "weread",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          capturedAt: 1
        }
      ]
    });

    expect(await handlers[READING_IPC_CHANNELS.LIST_NOTES]?.({})).toHaveLength(1);
    await expect(handlers[READING_IPC_CHANNELS.GET_NOTE]?.({ id: note.id })).resolves.toMatchObject({
      id: note.id,
      bookId: book.id,
      book: {
        id: book.id,
        title: "我在北京送快递"
      }
    });
    await handlers[READING_IPC_CHANNELS.HIDE_NOTE]?.({ id: note.id });
    expect(await handlers[READING_IPC_CHANNELS.LIST_NOTES]?.({})).toEqual([]);
    expect(await handlers[READING_IPC_CHANNELS.LIST_NOTES]?.({ includeHidden: true })).toHaveLength(1);

    await handlers[READING_IPC_CHANNELS.DELETE_NOTE]?.({ id: note.id });
    expect(await handlers[READING_IPC_CHANNELS.LIST_NOTES]?.({ includeHidden: true })).toEqual([]);
    expect(await handlers[READING_IPC_CHANNELS.LIST_NOTES]?.({
      includeHidden: true,
      includeDeleted: true
    })).toHaveLength(1);
  });

  test("supports Alice-like addBookToAlice collaboration entry", async () => {
    const handlers = createReadingHandlers();

    const book = await handlers[READING_IPC_CHANNELS.ADD_BOOK_TO_ALICE]?.({
      title: "置身事内",
      reason: "用户想让 Lume 一起理解地方政府与普通生活的关系。"
    }) as { id: string };

    expect(book).toMatchObject({
      title: "置身事内",
      track: "recommended",
      status: "queued",
      source: {
        kind: "manual",
        excerpt: "用户想让 Lume 一起理解地方政府与普通生活的关系。"
      },
      tags: ["用户推荐"]
    });
    await expect(handlers[READING_IPC_CHANNELS.LIST_BOOKS]?.({})).resolves.toContainEqual(
      expect.objectContaining({
        id: book.id,
        title: "置身事内"
      })
    );
  });

  test("bootstraps the first Lume book through direct book list entrypoints", async () => {
    const handlers = createReadingHandlers();

    await expect(handlers[READING_IPC_CHANNELS.LIST_BOOKS]?.({})).resolves.toContainEqual(
      expect.objectContaining({
        title: "人间词话",
        author: "王国维",
        track: "lume",
        status: "reading"
      })
    );
  });

  test("exposes Alice-like generation, revision, cover, and quote refresh channels", async () => {
    const handlers = createReadingHandlers();
    for (const channel of [
      READING_IPC_CHANNELS.FORCE_GENERATE_NOTE,
      READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE,
      READING_IPC_CHANNELS.REVISE_NOTE,
      READING_IPC_CHANNELS.GENERATE_COVER,
      READING_IPC_CHANNELS.DELETE_COVER,
      READING_IPC_CHANNELS.REFRESH_QUOTES,
      READING_IPC_CHANNELS.GET_UNREAD_COUNTS,
      READING_IPC_CHANNELS.GET_HIGHLIGHTS,
      READING_IPC_CHANNELS.GET_BLURS,
      READING_IPC_CHANNELS.ADD_BLUR,
      READING_IPC_CHANNELS.REMOVE_BLUR,
      READING_IPC_CHANNELS.REMOVE_HIGHLIGHT,
      READING_IPC_CHANNELS.REACT_PLUS_ONE,
      READING_IPC_CHANNELS.GET_BOOK_DEBUG_INFO
    ]) {
      expect(handlers[channel]).toBeFunction();
    }

    const book = await handlers[READING_IPC_CHANNELS.ADD_BOOK]?.({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "weread",
        externalId: "wr-1",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      }
    }) as { id: string };
    const note = createReadingNote({
      bookId: book.id,
      body: "Lume 先把这句话理解成劳动。",
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "weread",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          capturedAt: 1
        }
      ]
    });

    await expect(handlers[READING_IPC_CHANNELS.REVISE_NOTE]?.({
      id: note.id,
      body: "Lume 修订后更关心普通生活的位置。",
      editReason: "改为聚焦普通生活。"
    })).resolves.toMatchObject({
      id: note.id,
      body: "Lume 修订后更关心普通生活的位置。",
      revisions: [
        {
          editReason: "改为聚焦普通生活。"
        }
      ]
    });

    await expect(handlers[READING_IPC_CHANNELS.GENERATE_COVER]?.({ bookId: book.id })).resolves.toMatchObject({
      ok: true,
      bookId: book.id
    });
    await expect(handlers[READING_IPC_CHANNELS.DELETE_COVER]?.({ bookId: book.id })).resolves.toMatchObject({
      id: book.id
    });
    await expect(handlers[READING_IPC_CHANNELS.REFRESH_QUOTES]?.({ bookId: book.id })).resolves.toMatchObject({
      ok: true,
      refreshed: 1
    });

    await expect(handlers[READING_IPC_CHANNELS.GET_UNREAD_COUNTS]?.({})).resolves.toMatchObject({
      total: 1,
      byBookId: {
        [book.id]: 1
      }
    });
    await expect(handlers[READING_IPC_CHANNELS.REACT_PLUS_ONE]?.({ id: note.id })).resolves.toMatchObject({
      noteId: note.id,
      plusOnes: 1
    });
    await expect(handlers[READING_IPC_CHANNELS.ADD_BLUR]?.({ id: note.id })).resolves.toMatchObject({
      id: note.id
    });
    await expect(handlers[READING_IPC_CHANNELS.GET_BLURS]?.({})).resolves.toHaveLength(1);
    await expect(handlers[READING_IPC_CHANNELS.REMOVE_BLUR]?.({ id: note.id })).resolves.toMatchObject({ ok: true });
    await expect(handlers[READING_IPC_CHANNELS.REMOVE_HIGHLIGHT]?.({ id: note.id })).resolves.toMatchObject({ ok: true });
    await expect(handlers[READING_IPC_CHANNELS.GET_HIGHLIGHTS]?.({})).resolves.toEqual([]);
    await expect(handlers[READING_IPC_CHANNELS.GET_BOOK_DEBUG_INFO]?.({ bookId: book.id })).resolves.toMatchObject({
      book: { id: book.id },
      reactionCount: 1,
      highlightedCount: 0
    });
  });

  test("emits Alice-like reading note generation notifications", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const handlers = (createReadingHandlers as unknown as (context: {
      writeNotification: (method: string, params: unknown) => void;
    }) => ReturnType<typeof createReadingHandlers>)({
      writeNotification: (method, params) => notifications.push({ method, params })
    });

    const book = await handlers[READING_IPC_CHANNELS.ADD_BOOK]?.({
      title: "我在北京送快递",
      author: "胡安焉",
      source: {
        kind: "manual",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      }
    }) as { id: string };

    await expect(handlers[READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE]?.({
      bookId: book.id,
      depth: "seed"
    })).resolves.toMatchObject({
      status: "failed",
      message: "读书模型未配置，无法生成读书笔记",
      bookId: book.id
    });

    expect(notifications).toContainEqual({
      method: READING_IPC_CHANNELS.NOTE_GEN_FAILED,
      params: expect.objectContaining({
        bookId: book.id,
        bookTitle: "我在北京送快递",
        status: "failed"
      })
    });
  });

  test("emits Alice-like reading notifications for the starter book", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const handlers = (createReadingHandlers as unknown as (context: {
      writeNotification: (method: string, params: unknown) => void;
    }) => ReturnType<typeof createReadingHandlers>)({
      writeNotification: (method, params) => notifications.push({ method, params })
    });

    await expect(handlers[READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE]?.({
      depth: "seed"
    })).resolves.toMatchObject({
      status: "failed",
      message: "读书模型未配置，无法生成读书笔记"
    });

    expect(notifications).toContainEqual({
      method: READING_IPC_CHANNELS.NOTE_GEN_FAILED,
      params: expect.objectContaining({
        status: "failed",
        bookTitle: "人间词话"
      })
    });
  });

  test("exposes Alice-like WeRead IPC channels and maps generation/export into Lume Reading", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const handlers = (createReadingHandlers as unknown as (context: {
      writeNotification: (method: string, params: unknown) => void;
      weread: Record<string, unknown>;
    }) => ReturnType<typeof createReadingHandlers>)({
      writeNotification: (method, params) => notifications.push({ method, params }),
      weread: {
        openAndFetchKey: async () => ({ ok: false, reason: "not_supported" }),
        testKey: async (apiKey: string) => ({ ok: apiKey === "valid-key" }),
        shelf: async () => [{ title: "我在北京送快递", source: { kind: "weread", externalId: "wr-1" } }],
        notebooks: async () => [{ bookId: "wr-1", title: "我在北京送快递" }],
        bookmarks: async (bookId: string) => [{ bookId, markText: "把自己看作一个普通人。" }],
        reviews: async (bookId: string) => [{ bookId, review: { content: "这句让我停了一下。" } }],
        readdata: async (period?: string) => ({ period, readingTime: 120 }),
        bestBookmarks: async (bookId: string) => [{ bookId, markText: "过普通人的生活。" }],
        publicReviews: async (bookId: string, listType?: string) => [{ bookId, listType, content: "非常真诚。" }],
        search: async (query: string) => [{ source: "weread", externalId: "wr-1", title: query }]
      }
    });

    for (const channel of [
      WEREAD_IPC_CHANNELS.OPEN_AND_FETCH_KEY,
      WEREAD_IPC_CHANNELS.GET_KEY,
      WEREAD_IPC_CHANNELS.TEST_KEY,
      WEREAD_IPC_CHANNELS.GET_SHELF,
      WEREAD_IPC_CHANNELS.GET_NOTEBOOKS,
      WEREAD_IPC_CHANNELS.GET_BOOKMARKS,
      WEREAD_IPC_CHANNELS.GET_REVIEWS,
      WEREAD_IPC_CHANNELS.GET_READ_DATA,
      WEREAD_IPC_CHANNELS.GET_BEST_BOOKMARKS,
      WEREAD_IPC_CHANNELS.GET_PUBLIC_REVIEWS,
      WEREAD_IPC_CHANNELS.GENERATE_NOTE,
      WEREAD_IPC_CHANNELS.EXPORT_ALL_NOTES,
      WEREAD_IPC_CHANNELS.SEARCH_BOOKS
    ]) {
      expect(handlers[channel]).toBeFunction();
    }

    await expect(handlers[WEREAD_IPC_CHANNELS.TEST_KEY]?.({ apiKey: "valid-key" })).resolves.toMatchObject({ ok: true });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_KEY]?.({})).resolves.toMatchObject({ apiKey: null });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_SHELF]?.({})).resolves.toMatchObject({
      books: [{ title: "我在北京送快递" }]
    });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_BOOKMARKS]?.({ bookId: "wr-1" })).resolves.toMatchObject({
      bookmarks: [{ markText: "把自己看作一个普通人。" }]
    });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_REVIEWS]?.({ bookId: "wr-1" })).resolves.toMatchObject({
      reviews: [{ review: { content: "这句让我停了一下。" } }]
    });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_READ_DATA]?.({ period: "week" })).resolves.toMatchObject({
      period: "week",
      readingTime: 120
    });
    await expect(handlers[WEREAD_IPC_CHANNELS.SEARCH_BOOKS]?.({ keyword: "置身事内" })).resolves.toMatchObject({
      results: [{ title: "置身事内" }]
    });

    const generated = await handlers[WEREAD_IPC_CHANNELS.GENERATE_NOTE]?.({
      bookTitle: "我在北京送快递",
      text: "把自己看作一个普通人，过普通人的生活。",
      source: "第 1 章",
      authorName: "胡安焉"
    }) as { status: string; noteId?: string; bookId?: string };
    expect(generated).toMatchObject({
      status: "failed",
      message: "读书模型未配置，无法生成读书笔记"
    });
    expect(generated.noteId).toBeUndefined();
    expect(notifications).toContainEqual({
      method: READING_IPC_CHANNELS.NOTE_GEN_FAILED,
      params: expect.objectContaining({
        bookTitle: "我在北京送快递",
        trigger: "manual"
      })
    });

    createReadingNote({
      bookId: generated.bookId ?? "manual-export-book",
      body: "普通人的生活在重复劳动里显出重量。",
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "manual",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          capturedAt: 1
        }
      ]
    });
    const exported = await handlers[WEREAD_IPC_CHANNELS.EXPORT_ALL_NOTES]?.({}) as { ok: boolean; path: string; count: number };
    expect(exported).toMatchObject({
      ok: true,
      count: 1
    });
    expect(exported.path).toContain("reading");
  });

  test("emits Alice-like WeRead export progress notifications", async () => {
    const notifications: Array<{ method: string; params: unknown }> = [];
    const handlers = (createReadingHandlers as unknown as (context: {
      writeNotification: (method: string, params: unknown) => void;
    }) => ReturnType<typeof createReadingHandlers>)({
      writeNotification: (method, params) => notifications.push({ method, params })
    });

    const book = await handlers[READING_IPC_CHANNELS.ADD_BOOK]?.({
      title: "我在北京送快递",
      source: {
        kind: "manual",
        excerpt: "把自己看作一个普通人，过普通人的生活。"
      }
    }) as { id: string };
    createReadingNote({
      bookId: book.id,
      body: "普通人的生活在重复劳动里显出重量。",
      evidence: [
        {
          quote: "把自己看作一个普通人，过普通人的生活。",
          sourceKind: "manual",
          excerpt: "把自己看作一个普通人，过普通人的生活。",
          capturedAt: 1
        }
      ]
    });

    await expect(handlers[WEREAD_IPC_CHANNELS.EXPORT_ALL_NOTES]?.({})).resolves.toMatchObject({
      ok: true,
      count: 1
    });
    expect(notifications).toContainEqual({
      method: WEREAD_IPC_CHANNELS.EXPORT_PROGRESS,
      params: expect.objectContaining({
        status: "started",
        total: 1
      })
    });
    expect(notifications).toContainEqual({
      method: WEREAD_IPC_CHANNELS.EXPORT_PROGRESS,
      params: expect.objectContaining({
        status: "completed",
        total: 1,
        exported: 1
      })
    });
  });
});

function createTestWereadSource(overrides: Partial<WereadIpcSource> = {}): WereadIpcSource {
  return {
    openAndFetchKey: async () => ({ ok: false, reason: "not_supported" }),
    testKey: async () => ({ ok: true }),
    shelf: async () => [],
    notebooks: async () => [],
    bookmarks: async () => [],
    reviews: async () => [],
    readdata: async () => ({}),
    bestBookmarks: async () => [],
    publicReviews: async () => [],
    search: async () => [],
    ...overrides
  };
}
