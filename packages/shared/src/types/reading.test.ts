import { describe, expect, test } from "bun:test";
import {
  READING_IPC_CHANNELS,
  WEREAD_IPC_CHANNELS,
  normalizeReadingBook,
  normalizeReadingSettings,
  type ReadingGenerateShareCardInput
} from "./reading";

describe("reading shared types", () => {
  test("Reading IPC channel names are stable", () => {
    expect(READING_IPC_CHANNELS).toMatchObject({
      GET_SNAPSHOT: "reading:get-snapshot",
      UPDATE_SETTINGS: "reading:update-settings",
      ADD_BOOK: "reading:add-book",
      MANUAL_GENERATE_NOTE: "reading:manual-generate-note",
      CONNECT_WEREAD: "reading:connect-weread",
      SEARCH_BOOKS: "reading:search-books",
      NOTE_GEN_DONE: "reading:noteGenDone",
      NOTE_GEN_FAILED: "reading:noteGenFailed"
    });
  });

  test("Alice-like WeRead IPC channel names are stable", () => {
    expect(WEREAD_IPC_CHANNELS).toMatchObject({
      GET_KEY: "weread:getKey",
      TEST_KEY: "weread:testKey",
      GET_SHELF: "weread:getShelf",
      GET_NOTEBOOKS: "weread:getNotebooks",
      GET_BOOKMARKS: "weread:getBookmarks",
      GET_REVIEWS: "weread:getReviews",
      GET_READ_DATA: "weread:getReadData",
      GET_BEST_BOOKMARKS: "weread:getBestBookmarks",
      GET_PUBLIC_REVIEWS: "weread:getPublicReviews"
    });
  });

  test("Reading share card generation can target a user-selected output path", () => {
    const input: ReadingGenerateShareCardInput = {
      noteId: "note-1",
      outputPath: "/tmp/lume-reading-card.svg"
    };

    expect(input.outputPath).toBe("/tmp/lume-reading-card.svg");
  });

  test("normalizes Reading settings to Alice-like V1 defaults", () => {
    const settings = normalizeReadingSettings({
      cadence: "daily",
      language: "en",
      textModelMode: "explicit",
      textModelRef: "  openai/gpt-5  ",
      imageModelRef: "  ",
      advanced: {
        seedModelRef: "  anthropic/claude-sonnet-4-5  "
      }
    } as never);

    expect(settings.cadence).toBe("weekly");
    expect(settings.language).toBe("zh");
    expect(settings.quiet).toBe(true);
    expect(settings.maxDeepNotesPerWeek).toBe(1);
    expect(settings.textModelMode).toBe("explicit");
    expect(settings.textModelRef).toBe("openai/gpt-5");
    expect(settings.imageModelRef).toBeUndefined();
    expect(settings.advanced.seedModelRef).toBe("anthropic/claude-sonnet-4-5");
    expect(settings.advanced.selectionModelRef).toBeUndefined();
  });

  test("normalizes Reading books while preserving source provenance", () => {
    const book = normalizeReadingBook({
      id: "book-1",
      title: "  我在北京送快递  ",
      author: "  胡安焉  ",
      track: "co_read",
      status: "reading",
      source: {
        kind: "weread",
        externalId: "  wr-123  ",
        url: "  https://weread.qq.com/web/book/wr-123  ",
        title: "  我在北京送快递  "
      },
      progressPercent: 54,
      addedAt: 10,
      updatedAt: 12
    });

    expect(book).toMatchObject({
      id: "book-1",
      title: "我在北京送快递",
      author: "胡安焉",
      track: "co_read",
      status: "reading",
      progressPercent: 54,
      source: {
        kind: "weread",
        externalId: "wr-123",
        url: "https://weread.qq.com/web/book/wr-123",
        title: "我在北京送快递"
      },
      addedAt: 10,
      updatedAt: 12
    });
  });
});
