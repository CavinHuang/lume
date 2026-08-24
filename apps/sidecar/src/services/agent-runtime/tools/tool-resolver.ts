import type { AgentToolPolicy } from "@lume/shared";
import type { ToolRegistry } from "./tool-registry";
import type { LumeToolDescriptor } from "./tool-types";
import {
  expandRuntimeToolPolicyEntries,
  matchesAnyRuntimeToolPolicyEntry
} from "./tool-policy-matcher";

export interface ToolResolveInput {
  permissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions" | "dontAsk";
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
  const allow = expandRuntimeToolPolicyEntries(policy.allow);
  const deny = expandRuntimeToolPolicyEntries(policy.deny);
  // 全部 allow 条目都匹配不到任何已注册工具 = 存量失效配置（如技能仍引用已下线工具），
  // 视为未设置 allow 回退默认工具集；只要有一个条目命中就维持收紧语义
  const allowAlive = allow.length === 0
    || tools.some((tool) => matchesAnyRuntimeToolPolicyEntry(tool.canonicalName, allow));
  return tools.filter((tool) => {
    if (matchesAnyRuntimeToolPolicyEntry(tool.canonicalName, deny)) return false;
    if (allowAlive && allow.length > 0 && !matchesAnyRuntimeToolPolicyEntry(tool.canonicalName, allow)) return false;
    return true;
  });
}
