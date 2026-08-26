import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 单文件 mock:兑换直接返回 canned 凭证(SSRF 护栏禁 loopback 真实请求);
// 在途窗口由校验器闸门制造,mock 不参与时序
mock.module("./oauth/oauth-token", () => ({
  requestAuthorizationCodeToken: async () => ({
    authType: "oauth2" as const,
    accessToken: "at",
    tokenType: "Bearer",
    refreshToken: "rt",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    profile: { accountId: "oauth2", displayName: "OAuth Credential", grantedScopes: [] },
    metadata: {},
  }),
  requestRefreshToken: async () => {
    throw new Error("not used in this suite");
  },
}));

const { disconnectConnector, registerConnector, startConnectorAuthorization } = await import("./service");
const { getConnectorCredentialRecord, setConnectorClientConfig } = await import("./credential-store");
const { installConnectionVaultKey } = await import("../channel/connection-credential-store");

/**
 * #689 回归:token 兑换成功后 validateAndStoreCredential 内部还有一次校验器网络 await,
 * 此窗口内断开连接,迟到结果不得把凭证写回复活"已连接"。
 */
describe("connector oauth 流终止与在途落盘竞态", () => {
  let previousConfigDir: string | undefined;
  let directory = "";
  /** 校验器在途闸门:置位后测试可在窗口内注入 disconnect。 */
  let releaseValidator: (() => void) | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connector-race-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 7).toString("base64"));

    registerConnector({
      definition: {
        service: "race_mail",
        displayName: "Race Mail",
        categories: [],
        authTypes: ["oauth2"],
        auth: [
          {
            type: "oauth2",
            authorizationUrl: "https://example.com/auth",
            tokenUrl: "https://example.com/token",
            scopes: [],
            tokenEndpointAuthMethod: "client_secret_post",
          },
        ],
        actions: [],
      },
      executors: {},
      validators: {
        oauth2: async () => {
          await new Promise<void>((resolve) => {
            releaseValidator = resolve;
          });
          return { profile: { accountId: "race@example.com" } };
        },
      },
    });
  });

  afterEach(() => {
    disconnectConnector("race_mail");
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test("校验器在途期间断开:迟到的凭证不得写盘复活", async () => {
    setConnectorClientConfig("race_mail", {
      service: "race_mail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
    const flow = startConnectorAuthorization("race_mail");
    flow.done.catch(() => {}); // 断开路径的预期 rejection,防 unhandled
    const url = new URL(await flow.authorizationUrl);
    const state = url.searchParams.get("state");
    const loopback = new URL(url.searchParams.get("redirect_uri") ?? "http://127.0.0.1:0/callback");

    // 真回调进入兑换→校验器闸门挂起;等闸门就绪即代表已越过 map 成员检查
    const callbackPage = fetch(`${loopback.origin}/callback?state=${state}&code=abc`).then(
      (res) => res.text(),
      () => "fetch-failed",
    );
    for (let i = 0; i < 600 && !releaseValidator; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!releaseValidator) {
      const peek = await Promise.race([callbackPage, new Promise<"pending">((r) => setTimeout(() => r("pending"), 500))]);
      throw new Error(`校验器未被调用;回调页状态: ${peek}`);
    }

    // 校验器在途窗口内断开:清凭证 + 终止流
    disconnectConnector("race_mail");
    await expect(flow.done).rejects.toBeDefined();
    releaseValidator?.();

    // 迟到的校验结果走完:凭证必须仍是空的(未复活)
    const pageText = await callbackPage;
    expect(pageText).not.toContain("✅");
    expect(getConnectorCredentialRecord("race_mail").oauth).toBeUndefined();
  });
});
