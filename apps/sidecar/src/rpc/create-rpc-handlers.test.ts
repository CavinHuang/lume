import { describe, expect, test } from "bun:test";
import {
  AGENT_IPC_CHANNELS,
  ALICE_READING_IPC_CHANNELS,
  AUTOMATION_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
  GENERAL_SETTINGS_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS,
  IM_IPC_CHANNELS,
  MEMORY_IPC_CHANNELS,
  READING_IPC_CHANNELS,
  WEREAD_IPC_CHANNELS
} from "@lume/shared";
import { createRpcHandlers } from "./create-rpc-handlers";

describe("createRpcHandlers", () => {
  test("rpc:list-methods 应包含拆分后的关键 method", async () => {
    const handlers = createRpcHandlers({
      writeNotification: () => {}
    });
    const listMethodsHandler = handlers["rpc:list-methods"];
    expect(listMethodsHandler).toBeDefined();
    if (!listMethodsHandler) {
      throw new Error("缺少 rpc:list-methods handler");
    }

    const methods = await listMethodsHandler(undefined) as string[];

    expect(methods).toEqual(expect.arrayContaining([
      "healthcheck",
      CHANNEL_IPC_CHANNELS.LIST,
      AGENT_IPC_CHANNELS.LIST_THREADS,
      AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS,
      AGENT_IPC_CHANNELS.LIST_MESSAGE_QUEUE,
      AGENT_IPC_CHANNELS.REORDER_MESSAGE_QUEUE,
      AGENT_IPC_CHANNELS.REMOVE_QUEUED_MESSAGE,
      AGENT_IPC_CHANNELS.PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE,
      MEMORY_IPC_CHANNELS.SEARCH,
      MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT,
      MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY,
      MEMORY_IPC_CHANNELS.GET_INGEST_JOB,
      MEMORY_IPC_CHANNELS.OPEN_SOURCE,
      MEMORY_IPC_CHANNELS.GET_RUNTIME_CONFIG,
      AUTOMATION_IPC_CHANNELS.LIST_JOBS,
      IM_IPC_CHANNELS.LIST_ACCOUNTS,
      READING_IPC_CHANNELS.GET_SNAPSHOT,
      READING_IPC_CHANNELS.ADD_BOOK_TO_ALICE,
      ALICE_READING_IPC_CHANNELS.GET_BOOKS,
      ALICE_READING_IPC_CHANNELS.MARK_NOTES_READ,
      WEREAD_IPC_CHANNELS.GET_SHELF,
      WEREAD_IPC_CHANNELS.GET_REVIEWS,
      WEREAD_IPC_CHANNELS.GENERATE_NOTE,
      WEREAD_IPC_CHANNELS.EXPORT_ALL_NOTES,
      GENERAL_SETTINGS_IPC_CHANNELS.LIST_LOG_FILES,
      GENERAL_SETTINGS_IPC_CHANNELS.READ_LOG_FILE,
      GENERAL_SETTINGS_IPC_CHANNELS.EXPORT_LOGS,
      GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE
    ]));
  });

  test("healthcheck 应返回 sidecar 基础元信息", async () => {
    const handlers = createRpcHandlers({
      writeNotification: () => {}
    });
    const healthcheckHandler = handlers.healthcheck;
    expect(healthcheckHandler).toBeDefined();
    if (!healthcheckHandler) {
      throw new Error("缺少 healthcheck handler");
    }

    const result = await healthcheckHandler(undefined) as {
      ok: boolean;
      source: string;
      version: string | number;
      pid: number;
      native: {
        available: boolean;
        capabilities: string[];
        error?: string | null;
      };
    };

    expect(result.ok).toBeTrue();
    expect(result.source).toBe("sidecar");
    expect(result.version).toBeDefined();
    expect(result.pid).toBe(process.pid);
    expect(typeof result.native.available).toBe("boolean");
    expect(Array.isArray(result.native.capabilities)).toBeTrue();
    expect("binaryPath" in result.native).toBeFalse();
  });

  test("renderer-facing log path methods must not expose local filesystem paths", async () => {
    const handlers = createRpcHandlers({
      writeNotification: () => {}
    });
    const getLogsDirHandler = handlers[AGENT_IPC_CHANNELS.GET_LOGS_DIR];
    expect(getLogsDirHandler).toBeDefined();
    if (!getLogsDirHandler) {
      throw new Error("缺少 agent:get-logs-dir handler");
    }

    const result = await getLogsDirHandler(undefined) as { path: string };

    expect(result).toEqual({ path: "" });
  });
});
