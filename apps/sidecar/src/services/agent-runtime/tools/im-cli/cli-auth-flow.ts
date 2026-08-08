/**
 * CLI OAuth 授权流程:spawn 授权命令 → 提取 OAuth URL(供 UI openExternal)→ 解析最终 status。
 * 凭据由 CLI 自管 config dir,本模块按 config.envDirs 注入 env 指向 userData 子路径。
 *
 * TODO(provider 分派):当前 URL/status 解析用钉钉实现;飞书/企微授权 UI 落地时,
 * 应注入对应 extractAuthUrl/parseAuthStatus(或 config 携带解析器引用)。
 */
import { join } from "node:path";
import type { CliExecOptions, CliExecResult } from "./cli-executor";
import type { CliProviderConfig } from "./providers/dingtalk";
import { extractDingtalkAuthUrl, parseDingtalkAuthStatus } from "./providers/dingtalk";

export type ExecCliFn = (
  command: string,
  args: string[],
  options: CliExecOptions,
) => Promise<CliExecResult>;

export interface CliAuthResult {
  authUrl?: string;
  status: { connected: boolean; profile?: string };
}

export async function runCliAuth(
  config: CliProviderConfig,
  binaryPath: string,
  userDataRoot: string,
  exec: ExecCliFn,
): Promise<CliAuthResult> {
  const env: Record<string, string> = {};
  for (const [envName, subdir] of Object.entries(config.envDirs)) {
    env[envName] = join(userDataRoot, `${config.provider}-cli`, subdir);
  }
  const result = await exec(binaryPath, config.authCommand, {
    env,
    envDenyList: config.envDenyList,
    timeoutMs: config.authTimeoutMs,
  });
  const authUrl = extractDingtalkAuthUrl(`${result.stdout}\n${result.stderr}`);
  const status = parseDingtalkAuthStatus(result.stdout);
  return { authUrl, status };
}
