import { canonicalizeAgentToolName, type AgentToolPolicy } from "@lume/shared";
import type { ToolRegistry } from "./tool-registry";
import type { LumeToolDescriptor } from "./tool-types";

export interface ToolResolveInput {
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  messageMetadata?: Record<string, unknown>;
  policies?: AgentToolPolicy[];
}

export class ToolResolver {
  constructor(private readonly registry: ToolRegistry) {}

  resolve(input: ToolResolveInput = {}): LumeToolDescriptor[] {
    let tools = this.registry.list();
    if (input.permissionMode === "plan") {
      tools = tools.filter((tool) => tool.metadata.allowedInPlanMode);
    }
    const metadataPolicy = resolveMetadataToolPolicy(input.messageMetadata);
    if (metadataPolicy) {
      tools = filterDescriptorsByPolicy(tools, metadataPolicy);
    }
    for (const policy of input.policies ?? []) {
      tools = filterDescriptorsByPolicy(tools, policy);
    }
    return tools;
  }
}

const TOOL_NAME_ALIASES: Record<string, string> = {
  "apply-patch": "apply_patch",
  glob: "find",
  memory_search: "memory.search",
  memory_get: "memory.read",
  memory_save: "memory.remember",
  websearch: "web_search",
  webfetch: "web_fetch"
};

const TOOL_GROUPS: Record<string, string[]> = {
  "group:fs": ["read", "write", "edit"],
  "group:runtime": ["bash"],
  "group:search": ["find", "grep", "ls"],
  "group:memory": ["memory.search", "memory.read", "memory.remember", "memory.writeEpisode", "memory.flush", "memory.status"],
  "group:memory-maintenance": ["memory.distillWorkspace", "memory.indexWorkspace", "memory.indexDocument"],
  "group:memory-global": ["memory.searchGlobal", "memory.listGlobalCandidates"],
  "group:memory-global-write": ["memory.promoteGlobal", "memory.rejectGlobalCandidate"],
  "group:web": ["web_search", "web_fetch"],
  "group:planning": ["askuserquestion", "taskcontractwrite"]
};

function resolveMetadataToolPolicy(messageMetadata?: Record<string, unknown>): AgentToolPolicy | undefined {
  const raw = messageMetadata?.toolPolicy;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const allow = Array.isArray(record.allow) ? record.allow.filter((item): item is string => typeof item === "string") : [];
  const deny = Array.isArray(record.deny) ? record.deny.filter((item): item is string => typeof item === "string") : [];
  if (allow.length === 0 && deny.length === 0) {
    return undefined;
  }
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {})
  };
}

function filterDescriptorsByPolicy(
  tools: LumeToolDescriptor[],
  policy: AgentToolPolicy
): LumeToolDescriptor[] {
  const allow = expandPolicyEntries(policy.allow);
  const deny = expandPolicyEntries(policy.deny);
  return tools.filter((tool) => {
    if (matchesAnyPolicyEntry(tool.canonicalName, deny)) return false;
    if (allow.length > 0 && !matchesAnyPolicyEntry(tool.canonicalName, allow)) return false;
    return true;
  });
}

function normalizeToolName(value: string): string {
  const normalized = canonicalizeAgentToolName(value);
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
}

function expandPolicyEntries(entries?: string[]): string[] {
  const expanded: string[] = [];
  for (const entry of entries ?? []) {
    const normalized = normalizeToolName(entry);
    const group = TOOL_GROUPS[normalized];
    if (group) {
      expanded.push(...group.map(normalizeToolName));
      continue;
    }
    expanded.push(normalized);
  }
  return Array.from(new Set(expanded));
}

function matchesAnyPolicyEntry(toolName: string, entries: string[]): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  return entries.some((entry) => matchesPolicyEntry(normalizedToolName, entry));
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
