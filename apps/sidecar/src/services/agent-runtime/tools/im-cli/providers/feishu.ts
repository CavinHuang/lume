/**
 * 飞书 CLI(lark-cli)provider 配置。
 * 数据来源:wanta 移植 + design 调研(2026-08-07)。包 @larksuite/cli v1.0.81,license MIT。
 */
import { gunzipSync } from "node:zlib";
import { extractFileFromTar, extractFileFromZip, verifySha256 } from "../archive-extract";
import type { CliProviderConfig } from "./dingtalk";

export const larkCliConfig: CliProviderConfig = {
  provider: "feishu",
  npmPackage: "@larksuite/cli",
  version: "1.0.81",
  binaryName: "lark-cli",
  envDirs: {
    LARKSUITE_CLI_CONFIG_DIR: "config",
  },
  authCommand: ["auth", "login", "--recommend", "--json"],
  authUrlPattern: /https:\/\/[^"'\s]*(?:feishu\.cn|larksuite\.com)[^"'\s]*/,
  statusCommand: ["auth", "status", "--json", "--verify"],
  parseAuthStatus: parseLarkAuthStatus,
  authTimeoutMs: 5 * 60 * 1000,
  envDenyList: [],
  acquireBinary: acquireLarkBinary,
};

/** 解析 auth status 的 JSON 输出(从混合日志文本提取;兼容 connected/loggedIn/authenticated/isLogin 命名) */
export function parseLarkAuthStatus(stdout: string): { connected: boolean; profile?: string } {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { connected: false };
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const connected =
      (parsed.identity === "user" && parsed.verified !== false) ||
      parsed.connected === true ||
      parsed.loggedIn === true ||
      parsed.authenticated === true ||
      parsed.isLogin === true;
    const profile = typeof parsed.profile === "string" ? parsed.profile : undefined;
    return { connected, profile };
  } catch {
    return { connected: false };
  }
}

/** GitHub release asset sha256 hex(数据源 wanta LARK_CLI_CHECKSUMS) */
const LARK_CHECKSUMS: Readonly<Record<string, string>> = {
  "lark-cli-1.0.81-darwin-amd64.tar.gz": "8efdf2706a98c22d6ee4600f6c4656b1f9924c2e277821753199c5f4f8486b29",
  "lark-cli-1.0.81-darwin-arm64.tar.gz": "0693846b129044a8c1312999f04ff26343b9a2fdb41615343e33fe67cea9dea5",
  "lark-cli-1.0.81-linux-amd64.tar.gz": "4c783dc4bb7dd9829184058f09e1953ad5016c2fea6a38b5ae2966b191907a33",
  "lark-cli-1.0.81-linux-arm64.tar.gz": "31691d8391d2a2cc64203b3fe4a4dd595da8f03b6c86a8be53af1f3bdb15dc64",
  "lark-cli-1.0.81-linux-riscv64.tar.gz": "4323e7111a5a3a53187a4efdf0644852e18dde9bac24a267fe028c5baa6e533d",
  "lark-cli-1.0.81-windows-amd64.zip": "d6ba5f4794dde63ed1b5f2373ab6cb2fcdcabf8b9dcdf0a701362a78c1ed1c74",
  "lark-cli-1.0.81-windows-arm64.zip": "c4305ddb55cf1b9e06cb33b7c9c2289a5632e313254c5edea3c84306bce732cd",
};

/** 单层下载:GitHub release asset(sha256)→ 解压取 lark-cli。x64→amd64;win→zip,余→tar.gz。 */
async function acquireLarkBinary(
  platform: string,
  arch: string,
  fetchImpl: (url: string) => Promise<Buffer>,
): Promise<Buffer> {
  const upstream = arch === "x64" ? "amd64" : arch;
  const ext = platform === "win32" ? "zip" : "tar.gz";
  const binaryPath = platform === "win32" ? "lark-cli.exe" : "lark-cli";
  const name = `lark-cli-${larkCliConfig.version}-${platform}-${upstream}.${ext}`;
  const url = `https://github.com/larksuite/cli/releases/download/v${larkCliConfig.version}/${name}`;
  const archive = await fetchImpl(url);
  verifySha256(archive, LARK_CHECKSUMS[name] ?? "", name);
  const binary = ext === "tar.gz"
    ? extractFileFromTar(gunzipSync(archive), binaryPath)
    : extractFileFromZip(archive, binaryPath);
  if (!binary) throw new Error(`飞书 CLI 二进制不在归档: ${binaryPath}`);
  return binary;
}
