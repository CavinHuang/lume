import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exchangeCalls: string[] = [];

// 单文件 mock:兑换走本地桩计数;profile 校验短路(validator 失败不阻断落盘)。
// 导出面须与源模块一致(CI bun 对缺失具名导出抛错),expiresAtFromLifetime 一并补齐。
mock.module("./oauth/oauth-token", () => ({
  requestAuthorizationCodeToken: async (input: { code: string }) => {
    exchangeCalls.push(input.code);
    return {
      authType: "oauth2" as const,
      accessToken: "at-test",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      profile: { accountId: "me@gmail.com", displayName: "me@gmail.com", grantedScopes: [] },
      metadata: {},
    };
  },
  requestRefreshToken: async (): Promise<never> => {
    throw new Error("requestRefreshToken not expected in replay tests");
  },
  expiresAtFromLifetime: (lifetimeSeconds: unknown): string | undefined =>
    typeof lifetimeSeconds === "number" ? new Date(Date.now() + lifetimeSeconds * 1000).toISOString() : undefined,
}));

// providerFetch 短路:oauth2 validator 的 getProfile 会打真 Google 端点。
// bun 的 mock.module factory 不支持 importOriginal,先取原命名空间供复刻
// 其余导出(defineProviderExecutors 等被 gmail/qq_mail executors 顶层消费)。
const providerRuntimeActual = await import("./providers/provider-runtime");
mock.module("./providers/provider-runtime", () => ({
  ...providerRuntimeActual,
  // bun 全局 fetch 类型带 preconnect 方法,桩需双跳断言
  providerFetch: (() =>
    Promise.reject(new Error("network disabled in oauth replay tests"))) as unknown as typeof fetch,
}));

const { disconnectConnector, startConnectorAuthorization } = await import("./service");
const { setConnectorClientConfig } = await import("./credential-store");
const { installConnectionVaultKey } = await import("../channel/connection-credential-store");

describe("oauth callback replay guard", () => {
  let previousConfigDir: string | undefined;
  let directory = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-oauth-replay-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 5).toString("base64"));
    exchangeCalls.length = 0;
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

  test("同一授权流的并发重复回调只触发一次 code 兑换", async () => {
    // RFC 6749 §4.1.2:同一 code 兑换两次会被授权服务器视为攻击并撤销已发凭证——
    // 兑换前摘除 pending 保证并发第二个回调落入 state 不匹配分支
    const flow = startConnectorAuthorization("gmail");
    const authorizationUrl = await flow.authorizationUrl;
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get("state");
    const port = new URL(url.searchParams.get("redirect_uri")!).port;
    expect(state).toBeTruthy();

    await Promise.allSettled([
      flow.done,
      fetch(`http://127.0.0.1:${port}/callback?state=${state}&code=CODE-X`),
      fetch(`http://127.0.0.1:${port}/callback?state=${state}&code=CODE-X`),
    ]);

    expect(exchangeCalls).toEqual(["CODE-X"]);
  });
});
