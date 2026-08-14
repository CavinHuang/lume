import { READING_IPC_CHANNELS, WEREAD_IPC_CHANNELS } from "@lume/shared";
import type {
  ReadingAddBookInput,
  ReadingConnectWereadInput,
  ReadingRunTaskInput,
  ReadingTaskResult,
  ReadingSearchBooksInput,
  ReadingUpdateSettingsInput
} from "@lume/shared";
import {
  addReadingBook,
  connectReadingWeread,
  getReadingSnapshot,
  getReadingWereadApiKey,
  searchReadingBooks,
  syncReadingWereadShelf,
  updateReadingSettings
} from "../services/reading/reading-store";
import { runReadingTaskAsync } from "../services/reading/reading-task-runner";
import { createLogger } from "../services/infra/logger";

const log = createLogger("reading-rpc");
import {
  readingAddBookInputSchema,
  readingConnectWereadInputSchema,
  readingRunTaskInputSchema,
  readingSearchBooksInputSchema,
  readingUpdateSettingsInputSchema,
  wereadApiKeyInputSchema,
  wereadBestBookmarksInputSchema,
  wereadBookIdInputSchema,
  wereadPublicReviewsInputSchema,
  wereadReadDataInputSchema
} from "./schemas";
import type { RpcHandler } from "./types";
import type { NotificationWriter } from "./types";
import { validateInput } from "./validation";
import { emitReadingGenerationNotification } from "../services/reading/reading-notifications";
import {
  createDefaultWereadIpcSource,
  type WereadIpcSource
} from "../services/reading/weread-ipc-service";
import { clearWereadCache } from "../services/reading/weread-cache-service";

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
    [READING_IPC_CHANNELS.ADD_BOOK]: async (params) =>
      addReadingBook(validateInput(
        readingAddBookInputSchema,
        params,
        READING_IPC_CHANNELS.ADD_BOOK
      ) as ReadingAddBookInput),
    [READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE]: async (params) => {
      const input = validateInput(
        readingRunTaskInputSchema,
        params ?? {},
        READING_IPC_CHANNELS.MANUAL_GENERATE_NOTE
      ) as ReadingRunTaskInput | undefined;
      log.info("RPC: 手动生成读书笔记", { bookId: input?.bookId, depth: input?.depth, trigger: input?.trigger ?? "conversation" });
      return runReadingTaskAndNotify(context, { ...input, trigger: input?.trigger ?? "conversation" });
    },
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
    [READING_IPC_CHANNELS.SEARCH_BOOKS]: async (params) => {
      const input = validateInput(
        readingSearchBooksInputSchema,
        params,
        READING_IPC_CHANNELS.SEARCH_BOOKS
      ) as ReadingSearchBooksInput;
      return searchReadingBooks(input.query, input.limit);
    },
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
