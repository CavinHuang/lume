import { createConnection } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CheckBridgeStatusInput,
  CheckBridgeStatusResult,
} from "@lume/shared";

export class PluginBridgeError extends Error {
  constructor(
    public readonly code:
      | "unsupported_verify"
      | "unsafe_target",
    message: string,
  ) {
    super(message);
    this.name = "PluginBridgeError";
  }
}

export interface PluginBridgeServiceConfig {
  fetchImpl?: typeof fetch;
}

export function createDefaultPluginBridgeService(): PluginBridgeService {
  return new PluginBridgeService();
}

const TCP_TIMEOUT_MS = 2000;

export class PluginBridgeService {
  private readonly fetchImpl: typeof fetch;

  constructor(config: PluginBridgeServiceConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
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
