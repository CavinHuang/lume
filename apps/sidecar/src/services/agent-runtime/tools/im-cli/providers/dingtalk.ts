/**
 * 钉钉 CLI(dws)provider 配置。
 * 数据来源:wanta 移植(Explore 核实)。包 dingtalk-workspace-cli v1.0.55,license Apache-2.0。
 */

export interface CliProviderConfig {
  provider: string;
  npmPackage: string;
  version: string;
  binaryName: string;
  /** CLI 运行时需注入的环境变量 → userData 下子目录映射(如 { DWS_CONFIG_DIR: "config" }) */
  envDirs: Record<string, string>;
  authCommand: string[];
  authUrlPattern: RegExp;
  /** 授权命令超时(ms)——钉钉含管理员审批窗口 */
  authTimeoutMs: number;
  /** 从子进程环境强制移除的敏感变量 */
  envDenyList: string[];
}

export const dingtalkCliConfig: CliProviderConfig = {
  provider: "dingtalk",
  npmPackage: "dingtalk-workspace-cli",
  version: "1.0.55",
  binaryName: "dws",
  envDirs: {
    DWS_CONFIG_DIR: "config",
    DWS_KEYCHAIN_DIR: "keychain",
  },
  authCommand: ["auth", "login", "--yes", "--format", "json", "--no-browser"],
  authUrlPattern: /https:\/\/login\.dingtalk\.com\/oauth2\/auth[^\s"']*/,
  authTimeoutMs: 16 * 60 * 1000,
  envDenyList: ["DINGTALK_DWS_AGENTCODE", "DWS_CLIENT_ID", "DWS_CLIENT_SECRET"],
};

/** 从授权命令输出中提取 OAuth URL */
export function extractDingtalkAuthUrl(stdout: string): string | undefined {
  const match = stdout.match(dingtalkCliConfig.authUrlPattern);
  return match ? match[0] : undefined;
}

/** 解析 auth status 命令的 JSON 输出(从混合日志文本中提取 JSON 对象) */
export function parseDingtalkAuthStatus(stdout: string): { connected: boolean; profile?: string } {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { connected: false };
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { connected?: boolean; profile?: string };
    return { connected: Boolean(parsed.connected), profile: parsed.profile };
  } catch {
    return { connected: false };
  }
}
