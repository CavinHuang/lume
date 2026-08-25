import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// type-only 导入运行时擦除,不破坏 mock 先于模块求值的顺序
import type { ConnectorError } from "./service";

// #689 断开与在途 token 兑换的写回竞态回归套件。
// 兑换必须 mock.module 桩掉:providerFetch 对 loopback 有 SSRF 硬拦(core/request.ts always-blocked),
// 本地假 token endpoint 不可行;入站回调监听是裸 node:http,不在守卫射程,用真实 fetch 驱动
// (service.test.ts 杂散请求用例成例)。全流程由显式 gate 控制,零 sleep。

let releaseExchange!: (credential: Record<string, unknown>) => void;
let exchangeRequestedResolve!: () => void;
let exchangeRequested!: Promise<void>;
let validatorEnteredResolve!: () => void;
let validatorEntered!: Promise<void>;
let resolveValidatorGate!: () => void;
let validatorGate!: Promise<void>;

// mock 工厂闭包经此盒读取当前 gate:工厂只在模块求值时执行一次,须间接引用可重置句柄
const exchangeGateRef: { current: Promise<Record<string, unknown>> } = { current: Promise.resolve({}) };

function resetGates(): void {
  exchangeGateRef.current = new Promise<Record<string, unknown>>((resolve) => {
    releaseExchange = resolve;
  });
  exchangeRequested = new Promise<void>((resolve) => {
    exchangeRequestedResolve = resolve;
  });
  validatorEntered = new Promise<void>((resolve) => {
    validatorEnteredResolve = resolve;
  });
  validatorGate = new Promise<void>((resolve) => {
    resolveValidatorGate = resolve;
  });
}

const raceCredential = {
  authType: "oauth2",
  accessToken: "race-access",
  tokenType: "Bearer",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  refreshToken: "rt-race",
  profile: { accountId: "race@probe.test", displayName: "Race Probe", grantedScopes: [] as string[] },
  metadata: {},
};

// 单文件 mock:枚举面照 service-refresh.test.ts 成例——service.ts 只绑定这两个函数,
// expiresAtFromLifetime 全仓零外部 importer 不进工厂(#724 教训只约束被绑定导出)
mock.module("./oauth/oauth-token", () => ({
  requestAuthorizationCodeToken: () => {
    exchangeRequestedResolve(); // handler 已受理回调并悬在兑换上
    return exchangeGateRef.current;
  },
  requestRefreshToken: async (): Promise<never> => {
    throw new Error("requestRefreshToken not expected in oauth race tests");
  },
}));

const { disconnectConnector, registerConnector, startConnectorAuthorization } = await import("./service");
const { getConnectorOAuthCredential, setConnectorClientConfig } = await import("./credential-store");
const { installConnectionVaultKey } = await import("../channel/connection-credential-store");

registerConnector({
  definition: {
    service: "race-probe",
    displayName: "Race Probe",
    categories: ["probe"],
    authTypes: ["oauth2"],
    auth: [
      {
        type: "oauth2",
        authorizationUrl: "https://example.com/authorize",
        tokenUrl: "https://example.com/token",
        scopes: ["probe"],
        tokenEndpointAuthMethod: "client_secret_post",
      },
    ],
    actions: [],
  },
  executors: {},
  validators: {
    async oauth2() {
      validatorEnteredResolve();
      await validatorGate;
      return { profile: { accountId: "race@probe.test", displayName: "Race Probe" } };
    },
  },
});

describe("#689 断开与在途兑换的写回竞态", () => {
  let previousConfigDir: string | undefined;
  let directory = "";

  beforeEach(() => {
    resetGates();
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connector-oauth-race-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 11).toString("base64"));
    setConnectorClientConfig("race-probe", {
      service: "race-probe",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
  });

  afterEach(() => {
    // 兜底放行在途 gate,防止悬挂请求拖死整个套件
    exchangeRequestedResolve();
    releaseExchange(raceCredential);
    resolveValidatorGate();
    disconnectConnector("race-probe");
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  /** 发起授权并驱动真回调;outcome 捕获 done 结局。 */
  async function startFlowAndCallback() {
    const flow = startConnectorAuthorization("race-probe");
    const outcome = flow.done.then(
      () => "resolved" as const,
      (error) => `rejected:${(error as ConnectorError).code}`,
    );
    const url = new URL(await flow.authorizationUrl);
    const loopback = new URL(url.searchParams.get("redirect_uri") ?? "http://127.0.0.1:0/callback");
    void fetch(`${loopback.origin}/callback?state=${url.searchParams.get("state")}&code=code`);
    return { outcome };
  }

  /** 排空当前微任务风暴:Bun 下 server.close() 可能提前毁掉在途回调 socket,
   * 回调页不可作收尾屏障;丢弃路径无后续真实异步,一个宏任务轮转即保证 handler 同步尾全部执行。 */
  function drainQueue(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  test("无断开时全流程正常落盘(防过杀)", async () => {
    const { outcome } = await startFlowAndCallback();
    releaseExchange(raceCredential);
    await validatorEntered;
    resolveValidatorGate();
    expect(await outcome).toBe("resolved");
    expect(getConnectorOAuthCredential("race-probe")?.profile?.accountId).toBe("race@probe.test");
  });

  test("兑换期间断开:旧流凭证不落盘(#705 守卫钉)", async () => {
    const { outcome } = await startFlowAndCallback();
    await exchangeRequested; // 回调已被受理、handler 悬在兑换上,此刻断开才落在兑换窗内
    disconnectConnector("race-probe");
    releaseExchange(raceCredential);
    await drainQueue();
    expect(await outcome).toBe("rejected:oauth_flow_cancelled");
    expect(getConnectorOAuthCredential("race-probe")).toBeUndefined();
  });

  test("validator 在途期间断开:陈旧凭证不得写回(#689 主测)", async () => {
    const { outcome } = await startFlowAndCallback();
    releaseExchange(raceCredential); // 通过兑换与一次性守卫,进入 validator 异步边界
    await validatorEntered;
    disconnectConnector("race-probe"); // 断开精确落在 validator await 窗口
    resolveValidatorGate();
    await drainQueue(); // 保证 handler 恢复后的同步收尾(含盲写/拦截分支)已执行完再断言
    expect(await outcome).toBe("rejected:oauth_flow_cancelled");
    // pre-fix:盲写把凭证复活进已终止流程,此处必红;post-fix:落盘前 identity 复检拦截
    expect(getConnectorOAuthCredential("race-probe")).toBeUndefined();
  });
});
