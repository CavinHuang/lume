import { READING_IPC_CHANNELS, WEREAD_IPC_CHANNELS } from "@lume/shared";
import type {
  ReadingAddBookInput,
  ReadingAddBookToAliceInput,
  ReadingConnectWereadInput,
  ReadingGenerateShareCardInput,
  ReadingListNotesInput,
  ReadingNoteRevisionInput,
  ReadingRunTaskInput,
  ReadingTaskResult,
  ReadingSearchBooksInput,
  ReadingSearchWereadInput,
  ReadingUpdateBookInput,
  ReadingUpdateSettingsInput
} from "@lume/shared";
import {
  addReadingBook,
  connectReadingWeread,
  deleteReadingBookCover,
  deleteReadingNote,
  disconnectReadingWeread,
  ensureReadingBootstrapBook,
  getReadingBlurs,
  getReadingBookDebugInfo,
  getReadingHighlights,
  getReadingNote,
  getReadingSnapshot,
  getReadingUnreadCounts,
  getReadingWereadApiKey,
  hideReadingNote,
  listReadingBooks,
  listReadingNotes,
  markReadingBlurred,
  markReadingSeen,
  reactPlusOneReadingNote,
  removeReadingBlur,
  removeReadingHighlight,
  reviseReadingNote,
  searchReadingWeread,
  searchReadingBooks,
  syncReadingWereadShelf,
  updateReadingBook,
  updateReadingSettings
} from "../services/reading/reading-store";
import { runReadingTaskAsync } from "../services/reading/reading-task-runner";
import { generateReadingCover } from "../services/reading/cover-generator";
import { refreshReadingQuotes } from "../services/reading/quote-provider";
import { generateReadingShareCard } from "../services/reading/share-card-service";
import { createLogger } from "../services/infra/logger";

