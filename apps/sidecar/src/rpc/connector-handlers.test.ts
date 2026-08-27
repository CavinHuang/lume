import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnectorHandlers } from "./connector-handlers";
import { CONNECTOR_IPC_CHANNELS } from "@lume/shared";
import type { ConnectorStatus } from "@lume/shared";
import { disconnectConnector } from "../services/connectors/service";
import { setConnectorClientConfig } from "../services/connectors/credential-store";
import { installConnectionVaultKey } from "../services/channel/connection-credential-store";

describe("connector rpc handlers: auth state generations", () => {
  let previousConfigDir: string | undefined;
  let directory = "";
  const handlers = createConnectorHandlers();

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connector-rpc-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 13).toString("base64"));
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
  });

  afterEach(() => {
    disconnectConnector("gmail");
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 10));
  const call = async (channel: string, params: unknown): Promise<unknown> => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`no handler for ${channel}`);
    return handler(params);
  };

  test("二次发起后,被顶替旧流的回调不得覆盖新流的 authorizing 态", async () => {
    await call(CONNECTOR_IPC_CHANNELS.START_AUTH, { service: "gmail" });
    // 二次发起:第一个流被 supersede reject,其 catch 在微任务中执行
    const second = await call(CONNECTOR_IPC_CHANNELS.START_AUTH, { service: "gmail" });
    await flushMicrotasks();

    const status = (await call(CONNECTOR_IPC_CHANNELS.GET_STATUS, { service: "gmail" })) as ConnectorStatus;
    expect(status.authorizing).toBe(true); // 若无代际校验,这里会被旧流覆盖成 false+lastError
    expect(status.lastError).toBeUndefined();
    void second;
  });

  test("断开进行中的授权后,被拒流不得复活错误态", async () => {
    await call(CONNECTOR_IPC_CHANNELS.START_AUTH, { service: "gmail" });
    await call(CONNECTOR_IPC_CHANNELS.DISCONNECT, { service: "gmail" });
    await flushMicrotasks();

    const status = (await call(CONNECTOR_IPC_CHANNELS.GET_STATUS, { service: "gmail" })) as ConnectorStatus;
    expect(status.authorizing).toBe(false);
    expect(status.lastError).toBeUndefined(); // "授权已取消"不得复活
  });
});

describe("connector rpc handlers: SAVE_CREDENTIAL authType dispatch", () => {
  let previousConfigDir: string | undefined;
  let directory = "";
  const handlers = createConnectorHandlers();

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connector-rpc-save-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 13).toString("base64"));
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
  });

  afterEach(() => {
    disconnectConnector("gmail");
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test("OAuth 型服务拒绝授权码写入,customValues 不落盘", async () => {
    const saveHandler = handlers[CONNECTOR_IPC_CHANNELS.SAVE_CREDENTIAL];
    if (!saveHandler) throw new Error("no handler for SAVE_CREDENTIAL");
    const result = await saveHandler({
      service: "gmail",
      values: { email: "attacker@example.com" },
    }).then(
      () => "resolved" as const,
      (error) => String((error as { message?: string }).message ?? error),
    );
    expect(result).toContain("OAuth");
    // 守卫必须先于落盘:gmail 无 custom_credential,任何 values 都不得进入存储
    const statusHandler = handlers[CONNECTOR_IPC_CHANNELS.GET_STATUS];
    if (!statusHandler) throw new Error("no handler for GET_STATUS");
    const statusAfter = await statusHandler({ service: "gmail" });
    expect((statusAfter as ConnectorStatus).connected).toBe(false);
  });
});
