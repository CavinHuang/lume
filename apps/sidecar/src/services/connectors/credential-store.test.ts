import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteConnectorCredential,
  getConnectorClientConfig,
  getConnectorCustomValues,
  getConnectorOAuthCredential,
  setConnectorClientConfig,
  setConnectorCustomValues,
  setConnectorOAuthCredential,
} from "./credential-store";
import { installConnectionVaultKey } from "../channel/connection-credential-store";
import { getConnectorCredentialsPath } from "../infra/config-paths";

describe("connector credential store", () => {
  let previousConfigDir: string | undefined;
  let directory = "";

  beforeEach(() => {
    previousConfigDir = process.env.LUME_CONFIG_DIR;
    directory = mkdtempSync(join(tmpdir(), "lume-connector-credentials-"));
    process.env.LUME_CONFIG_DIR = directory;
    installConnectionVaultKey(Buffer.alloc(32, 7).toString("base64"));
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.LUME_CONFIG_DIR;
    else process.env.LUME_CONFIG_DIR = previousConfigDir;
    rmSync(directory, { recursive: true, force: true });
  });

  test("client config 与 oauth 凭证往返且落盘为密文", () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "id.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret",
      extra: {},
      secretExtra: {},
    });
    setConnectorOAuthCredential("gmail", {
      authType: "oauth2",
      accessToken: "access-token",
      tokenType: "Bearer",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      profile: { accountId: "me@gmail.com", displayName: "me@gmail.com", grantedScopes: [] },
      metadata: {},
    });

    const raw = readFileSync(getConnectorCredentialsPath(), "utf8");
    expect(raw).not.toContain("GOCSPX-secret");
    expect(raw).not.toContain("access-token");

    expect(getConnectorClientConfig("gmail")?.clientSecret).toBe("GOCSPX-secret");
    expect(getConnectorOAuthCredential("gmail")?.refreshToken).toBe("refresh-token");
    expect(getConnectorClientConfig("outlook")).toBeUndefined();
  });

  test("delete 清空记录", () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "id",
      clientSecret: "s",
      extra: {},
      secretExtra: {},
    });
    deleteConnectorCredential("gmail");
    expect(getConnectorClientConfig("gmail")).toBeUndefined();
    // 删除后文件仍存在但无残留明文
    expect(existsSync(getConnectorCredentialsPath())).toBe(true);
  });

  test("授权码型凭证(customValues)往返且落盘为密文", () => {
    setConnectorCustomValues("qq_mail", { email: "user@qq.com", authorizationCode: "abcd".repeat(4) });
    const raw = readFileSync(getConnectorCredentialsPath(), "utf8");
    expect(raw).not.toContain("abcd");
    expect(getConnectorCustomValues("qq_mail")?.email).toBe("user@qq.com");
    expect(getConnectorOAuthCredential("qq_mail")).toBeUndefined();
  });

  test("vault 未解锁时读取视为未配置而非崩溃", () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "id",
      clientSecret: "s",
      extra: {},
      secretExtra: {},
    });
    // 换一把 key 模拟轮换:解密失败应降级为空记录
    installConnectionVaultKey(Buffer.alloc(32, 9).toString("base64"));
    expect(getConnectorClientConfig("gmail")).toBeUndefined();
  });
});
