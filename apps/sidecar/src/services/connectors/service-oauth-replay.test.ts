import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const exchangeCalls: string[] = [];
/** 置为非 null 时兑换挂起直到 release(测 disconnect 取消在途兑换)。 */
let exchangeGate: { promise: Promise<void>; release: () => void } | null = null;

// 单文件 mock:兑换走本地桩计数;profile 校验短路(validator 失败不阻断落盘)。
// 导出面须与源模块一致(CI bun 对缺失具名导出抛错),expiresAtFromLifetime 一并补齐。
mock.module("./oauth/oauth-token", () => ({
  requestAuthorizationCodeToken: async (input: { code: string }) => {
    exchangeCalls.push(input.code);
    if (exchangeGate) {
      await exchangeGate.promise;
      exchangeGate = null;
    }
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

const {
  ConnectorError,
  disconnectConnector,
  startConnectorAuthorization,
} = await import("./service");
const { getConnectorOAuthCredential, setConnectorClientConfig } = await import("./credential-store");
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
    exchangeGate = null;
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
    // 兑换前置 exchanging 保证并发第二个回调被挡下
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

  test("disconnect 取消在途兑换:凭证不落盘", async () => {
    let releaseExchange!: () => void;
    exchangeGate = { promise: new Promise<void>((r) => (releaseExchange = r)), release: () => releaseExchange() };

    const flow = startConnectorAuthorization("gmail");
    // disconnect 会 reject done:提前挂 catch 防 unhandled rejection
    const doneOutcome = flow.done.then(
      () => "resolved",
      (error: unknown) => error as Error,
    );
    const authorizationUrl = await flow.authorizationUrl;
    const url = new URL(authorizationUrl);
    const port = new URL(url.searchParams.get("redirect_uri")!).port;

    void fetch(`http://127.0.0.1:${port}/callback?state=${url.searchParams.get("state")}&code=CODE-Y`);
    // 兑换进入挂起(桩 await gate)
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exchangeCalls).toEqual(["CODE-Y"]);

    // 用户断开连接:在途兑换必须作废
    disconnectConnector("gmail");
    releaseExchange();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getConnectorOAuthCredential("gmail")).toBeUndefined();
    const outcome = await doneOutcome;
    // 动态 import 的 ConnectorError 是运行时值,按结构断言 code
    expect((outcome as { code?: string }).code).toBe("oauth_flow_cancelled");
  });
});
