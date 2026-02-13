import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getAgentRuntimeConfigPath } from "./config-paths";

export type AgentCliBackend = "claude_cli" | "codex_cli";

export type AgentCliOutputMode = "json" | "jsonl" | "text";
export type AgentCliInputMode = "arg" | "stdin";
export type AgentCliSessionMode = "always" | "existing" | "none";
export type AgentCliSystemPromptWhen = "always" | "first" | "never";
export type AgentCliImageMode = "repeat" | "list";

export interface AgentCliBackendConfig {
  command?: string;
  args?: string[];
  resumeArgs?: string[];
  output?: AgentCliOutputMode;
  resumeOutput?: AgentCliOutputMode;
  input?: AgentCliInputMode;
  maxPromptArgChars?: number;
  modelArg?: string;
  modelAliases?: Record<string, string>;
  sessionArg?: string;
  sessionArgs?: string[];
  sessionMode?: AgentCliSessionMode;
  sessionIdFields?: string[];
  systemPromptArg?: string;
  systemPromptWhen?: AgentCliSystemPromptWhen;
  imageArg?: string;
  imageMode?: AgentCliImageMode;
  env?: Record<string, string>;
  clearEnv?: string[];
  serialize?: boolean;
}

interface AgentRuntimeConfigFile {
  version?: number;
  cliBackends?: Record<string, AgentCliBackendConfig>;
}

export interface AgentRuntimeConfig {
  cliBackends: Record<string, AgentCliBackendConfig>;
}

const AGENT_RUNTIME_CONFIG_VERSION = 1;

const DEFAULT_AGENT_RUNTIME_CONFIG_FILE: AgentRuntimeConfigFile = {
  version: AGENT_RUNTIME_CONFIG_VERSION,
  cliBackends: {}
};

function normalizeBackendKey(value: string): string {
  return value.trim().toLowerCase().replaceAll("_", "-");
}

export function toCanonicalBackendId(value: string): AgentCliBackend | null {
  const normalized = normalizeBackendKey(value);
  if (normalized === "claude-cli") return "claude_cli";
  if (normalized === "codex-cli") return "codex_cli";
  return null;
}

function normalizeBackendConfig(value: unknown): AgentCliBackendConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const output = record.output;
  const resumeOutput = record.resumeOutput;

  const asStringList = (raw: unknown): string[] | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const list = raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  };

  return {
    command: typeof record.command === "string" ? record.command.trim() : undefined,
    args: asStringList(record.args),
    resumeArgs: asStringList(record.resumeArgs),
    output: output === "json" || output === "jsonl" || output === "text" ? output : undefined,
    resumeOutput:
      resumeOutput === "json" || resumeOutput === "jsonl" || resumeOutput === "text"
        ? resumeOutput
        : undefined,
    input: record.input === "arg" || record.input === "stdin" ? record.input : undefined,
    maxPromptArgChars:
      typeof record.maxPromptArgChars === "number" &&
      Number.isFinite(record.maxPromptArgChars) &&
      record.maxPromptArgChars > 0
        ? Math.floor(record.maxPromptArgChars)
        : undefined,
    modelArg: typeof record.modelArg === "string" ? record.modelArg.trim() : undefined,
    modelAliases: (() => {
      if (!record.modelAliases || typeof record.modelAliases !== "object") return undefined;
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(record.modelAliases as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        const normalizedKey = key.trim();
        const normalizedValue = value.trim();
        if (!normalizedKey || !normalizedValue) continue;
        next[normalizedKey] = normalizedValue;
      }
      return Object.keys(next).length > 0 ? next : undefined;
    })(),
    sessionArg: typeof record.sessionArg === "string" ? record.sessionArg.trim() : undefined,
    sessionArgs: asStringList(record.sessionArgs),
    sessionMode:
      record.sessionMode === "always" || record.sessionMode === "existing" || record.sessionMode === "none"
        ? record.sessionMode
        : undefined,
    sessionIdFields: asStringList(record.sessionIdFields),
    systemPromptArg: typeof record.systemPromptArg === "string" ? record.systemPromptArg.trim() : undefined,
    systemPromptWhen:
      record.systemPromptWhen === "always" ||
      record.systemPromptWhen === "first" ||
      record.systemPromptWhen === "never"
        ? record.systemPromptWhen
        : undefined,
    imageArg: typeof record.imageArg === "string" ? record.imageArg.trim() : undefined,
    imageMode: record.imageMode === "repeat" || record.imageMode === "list" ? record.imageMode : undefined,
    env: (() => {
      if (!record.env || typeof record.env !== "object") return undefined;
      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(record.env as Record<string, unknown>)) {
        if (typeof value !== "string") continue;
        const normalizedKey = key.trim();
        if (!normalizedKey) continue;
        next[normalizedKey] = value;
      }
      return Object.keys(next).length > 0 ? next : undefined;
    })(),
    clearEnv: asStringList(record.clearEnv),
    serialize: typeof record.serialize === "boolean" ? record.serialize : undefined
  };
}

export function parseAgentRuntimeConfigPayload(payload: unknown): AgentRuntimeConfig {
  const parsed = payload && typeof payload === "object" ? (payload as AgentRuntimeConfigFile) : {};
  const backends: Record<string, AgentCliBackendConfig> = {};

  const rawBackends = parsed.cliBackends;
  if (rawBackends && typeof rawBackends === "object") {
    const record = rawBackends as Record<string, unknown>;
    for (const [rawKey, rawValue] of Object.entries(record)) {
      const normalized = normalizeBackendConfig(rawValue);
      if (!normalized) continue;
      const canonical = toCanonicalBackendId(rawKey);
      const key = canonical ? canonical.replaceAll("_", "-") : normalizeBackendKey(rawKey);
      if (!key) continue;
      backends[key] = normalized;
    }
  }

  for (const [hyphen, underscore] of [
    ["claude-cli", "claude_cli"],
    ["codex-cli", "codex_cli"]
  ] as const) {
    if (!backends[hyphen] && backends[underscore]) {
      backends[hyphen] = backends[underscore] as AgentCliBackendConfig;
    }
    if (!backends[underscore] && backends[hyphen]) {
      backends[underscore] = backends[hyphen] as AgentCliBackendConfig;
    }
  }

  return { cliBackends: backends };
}

export function resolveCliBackendIdsFromRuntimeConfig(config: AgentRuntimeConfig): Set<string> {
  const ids = new Set<string>(["claude-cli", "codex-cli"]);
  for (const key of Object.keys(config.cliBackends)) {
    const normalized = normalizeBackendKey(key);
    if (normalized) ids.add(normalized);
  }
  return ids;
}

export function findCliBackendConfig(
  config: AgentRuntimeConfig,
  backendId: string
): AgentCliBackendConfig | undefined {
  const normalized = normalizeBackendKey(backendId);
  if (!normalized) return undefined;
  return config.cliBackends[normalized] ?? config.cliBackends[normalized.replaceAll("-", "_")];
}

export function resolveAgentRuntimeConfig(): AgentRuntimeConfig {
  const configPath = getAgentRuntimeConfigPath();
  if (!existsSync(configPath)) {
    try {
      writeFileSync(configPath, JSON.stringify(DEFAULT_AGENT_RUNTIME_CONFIG_FILE, null, 2), "utf-8");
    } catch (error) {
      console.warn("[Agent] 写入默认运行时配置失败:", error);
    }
    return { cliBackends: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as AgentRuntimeConfigFile;
    return parseAgentRuntimeConfigPayload(parsed);
  } catch (error) {
    console.warn("[Agent] 读取运行时配置失败，使用默认配置:", error);
    return { cliBackends: {} };
  }
}
