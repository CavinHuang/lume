import type { AgentSendInput } from "@lume/shared";
import { getAgentThreadMeta } from "./agent-thread-manager";
import { getRuntimeSkills } from "./agent-workspace-manager";
import type { DynamicContext, EnabledPluginContextItem } from "./agent-prompt-builder";
import { inferCapabilityLanes, resolvePreferredCapabilityRoute, type CapabilityLane } from "./capability-routing";

interface ResolveAgentDynamicContextInput {
  threadId: string;
  userMessage?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  agentCwd?: string;
  lumeWorkDir?: string;
  projectRoot?: string;
  availableTools?: string[];
  routingTrace?: AgentRuntimeRoutingTrace;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  fallbackModelRef?: string;
  fallbackModelId?: string;
  enabledPlugins?: EnabledPluginContextItem[];
}

export interface AgentRuntimeRoutingTrace {
  capabilityLanes: CapabilityLane[];
  preferredCapabilityRoute: CapabilityLane | null;
  reason: string;
}

const CAPABILITY_LANES = new Set<CapabilityLane>([
  "skills",
  "browser",
  "memory",
  "web",
  "coding",
  "raw-tools"
]);

function isCapabilityLane(value: unknown): value is CapabilityLane {
  return typeof value === "string" && CAPABILITY_LANES.has(value as CapabilityLane);
}

export function resolvePersistedRoutingTrace(
  metadata?: Record<string, unknown>
): AgentRuntimeRoutingTrace | undefined {
  if (!metadata || !Array.isArray(metadata.capabilityLanes)) return undefined;
  const preferredRoute = metadata.preferredCapabilityRoute;
  if (preferredRoute !== null && !isCapabilityLane(preferredRoute)) return undefined;
  if (typeof metadata.capabilityRoutingReason !== "string") return undefined;

  return {
    capabilityLanes: metadata.capabilityLanes.filter(isCapabilityLane),
    preferredCapabilityRoute: preferredRoute,
    reason: metadata.capabilityRoutingReason
  };
}

export function resolveAgentDynamicContextInput(
  input: ResolveAgentDynamicContextInput
): DynamicContext {
  const threadMeta = getAgentThreadMeta(input.threadId);
  return {
    sessionId: input.threadId,
    sessionTitle: threadMeta?.title,
    sessionType: input.threadType,
    chatType: input.chatType,
    parentSessionId: threadMeta?.parentThreadId,
    workspaceId: threadMeta?.workspaceId,
    channelId: threadMeta?.channelId,
    modelRef: threadMeta?.modelRef ?? input.fallbackModelRef,
    modelId: threadMeta?.modelId ?? input.fallbackModelId,
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    agentCwd: input.agentCwd,
    lumeWorkDir: input.lumeWorkDir,
    projectRoot: input.projectRoot,
    availableTools: input.availableTools,
    userMessage: input.userMessage,
    capabilityLanes: input.routingTrace?.capabilityLanes,
    preferredCapabilityRoute: input.routingTrace?.preferredCapabilityRoute,
    capabilityRoutingReason: input.routingTrace?.reason,
    enabledPlugins: input.enabledPlugins
  };
}

export function resolveAgentRuntimeRoutingTrace(input: {
  workspaceSlug?: string;
  agentCwd?: string;
  userMessage?: string;
  availableTools?: string[];
}): AgentRuntimeRoutingTrace {
  const loadedSkills = input.workspaceSlug ? getRuntimeSkills(input.workspaceSlug, input.agentCwd) : [];
  const availableTools = [...(input.availableTools ?? [])];
  if (loadedSkills.length > 0 && !availableTools.some((tool) => tool.trim().toLowerCase() === "skill")) {
    availableTools.push("Skill");
  }
  const decision = resolvePreferredCapabilityRoute({
    userMessage: input.userMessage,
    availableTools,
    loadedSkills
  });
  return {
    capabilityLanes: inferCapabilityLanes(availableTools, input.userMessage),
    preferredCapabilityRoute: decision.preferredLane,
    reason: decision.reason
  };
}
