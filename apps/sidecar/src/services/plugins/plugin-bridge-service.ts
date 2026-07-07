import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type {
  CheckBridgeStatusInput,
  CheckBridgeStatusResult,
  DownloadBridgeAssetInput,
  DownloadBridgeAssetResult,
  ExportPluginArtifactInput,
  ExportPluginArtifactResult,
} from "@lume/shared";

export class PluginBridgeError extends Error {
  constructor(
    public readonly code:
      | "artifact_not_found"
      | "download_failed"
      | "verify_failed"
      | "unsupported_verify"
      | "unsafe_target",
    message: string,
  ) {
    super(message);
    this.name = "PluginBridgeError";
  }
}

export interface PluginBridgeServiceConfig {
  installedRoot: string;
  fetchImpl?: typeof fetch;
}

export function createDefaultPluginBridgeService(): PluginBridgeService {
  return new PluginBridgeService({
    installedRoot: join(homedir(), ".lume", "plugins"),
  });
}

const TCP_TIMEOUT_MS = 2000;

export class PluginBridgeService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: PluginBridgeServiceConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  /** 导出已安装插件目录内的桥接产物到本地目录。 */
  async exportPluginArtifact(input: ExportPluginArtifactInput): Promise<ExportPluginArtifactResult> {
    const src = this.resolveArtifactPath(input.pluginId, input.version, input.artifactPath);
    if (!existsSync(src)) {
      throw new PluginBridgeError("artifact_not_found", `桥接产物不存在: ${input.artifactPath}`);
    }
    const destDir = input.destDir ?? join(homedir(), "Downloads");
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, basename(src));
    await copyFile(src, dest);
    return { savedPath: dest };
  }

  /** 下载外部桥接资产（如 GitHub Release），可选 sha256 校验。 */
  async downloadBridgeAsset(input: DownloadBridgeAssetInput): Promise<DownloadBridgeAssetResult> {
    if (!input.url.startsWith("https://")) {
      throw new PluginBridgeError("download_failed", "仅允许 https 下载源");
    }
    const filename = input.filename ?? (basename(new URL(input.url).pathname) || "bridge-asset.bin");
    const destDir = input.destDir ?? join(homedir(), "Downloads");
    await mkdir(destDir, { recursive: true });
    const dest = join(destDir, filename);

    const resp = await this.fetchImpl(input.url);
    if (!resp.ok || !resp.body) {
      throw new PluginBridgeError("download_failed", `下载失败: HTTP ${resp.status}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    await mkdir(dirname(dest), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(dest, buf);

    let verified = true;
    if (input.sha256) {
      const actual = createHash("sha256").update(buf).digest("hex");
      verified = actual === input.sha256.toLowerCase();
      if (!verified) {
        throw new PluginBridgeError("verify_failed", `sha256 不匹配: 期望 ${input.sha256}, 实际 ${actual}`);
      }
    }
    return { savedPath: dest, verified };
  }

  /** 检测桥接是否就绪。tcp-port/http-get 仅允许本地地址。 */
  async checkBridgeStatus(input: CheckBridgeStatusInput): Promise<CheckBridgeStatusResult> {
    const { method, detail } = input.verify;
    switch (method) {
      case "none":
        return { ok: true, detail: "无需检测" };
      case "tcp-port": {
        const target = parseHostPort(detail ?? "");
        if (!isLocalHost(target.host)) {
          throw new PluginBridgeError("unsafe_target", `仅允许本地地址: ${detail}`);
        }
        const ok = await probeTcp(target.host, target.port);
        return { ok, detail: ok ? `${detail} 可连接` : `${detail} 未监听` };
      }
      case "http-get": {
        const url = new URL(detail ?? "");
        if (!isLocalHost(url.hostname)) {
          throw new PluginBridgeError("unsafe_target", `仅允许本地地址: ${detail}`);
        }
        try {
          const r = await this.fetchImpl(url.toString());
          return { ok: r.ok, detail: `HTTP ${r.status}` };
        } catch {
          return { ok: false, detail: "请求失败" };
        }
      }
      case "chrome-extension": {
        const ok = checkChromeExtensionInstalled(detail ?? "");
        return { ok, detail: ok ? "扩展已加载" : "未检测到扩展" };
      }
      default:
        throw new PluginBridgeError("unsupported_verify", `不支持的检测方式: ${method}`);
    }
  }

  private resolveArtifactPath(pluginId: string, version: string, artifactPath: string): string {
    // artifactPath 形如 "./ext.zip"；拼到 ~/.lume/plugins/<id>/<ver>/<path>
    const rel = artifactPath.replace(/^\.\//, "");
    return join(this.config.installedRoot, pluginId, version, rel);
  }
}

function parseHostPort(detail: string): { host: string; port: number } {
  const m = detail.match(/^([^:]+):(\d+)$/);
  if (!m) throw new PluginBridgeError("unsafe_target", `非法的地址格式: ${detail}`);
  return { host: m[1]!, port: Number(m[2]!) };
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function probeTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const socket = createConnection({ host, port }, () => {
      if (!done) { done = true; socket.destroy(); resolve(true); }
    });
    socket.on("error", () => { if (!done) { done = true; resolve(false); } });
    setTimeout(() => { if (!done) { done = true; socket.destroy(); resolve(false); } }, TCP_TIMEOUT_MS);
  });
}

/** 扫描 Chrome 扩展目录（MVP: Windows）。 */
function checkChromeExtensionInstalled(extensionId: string): boolean {
  if (!/^[a-p]{32}$/i.test(extensionId)) return false;
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const base = join(localAppData, "Google", "Chrome", "User Data", "Default", "Extensions", extensionId);
  try {
    return existsSync(base) && readdirSync(base).length > 0;
  } catch {
    return false;
  }
}
