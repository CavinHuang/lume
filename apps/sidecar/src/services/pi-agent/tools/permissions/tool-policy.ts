import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createLogger } from "../../../infra/logger";
import {
  compilePatterns as compilePatterns_shared,
  makeMatcher as makeMatcher_shared,
  type CompiledPattern
} from "../../../infra/pattern-utils";
import { getAgentRuntimeConfigPath } from "../../../infra/config-paths";
import { getEffectiveLumeConfig } from "../../../system/lume-config-service";
import { applyMemoryToolPolicy } from "../../../memory/memory-policy";
import type { MemoryToolPolicy } from "../../../memory/memory-policy";
import {
  MEMORY_GET_TOOL_NAME,
  MEMORY_SAVE_TOOL_NAME,
  MEMORY_SEARCH_TOOL_NAME
} from "../../../memory/memory-mcp-service";
import type { AgentSendInput } from "@lume/shared";
import type { ProviderType } from "@lume/shared";
import type { AgentRuntimeToolPolicyConfig, AgentToolPolicy } from "@lume/shared";
import { canonicalizeAgentToolName } from "@lume/shared";

const log = createLogger("pi-tool-policy");

// ===== 配置文件缓存 =====
interface PolicyConfigCache {
  path: string;
  config: AgentRuntimeToolPolicyConfig;
  mtimeMs: number;
  checkedAt: number;
}

const CACHE_RECHECK_INTERVAL_MS = 1000;
let _policyConfigCache: PolicyConfigCache | null = null;

const TOOL_NAME_ALIASES: Record<string, string> = {
  "apply-patch": "apply_patch",
  glob: "find",
  ls: "ls",
  websearch: "web_search",
  webfetch: "web_fetch"
};

const TOOL_GROUPS: Record<string, string[]> = {
  "group:fs": ["read", "write", "edit"],
  "group:runtime": ["bash"],
  "group:search": ["find", "grep", "ls"],
  "group:memory": ["memory_search", "memory_get", "memory_save"],
  "group:web": ["web_search", "web_fetch"],
  "group:planning": ["askuserquestion"]
};

const DEFAULT_SUBAGENT_POLICY: ToolPolicy = {};

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

export type ToolPolicy = AgentToolPolicy;

export interface ResolveEffectiveToolPolicyInput {
  provider?: ProviderType | string;
  workspaceSlug?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  messageMetadata?: Record<string, unknown>;
}

function normalizeToolName(value: string): string {
  const normalized = canonicalizeAgentToolName(value);
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

function compilePatterns(entries?: string[]): CompiledPattern[] {
  return compilePatterns_shared(expandEntries(entries), normalizeToolName);
}

function makeMatcher(policy: ToolPolicy): (toolName: string) => boolean {
  const deny = compilePatterns(policy.deny);
  const allow = compilePatterns(policy.allow);
  return makeMatcher_shared(allow, deny, normalizeToolName);
}

function filterToolsByPolicy<T extends { name: string }>(tools: T[], policy?: ToolPolicy): T[] {
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
  const now = Date.now();

  // 缓存命中：距上次检查不足 1 秒，直接返回
  if (_policyConfigCache && _policyConfigCache.path === path && now - _policyConfigCache.checkedAt < CACHE_RECHECK_INTERVAL_MS) {
    return _policyConfigCache.config;
  }

  if (!existsSync(path)) {
    const config = DEFAULT_AGENT_TOOL_POLICY_CONFIG;
    try {
      writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
    } catch (error) {
      log.warn("写入默认 Agent tool policy 配置失败", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    _policyConfigCache = { path, config, mtimeMs: 0, checkedAt: now };
    return config;
  }

  try {
    const mtimeMs = statSync(path).mtimeMs;
    // mtime 未变化，更新检查时间戳后直接返回缓存
    if (_policyConfigCache && _policyConfigCache.path === path && mtimeMs === _policyConfigCache.mtimeMs) {
      _policyConfigCache.checkedAt = now;
      return _policyConfigCache.config;
    }
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as AgentRuntimeToolPolicyConfig;
    const config = (!parsed || typeof parsed !== "object")
      ? DEFAULT_AGENT_TOOL_POLICY_CONFIG
      : normalizeRuntimeToolPolicyConfig(parsed);
    _policyConfigCache = { path, config, mtimeMs, checkedAt: now };
    return config;
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
  const path = getAgentRuntimeConfigPath();
  try {
    writeFileSync(path, JSON.stringify(normalized, null, 2), "utf-8");
    // 写入成功后立即更新缓存，避免下次调用再读盘
    const mtimeMs = statSync(path).mtimeMs;
    _policyConfigCache = { path, config: normalized, mtimeMs, checkedAt: Date.now() };
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

function resolveWorkspaceSlug(input: ResolveEffectiveToolPolicyInput): string | undefined {
  if (typeof input.workspaceSlug === "string" && input.workspaceSlug.trim().length > 0) {
    return input.workspaceSlug;
  }
  const metadataWorkspaceSlug = input.messageMetadata?.workspaceSlug;
  if (typeof metadataWorkspaceSlug === "string" && metadataWorkspaceSlug.trim().length > 0) {
    return metadataWorkspaceSlug;
  }
  return undefined;
}

function resolveLumeToolPolicy(workspaceSlug?: string): ToolPolicy | undefined {
  try {
    const effectiveConfig = getEffectiveLumeConfig(workspaceSlug);
    return parsePolicyObject(effectiveConfig.permissions?.toolPolicy);
  } catch (error) {
    log.warn("读取 lume.yaml toolPolicy 失败，回退 runtime policy", {
      workspaceSlug,
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
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
  const workspaceSlug = resolveWorkspaceSlug(input);
  const lumeToolPolicy = resolveLumeToolPolicy(workspaceSlug);

  const policies: ToolPolicy[] = [];
  const globalPolicy = normalizePolicy({
    allow: lumeToolPolicy?.allow ?? cfgTools.allow,
    deny: lumeToolPolicy?.deny ?? cfgTools.deny
  });
  if (globalPolicy) {
    policies.push(globalPolicy);
  }

  const providerPolicy = resolveProviderPolicy(cfgTools.byProvider, input.provider);
  if (providerPolicy) {
    policies.push(providerPolicy);
  }

  if (input.threadType && cfgTools.bySessionType?.[input.threadType]) {
    const policy = normalizePolicy(cfgTools.bySessionType[input.threadType]);
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

  if (input.threadType === "subagent") {
    policies.push(normalizePolicy(cfgTools.subagent) ?? DEFAULT_SUBAGENT_POLICY);
  }

  const metadataPolicy = resolveMetadataPolicy(input.messageMetadata);
  if (metadataPolicy) {
    policies.push(metadataPolicy);
  }

  return policies;
}

export function applyPiToolPolicies<T extends { name: string }>(
  tools: T[],
  input: ResolveEffectiveToolPolicyInput
): T[] {
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


