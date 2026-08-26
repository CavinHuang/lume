import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { platform } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

  // win32 忽略 POSIX mode 位(实际保护靠 %USERPROFILE% NTFS ACL),断言只在 POSIX 平台有意义
  const skipWindows = platform() === "win32" ? test.skip : test;
  skipWindows("落盘文件权限收紧为 0600", () => {
    setConnectorCustomValues("qq_mail", { email: "user@qq.com", authorizationCode: "abcd".repeat(4) });
    const mode = statSync(getConnectorCredentialsPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("文件损坏时读取降级且写入被拒,不静默清空现存凭证", () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "id",
      clientSecret: "s",
      extra: {},
      secretExtra: {},
    });
    // 模拟磁盘/中断导致的半截文件
    writeFileSync(getConnectorCredentialsPath(), '{"version":1,"cred', "utf8");

    expect(getConnectorClientConfig("gmail")).toBeUndefined(); // 读降级,UI 不崩
    expect(() =>
      setConnectorCustomValues("qq_mail", { email: "u@qq.com", authorizationCode: "abcd".repeat(4) }),
    ).toThrow(); // 拒绝把残缺集合覆盖成单条记录
  });

  test("文件级损坏时断开即删除坏文件,重连路径畅通", () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "id",
      clientSecret: "s",
      extra: {},
      secretExtra: {},
    });
    writeFileSync(getConnectorCredentialsPath(), '{"version":1,"cred', "utf8");

    // 损坏状态下写入被拒(保护仍在)
    expect(() =>
      setConnectorCustomValues("qq_mail", { email: "u@qq.com", authorizationCode: "abcd".repeat(4) }),
    ).toThrow();

    // 用户按指引断开:应删除损坏文件本身,而非静默 no-op
    deleteConnectorCredential("gmail");
    expect(getConnectorClientConfig("gmail")).toBeUndefined();

    // 重连路径畅通
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "id2",
      clientSecret: "s2",
      extra: {},
      secretExtra: {},
    });
    expect(getConnectorClientConfig("gmail")?.clientId).toBe("id2");
  });

  test("陈留 .tmp 不阻塞后续写入(wx 自愈)", () => {
    // 模拟上次写后 rename 前进程中断留下的残留 tmp
    writeFileSync(`${getConnectorCredentialsPath()}.tmp`, "stale", { encoding: "utf8", mode: 0o600, flag: "wx" });

    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "id",
      clientSecret: "s",
      extra: {},
      secretExtra: {},
    });
    expect(getConnectorClientConfig("gmail")?.clientId).toBe("id");
  });

  test("记录密文不可解(vault key 轮换)时该条写入被拒,显式删除后可重建", () => {
    setConnectorClientConfig("gmail", {
      service: "gmail",
      clientId: "id",
      clientSecret: "s",
      extra: {},
      secretExtra: {},
    });
    installConnectionVaultKey(Buffer.alloc(32, 11).toString("base64")); // 轮换

    expect(() => setConnectorOAuthCredential("gmail", {
      authType: "oauth2",
      accessToken: "a",
      tokenType: "Bearer",
      profile: { accountId: "x", displayName: "x", grantedScopes: [] },
      metadata: {},
    })).toThrow(/unreadable/); // 盲写会抹掉残留 clientConfig,必须显式断开

    deleteConnectorCredential("gmail"); // 断开路径畅通,可重新配置
    expect(getConnectorClientConfig("gmail")).toBeUndefined();
    setConnectorOAuthCredential("gmail", {
      authType: "oauth2",
      accessToken: "fresh",
      tokenType: "Bearer",
      profile: { accountId: "x", displayName: "x", grantedScopes: [] },
      metadata: {},
    });
    expect(getConnectorOAuthCredential("gmail")?.accessToken).toBe("fresh");
  });
});