const log = createLogger("reading-rpc");
import {
  readingAddBookInputSchema,
  readingAddBookToAliceInputSchema,
  readingBookIdInputSchema,
  readingConnectWereadInputSchema,
  readingGenerateShareCardInputSchema,
  readingListNotesInputSchema,
  readingMarkSeenInputSchema,
  readingNoteIdInputSchema,
  readingReviseNoteInputSchema,
  readingRunTaskInputSchema,
  readingSearchWereadInputSchema,
  readingSearchBooksInputSchema,
  readingUpdateBookInputSchema,
  readingUpdateSettingsInputSchema,
  wereadApiKeyInputSchema,
  wereadBestBookmarksInputSchema,
  wereadBookIdInputSchema,
  wereadGenerateNoteInputSchema,
  wereadPublicReviewsInputSchema,
  wereadReadDataInputSchema,
  wereadSearchBooksInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import type { NotificationWriter } from "./types";
import { validateInput } from "./validation";
import { emitReadingGenerationNotification } from "../services/reading/reading-notifications";
import {
  createDefaultWereadIpcSource,
  exportAllReadingNotes,
  generateWereadReadingNote,
  type WereadGenerateNoteInput,
  type WereadIpcSource
} from "../services/reading/weread-ipc-service";
import { clearWereadCache } from "../services/reading/weread-cache-service";

function listReadingBooksWithBootstrap() {
  ensureReadingBootstrapBook();
  return listReadingBooks();
}

export interface CreateReadingHandlersContext {
  writeNotification?: NotificationWriter;
  weread?: WereadIpcSource;
}

export function createReadingHandlers(context: CreateReadingHandlersContext = {}): Record<string, RpcHandler> {
  const weread = context.weread ?? createDefaultWereadIpcSource();
  return {
    [READING_IPC_CHANNELS.GET_SNAPSHOT]: async () => getReadingSnapshot(),
    [READING_IPC_CHANNELS.UPDATE_SETTINGS]: async (params) =>
      updateReadingSettings(validateInput(
        readingUpdateSettingsInputSchema,
        params,
        READING_IPC_CHANNELS.UPDATE_SETTINGS
      ) as ReadingUpdateSettingsInput),
    [READING_IPC_CHANNELS.LIST_BOOKS]: async () => listReadingBooksWithBootstrap(),
    [READING_IPC_CHANNELS.LIST_NOTES]: async (params) =>
      listReadingNotes(validateInput(
        readingListNotesInputSchema,
        params ?? {},
        READING_IPC_CHANNELS.LIST_NOTES
      ) as ReadingListNotesInput | undefined),
    [READING_IPC_CHANNELS.GET_NOTE]: async (params) => {
      const input = validateInput(readingNoteIdInputSchema, params, READING_IPC_CHANNELS.GET_NOTE) as { id: string };
      return getReadingNote(input.id);
    },
    [READING_IPC_CHANNELS.ADD_BOOK]: async (params) =>
      addReadingBook(validateInput(
        readingAddBookInputSchema,
        params,
        READING_IPC_CHANNELS.ADD_BOOK
      ) as ReadingAddBookInput),
    [READING_IPC_CHANNELS.ADD_BOOK_TO_ALICE]: async (params) => {
      const input = validateInput(
        readingAddBookToAliceInputSchema,
        params,
        READING_IPC_CHANNELS.ADD_BOOK_TO_ALICE
      ) as ReadingAddBookToAliceInput;
      return addReadingBook({
        title: input.title,
        track: "recommended",
        status: "queued",
        source: {
          kind: "manual",
          title: input.title,
          excerpt: input.reason
        },
        tags: ["用户推荐"]
      });
    },
    [READING_IPC_CHANNELS.UPDATE_BOOK]: async (params) =>
      updateReadingBook(validateInput(
        readingUpdateBookInputSchema,
        params,
        READING_IPC_CHANNELS.UPDATE_BOOK
      ) as ReadingUpdateBookInput),
    [READING_IPC_CHANNELS.HIDE_NOTE]: async (params) => {
      const input = validateInput(readingNoteIdInputSchema, params, READING_IPC_CHANNELS.HIDE_NOTE) as { id: string };
      return hideReadingNote(input.id);
    },
    [READING_IPC_CHANNELS.DELETE_NOTE]: async (params) => {
      const input = validateInput(readingNoteIdInputSchema, params, READING_IPC_CHANNELS.DELETE_NOTE) as { id: string };
      return deleteReadingNote(input.id);
    },
    [READING_IPC_CHANNELS.MARK_SEEN]: async (params) => {
      const input = validateInput(readingMarkSeenInputSchema, params ?? {}, READING_IPC_CHANNELS.MARK_SEEN) as { noteIds?: string[] } | undefined;
      return markReadingSeen(input?.noteIds);
    },
    [READING_IPC_CHANNELS.GET_UNREAD_COUNTS]: async () => getReadingUnreadCounts(),
    [READING_IPC_CHANNELS.GET_HIGHLIGHTS]: async () => getReadingHighlights(),
    [READING_IPC_CHANNELS.REMOVE_HIGHLIGHT]: async (params) => {
      const input = validateInput(readingNoteIdInputSchema, params, READING_IPC_CHANNELS.REMOVE_HIGHLIGHT) as { id: string };
      return removeReadingHighlight(input.id);
    },
    [READING_IPC_CHANNELS.GET_BLURS]: async () => getReadingBlurs(),
    [READING_IPC_CHANNELS.ADD_BLUR]: async (params) => {
      const input = validateInput(readingNoteIdInputSchema, params, READING_IPC_CHANNELS.ADD_BLUR) as { id: string };
      return markReadingBlurred(input.id);
    },
    [READING_IPC_CHANNELS.REMOVE_BLUR]: async (params) => {
      const input = validateInput(readingNoteIdInputSchema, params, READING_IPC_CHANNELS.REMOVE_BLUR) as { id: string };
      return removeReadingBlur(input.id);
    },
    [READING_IPC_CHANNELS.REACT_PLUS_ONE]: async (params) => {
      const input = validateInput(readingNoteIdInputSchema, params, READING_IPC_CHANNELS.REACT_PLUS_ONE) as { id: string };
      return reactPlusOneReadingNote(input.id);
    },
    [READING_IPC_CHANNELS.RUN_TASK]: async (params) => {
      const input = validateInput(
        readingRunTaskInputSchema,
        params ?? {},
        READING_IPC_CHANNELS.RUN_TASK
      ) as ReadingRunTaskInput | undefined;
      log.info("RPC: 执行读书任务", { bookId: input?.bookId, depth: input?.depth });
      return runReadingTaskAndNotify(context, input ?? {});
    },
    [READING_IPC_CHANNELS.FORCE_GENERATE_NOTE]: async (params) => {
      const input = validateInput(
        readingRunTaskInputSchema,
        params ?? {},
        READING_IPC_CHANNELS.FORCE_GENERATE_NOTE
      ) as ReadingRunTaskInput | undefined;
      log.info("RPC: 强制生成读书笔记", { bookId: input?.bookId, depth: input?.depth });
      return runReadingTaskAndNotify(context, { ...input, trigger: "manual" });
    },
    [READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE]: async (params) => {
      const input = validateInput(
        readingRunTaskInputSchema,
        params ?? {},
        READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE
      ) as ReadingRunTaskInput | undefined;
      log.info("RPC: 手动生成读书笔记", { bookId: input?.bookId, depth: input?.depth, trigger: input?.trigger ?? "conversation" });
      return runReadingTaskAndNotify(context, { ...input, trigger: input?.trigger ?? "conversation" });
    },
    [READING_IPC_CHANNELS.REVISE_NOTE]: async (params) =>
      reviseReadingNote(validateInput(
        readingReviseNoteInputSchema,
        params,
        READING_IPC_CHANNELS.REVISE_NOTE
      ) as ReadingNoteRevisionInput),
    [READING_IPC_CHANNELS.CONNECT_WEREAD]: async (params) => {
      clearWereadCache();
      log.info("RPC: 连接微信读书");
      const connection = connectReadingWeread(validateInput(
        readingConnectWereadInputSchema,
        params,
        READING_IPC_CHANNELS.CONNECT_WEREAD
      ) as ReadingConnectWereadInput);
      try {
        syncReadingWereadShelf(await weread.shelf());
      } catch (error) {
        log.warn("微信读书书架同步失败", { error: error instanceof Error ? error.message : String(error) });
      }
      return connection;
    },
    [READING_IPC_CHANNELS.DISCONNECT_WEREAD]: async () => {
      clearWereadCache();
      return disconnectReadingWeread();
    },
    [READING_IPC_CHANNELS.SEARCH_WEREAD]: async (params) => {
      const input = validateInput(
        readingSearchWereadInputSchema,
        params,
        READING_IPC_CHANNELS.SEARCH_WEREAD
      ) as ReadingSearchWereadInput;
      return searchReadingWeread(input.query, input.limit);
    },
    [READING_IPC_CHANNELS.SEARCH_BOOKS]: async (params) => {
      const input = validateInput(
        readingSearchBooksInputSchema,
        params,
        READING_IPC_CHANNELS.SEARCH_BOOKS
      ) as ReadingSearchBooksInput;
      return searchReadingBooks(input.query, input.limit);
    },
    [READING_IPC_CHANNELS.GENERATE_COVER]: async (params) => {
      const input = validateInput(readingBookIdInputSchema, params, READING_IPC_CHANNELS.GENERATE_COVER) as { bookId: string };
      return generateReadingCover(input);
    },
    [READING_IPC_CHANNELS.DELETE_COVER]: async (params) => {
      const input = validateInput(readingBookIdInputSchema, params, READING_IPC_CHANNELS.DELETE_COVER) as { bookId: string };
      return deleteReadingBookCover(input.bookId);
    },
    [READING_IPC_CHANNELS.REFRESH_QUOTES]: async (params) => {
      const input = validateInput(readingBookIdInputSchema, params, READING_IPC_CHANNELS.REFRESH_QUOTES) as { bookId: string };
      return refreshReadingQuotes(input);
    },
    [READING_IPC_CHANNELS.GET_BOOK_DEBUG_INFO]: async (params) => {
      const input = validateInput(readingBookIdInputSchema, params, READING_IPC_CHANNELS.GET_BOOK_DEBUG_INFO) as { bookId: string };
      return getReadingBookDebugInfo(input.bookId);
    },
    [READING_IPC_CHANNELS.GENERATE_SHARE_CARD]: async (params) => {
      const input = validateInput(
        readingGenerateShareCardInputSchema,
        params,
        READING_IPC_CHANNELS.GENERATE_SHARE_CARD
      ) as ReadingGenerateShareCardInput;
      return generateReadingShareCard(input);
    },
    [WEREAD_IPC_CHANNELS.OPEN_AND_FETCH_KEY]: async () => weread.openAndFetchKey(),
    [WEREAD_IPC_CHANNELS.GET_KEY]: async () => ({ apiKey: getReadingWereadApiKey() }),
    [WEREAD_IPC_CHANNELS.TEST_KEY]: async (params) => {
      const input = validateInput(wereadApiKeyInputSchema, params, WEREAD_IPC_CHANNELS.TEST_KEY) as { apiKey: string };
      return weread.testKey(input.apiKey);
    },
    [WEREAD_IPC_CHANNELS.GET_SHELF]: async () => ({
      books: await weread.shelf()
    }),
    [WEREAD_IPC_CHANNELS.GET_NOTEBOOKS]: async () => ({
      notebooks: await weread.notebooks()
    }),
    [WEREAD_IPC_CHANNELS.GET_BOOKMARKS]: async (params) => {
      const input = validateInput(wereadBookIdInputSchema, params, WEREAD_IPC_CHANNELS.GET_BOOKMARKS) as { bookId: string };
      return {
        bookmarks: await weread.bookmarks(input.bookId)
      };
    },
    [WEREAD_IPC_CHANNELS.GET_REVIEWS]: async (params) => {
      const input = validateInput(wereadBookIdInputSchema, params, WEREAD_IPC_CHANNELS.GET_REVIEWS) as { bookId: string };
      return {
        reviews: await weread.reviews(input.bookId)
      };
    },
    [WEREAD_IPC_CHANNELS.GET_READ_DATA]: async (params) => {
      const input = validateInput(wereadReadDataInputSchema, params ?? {}, WEREAD_IPC_CHANNELS.GET_READ_DATA) as { period?: string } | undefined;
      return weread.readdata(input?.period);
    },
    [WEREAD_IPC_CHANNELS.GET_BEST_BOOKMARKS]: async (params) => {
      const input = validateInput(wereadBestBookmarksInputSchema, params, WEREAD_IPC_CHANNELS.GET_BEST_BOOKMARKS) as {
        bookId: string;
        bookTitle?: string;
      };
      return {
        bookmarks: await weread.bestBookmarks(input.bookId, input.bookTitle)
      };
    },
    [WEREAD_IPC_CHANNELS.GET_PUBLIC_REVIEWS]: async (params) => {
      const input = validateInput(wereadPublicReviewsInputSchema, params, WEREAD_IPC_CHANNELS.GET_PUBLIC_REVIEWS) as {
        bookId: string;
        listType?: string;
        bookTitle?: string;
      };
      return {
        reviews: await weread.publicReviews(input.bookId, input.listType, input.bookTitle)
      };
    },
    [WEREAD_IPC_CHANNELS.GENERATE_NOTE]: async (params) => {
      const input = validateInput(
        wereadGenerateNoteInputSchema,
        params,
        WEREAD_IPC_CHANNELS.GENERATE_NOTE
      ) as WereadGenerateNoteInput;
      const result = await generateWereadReadingNote(input);
      emitReadingGenerationNotification(context.writeNotification, result, {
        trigger: "manual",
        depth: "deep"
      });
      return result;
    },
    [WEREAD_IPC_CHANNELS.EXPORT_ALL_NOTES]: async () => exportAllReadingNotes({
      onProgress: (progress) => context.writeNotification?.(WEREAD_IPC_CHANNELS.EXPORT_PROGRESS, progress)
    }),
    [WEREAD_IPC_CHANNELS.SEARCH_BOOKS]: async (params) => {
      const input = validateInput(wereadSearchBooksInputSchema, params, WEREAD_IPC_CHANNELS.SEARCH_BOOKS) as {
        keyword: string;
        limit?: number;
      };
      return {
        results: await weread.search(input.keyword, input.limit)
      };
    }
  };
}

async function runReadingTaskAndNotify(
  context: CreateReadingHandlersContext,
  input: ReadingRunTaskInput
): Promise<ReadingTaskResult> {
  const result = await runReadingTaskAsync(input);
  emitReadingGenerationNotification(context.writeNotification, result, input);
  return result;
}
