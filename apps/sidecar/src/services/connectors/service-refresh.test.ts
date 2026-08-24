import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let refreshCalls = 0;

// 单文件 mock:service.ts 是 oauth-token 的唯一消费者,替换后刷新走本地桩
mock.module("./oauth/oauth-token", () => ({
  requestAuthorizationCodeToken: async (): Promise<never> => {
    throw new Error("requestAuthorizationCodeToken not expected in refresh tests");
  },
  requestRefreshToken: async () => {
    refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      authType: "oauth2" as const,
      accessToken: `refreshed-access-${refreshCalls}`,
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  },
}));

const { getConnectorOAuthCredentialFresh } = await import("./service");
const { setConnectorClientConfig, setConnectorOAuthCredential } = await import("./credential-store");
const { installConnectionVaultKey } = await import("../channel/connection-credential-store");

describe("oauth credential refresh single-flight", () => {
  let previousConfigDir: string | undefined;
  let directory = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connector-refresh-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 9).toString("base64"));
    refreshCalls = 0;
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
    setConnectorOAuthCredential("gmail", {
      authType: "oauth2",
      accessToken: "stale-access",
      tokenType: "Bearer",
      // 已过期:isExpiredSoon 命中刷新路径
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshToken: "rt-original",
      profile: { accountId: "acct", displayName: "Tester", grantedScopes: [] },
      metadata: {},
    });
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test("并发命中过期凭证只发起一次刷新,各调用拿到同一结果", async () => {
    const results = await Promise.all([
      getConnectorOAuthCredentialFresh("gmail"),
      getConnectorOAuthCredentialFresh("gmail"),
      getConnectorOAuthCredentialFresh("gmail"),
    ]);

    expect(refreshCalls).toBe(1);
    for (const credential of results) {
      expect(credential.accessToken).toBe("refreshed-access-1");
    }
  });

  test("刷新结果落盘,后续读取不再触发刷新;响应未带 RT 时保留原 RT", async () => {
    await getConnectorOAuthCredentialFresh("gmail");
    const again = await getConnectorOAuthCredentialFresh("gmail");

    expect(refreshCalls).toBe(1); // 新 expiresAt 在未来 → 直读
    expect(again.accessToken).toBe("refreshed-access-1");
    expect(again.refreshToken).toBe("rt-original"); // 桩未返回新 RT → 保留
  });

  test("单飞槽位完成后清除:记录再度过期时重新发起刷新", async () => {
    await getConnectorOAuthCredentialFresh("gmail");

    // 把凭证改回过期态(模拟时间流逝),单飞槽已被 finally 清空,应再次发起刷新
    setConnectorOAuthCredential("gmail", {
      authType: "oauth2",
      accessToken: "stale-access-2",
      tokenType: "Bearer",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      refreshToken: "rt-second",
      profile: { accountId: "acct", displayName: "Tester", grantedScopes: [] },
      metadata: {},
    });

    const refreshed = await getConnectorOAuthCredentialFresh("gmail");
    expect(refreshCalls).toBe(2);
    expect(refreshed.accessToken).toBe("refreshed-access-2");
  });
});
