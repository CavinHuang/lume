/**
 * 钉钉 CLI(dws)provider 配置。
 * 数据来源:wanta 移植(Explore 核实)。包 dingtalk-workspace-cli v1.0.55,license Apache-2.0。
 */
import { gunzipSync } from "node:zlib";
import { extractFileFromTar, extractFileFromZip, verifySha256, verifyTarballIntegrity } from "../archive-extract";

export interface CliProviderConfig {
  provider: string;
  npmPackage: string;
  version: string;
  binaryName: string;
  /** CLI 运行时需注入的环境变量 → userData 下子目录映射(如 { DWS_CONFIG_DIR: "config" }) */
  envDirs: Record<string, string>;
  authCommand: string[];
  authUrlPattern: RegExp;
  /** #598：authUrl host 白名单（后缀匹配，hostname === h 或以 .h 结尾）；命中 pattern 后须经此校验 */
  allowedAuthUrlHosts: string[];
  /** 授权后确认 connected 的独立命令(两段 spawn:authCommand exit 0 后再跑此命令判定) */
  statusCommand: string[];
  /** 解析 statusCommand 输出,判定是否已连接 */
  parseAuthStatus: (stdout: string) => { connected: boolean; profile?: string };
  /** 授权命令超时(ms)——钉钉含管理员审批窗口 */
  authTimeoutMs: number;
  /** 从子进程环境强制移除的敏感变量 */
  envDenyList: string[];
  /** 下载+校验+解压当前平台二进制;fetchImpl 注入便于测试(默认联网)。渠道差异下沉于此。 */
  acquireBinary: (platform: string, arch: string, fetchImpl: (url: string) => Promise<Buffer>) => Promise<Buffer>;
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
  allowedAuthUrlHosts: ["login.dingtalk.com"],
  statusCommand: ["auth", "status", "--format", "json"],
  parseAuthStatus: parseDingtalkAuthStatus,
  authTimeoutMs: 16 * 60 * 1000,
  envDenyList: ["DINGTALK_DWS_AGENTCODE", "DWS_CLIENT_ID", "DWS_CLIENT_SECRET"],
  acquireBinary: acquireDingtalkBinary,
};

/** 解析 statusCommand 的 JSON 输出(从混合日志文本提取 JSON);兼容 authenticated/connected/loggedIn/isLogin 命名 */
export function parseDingtalkAuthStatus(stdout: string): { connected: boolean; profile?: string } {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { connected: false };
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const connected =
      parsed.authenticated === true ||
      parsed.connected === true ||
      parsed.loggedIn === true ||
      parsed.isLogin === true;
    const profile = typeof parsed.profile === "string" ? parsed.profile : undefined;
    return { connected, profile };
  } catch {
    return { connected: false };
  }
}

/** 钉钉 npm tarball 整包 SRI(sha512-base64,数据源 wanta dingtalk-cli.ts) */
const DINGTALK_NPM_INTEGRITY =
  "sha512-0h4qxnHT3KUgNgzgUzwczZfnS0oKv9hc9mUPphJUZerqYjg6LtWtOvJRgFiMMCo9TfSmcx5/NfoItO7d1xmeVQ==";
/** 内层平台 asset sha256 hex(数据源 wanta DINGTALK_CLI_CHECKSUMS) */
const DINGTALK_CHECKSUMS: Readonly<Record<string, string>> = {
  "dws-darwin-amd64.tar.gz": "f465eb7ac38a8a84eac4eb821fd15424bfc6f6245a60fa695ba97a639970dd77",
  "dws-darwin-arm64.tar.gz": "dd753bbd051e5dd007cf433b8aa211c4a221dd73dfcb0b3783fa924d09f12351",
  "dws-linux-amd64.tar.gz": "051ba404a5f6a8fb15def0e0f5d9d273cf9d63f881df2fffe159f2c4ea3366e7",
  "dws-linux-arm64.tar.gz": "5961be0fd551ec8e69b6fff2b1609f73486f7e6c3ffe8eb4bb99fa1ed691b401",
  "dws-windows-amd64.zip": "9e273fa5f069a2606921aa5d325849a2245a1bb6d81329f5aa02376421c2330c",
  "dws-windows-arm64.zip": "2c417f8957b683d5e354fefeb9f06115bb020f957dbb3c4dbe078b2d1275e3f0",
};

interface DingtalkAsset {
  name: string;
  archive: "tar.gz" | "zip";
  binaryPath: string;
}

/** platform/arch → npm 包内 asset 名 + 内层归档类型 + 二进制路径(x64→amd64) */
function resolveDingtalkAsset(platform: string, arch: string): DingtalkAsset {
  const upstream = arch === "x64" ? "amd64" : arch;
  if (upstream !== "amd64" && upstream !== "arm64") {
    throw new Error(`钉钉 CLI 无预编译二进制: ${platform} ${arch}`);
  }
  if (platform === "darwin" || platform === "linux") {
    return { name: `dws-${platform}-${upstream}.tar.gz`, archive: "tar.gz", binaryPath: "dws" };
  }
  if (platform === "win32") {
    return { name: `dws-windows-${upstream}.zip`, archive: "zip", binaryPath: "dws.exe" };
  }
  throw new Error(`钉钉 CLI 无预编译二进制: ${platform} ${arch}`);
}

/** 两段下载:npm tarball(SRI 校验)→ gunzip+tar 取 platform asset(sha256)→ 内层解压取 dws。 */
async function acquireDingtalkBinary(
  platform: string,
  arch: string,
  fetchImpl: (url: string) => Promise<Buffer>,
): Promise<Buffer> {
  const asset = resolveDingtalkAsset(platform, arch);
  const url = `https://registry.npmjs.org/dingtalk-workspace-cli/-/dingtalk-workspace-cli-${dingtalkCliConfig.version}.tgz`;
  const tgz = await fetchImpl(url);
  verifyTarballIntegrity(tgz, DINGTALK_NPM_INTEGRITY, url);
  const assetBuf = extractFileFromTar(gunzipSync(tgz), `package/assets/${asset.name}`);
  if (!assetBuf) throw new Error(`钉钉 npm 包缺少 release asset: ${asset.name}`);
  verifySha256(assetBuf, DINGTALK_CHECKSUMS[asset.name] ?? "", asset.name);
  if (asset.archive === "tar.gz") {
    const binary = extractFileFromTar(gunzipSync(assetBuf), asset.binaryPath);
    if (!binary) throw new Error(`钉钉 CLI 二进制不在内层归档: ${asset.binaryPath}`);
    return binary;
  }
  const binary = extractFileFromZip(assetBuf, asset.binaryPath);
  if (!binary) throw new Error(`钉钉 CLI 二进制不在内层归档: ${asset.binaryPath}`);
  return binary;
}
