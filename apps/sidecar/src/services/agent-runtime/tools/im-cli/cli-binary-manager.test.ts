import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveBinaryPath, ensureBinary, manualBinaryEnvName } from "./cli-binary-manager";
import { dingtalkCliConfig, type CliProviderConfig } from "./providers/dingtalk";

/** 构造最小 config,acquireBinary 注入:测 ensureBinary 的 env/cache/落盘编排,不耦合 provider 校验。 */
function makeMockConfig(acquireBinary: CliProviderConfig["acquireBinary"]): CliProviderConfig {
  return {
    provider: "mock",
    npmPackage: "mock-cli",
    version: "1.0.0",
    binaryName: "mock",
    envDirs: {},
    authCommand: [],
    authUrlPattern: /x/,
    allowedAuthUrlHosts: ["login.dingtalk.com"],
    statusCommand: [],
    parseAuthStatus: () => ({ connected: false }),
    authTimeoutMs: 1000,
    envDenyList: [],
    acquireBinary,
  };
}

describe("resolveBinaryPath", () => {
  it("返回 userData 下按平台/架构组织的 binary 路径", () => {
    const p = resolveBinaryPath(dingtalkCliConfig, "/userdata", "darwin", "arm64");
    expect(p).toContain("dingtalk-cli");
    expect(p).toContain("darwin");
    expect(p).toContain("arm64");
    expect(p).toContain("dws");
  });

  it("缓存路径含 version 段(#536)", () => {
    const p = resolveBinaryPath(dingtalkCliConfig, "/userdata", "darwin", "arm64");
    expect(p).toContain(dingtalkCliConfig.version);
  });
});

describe("manualBinaryEnvName", () => {
  it("生成 LUME_<PROVIDER>_CLI_BIN", () => {
    expect(manualBinaryEnvName("dingtalk")).toBe("LUME_DINGTALK_CLI_BIN");
    expect(manualBinaryEnvName("mock")).toBe("LUME_MOCK_CLI_BIN");
  });
});

describe("ensureBinary", () => {
  let root = "";
  function freshRoot(): string {
    root = mkdtempSync(join(tmpdir(), "lume-binmgr-test-"));
    return root;
  }
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  it("env 手动路径存在 → 直接返回,不调用 acquireBinary", async () => {
    let called = false;
    const config = makeMockConfig(async () => {
      called = true;
      return Buffer.alloc(0);
    });
    const res = await ensureBinary(config, freshRoot(), "darwin", "arm64", undefined, {
      env: { LUME_MOCK_CLI_BIN: process.execPath },
    });
    expect(res.path).toBe(process.execPath);
    expect(res.downloaded).toBe(false);
    expect(called).toBe(false);
  });

  it("下载分支 → 调用 acquireBinary 并落盘", async () => {
    const config = makeMockConfig(async () => Buffer.from("BINARY"));
    const res = await ensureBinary(config, freshRoot(), "darwin", "arm64");
    expect(res.downloaded).toBe(true);
    expect(existsSync(res.path)).toBe(true);
    expect(readFileSync(res.path, "utf-8")).toBe("BINARY");
  });

  it("缓存命中 → 第二次不调用 acquireBinary", async () => {
    let calls = 0;
    const config = makeMockConfig(async () => {
      calls += 1;
      return Buffer.from("BINARY");
    });
    const r = freshRoot();
    const first = await ensureBinary(config, r, "darwin", "arm64");
    const second = await ensureBinary(config, r, "darwin", "arm64");
    expect(first.downloaded).toBe(true);
    expect(second.downloaded).toBe(false);
    expect(second.path).toBe(first.path);
    expect(calls).toBe(1);
  });

  it("acquireBinary 抛错 → 不落盘半截文件且向上抛出", async () => {
    const config = makeMockConfig(async () => {
      throw new Error("下载失败");
    });
    const r = freshRoot();
    await expect(ensureBinary(config, r, "darwin", "arm64")).rejects.toThrow("下载失败");
    const target = resolveBinaryPath(config, r, "darwin", "arm64");
    expect(existsSync(target)).toBe(false);
  });

  it("版本升级 → 旧版本缓存不命中，重新下载新版本(#536)", async () => {
    let calls = 0;
    const v1 = makeMockConfig(async () => {
      calls += 1;
      return Buffer.from("V1");
    });
    const r = freshRoot();
    await ensureBinary(v1, r, "darwin", "arm64");

    const v2: CliProviderConfig = {
      ...makeMockConfig(async () => {
        calls += 1;
        return Buffer.from("V2");
      }),
      version: "1.0.1",
    };
    const resV2 = await ensureBinary(v2, r, "darwin", "arm64");

    expect(resV2.downloaded).toBe(true);
    expect(readFileSync(resV2.path, "utf-8")).toBe("V2");
    expect(calls).toBe(2);
  });
});
