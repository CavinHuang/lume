import { execFileSync } from "node:child_process";
import type { AgentProxySettings, AgentProxyStatus } from "@lume/shared";
import { readPersistedSettings, writePersistedSettings } from "./settings-store";
import { createLogger } from "../infra/logger";

interface StoredSettings {
  version: 1;
  proxy: AgentProxySettings;
  [key: string]: unknown;
}

const SETTINGS_VERSION = 1;
const PROXY_SETTINGS_VERSION = 1;
const log = createLogger("proxy-settings");

const DEFAULT_PROXY_SETTINGS: AgentProxySettings = {
  version: PROXY_SETTINGS_VERSION,
  enabled: false,
  mode: "off"
};

type ProxyEnvironment = Record<string, string | undefined>;

interface SystemProxyDetectionOptions {
  env?: ProxyEnvironment;
  platform?: NodeJS.Platform;
  execFileSync?: typeof execFileSync;
}

interface ApplyProxySettingsOptions {
  detectSystemProxy?: () => SystemProxySnapshot;
  applyDispatcher?: (mode: AgentProxySettings["mode"], proxyUrl?: string) => Promise<void>;
}

// #578 review fix:ActiveProxyConfig 类型下沉 infra/proxy-config-holder 后,
// 此处仅保留文件内部使用的 type import——re-export 曾无任何消费者,系死导出。
import type { ActiveProxyConfig } from "../infra/proxy-config-holder";

type SystemProxySnapshot = Pick<ActiveProxyConfig, "httpProxy" | "httpsProxy" | "noProxy">;

function readStoredSettings(): StoredSettings {
  try {
    const parsed = readPersistedSettings() as Partial<StoredSettings>;
    const rawProxy = parsed.proxy ?? DEFAULT_PROXY_SETTINGS;
    return {
      ...parsed,
      version: SETTINGS_VERSION,
      proxy: normalizeProxySettings(rawProxy)
    };
  } catch (error) {
    log.error("failed to read proxy settings; using defaults", { error });
    return {
      version: SETTINGS_VERSION,
      proxy: DEFAULT_PROXY_SETTINGS
    };
  }
}

async function writeStoredSettings(proxy: AgentProxySettings): Promise<void> {
  const prev = readStoredSettings();
  const payload: StoredSettings = {
    ...prev,
    version: SETTINGS_VERSION,
    proxy
  };
  await writePersistedSettings(payload);
}

function pickProxyValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatHostPortProxy(host: string | undefined, port: string | undefined): string | undefined {
  const trimmedHost = pickProxyValue(host);
  const trimmedPort = pickProxyValue(port);
  if (!trimmedHost || !trimmedPort) {
    return undefined;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedHost)) {
    return trimmedHost;
  }
  return `http://${trimmedHost}:${trimmedPort}`;
}

function readEnvProxy(env: ProxyEnvironment = process.env): SystemProxySnapshot {
  return {
    httpProxy: pickProxyValue(env.HTTP_PROXY ?? env.http_proxy),
    httpsProxy: pickProxyValue(env.HTTPS_PROXY ?? env.https_proxy),
    noProxy: pickProxyValue(env.NO_PROXY ?? env.no_proxy)
  };
}

export function parseMacSystemProxyOutput(output: string): SystemProxySnapshot {
  const entries = new Map<string, string>();
  const exceptions: string[] = [];
  let insideExceptions = false;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith("ExceptionsList")) {
      insideExceptions = true;
      continue;
    }
    if (insideExceptions) {
      if (trimmed === "}") {
        insideExceptions = false;
        continue;
      }
      const match = trimmed.match(/^\d+\s*:\s*(.+)$/);
      if (match?.[1]) {
        exceptions.push(match[1].trim());
      }
      continue;
    }

    const match = trimmed.match(/^([A-Za-z]+)\s*:\s*(.+)$/);
    if (match?.[1] && match[2] !== undefined) {
      entries.set(match[1], match[2].trim());
    }
  }

  const httpProxy = entries.get("HTTPEnable") === "1"
    ? formatHostPortProxy(entries.get("HTTPProxy"), entries.get("HTTPPort"))
    : undefined;
  const httpsProxy = entries.get("HTTPSEnable") === "1"
    ? formatHostPortProxy(entries.get("HTTPSProxy"), entries.get("HTTPSPort"))
    : undefined;
  const socksProxy = entries.get("SOCKSEnable") === "1"
    ? formatHostPortProxy(entries.get("SOCKSProxy"), entries.get("SOCKSPort"))?.replace(/^http:\/\//, "socks5://")
    : undefined;

  return {
    httpProxy: httpProxy ?? socksProxy,
    httpsProxy: httpsProxy ?? httpProxy ?? socksProxy,
    noProxy: pickProxyValue(exceptions.join(","))
  };
}

