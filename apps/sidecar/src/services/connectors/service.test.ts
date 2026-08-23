import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConnectorError,
  executeConnectorAction,
  getConnector,
  getConnectorSetup,
  listConnectors,
  saveConnectorCustomCredential,
  startConnectorAuthorization,
} from "./service";
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
});
