/**
 * CLI binary 下载管理:env 手动路径 → 缓存 → config.acquireBinary(渠道特定下载+校验+解压) → 落盘 0o755。
 * 渠道差异(钉钉两层 npm tarball / 飞书 GitHub release / 企微 registry packument)下沉到各 provider 的 acquireBinary。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CliProviderConfig } from "./providers/dingtalk";

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
  // 3. 下载 + 校验 + 解压 + 落盘(渠道特定逻辑下沉到 config.acquireBinary)
  const fetchImpl = deps?.fetchTarball ?? defaultFetchTarball;
  const binary = await config.acquireBinary(platform, arch, fetchImpl);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, binary, { mode: 0o755 });
  return { path: target, downloaded: true };
}

async function defaultFetchTarball(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载 CLI 失败: ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}
