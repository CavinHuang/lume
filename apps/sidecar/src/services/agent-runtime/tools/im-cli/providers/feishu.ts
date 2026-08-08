/**
 * 飞书 CLI(lark-cli)provider 配置。
 * 数据来源:wanta 移植 + design 调研(2026-08-07)。包 @larksuite/cli v1.0.81,license MIT。
 */
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
  authTimeoutMs: 5 * 60 * 1000,
  envDenyList: [],
};

/** 从授权命令输出中提取 OAuth URL(飞书 / Lark 登录页) */
export function extractLarkAuthUrl(stdout: string): string | undefined {
  const match = stdout.match(larkCliConfig.authUrlPattern);
  return match ? match[0] : undefined;
}

/** 解析 auth status 的 JSON 输出(从混合日志文本提取;兼容 connected/loggedIn/authenticated/isLogin 命名) */
export function parseLarkAuthStatus(stdout: string): { connected: boolean; profile?: string } {
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
