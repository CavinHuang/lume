import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createLogger } from "../../logger";
import { getAgentRuntimeConfigPath } from "../../config-paths";
import { applyMemoryToolPolicy } from "../../memory-policy";
import type { MemoryToolPolicy } from "../../memory-policy";
import {
  MEMORY_GET_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME
} from "../../memory-mcp-service";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentSendInput } from "@lume/shared";
import type { ProviderType } from "@lume/shared";
import type { AgentRuntimeToolPolicyConfig, AgentToolPolicy } from "@lume/shared";

const log = createLogger("pi-tool-policy");

const TOOL_NAME_ALIASES: Record<string, string> = {
  "apply-patch": "apply_patch",
  glob: "find",
  ls: "ls"
};

const TOOL_GROUPS: Record<string, string[]> = {
  "group:fs": ["read", "write", "edit"],
  "group:runtime": ["bash"],
  "group:search": ["find", "grep", "ls"],
  "group:memory": ["memory_search", "memory_get", "memory_save"],
  "group:web": ["web_search", "web_fetch"],
  "group:sessions": [
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_delete",
    "sessions_spawn",
    "session_status"
  ],
  "group:planning": ["askuserquestion", "enterplanmode", "exitplanmode"]
};

const DEFAULT_SUBAGENT_POLICY: ToolPolicy = {
  deny: [
    "agents_list",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_delete",
    "sessions_spawn",
    "session_status"
  ]
};

const DEFAULT_AGENT_TOOL_POLICY_CONFIG: AgentRuntimeToolPolicyConfig = {
  version: 1,
  tools: {
    // 默认不做全局 allow/deny，保持“按已注册工具可用”。
    allow: undefined,
    deny: undefined,
    // provider/session/chat 维度默认空，按需覆盖。
    byProvider: {},
    bySessionType: {},
    byChatType: {},
    // 子代理默认降权，匹配 OpenClaw 的 fail-closed 思路。
    subagent: { ...DEFAULT_SUBAGENT_POLICY }
  }
};

type CompiledPattern =
  | { kind: "all" }
  | { kind: "exact"; value: string }
  | { kind: "regex"; value: RegExp };

export type ToolPolicy = AgentToolPolicy;

export interface ResolveEffectiveToolPolicyInput {
  provider?: ProviderType | string;
  sessionType?: AgentSendInput["sessionType"];
  chatType?: AgentSendInput["chatType"];
  messageMetadata?: Record<string, unknown>;
}

