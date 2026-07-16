import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type {
  MemoryCitationsMode,
  MemoryRuntimeConfig,
  MemoryRetrievalConfig,
  MemorySourceMode,
  MemoryToolPolicy,
  UpdateMemoryRuntimeConfigInput
} from "@lume/shared";
export type {
  MemoryCitationsMode,
  MemorySourceMode,
  MemoryToolPolicy
} from "@lume/shared";
import { getMemoryConfigPath } from "../infra/config-paths";
import {
  compilePatterns as compilePatterns_shared,
  matchesAny,
  type CompiledPattern
} from "../infra/pattern-utils";
import { createLogger } from "../infra/logger";

export type MemoryChatType = "direct" | "group" | "channel";

interface MemoryRuntimeConfigFile {
  version?: number;
  tools?: MemoryToolPolicy;
  citations?: MemoryCitationsMode;
  sources?: MemorySourceMode[];
  extraPaths?: string[];
  retrieval?: Partial<MemoryRetrievalConfig>;
}

export const MEMORY_CONFIG_VERSION = 1;
const log = createLogger("memory-policy");

const DEFAULT_MEMORY_CONFIG: Required<Pick<MemoryRuntimeConfigFile, "version" | "tools" | "citations">> = {
  version: MEMORY_CONFIG_VERSION,
  tools: { allow: ["group:memory"] },
  citations: "auto"
};
const DEFAULT_SOURCES: MemorySourceMode[] = ["memory"];
const DEFAULT_EXTRA_PATHS: string[] = [];
const DEFAULT_RETRIEVAL: MemoryRetrievalConfig = { semantic: "auto" };

const MEMORY_TOOL_GROUPS: Record<string, string[]> = {
  "group:memory": ["memory.search", "memory.read"],
  "group:memory-write": ["memory.remember"]
};
const TOOL_NAME_ALIASES: Record<string, string> = {
  "apply-patch": "apply_patch",
  bash: "exec"
};

function normalizeEntry(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "memory_*") return "memory.*";
  if (normalized === "*_save") return "*.remember";
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
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

function compilePatterns(entries?: string[]): CompiledPattern[] {
  return compilePatterns_shared(expandToolEntries(entries), normalizeEntry);
}

export function deriveChatTypeFromThreadKey(threadKey?: string): MemoryChatType {
  const raw = (threadKey ?? "").trim().toLowerCase();
  if (!raw) return "direct";
  const tokens = new Set(raw.split(":").filter(Boolean));
  if (tokens.has("channel")) return "channel";
  if (tokens.has("group")) return "group";
  return "direct";
}

export function deriveChatTypeFromThreadType(threadType?: unknown): MemoryChatType | undefined {
  if (threadType === "group" || threadType === "channel") {
    return threadType;
  }
  if (threadType === "main" || threadType === "subagent") {
    return "direct";
  }
  return undefined;
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
  retrieval: MemoryRetrievalConfig;
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
  const retrieval = normalizeRetrievalConfig(parsed.retrieval);

  return {
    toolPolicy,
    citationsMode,
    sources: sources.length > 0 ? sources : [...DEFAULT_SOURCES],
    extraPaths,
    retrieval
  };
}

function normalizeRuntimeConfig(payload: unknown): MemoryRuntimeConfig {
  const parsed = parseMemoryRuntimeConfigPayload(payload);
  return {
    version: MEMORY_CONFIG_VERSION,
    tools: parsed.toolPolicy ?? { ...DEFAULT_MEMORY_CONFIG.tools },
    citations: parsed.citationsMode,
    sources: parsed.sources,
    extraPaths: parsed.extraPaths,
    retrieval: parsed.retrieval
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
  const allowPatterns = compilePatterns(params.policy?.allow);
  const denyPatterns = compilePatterns(params.policy?.deny);
  const allowActive = allowPatterns.length > 0;
  const result: string[] = [];

  for (const tool of baseSet) {
    if (matchesAny(tool, denyPatterns)) continue;
    if (allowActive && !matchesAny(tool, allowPatterns)) continue;
    result.push(tool);
  }
  return result;
}

export function resolveMemoryRuntimeConfig(): {
  toolPolicy: MemoryToolPolicy | undefined;
  citationsMode: MemoryCitationsMode;
  sources: MemorySourceMode[];
  extraPaths: string[];
  retrieval: MemoryRetrievalConfig;
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
            extraPaths: DEFAULT_EXTRA_PATHS,
            retrieval: DEFAULT_RETRIEVAL
          },
          null,
          2
        ),
        "utf-8"
      );
    } catch (error) {
      log.warn("failed to write default memory config", { error });
    }
    return {
      toolPolicy: { ...DEFAULT_MEMORY_CONFIG.tools },
      citationsMode: DEFAULT_MEMORY_CONFIG.citations,
      sources: [...DEFAULT_SOURCES],
      extraPaths: [...DEFAULT_EXTRA_PATHS],
      retrieval: { ...DEFAULT_RETRIEVAL }
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as MemoryRuntimeConfigFile;
    return parseMemoryRuntimeConfigPayload(parsed);
  } catch (error) {
    log.warn("failed to read memory config; using defaults", { error });
    return {
      toolPolicy: { ...DEFAULT_MEMORY_CONFIG.tools },
      citationsMode: DEFAULT_MEMORY_CONFIG.citations,
      sources: [...DEFAULT_SOURCES],
      extraPaths: [...DEFAULT_EXTRA_PATHS],
      retrieval: { ...DEFAULT_RETRIEVAL }
    };
  }
}

export function getMemoryRuntimeConfig(): MemoryRuntimeConfig {
  const configPath = getMemoryConfigPath();
  if (!existsSync(configPath)) {
    return updateMemoryRuntimeConfig({});
  }
  try {
    return normalizeRuntimeConfig(JSON.parse(readFileSync(configPath, "utf-8")) as unknown);
  } catch (error) {
    log.warn("failed to read memory config; using defaults", { error });
    return normalizeRuntimeConfig({});
  }
}

export function updateMemoryRuntimeConfig(input: UpdateMemoryRuntimeConfigInput): MemoryRuntimeConfig {
  const current = existsSync(getMemoryConfigPath())
    ? getMemoryRuntimeConfig()
    : normalizeRuntimeConfig({});
  const next = normalizeRuntimeConfig({
    version: MEMORY_CONFIG_VERSION,
    tools: input.tools ?? current.tools,
    citations: input.citations ?? current.citations,
    sources: input.sources ?? current.sources,
    extraPaths: input.extraPaths ?? current.extraPaths,
    retrieval: {
      ...current.retrieval,
      ...(input.retrieval ?? {})
    }
  });
  writeFileSync(getMemoryConfigPath(), JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function normalizeRetrievalConfig(value: unknown): MemoryRetrievalConfig {
  const raw = value && typeof value === "object" ? value as Partial<MemoryRetrievalConfig> : {};
  const semantic = raw.semantic === "off" ? "off" : "auto";
  const rerankModelRef = typeof raw.rerankModelRef === "string" && raw.rerankModelRef.trim()
    ? raw.rerankModelRef.trim()
    : undefined;
  return {
    semantic,
    ...(rerankModelRef ? { rerankModelRef } : {})
  };
}
