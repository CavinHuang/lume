import { describe, expect, test } from "bun:test";
import {
  AGENT_IPC_CHANNELS,
  AUTOMATION_IPC_CHANNELS,
  CHANNEL_IPC_CHANNELS,
  GITHUB_RELEASE_IPC_CHANNELS,
  MEMORY_IPC_CHANNELS
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
      MEMORY_IPC_CHANNELS.SEARCH,
      MEMORY_IPC_CHANNELS.SETTINGS_SNAPSHOT,
      MEMORY_IPC_CHANNELS.ORGANIZE_HISTORY,
      MEMORY_IPC_CHANNELS.OPEN_SOURCE,
      MEMORY_IPC_CHANNELS.GET_RUNTIME_CONFIG,
      AUTOMATION_IPC_CHANNELS.LIST_JOBS,
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
    };

    expect(result.ok).toBeTrue();
    expect(result.source).toBe("sidecar");
    expect(result.version).toBeDefined();
    expect(result.pid).toBe(process.pid);
  });
});