function normalizeToolName(value: string): string {
  const normalized = value.trim().toLowerCase();
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

function normalizePolicy(policy?: ToolPolicy): ToolPolicy | undefined {
  if (!policy) {
    return undefined;
  }
  const allow = Array.isArray(policy.allow)
    ? policy.allow.filter((v): v is string => typeof v === "string")
    : undefined;
  const deny = Array.isArray(policy.deny)
    ? policy.deny.filter((v): v is string => typeof v === "string")
    : undefined;
  if ((!allow || allow.length === 0) && (!deny || deny.length === 0)) {
    return undefined;
  }
  return { allow, deny };
}

function expandEntries(entries?: string[]): string[] {
  if (!entries || entries.length === 0) {
    return [];
  }
  const expanded: string[] = [];
  for (const raw of entries) {
    const normalized = normalizeToolName(raw);
    if (!normalized) {
      continue;
    }
    const grouped = TOOL_GROUPS[normalized];
    if (grouped) {
      expanded.push(...grouped);
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

function compilePattern(rawPattern: string): CompiledPattern {
  const pattern = normalizeToolName(rawPattern);
  if (!pattern) {
    return { kind: "exact", value: "" };
  }
  if (pattern === "*") {
    return { kind: "all" };
  }
  if (!pattern.includes("*")) {
    return { kind: "exact", value: pattern };
  }
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    kind: "regex",
    value: new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`)
  };
}

function compilePatterns(entries?: string[]): CompiledPattern[] {
  return expandEntries(entries)
    .map(compilePattern)
    .filter((entry) => entry.kind !== "exact" || entry.value.length > 0);
}

function matchesAny(name: string, patterns: CompiledPattern[]): boolean {
  for (const pattern of patterns) {
    if (pattern.kind === "all") return true;
    if (pattern.kind === "exact" && pattern.value === name) return true;
    if (pattern.kind === "regex" && pattern.value.test(name)) return true;
  }
  return false;
}

function makeMatcher(policy: ToolPolicy): (toolName: string) => boolean {
  const deny = compilePatterns(policy.deny);
  const allow = compilePatterns(policy.allow);
  return (toolName) => {
    const normalized = normalizeToolName(toolName);
    if (matchesAny(normalized, deny)) return false;
    if (allow.length === 0) return true;
    return matchesAny(normalized, allow);
  };
}

function filterToolsByPolicy(tools: AgentTool[], policy?: ToolPolicy): AgentTool[] {
  if (!policy) return tools;
  const matcher = makeMatcher(policy);
  return tools.filter((tool) => matcher(tool.name));
}

function parsePolicyObject(raw: unknown): ToolPolicy | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  return normalizePolicy({
    allow: Array.isArray(record.allow)
      ? record.allow.filter((v): v is string => typeof v === "string")
      : undefined,
    deny: Array.isArray(record.deny)
      ? record.deny.filter((v): v is string => typeof v === "string")
      : undefined
  });
}

function readRuntimeToolPolicyConfig(): AgentRuntimeToolPolicyConfig {
  const path = getAgentRuntimeConfigPath();
  if (!existsSync(path)) {
    try {
      writeFileSync(path, JSON.stringify(DEFAULT_AGENT_TOOL_POLICY_CONFIG, null, 2), "utf-8");
    } catch (error) {
      log.warn("写入默认 Agent tool policy 配置失败", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return DEFAULT_AGENT_TOOL_POLICY_CONFIG;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as AgentRuntimeToolPolicyConfig;
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_AGENT_TOOL_POLICY_CONFIG;
    }
    return normalizeRuntimeToolPolicyConfig(parsed);
  } catch (error) {
    log.warn("读取 Agent tool policy 配置失败，使用默认策略", {
      error: error instanceof Error ? error.message : String(error)
    });
    return DEFAULT_AGENT_TOOL_POLICY_CONFIG;
  }
}

function normalizeToolPolicyRecord(raw: unknown): Record<string, ToolPolicy> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const result: Record<string, ToolPolicy> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = normalizePolicy(parsePolicyObject(value));
    if (!normalized) continue;
    result[key] = normalized;
  }
  return result;
}

function normalizeRuntimeToolPolicyConfig(raw: AgentRuntimeToolPolicyConfig): AgentRuntimeToolPolicyConfig {
  const parsedTools = raw.tools ?? {};
  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    tools: {
      allow: Array.isArray(parsedTools.allow) ? parsedTools.allow : undefined,
      deny: Array.isArray(parsedTools.deny) ? parsedTools.deny : undefined,
      byProvider: normalizeToolPolicyRecord(parsedTools.byProvider),
      bySessionType: normalizeToolPolicyRecord(parsedTools.bySessionType),
      byChatType: normalizeToolPolicyRecord(parsedTools.byChatType),
      subagent: normalizePolicy(parsedTools.subagent) ?? { ...DEFAULT_SUBAGENT_POLICY }
    }
  };
}

export function getAgentRuntimeToolPolicyConfig(): AgentRuntimeToolPolicyConfig {
  return readRuntimeToolPolicyConfig();
}

export function saveAgentRuntimeToolPolicyConfig(
  input: AgentRuntimeToolPolicyConfig
): AgentRuntimeToolPolicyConfig {
  const normalized = normalizeRuntimeToolPolicyConfig(input);
  try {
    writeFileSync(getAgentRuntimeConfigPath(), JSON.stringify(normalized, null, 2), "utf-8");
  } catch (error) {
    log.error("保存 Agent tool policy 配置失败", {
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Error(`保存 Agent tool policy 配置失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalized;
}

function resolveMetadataPolicy(metadata?: Record<string, unknown>): ToolPolicy | undefined {
  if (!metadata) {
    return undefined;
  }
  return parsePolicyObject(metadata.toolPolicy);
}

function resolveProviderPolicy(
  byProvider: Record<string, ToolPolicy> | undefined,
  provider?: ProviderType | string
): ToolPolicy | undefined {
  if (!byProvider || !provider) {
    return undefined;
  }
  const normalizedProvider = provider.trim().toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }
  for (const [key, value] of Object.entries(byProvider)) {
    if (key.trim().toLowerCase() !== normalizedProvider) {
      continue;
    }
    return normalizePolicy(value);
  }
  return undefined;
}

export function resolveEffectiveToolPolicies(input: ResolveEffectiveToolPolicyInput): ToolPolicy[] {
  const config = readRuntimeToolPolicyConfig();
  const cfgTools = config.tools ?? {};

  const policies: ToolPolicy[] = [];
  const globalPolicy = normalizePolicy({
    allow: cfgTools.allow,
    deny: cfgTools.deny
  });
  if (globalPolicy) {
    policies.push(globalPolicy);
  }

  const providerPolicy = resolveProviderPolicy(cfgTools.byProvider, input.provider);
  if (providerPolicy) {
    policies.push(providerPolicy);
  }

  if (input.sessionType && cfgTools.bySessionType?.[input.sessionType]) {
    const policy = normalizePolicy(cfgTools.bySessionType[input.sessionType]);
    if (policy) {
      policies.push(policy);
    }
  }

  if (input.chatType && cfgTools.byChatType?.[input.chatType]) {
    const policy = normalizePolicy(cfgTools.byChatType[input.chatType]);
    if (policy) {
      policies.push(policy);
    }
  }

  if (input.sessionType === "subagent") {
    policies.push(normalizePolicy(cfgTools.subagent) ?? DEFAULT_SUBAGENT_POLICY);
  }

  const metadataPolicy = resolveMetadataPolicy(input.messageMetadata);
  if (metadataPolicy) {
    policies.push(metadataPolicy);
  }

  return policies;
}

export function applyPiToolPolicies(
  tools: AgentTool[],
  input: ResolveEffectiveToolPolicyInput
): AgentTool[] {
  const policies = resolveEffectiveToolPolicies(input);
  let filtered = tools;
  for (const policy of policies) {
    filtered = filterToolsByPolicy(filtered, policy);
  }
  return filtered;
}

export function resolveEnabledPiMemoryToolNames(policy?: MemoryToolPolicy): string[] {
  return applyMemoryToolPolicy({
    baseTools: [MEMORY_SEARCH_TOOL_NAME, MEMORY_GET_TOOL_NAME, MEMORY_SAVE_TOOL_NAME],
    policy
  });
}
