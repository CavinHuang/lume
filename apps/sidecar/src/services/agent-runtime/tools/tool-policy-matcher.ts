import { canonicalizeAgentToolName } from "@lume/shared";
import type { AgentSendInput, AgentToolPolicy, ProviderType } from "@lume/shared";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import { applyMemoryToolPolicy, type MemoryToolPolicy } from "../../memory-v2/policy";

export const GUANLAN_TOOL_NAMES = [
  "guanlan_search",
  "guanlan_read",
  "guanlan_hotnews",
  "guanlan_research"
] as const;

const TOOL_NAME_ALIASES: Record<string, string> = {
  "apply-patch": "apply_patch",
  glob: "find",
  websearch: "web_search",
  webfetch: "web_fetch",
  guanlansearch: "guanlan_search",
  guanlanread: "guanlan_read",
  guanlanhotnews: "guanlan_hotnews",
  guanlanresearch: "guanlan_research",
  Agent: "agent_spawn",
  AskUserQuestion: "askuserquestion",
};

const AUTOMATION_TOOL_NAMES = [
  "cron_set",
  "automation_set"
] as const;

const READING_TOOL_NAMES = [
  "lume_reading_snapshot",
  "lume_add_book",
  "lume_write_reading_note",
  "lume_hide_reading_note",
  "lume_revise_reading_note",
  "lume_generate_share_card",
  "weread_generate_note",
  "weread_export_all_notes",
  "weread_shelf",
  "weread_notebooks",
  "weread_bookmarks",
  "weread_best_bookmarks",
  "weread_reviews",
  "weread_public_reviews",
  "weread_readdata",
  "weread_search"
] as const;

const OFFICE_TOOL_NAMES = [
  "office_validate",
  "office_unpack",
  "office_pack"
] as const;

const TOOL_GROUPS: Record<string, string[]> = {
  "group:fs": ["read", "write", "edit"],
  "group:runtime": ["bash"],
  "group:search": ["find", "grep", "ls"],
  "group:memory": ["memory.search", "memory.read"],
  "group:memory-write": ["memory.remember"],
  "group:web": ["web_search", "web_fetch"],
  "group:data": [...GUANLAN_TOOL_NAMES],
  "group:planning": ["askuserquestion", "taskcontractwrite"],
  "group:automation": [...AUTOMATION_TOOL_NAMES],
  "group:im": ["send_im_message"],
  "group:evolution": ["personalize_ui"],
  "group:office": [...OFFICE_TOOL_NAMES],
  "group:reading": [...READING_TOOL_NAMES]
};

export function normalizeRuntimeToolPolicyEntry(value: string): string {
  const normalized = canonicalizeAgentToolName(value);
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

export function expandRuntimeToolPolicyEntries(entries?: string[]): string[] {
  const expanded: string[] = [];
  for (const entry of entries ?? []) {
    const normalized = normalizeRuntimeToolPolicyEntry(entry);
    const group = TOOL_GROUPS[normalized];
    if (group) {
      expanded.push(...group.map(normalizeRuntimeToolPolicyEntry));
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

export function matchesRuntimeToolPolicyEntry(toolName: string, entry: string): boolean {
  const normalizedToolName = normalizeRuntimeToolPolicyEntry(toolName);
  const expanded = expandRuntimeToolPolicyEntries([entry]);
  return expanded.some((candidate) => matchesPolicyEntry(normalizedToolName, candidate));
}

export function matchesAnyRuntimeToolPolicyEntry(toolName: string, entries: string[]): boolean {
  const normalizedToolName = normalizeRuntimeToolPolicyEntry(toolName);
  return entries.some((entry) => matchesPolicyEntry(normalizedToolName, entry));
}

export interface ResolveEffectiveToolPolicyInput {
  provider?: ProviderType | string;
  workspaceSlug?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  messageMetadata?: Record<string, unknown>;
}

export type ToolPolicy = AgentToolPolicy;

function normalizePolicy(policy?: ToolPolicy): ToolPolicy | undefined {
  if (!policy) return undefined;
  const allow = Array.isArray(policy.allow)
    ? policy.allow.filter((value): value is string => typeof value === "string")
    : undefined;
  const deny = Array.isArray(policy.deny)
    ? policy.deny.filter((value): value is string => typeof value === "string")
    : undefined;
  if ((!allow || allow.length === 0) && (!deny || deny.length === 0)) return undefined;
  return { allow, deny };
}

function parsePolicyObject(raw: unknown): ToolPolicy | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return normalizePolicy({
    allow: Array.isArray(record.allow)
      ? record.allow.filter((value): value is string => typeof value === "string")
      : undefined,
    deny: Array.isArray(record.deny)
      ? record.deny.filter((value): value is string => typeof value === "string")
      : undefined
  });
}

function resolveWorkspaceSlug(input: ResolveEffectiveToolPolicyInput): string | undefined {
  if (typeof input.workspaceSlug === "string" && input.workspaceSlug.trim()) {
    return input.workspaceSlug;
  }
  const metadataWorkspaceSlug = input.messageMetadata?.workspaceSlug;
  return typeof metadataWorkspaceSlug === "string" && metadataWorkspaceSlug.trim()
    ? metadataWorkspaceSlug
    : undefined;
}

export function resolveEffectiveToolPolicies(input: ResolveEffectiveToolPolicyInput): ToolPolicy[] {
  const workspaceSlug = resolveWorkspaceSlug(input);
  const effectiveConfig = getEffectiveLumeConfig(workspaceSlug);
  const policies: ToolPolicy[] = [];
  if (effectiveConfig.webSearch?.providers?.guanlan?.enabled !== true) {
    policies.push({ deny: [...GUANLAN_TOOL_NAMES] });
  }
  const configPolicy = parsePolicyObject(effectiveConfig.permissions?.toolPolicy);
  if (configPolicy) {
    policies.push(configPolicy);
  }
  const metadataPolicy = parsePolicyObject(input.messageMetadata?.toolPolicy);
  if (metadataPolicy) {
    policies.push(metadataPolicy);
  }
  return policies;
}

export function applyRuntimeToolPolicies<T extends { name: string }>(
  tools: T[],
  input: ResolveEffectiveToolPolicyInput
): T[] {
  let filtered = tools;
  for (const policy of resolveEffectiveToolPolicies(input)) {
    const allow = expandRuntimeToolPolicyEntries(policy.allow);
    const deny = expandRuntimeToolPolicyEntries(policy.deny);
    filtered = filtered.filter((tool) => {
      if (matchesAnyRuntimeToolPolicyEntry(tool.name, deny)) return false;
      if (allow.length > 0 && !matchesAnyRuntimeToolPolicyEntry(tool.name, allow)) return false;
      return true;
    });
  }
  return filtered;
}

export function resolveEnabledMemoryToolNames(policy?: MemoryToolPolicy): string[] {
  return applyMemoryToolPolicy({
    baseTools: [
      "memory.search",
      "memory.read",
      "memory.remember"
    ],
    policy
  });
}

function matchesPolicyEntry(toolName: string, entry: string): boolean {
  if (!entry.includes("*")) {
    return toolName === entry;
  }
  const escaped = entry
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}
