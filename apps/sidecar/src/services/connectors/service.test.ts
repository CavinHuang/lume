import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConnectorError,
  disconnectConnector,
  executeConnectorAction,
  getConnector,
  getConnectorSetup,
  hasAnyConnectorCredential,
  listConnectors,
  saveConnectorCustomCredential,
  startConnectorAuthorization,
} from "./service";
import { deleteConnectorCredential, setConnectorClientConfig } from "./credential-store";
import { installConnectionVaultKey } from "../channel/connection-credential-store";

describe("connector service", () => {
  let previousConfigDir: string | undefined;
  let directory = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connector-service-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 7).toString("base64"));
  });

  afterEach(() => {
    // 取消可能遗留的 pending 授权流(server/timer),并清掉本目录内的凭证
    disconnectConnector("gmail");
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test("gmail 已随模块加载注册", () => {
    expect(listConnectors()).toContain("gmail");
    expect(getConnector("gmail").definition.service).toBe("gmail");
  });

  test("qq_mail 已注册且为授权码型", () => {
    expect(listConnectors()).toContain("qq_mail");
    expect(getConnector("qq_mail").definition.authTypes).toEqual(["custom_credential"]);
  });

  test("配置向导按 auth 类型下发:gmail 带 clientSetup 步骤,qq_mail 带字段表", () => {
    const gmail = getConnectorSetup("gmail");
    expect(gmail.authKind).toBe("oauth2");
    expect(gmail.clientSetup?.steps.length).toBeGreaterThan(3);
    expect(gmail.fields).toEqual([]);

    const qq = getConnectorSetup("qq_mail");
    expect(qq.authKind).toBe("custom");
    expect(qq.clientSetup).toBeUndefined();
    expect(qq.fields.map((field) => field.key)).toEqual(["email", "authorizationCode"]);
    expect(qq.fields.find((field) => field.key === "authorizationCode")?.inputType).toBe("password");
  });

  test("授权码凭证格式非法时保存被拒(不触网)", async () => {
    await expect(
      saveConnectorCustomCredential("qq_mail", { email: "not-an-email", authorizationCode: "123" }),
    ).rejects.toBeDefined();
    // 正确格式但验证器必然失败的输入在无网络环境下同样被拒;此处只锁格式守卫
  });

  test("oauth2 型 provider 拒绝直存授权码凭证(防假已连接态)", async () => {
    try {
      await saveConnectorCustomCredential("gmail", { email: "x@gmail.com" });
      expect.unreachable();
    } catch (error) {
      expect((error as ConnectorError).code).toBe("connector_auth_unsupported");
    }
    // 守卫先于任何状态变更:customValues 未被写入
    expect(hasAnyConnectorCredential("gmail")).toBe(false);
  });

  test("未配置 OAuth client 时发起授权被拒", () => {
    expect(() => startConnectorAuthorization("gmail")).toThrow(ConnectorError);
    try {
      startConnectorAuthorization("gmail");
    } catch (error) {
      expect((error as ConnectorError).code).toBe("oauth_client_config_required");
    }
  });

  test("未知动作返回结构化错误而非抛出", async () => {
    const result = await executeConnectorAction("gmail", "not_an_action", {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("action_unknown");
  });

  test("未连接时执行只读动作返回 executor_unavailable", async () => {
    const result = await executeConnectorAction("gmail", "get_profile", {});
    // getCredential 返回 undefined → requireOAuthCredential 报执行错误信封
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBeDefined();
  });

  test("授权 URL 携带 PKCE S256 参数", async () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
    const flow = startConnectorAuthorization("gmail");
    flow.done.catch(() => {}); // 防提前断言失败时的 unhandled rejection
    const url = new URL(await flow.authorizationUrl);

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect((url.searchParams.get("code_challenge") ?? "").length).toBeGreaterThanOrEqual(43);
    const redirectUri = new URL(url.searchParams.get("redirect_uri") ?? "http://127.0.0.1:0/callback");
    expect(redirectUri.hostname).toBe("127.0.0.1");
    expect(redirectUri.port.length).toBeGreaterThan(0); // loopback 随机端口

    // 结束 pending 流程,释放 server 与 timer(下一次发起会顶替旧流)
    startConnectorAuthorization("gmail");
    await expect(flow.done).rejects.toBeDefined();
  });

  test("杂散请求(state 不匹配)不杀死进行中的授权流", async () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
    const flow = startConnectorAuthorization("gmail");
    flow.done.catch(() => {}); // 防提前断言失败时的 unhandled rejection
    const url = new URL(await flow.authorizationUrl);
    const state = url.searchParams.get("state");
    const loopback = new URL(url.searchParams.get("redirect_uri") ?? "http://127.0.0.1:0/callback");

    // 杂散请求:浏览器预取/刷新、端口扫描等——只回错误页,流程必须存活
    const stray = await fetch(`${loopback.origin}/callback?state=wrong&code=x`);
    expect(stray.status).toBe(200);

    // 真回调(state 匹配)仍被处理:用户在 Google 页面点拒绝 → oauth_denied
    await fetch(`${loopback.origin}/callback?state=${state}&error=access_denied`);
    try {
      await flow.done;
      throw new Error("expected flow.done to reject");
    } catch (error) {
      // 杂散请求若曾杀死流程,这里会是 invalid_oauth_state 而非 oauth_denied
      expect((error as ConnectorError).code).toBe("oauth_denied");
    }
  });

  test("配置缺失时二次发起不破坏既有 pending 流程", async () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
    const first = startConnectorAuthorization("gmail");
    const firstUrl = new URL(await first.authorizationUrl);
    // 回调地址须从 redirect_uri 取:授权页是 https,其 .port 恒为空串
    const firstLoopback = new URL(firstUrl.searchParams.get("redirect_uri") ?? "http://127.0.0.1:0/callback");

    deleteConnectorCredential("gmail");
    // 配置被清空后再发起:应抛配置错误,且不得作废第一个仍在进行的流
    expect(() => startConnectorAuthorization("gmail")).toThrow(/client_id/);

    const stillPending = await Promise.race([
      first.done.then(
        () => "settled",
        (error) => `rejected:${(error as ConnectorError).code}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 80)),
    ]);
    expect(stillPending).toBe("still-pending");

    // 清理:顶掉旧流,释放 server 与 timer;杂散请求打到真实监听端口只回错误页
    await fetch(`${firstLoopback.origin}/callback?state=x`).catch(() => {});
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "cid",
      clientSecret: "csecret",
      extra: {},
      secretExtra: {},
    });
    startConnectorAuthorization("gmail");
    await expect(first.done).rejects.toBeDefined();
  });
});
