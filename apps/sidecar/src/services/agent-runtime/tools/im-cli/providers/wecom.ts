/**
 * 企业微信 CLI(wecom-cli)provider 配置。
 * 数据来源:wanta 移植 + design 调研(2026-08-07)。包 @wecom/cli-{platform}-{arch} v0.1.9。
 * 注意:npm 包名按平台/架构变化(如 @wecom/cli-darwin-arm64),真实下载逻辑待 wanta 移植时按平台选包。
 * license:⚠️ 待确认(非阻塞)。
 */
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
  authTimeoutMs: 5 * 60 * 1000,
  envDenyList: [],
};

/** 从授权命令输出中提取企业微信登录 URL */
export function extractWecomAuthUrl(stdout: string): string | undefined {
  const match = stdout.match(wecomCliConfig.authUrlPattern);
  return match ? match[0] : undefined;
}

/** 解析 init/status 的 JSON 输出(从混合日志文本提取;兼容 connected/loggedIn/authenticated/isLogin 命名) */
export function parseWecomAuthStatus(stdout: string): { connected: boolean; profile?: string } {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { connected: false };
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const connected = Boolean(parsed.connected)
      || parsed.loggedIn === true
      || parsed.authenticated === true
      || parsed.isLogin === true;
    const profile = typeof parsed.profile === "string" ? parsed.profile : undefined;
    return { connected, profile };
  } catch {
    return { connected: false };
  }
}
