import { describe, expect, test } from "bun:test";
import {
  ALICE_READING_IPC_CHANNELS,
  READING_IPC_CHANNELS,
  WEREAD_IPC_CHANNELS,
  normalizeReadingBook,
  normalizeReadingSettings
} from "./reading";

describe("reading shared types", () => {
  test("Reading IPC channel names are stable", () => {
    expect(READING_IPC_CHANNELS).toMatchObject({
      GET_SNAPSHOT: "reading:get-snapshot",
      UPDATE_SETTINGS: "reading:update-settings",
      LIST_BOOKS: "reading:list-books",
      LIST_NOTES: "reading:list-notes",
      GET_NOTE: "reading:get-note",
      ADD_BOOK: "reading:add-book",
      ADD_BOOK_TO_ALICE: "reading:addBookToAlice",
      UPDATE_BOOK: "reading:update-book",
      HIDE_NOTE: "reading:hide-note",
      DELETE_NOTE: "reading:delete-note",
      MARK_SEEN: "reading:mark-seen",
      GET_UNREAD_COUNTS: "reading:get-unread-counts",
      GET_HIGHLIGHTS: "reading:get-highlights",
      REMOVE_HIGHLIGHT: "reading:remove-highlight",
      GET_BLURS: "reading:get-blurs",
      ADD_BLUR: "reading:add-blur",
      REMOVE_BLUR: "reading:remove-blur",
      REACT_PLUS_ONE: "reading:react-plus-one",
      RUN_TASK: "reading:run-task",
      FORCE_GENERATE_NOTE: "reading:force-generate-note",
      MANUAL_GENERATE_NOTE: "reading:manual-generate-note",
      REVISE_NOTE: "reading:revise-note",
      CONNECT_WEREAD: "reading:connect-weread",
      DISCONNECT_WEREAD: "reading:disconnect-weread",
      SEARCH_WEREAD: "reading:search-weread",
      GENERATE_COVER: "reading:generate-cover",
      DELETE_COVER: "reading:delete-cover",
      REFRESH_QUOTES: "reading:refresh-quotes",
      GET_BOOK_DEBUG_INFO: "reading:get-book-debug-info",
      GENERATE_SHARE_CARD: "reading:generate-share-card",
      NOTE_GEN_DONE: "reading:noteGenDone",
      NOTE_GEN_FAILED: "reading:noteGenFailed"
    });
  });

  test("Alice-compatible Reading IPC channel names are stable", () => {
    expect(ALICE_READING_IPC_CHANNELS).toMatchObject({
      GET_BOOKS: "reading:getBooks",
      GET_NOTES: "reading:getNotes",
      GET_NOTE: "reading:getNote",
      GET_STATS: "reading:getStats",
      FORCE_GENERATE_NOTE: "reading:forceGenerateNote",
      MANUAL_GENERATE_NOTE: "reading:manualGenerateNote",
      DELETE_NOTE: "reading:deleteNote",
      GENERATE_COVER: "reading:generateCover",
      DELETE_COVER: "reading:deleteCover",
      REFRESH_QUOTES: "reading:refreshQuotes",
      GET_UNREAD_COUNTS: "reading:getUnreadCounts",
      MARK_NOTES_READ: "reading:markNotesRead",
      GET_HIGHLIGHTS: "reading:getHighlights",
      REMOVE_HIGHLIGHT: "reading:removeHighlight",
      GET_BLURS: "reading:getBlurs",
      ADD_BLUR: "reading:addBlur",
      REMOVE_BLUR: "reading:removeBlur",
      REACT_PLUS_ONE: "reading:reactPlusOne",
      GET_BOOK_DEBUG_INFO: "reading:getBookDebugInfo",
      ADD_BOOK_TO_ALICE: "reading:addBookToAlice"
    });
  });

  test("Alice-like WeRead IPC channel names are stable", () => {
    expect(WEREAD_IPC_CHANNELS).toMatchObject({
      OPEN_AND_FETCH_KEY: "weread:openAndFetchKey",
      TEST_KEY: "weread:testKey",
      GET_SHELF: "weread:getShelf",
      GET_NOTEBOOKS: "weread:getNotebooks",
      GET_BOOKMARKS: "weread:getBookmarks",
      GET_READ_DATA: "weread:getReadData",
      GET_BEST_BOOKMARKS: "weread:getBestBookmarks",
      GET_PUBLIC_REVIEWS: "weread:getPublicReviews",
      GENERATE_NOTE: "weread:generateNote",
      EXPORT_ALL_NOTES: "weread:exportAllNotes",
      SEARCH_BOOKS: "weread:searchBooks",
      EXPORT_PROGRESS: "weread:exportProgress"
    });
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
