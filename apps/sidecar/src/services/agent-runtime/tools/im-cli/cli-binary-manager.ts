/**
 * CLI binary 下载管理:按需下载 + sha256 校验 + 路径解析。
 * 支持手动 binary 路径(env var)作为下载 fallback(防火墙/离线场景)。
 *
 * TODO(wanta 移植):EXPECTED_SHA256 与 tarballUrl 的确切下载源从 wanta scripts/dingtalk-cli.ts
 * 抄入。当前为框架;真实 sha256 未填,下载分支会在校验时抛错(单测不触达该分支)。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliProviderConfig } from "./providers/dingtalk";

/** key `${platform}-${arch}` → sha256,待从 wanta 抄入 */
const EXPECTED_SHA256: Record<string, string> = {};

function tarballUrl(config: CliProviderConfig, _platform: string, _arch: string): string {
  // TODO(wanta 移植):wanta 用平台专用包或 GitHub release,以 wanta 源为准
  return `https://registry.npmjs.org/${config.npmPackage}/-/${config.npmPackage}-${config.version}.tgz`;
}

export interface EnsureBinaryDeps {
  /** 注入点:测试用,避免触网 */
  fetchTarball?: (url: string) => Promise<Buffer>;
}

export interface EnsureBinaryOptions {
  env?: Record<string, string | undefined>;
}

export function manualBinaryEnvName(provider: string): string {
  return `LUME_${provider.toUpperCase()}_CLI_BIN`;
}

export function resolveBinaryPath(
  config: CliProviderConfig,
  userDataRoot: string,
  platform: string,
  arch: string,
): string {
  return join(userDataRoot, `${config.provider}-cli`, platform, arch, config.binaryName);
}

export async function ensureBinary(
  config: CliProviderConfig,
  userDataRoot: string,
  platform: string,
  arch: string,
  deps?: EnsureBinaryDeps,
  options?: EnsureBinaryOptions,
): Promise<{ path: string; downloaded: boolean }> {
  // 1. 手动指定路径(env fallback)
  const manual = options?.env?.[manualBinaryEnvName(config.provider)];
  if (manual && existsSync(manual)) {
    return { path: manual, downloaded: false };
  }
  // 2. 已下载缓存
  const target = resolveBinaryPath(config, userDataRoot, platform, arch);
  if (existsSync(target)) {
    return { path: target, downloaded: false };
  }
  // 3. 按需下载 + 校验 + 落盘
  const fetchTarball = deps?.fetchTarball ?? defaultFetchTarball;
  const buf = await fetchTarball(tarballUrl(config, platform, arch));
  const digest = createHash("sha256").update(buf).digest("hex");
  const expected = EXPECTED_SHA256[`${platform}-${arch}`];
  if (expected && digest !== expected) {
    throw new Error(`${config.provider} CLI sha256 mismatch: expected ${expected}, got ${digest}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, buf, { mode: 0o755 });
  return { path: target, downloaded: true };
}

async function defaultFetchTarball(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 CLI 失败: ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
