import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READING_IPC_CHANNELS, WEREAD_IPC_CHANNELS } from "@lume/shared";
import { createReadingHandlers } from "./reading-handlers";
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

  test("exposes the WeRead data channels used by Reading", async () => {
    const handlers = createReadingHandlers({
      weread: createTestWereadSource({
        testKey: async (apiKey: string) => ({ ok: apiKey === "valid-key" }),
        shelf: async () => [{ title: "我在北京送快递" }],
        notebooks: async () => [{ bookId: "wr-1", title: "我在北京送快递" }],
        bookmarks: async (bookId: string) => [{ bookId, markText: "把自己看作一个普通人。" }],
        reviews: async (bookId: string) => [{ bookId, review: { content: "这句让我停了一下。" } }],
        readdata: async (period?: string) => ({ period, readingTime: 120 }),
        bestBookmarks: async (bookId: string) => [{ bookId, markText: "过普通人的生活。" }],
        publicReviews: async (bookId: string, listType?: string) => [{ bookId, listType, content: "非常真诚。" }]
      })
    });

    for (const channel of [
      WEREAD_IPC_CHANNELS.GET_KEY,
      WEREAD_IPC_CHANNELS.TEST_KEY,
      WEREAD_IPC_CHANNELS.GET_SHELF,
      WEREAD_IPC_CHANNELS.GET_NOTEBOOKS,
      WEREAD_IPC_CHANNELS.GET_BOOKMARKS,
      WEREAD_IPC_CHANNELS.GET_REVIEWS,
      WEREAD_IPC_CHANNELS.GET_READ_DATA,
      WEREAD_IPC_CHANNELS.GET_BEST_BOOKMARKS,
      WEREAD_IPC_CHANNELS.GET_PUBLIC_REVIEWS
    ]) {
      expect(handlers[channel]).toBeFunction();
    }

    await expect(handlers[WEREAD_IPC_CHANNELS.TEST_KEY]?.({ apiKey: "valid-key" })).resolves.toMatchObject({ ok: true });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_SHELF]?.({})).resolves.toMatchObject({
      books: [{ title: "我在北京送快递" }]
    });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_NOTEBOOKS]?.({})).resolves.toMatchObject({
      notebooks: [{ bookId: "wr-1" }]
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
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_BEST_BOOKMARKS]?.({ bookId: "wr-1" })).resolves.toMatchObject({
      bookmarks: [{ markText: "过普通人的生活。" }]
    });
    await expect(handlers[WEREAD_IPC_CHANNELS.GET_PUBLIC_REVIEWS]?.({ bookId: "wr-1", listType: "hot" })).resolves.toMatchObject({
      reviews: [{ listType: "hot", content: "非常真诚。" }]
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
