import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getMemoryConfigPath } from "./config-paths";

export type MemoryCitationsMode = "on" | "off" | "auto";
export type MemoryChatType = "direct" | "group" | "channel";
export type MemorySourceMode = "memory" | "sessions";

export interface MemoryToolPolicy {
  allow?: string[];
  deny?: string[];
}

interface MemoryRuntimeConfigFile {
  version?: number;
  tools?: MemoryToolPolicy;
  citations?: MemoryCitationsMode;
  sources?: MemorySourceMode[];
  extraPaths?: string[];
}

const MEMORY_CONFIG_VERSION = 1;

const DEFAULT_MEMORY_CONFIG: Required<Pick<MemoryRuntimeConfigFile, "version" | "tools" | "citations">> = {
  version: MEMORY_CONFIG_VERSION,
  tools: { allow: ["group:memory"] },
  citations: "auto"
};
const DEFAULT_SOURCES: MemorySourceMode[] = ["memory"];
const DEFAULT_EXTRA_PATHS: string[] = [];

const MEMORY_TOOL_GROUPS: Record<string, string[]> = {
  "group:memory": ["memory_search", "memory_get"]
};

function normalizeEntry(value: string): string {
  return value.trim().toLowerCase();
}

function expandToolEntries(entries?: string[]): string[] {
  if (!entries || entries.length === 0) return [];
  const expanded: string[] = [];
  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (!normalized) continue;
    const groupTools = MEMORY_TOOL_GROUPS[normalized];
    if (groupTools) {
      expanded.push(...groupTools);
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

export function deriveChatTypeFromSessionKey(sessionKey?: string): MemoryChatType {
  const raw = (sessionKey ?? "").trim().toLowerCase();
  if (!raw) return "direct";
  const tokens = new Set(raw.split(":").filter(Boolean));
  if (tokens.has("channel")) return "channel";
  if (tokens.has("group")) return "group";
  return "direct";
}

export function normalizeMemoryChatType(value: unknown): MemoryChatType | undefined {
  if (value !== "direct" && value !== "group" && value !== "channel") {
    return undefined;
  }
  return value;
}

export function parseMemoryRuntimeConfigPayload(payload: unknown): {
  toolPolicy: MemoryToolPolicy | undefined;
  citationsMode: MemoryCitationsMode;
  sources: MemorySourceMode[];
  extraPaths: string[];
} {
  const parsed = payload && typeof payload === "object" ? (payload as MemoryRuntimeConfigFile) : {};
  const citationsMode =
    parsed.citations === "on" || parsed.citations === "off" || parsed.citations === "auto"
      ? parsed.citations
      : DEFAULT_MEMORY_CONFIG.citations;
  const toolPolicy = parsed.tools
    ? {
        allow: Array.isArray(parsed.tools.allow)
          ? parsed.tools.allow.filter((v): v is string => typeof v === "string")
          : undefined,
        deny: Array.isArray(parsed.tools.deny)
          ? parsed.tools.deny.filter((v): v is string => typeof v === "string")
          : undefined
      }
    : { ...DEFAULT_MEMORY_CONFIG.tools };
  const sourcesRaw = Array.isArray(parsed.sources) ? parsed.sources : DEFAULT_SOURCES;
  const sources = Array.from(
    new Set(
      sourcesRaw.filter(
        (value): value is MemorySourceMode => value === "memory" || value === "sessions"
      )
    )
  );
  const extraPaths = Array.isArray(parsed.extraPaths)
    ? Array.from(
        new Set(
          parsed.extraPaths
            .filter((v): v is string => typeof v === "string")
            .map((v) => v.trim())
            .filter(Boolean)
        )
      )
    : [];

  return {
    toolPolicy,
    citationsMode,
    sources: sources.length > 0 ? sources : [...DEFAULT_SOURCES],
    extraPaths
  };
}

export function shouldIncludeCitations(mode: MemoryCitationsMode, chatType: MemoryChatType): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return chatType === "direct";
}

export function applyMemoryToolPolicy(params: {
  baseTools: string[];
  policy?: MemoryToolPolicy;
}): string[] {
  const base = params.baseTools.map((item) => normalizeEntry(item)).filter(Boolean);
  const baseSet = new Set(base);

  const allowExpanded = expandToolEntries(params.policy?.allow);
  const denyExpanded = new Set(expandToolEntries(params.policy?.deny));

  const allowWildcard = (params.policy?.allow ?? []).some((entry) => normalizeEntry(entry) === "*");
  const allowActive = !allowWildcard && allowExpanded.length > 0;
  const allowSet = new Set(allowExpanded);
  const result: string[] = [];

  for (const tool of baseSet) {
    if (allowActive && !allowSet.has(tool)) continue;
    if (denyExpanded.has(tool)) continue;
    result.push(tool);
  }
  return result;
}

export function resolveMemoryRuntimeConfig(): {
  toolPolicy: MemoryToolPolicy | undefined;
  citationsMode: MemoryCitationsMode;
  sources: MemorySourceMode[];
  extraPaths: string[];
} {
  const configPath = getMemoryConfigPath();
  if (!existsSync(configPath)) {
    try {
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            ...DEFAULT_MEMORY_CONFIG,
            sources: DEFAULT_SOURCES,
            extraPaths: DEFAULT_EXTRA_PATHS
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch (error) {
      console.warn("[Memory] 写入默认配置失败:", error);
    }
    return {
      toolPolicy: { ...DEFAULT_MEMORY_CONFIG.tools },
      citationsMode: DEFAULT_MEMORY_CONFIG.citations,
      sources: [...DEFAULT_SOURCES],
      extraPaths: [...DEFAULT_EXTRA_PATHS]
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as MemoryRuntimeConfigFile;
    return parseMemoryRuntimeConfigPayload(parsed);
  } catch (error) {
    console.warn("[Memory] 读取配置失败，使用默认值:", error);
    return {
      toolPolicy: { ...DEFAULT_MEMORY_CONFIG.tools },
      citationsMode: DEFAULT_MEMORY_CONFIG.citations,
      sources: [...DEFAULT_SOURCES],
      extraPaths: [...DEFAULT_EXTRA_PATHS]
    };
  }
}