export function detectSystemProxySettings(options: SystemProxyDetectionOptions = {}): SystemProxySnapshot {
  const platform = options.platform ?? process.platform;
  const exec = options.execFileSync ?? execFileSync;
  const envProxy = readEnvProxy(options.env);

  if (platform !== "darwin") {
    return envProxy;
  }

  for (const command of ["/usr/sbin/scutil", "scutil"]) {
    try {
      const output = exec(command, ["--proxy"], {
        encoding: "utf8",
        timeout: 1500
      });
      const detected = parseMacSystemProxyOutput(output.toString());
      return {
        httpProxy: detected.httpProxy ?? envProxy.httpProxy,
        httpsProxy: detected.httpsProxy ?? envProxy.httpsProxy,
        noProxy: detected.noProxy ?? envProxy.noProxy
      };
    } catch {
      continue;
    }
  }

  return envProxy;
}

function normalizeProxySettings(input: Partial<AgentProxySettings>): AgentProxySettings {
  const mode = input.mode === "custom" || input.mode === "system" || input.mode === "off"
    ? input.mode
    : "off";
  const enabled = input.enabled === true && mode !== "off";
  return {
    version: PROXY_SETTINGS_VERSION,
    enabled,
    mode: enabled ? mode : "off",
    httpProxy: pickProxyValue(input.httpProxy),
    httpsProxy: pickProxyValue(input.httpsProxy),
    noProxy: pickProxyValue(input.noProxy)
  };
}

function setEnvProxy(key: "HTTP_PROXY" | "HTTPS_PROXY" | "NO_PROXY", value: string | undefined): void {
  if (value) {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

async function applyUndiciProxyDispatcher(mode: AgentProxySettings["mode"], proxyUrl?: string): Promise<void> {
  try {
    const undici = await import("undici") as {
      setGlobalDispatcher?: (dispatcher: unknown) => void;
      EnvHttpProxyAgent?: new () => unknown;
      ProxyAgent?: new (proxyUri: string) => unknown;
      Agent?: new () => unknown;
    };
    if (typeof undici.setGlobalDispatcher !== "function") return;
    if (mode === "off" && typeof undici.Agent === "function") {
      undici.setGlobalDispatcher(new undici.Agent());
      return;
    }
    if (mode === "custom" && proxyUrl && typeof undici.ProxyAgent === "function") {
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxyUrl));
      return;
    }
    if (mode === "system" && typeof undici.EnvHttpProxyAgent === "function") {
      undici.setGlobalDispatcher(new undici.EnvHttpProxyAgent());
    }
  } catch (error) {
    log.warn("failed to configure undici dispatcher; continuing without it", { error });
  }
}

export async function applyProxySettings(
  settings: AgentProxySettings,
  options: ApplyProxySettingsOptions = {}
): Promise<void> {
  const normalized = normalizeProxySettings(settings);
  const applyDispatcher = options.applyDispatcher ?? applyUndiciProxyDispatcher;
  if (!normalized.enabled || normalized.mode === "off") {
    setEnvProxy("HTTP_PROXY", undefined);
    setEnvProxy("HTTPS_PROXY", undefined);
    setEnvProxy("NO_PROXY", undefined);
    await applyDispatcher("off");
    return;
  }

  if (normalized.mode === "system") {
    const systemProxy = options.detectSystemProxy?.() ?? detectSystemProxySettings();
    setEnvProxy("HTTP_PROXY", systemProxy.httpProxy);
    setEnvProxy("HTTPS_PROXY", systemProxy.httpsProxy ?? systemProxy.httpProxy);
    setEnvProxy("NO_PROXY", systemProxy.noProxy);
    await applyDispatcher("system");
    return;
  }

  const httpProxy = normalized.httpProxy;
  const httpsProxy = normalized.httpsProxy ?? httpProxy;
  setEnvProxy("HTTP_PROXY", httpProxy);
  setEnvProxy("HTTPS_PROXY", httpsProxy);
  setEnvProxy("NO_PROXY", normalized.noProxy);
  await applyDispatcher("custom", httpsProxy ?? httpProxy);
}

export function getAgentProxyStatus(): AgentProxyStatus {
  const stored = readStoredSettings();
  const systemProxy = detectSystemProxySettings();
  return {
    settings: stored.proxy,
    systemProxy
  };
}

export function getActiveProxyConfig(): ActiveProxyConfig {
  const stored = readStoredSettings().proxy;
  if (!stored.enabled || stored.mode === "off") {
    return { mode: "off", enabled: false };
  }
  if (stored.mode === "system") {
    const systemProxy = detectSystemProxySettings();
    return {
      mode: "system",
      enabled: true,
      httpProxy: systemProxy.httpProxy,
      httpsProxy: systemProxy.httpsProxy ?? systemProxy.httpProxy,
      noProxy: systemProxy.noProxy
    };
  }
  return {
    mode: "custom",
    enabled: true,
    httpProxy: stored.httpProxy,
    httpsProxy: stored.httpsProxy ?? stored.httpProxy,
    noProxy: stored.noProxy
  };
}

export async function saveAgentProxySettings(input: AgentProxySettings): Promise<AgentProxyStatus> {
  const normalized = normalizeProxySettings(input);
  await writeStoredSettings(normalized);
  await applyProxySettings(normalized);
  return getAgentProxyStatus();
}

export async function initProxySettings(): Promise<void> {
  const current = readStoredSettings().proxy;
  await applyProxySettings(current);
}
