/**
 * 企业微信 CLI(wecom-cli)provider 配置。
 * 数据来源:wanta 移植 + design 调研(2026-08-07)。包 @wecom/cli-{platform}-{arch} v0.1.9。
 * 注意:npm 包名按平台/架构变化(如 @wecom/cli-darwin-arm64),真实下载逻辑待 wanta 移植时按平台选包。
 * license:⚠️ 待确认(非阻塞)。
 */
import { gunzipSync } from "node:zlib";
import { extractFileFromTar, verifyTarballIntegrity } from "../archive-extract";
import type { CliProviderConfig } from "./dingtalk";

export const wecomCliConfig: CliProviderConfig = {
  provider: "wecom",
  npmPackage: "@wecom/cli-{platform}-{arch}",
  version: "0.1.9",
  binaryName: "wecom-cli",
  envDirs: {
    WECOM_CLI_CONFIG_DIR: "config",
    WECOM_CLI_TMP_DIR: "tmp",
  },
  authCommand: ["init", "--noninteractive", "--no-open"],
  authUrlPattern: /https:\/\/[^"'\s]*work\.weixin\.qq\.com[^"'\s]*/,
  allowedAuthUrlHosts: ["work.weixin.qq.com"],
  statusCommand: ["auth", "show", "--auth-status"],
  parseAuthStatus: parseWecomAuthStatus,
  authTimeoutMs: 5 * 60 * 1000,
  envDenyList: [],
  acquireBinary: acquireWecomBinary,
};

/** 解析 statusCommand 输出:优先纯文本 "authorized",其次 JSON(兼容 connected/loggedIn/authenticated/isLogin) */
export function parseWecomAuthStatus(stdout: string): { connected: boolean; profile?: string } {
  const trimmed = stdout.trim();
  if (trimmed === "authorized") return { connected: true };
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { connected: false };
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const connected =
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

/** 企微 npm 平台子包的 gitHead 锁定(数据源 wanta WECOM_CLI_GIT_HEAD)。 */
const WECOM_GIT_HEAD = "72e14f7695f34d28f1ff23ea504ddd2210a87c13";

/** platform/arch → npm 平台子包名 + 二进制名。企微 arch 用 x64/arm64(process.arch 原值,非 amd64)。 */
function resolveWecomPackage(
  platform: string,
  arch: string,
): { packageName: string; binaryName: string } {
  const binaryName = platform === "win32" ? "wecom-cli.exe" : "wecom-cli";
  if ((platform === "darwin" || platform === "linux") && (arch === "arm64" || arch === "x64")) {
    return { packageName: `@wecom/cli-${platform}-${arch}`, binaryName };
  }
  if (platform === "win32" && arch === "x64") {
    return { packageName: `@wecom/cli-win32-${arch}`, binaryName };
  }
  throw new Error(`企微 CLI 无预编译二进制: ${platform} ${arch}`);
}

/**
 * registry 驱动下载:查 npm packument 取 dist.{tarball,integrity} + gitHead 锁定 →
 * 下载 tarball(SRI 校验)→ gunzip+tar 取 package/bin/<exe>。无静态 sha256 表(integrity 运行时取)。
 */
async function acquireWecomBinary(
  platform: string,
  arch: string,
  fetchImpl: (url: string) => Promise<Buffer>,
): Promise<Buffer> {
  const target = resolveWecomPackage(platform, arch);
  const packumentUrl = `https://registry.npmjs.org/${target.packageName}`;
  const packument = JSON.parse((await fetchImpl(packumentUrl)).toString("utf-8")) as {
    gitHead?: string;
    versions?: Record<string, { gitHead?: string; dist?: { tarball?: string; integrity?: string } }>;
  };
  const versionMeta = packument.versions?.[wecomCliConfig.version];
  const dist = versionMeta?.dist;
  if (!dist?.tarball || !dist?.integrity) {
    throw new Error(`企微 registry 无 ${target.packageName}@${wecomCliConfig.version} 的 dist 信息`);
  }
  const gitHead = versionMeta?.gitHead ?? packument.gitHead;
  if (gitHead !== WECOM_GIT_HEAD) {
    throw new Error(`企微 CLI gitHead 不匹配: 期望 ${WECOM_GIT_HEAD}, 实际 ${gitHead ?? "<missing>"}`);
  }
  const tgz = await fetchImpl(dist.tarball);
  verifyTarballIntegrity(tgz, dist.integrity, dist.tarball);
  const binary = extractFileFromTar(gunzipSync(tgz), `package/bin/${target.binaryName}`);
  if (!binary) throw new Error(`企微 CLI 二进制不在 tarball: package/bin/${target.binaryName}`);
  return binary;
}
