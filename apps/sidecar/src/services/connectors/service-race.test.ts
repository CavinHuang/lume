import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as realCreateServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 单文件 mock:兑换直接返回 canned 凭证(SSRF 护栏禁 loopback 真实请求);
// exchangeGate 挂起/failExchange 抛错供迟到失败场景控制时序
let exchangeGate: Promise<void> | null = null;
let exchangeEntered = false;
let failExchange = false;
mock.module("./oauth/oauth-token", () => ({
  requestAuthorizationCodeToken: async () => {
    exchangeEntered = true;
    if (exchangeGate) await exchangeGate;
    if (failExchange) throw new Error("exchange blew up");
    return {
      authType: "oauth2" as const,
      accessToken: "at",
      tokenType: "Bearer",
      refreshToken: "rt",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      profile: { accountId: "oauth2", displayName: "OAuth Credential", grantedScopes: [] },
      metadata: {},
    };
  },
  requestRefreshToken: async () => {
    throw new Error("not used in this suite");
  },
}));

const { disconnectConnector, registerConnector, setHttpServerFactoryForTest, startConnectorAuthorization } =
  await import("./service");
const { getConnectorCredentialRecord, setConnectorClientConfig } = await import("./credential-store");
const { installConnectionVaultKey } = await import("../channel/connection-credential-store");

/**
 * #689 回归:token 兑换成功后 validateAndStoreCredential 内部还有一次校验器网络 await,
 * 此窗口内断开连接,迟到结果不得把凭证写回复活"已连接"。
 */
describe("connector oauth flow termination vs in-flight persist (#689)", () => {
  let previousConfigDir: string | undefined;
  let directory = "";
  /** 校验器在途闸门:置位后测试可在窗口内注入 disconnect;用例间重置防旧门误释放。 */
  let releaseValidator: (() => void) | undefined;

  beforeEach(() => {
    releaseValidator = undefined;
    exchangeGate = null;
    exchangeEntered = false;
    failExchange = false;
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

  test("旧流兑换迟到失败不得摘除后继新流的 map 占位(finish 幂等)", async () => {
    setConnectorClientConfig("race_mail", {
      service: "race_mail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
    // A 流回调挂在兑换闸门内
    failExchange = true;
    let openGate!: () => void;
    exchangeGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const stale = startConnectorAuthorization("race_mail");
    stale.done.catch(() => {});
    const staleUrl = new URL(await stale.authorizationUrl);
    const staleState = staleUrl.searchParams.get("state");
    const staleLoopback = new URL(staleUrl.searchParams.get("redirect_uri") ?? "http://127.0.0.1:0/callback");
    const stalePage = fetch(`${staleLoopback.origin}/callback?state=${staleState}&code=old`).then(
      (res) => res.text(),
      () => "fetch-failed",
    );
    for (let i = 0; i < 600 && !exchangeEntered; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(exchangeEntered).toBe(true);

    // A 被顶掉,新流 B 立即接管 map 占位(failExchange 保持 true:A 放行后
    // 兑换须走 reject,才能触达 catch → pending.reject → finish 重放路径)
    exchangeGate = null;
    const fresh = startConnectorAuthorization("race_mail");
    fresh.done.catch(() => {});
    const freshUrl = new URL(await fresh.authorizationUrl);
    await expect(stale.done).rejects.toBeDefined();

    // A 的兑换此刻失败:catch → pending.reject → finish 重入,幂等守卫必须
    // 拦下重放,map 里仍是 B
    openGate();
    const pageText = await stalePage;
    expect(pageText).not.toContain("✅");

    // B 的真回调照常被处理:兑换即刻成功,校验器闸门就绪后放行
    failExchange = false;
    const freshState = freshUrl.searchParams.get("state");
    const freshLoopback = new URL(freshUrl.searchParams.get("redirect_uri") ?? "http://127.0.0.1:0/callback");
    const freshPage = fetch(`${freshLoopback.origin}/callback?state=${freshState}&code=new`).then(
      (res) => res.text(),
      () => "fetch-failed",
    );
    for (let i = 0; i < 600 && !releaseValidator; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    releaseValidator?.();
    expect(await freshPage).toContain("✅");
    expect(getConnectorCredentialRecord("race_mail").oauth).toBeDefined();
  });

  test("孤儿授权流终结不得摘除在位新流的 map 占位(bind 竞争红队 P2)", async () => {
    // 假工厂:bind 回调手工触发,回调页经 synthetic req/res 直调 handler,无真实网络
    const binds: Array<{ fire: () => void }> = [];
    const invokers: Array<(url: string) => Promise<string>> = [];
    const serverErrors: Array<() => void> = [];
    setHttpServerFactoryForTest(((handler: (req: IncomingMessage, res: ServerResponse) => void) => {
      const errorCbs: Array<(error: Error) => void> = [];
      let portSeed = 46000 + invokers.length * 10;
      invokers.push(
        (url: string) =>
          new Promise<string>((resolvePage) => {
            const resStub = {
              writeHead() {
                return { end: (body?: string) => resolvePage(body ?? "") };
              },
              end(body?: string) {
                resolvePage(body ?? "");
              },
            };
            void handler({ url } as IncomingMessage, resStub as unknown as ServerResponse);
          }),
      );
      serverErrors.push(() => {
        for (const cb of errorCbs) cb(new Error("injected listen failure"));
      });
      return {
        on(event: string, cb: (error: Error) => void) {
          if (event === "error") errorCbs.push(cb);
        },
        listen(_port: number, _host: string, callback: () => void) {
          binds.push({ fire: callback });
        },
        close() {},
        address() {
          return { port: portSeed++ };
        },
      } as unknown as Server;
    }) as unknown as typeof realCreateServer);

    try {
      setConnectorClientConfig("race_mail", {
        service: "race_mail",
        clientId: "cid",
        clientSecret: "csecret",
        extra: {},
        secretExtra: {},
      });
      // 双 START_AUTH 在任一 bind 决算前先后执行:#2 读 map 为空不顶替 → 双活
      const stale = startConnectorAuthorization("race_mail");
      stale.done.catch(() => {});
      const live = startConnectorAuthorization("race_mail");
      live.done.catch(() => {});
      binds[0]!.fire(); // A 占位
      binds[1]!.fire(); // B 覆盖,A 成孤儿(map 只剩 recordB)
      const liveUrl = new URL(await live.authorizationUrl);
      const liveState = liveUrl.searchParams.get("state");

      // 孤儿 A 的合法终结(注入 listen 失败):其首次 finish 若无条件 delete,
      // 摘掉的是 B 的占位——B 的真回调将 404、done 悬挂至超时
      serverErrors[0]!();
      await expect(stale.done).rejects.toBeDefined();

      // B 的真回调必须照常走完
      const pagePromise = invokers[1]!(`/callback?state=${liveState}&code=real`);
      for (let i = 0; i < 600 && !releaseValidator; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      releaseValidator?.();
      expect(await pagePromise).toContain("✅");
      await expect(live.done).resolves.toBeDefined();
      expect(getConnectorCredentialRecord("race_mail").oauth).toBeDefined();
    } finally {
      setHttpServerFactoryForTest(realCreateServer);
    }
  });
});
