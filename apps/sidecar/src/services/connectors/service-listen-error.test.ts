import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as realCreateServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";
import {
  setHttpServerFactoryForTest,
  startConnectorAuthorization,
  disconnectConnector,
} from "./service";
import { setConnectorClientConfig } from "./credential-store";
import { installConnectionVaultKey } from "../channel/connection-credential-store";

// #687 回归钉死:server 绑定失败(listen 尚未回调时触发 error 事件)时,
// authorizationUrl 必须 reject 而非永久悬挂——修复前该 promise 只有 resolve
// 通路,START_AUTH 会挂死至 RPC 超时且真实错误丢失。
// 经 setHttpServerFactoryForTest 注入替身:listen 中不触发成功回调,
// 由测试手工注入 error 事件复现失败窗口。afterEach 还原默认工厂。

const restoreRealServer = (): void => setHttpServerFactoryForTest(realCreateServer);

describe("oauth flow listen failure (#687)", () => {
  let directory = "";
  let emitServerError: ((error: Error) => void) | null = null;

  const configure = (): void => {
    directory = mkdtempSync(join(tmpdir(), "lume-listen-error-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 7).toString("base64"));
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
    setHttpServerFactoryForTest(() => {
      const errorHandlers: Array<(error: Error) => void> = [];
      const server = {
        on(event: string, handler: (error: Error) => void) {
          if (event === "error") errorHandlers.push(handler);
        },
        listen() {
          /* 绑定悬而未决:成功回调永不触发,保留 error 通路供注入 */
        },
        close() {},
        address() {
          return null;
        },
      } as unknown as Server;
      emitServerError = (error) => {
        for (const handler of errorHandlers) handler(error);
      };
      return server;
    });
  };

  test("authorizationUrl rejects instead of hanging when the listener errors before ready", async () => {
    configure();
    const flow = startConnectorAuthorization("gmail");
    flow.done.catch(() => {});

    const outcome = await Promise.race([
      (async () => {
        emitServerError?.(new Error("EACCES: bind refused"));
        return await flow.authorizationUrl.then(
          () => "resolved" as const,
          () => "rejected" as const,
        );
      })(),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 1000)),
    ]);
    // 修复前的实现此处置 "stuck"(url promise 无 reject 通路)
    expect(outcome).toBe("rejected");

    // done 同步终结且错误码为 listen 失败
    const doneCode = await flow.done.then(
      () => "resolved",
      (error) => String((error as { code?: string }).code),
    );
    expect(doneCode).toBe("oauth_listen_failed");
  });

  afterEach(() => {
    restoreRealServer();
    disconnectConnector("gmail");
    if (process.env.LUME_CONFIG_DIR?.includes("lume-listen-error")) {
      rmSync(process.env.LUME_CONFIG_DIR, { recursive: true, force: true });
      delete process.env.LUME_CONFIG_DIR;
    }
  });
});
