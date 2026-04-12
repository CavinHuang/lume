import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentProxySettings, AgentProxyStatus } from "@lume/shared";
import { getSettingsPath } from "../infra/config-paths";

interface StoredSettings {
  version: 1;
  proxy: AgentProxySettings;
  [key: string]: unknown;
}

const SETTINGS_VERSION = 1;
const PROXY_SETTINGS_VERSION = 1;

const DEFAULT_PROXY_SETTINGS: AgentProxySettings = {
  version: PROXY_SETTINGS_VERSION,
  enabled: false,
  mode: "off"
};

const startupEnvProxy = {
  httpProxy: process.env.HTTP_PROXY ?? process.env.http_proxy,
  httpsProxy: process.env.HTTPS_PROXY ?? process.env.https_proxy,
  noProxy: process.env.NO_PROXY ?? process.env.no_proxy
};

export interface ActiveProxyConfig {
  mode: AgentProxySettings["mode"];
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

function readStoredSettings(): StoredSettings {
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return {
      version: SETTINGS_VERSION,
      proxy: DEFAULT_PROXY_SETTINGS
    };
  }
  try {
    const text = readFileSync(path, "utf8");
    const parsed = JSON.parse(text) as Partial<StoredSettings>;
    const rawProxy = parsed.proxy ?? DEFAULT_PROXY_SETTINGS;
    return {
      ...parsed,
      version: SETTINGS_VERSION,
      proxy: normalizeProxySettings(rawProxy)
    };
  } catch (error) {
    console.error("[代理配置] 读取 settings.json 失败，使用默认配置:", error);
    return {
      version: SETTINGS_VERSION,
      proxy: DEFAULT_PROXY_SETTINGS
    };
  }
}

function writeStoredSettings(proxy: AgentProxySettings): void {
  const path = getSettingsPath();
  const prev = readStoredSettings();
  const payload: StoredSettings = {
    ...prev,
    version: SETTINGS_VERSION,
    proxy
  };
  const dir = dirname(path);
  const tmpPath = `${path}.tmp-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  renameSync(tmpPath, path);
  if (!existsSync(dir)) {
    throw new Error("settings 目录写入失败");
  }
}

function pickProxyValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
    console.error("[代理配置] undici dispatcher 设置失败（已忽略）:", error);
  }
}

export async function applyProxySettings(settings: AgentProxySettings): Promise<void> {
  const normalized = normalizeProxySettings(settings);
  if (!normalized.enabled || normalized.mode === "off") {
    setEnvProxy("HTTP_PROXY", undefined);
    setEnvProxy("HTTPS_PROXY", undefined);
    setEnvProxy("NO_PROXY", undefined);
    await applyUndiciProxyDispatcher("off");
    return;
  }

  if (normalized.mode === "system") {
    setEnvProxy("HTTP_PROXY", startupEnvProxy.httpProxy);
    setEnvProxy("HTTPS_PROXY", startupEnvProxy.httpsProxy);
    setEnvProxy("NO_PROXY", startupEnvProxy.noProxy);
    await applyUndiciProxyDispatcher("system");
    return;
  }

  const httpProxy = normalized.httpProxy;
  const httpsProxy = normalized.httpsProxy ?? httpProxy;
  setEnvProxy("HTTP_PROXY", httpProxy);
  setEnvProxy("HTTPS_PROXY", httpsProxy);
  setEnvProxy("NO_PROXY", normalized.noProxy);
  await applyUndiciProxyDispatcher("custom", httpsProxy ?? httpProxy);
}

export function getAgentProxyStatus(): AgentProxyStatus {
  const stored = readStoredSettings();
  return {
    settings: stored.proxy,
    systemProxy: {
      httpProxy: startupEnvProxy.httpProxy,
      httpsProxy: startupEnvProxy.httpsProxy,
      noProxy: startupEnvProxy.noProxy
    }
  };
}

export function getActiveProxyConfig(): ActiveProxyConfig {
  const stored = readStoredSettings().proxy;
  if (!stored.enabled || stored.mode === "off") {
    return { mode: "off", enabled: false };
  }
  if (stored.mode === "system") {
    return {
      mode: "system",
      enabled: true,
      httpProxy: startupEnvProxy.httpProxy,
      httpsProxy: startupEnvProxy.httpsProxy,
      noProxy: startupEnvProxy.noProxy
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
  writeStoredSettings(normalized);
  await applyProxySettings(normalized);
  return getAgentProxyStatus();
}

export async function initProxySettings(): Promise<void> {
  const current = readStoredSettings().proxy;
  await applyProxySettings(current);
}
