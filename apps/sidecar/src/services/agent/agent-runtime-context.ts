import type { AgentSendInput } from "@lume/shared";
import { getAgentThreadMeta } from "./agent-thread-manager";
import { getWorkspaceSkills } from "./agent-workspace-manager";
import type { DynamicContext } from "./agent-prompt-builder";
import { inferCapabilityLanes, resolvePreferredCapabilityRoute, type CapabilityLane } from "./capability-routing";

interface ResolveAgentDynamicContextInput {
  threadId: string;
  userMessage?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  agentCwd?: string;
  availableTools?: string[];
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  fallbackModelRef?: string;
  fallbackModelId?: string;
}

export interface AgentRuntimeRoutingTrace {
  capabilityLanes: CapabilityLane[];
  preferredCapabilityRoute: CapabilityLane | null;
  reason: string;
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
    availableTools: input.availableTools,
    userMessage: input.userMessage
  };
}

export function resolveAgentRuntimeRoutingTrace(input: {
  workspaceSlug?: string;
  userMessage?: string;
  availableTools?: string[];
}): AgentRuntimeRoutingTrace {
  const loadedSkills = input.workspaceSlug ? getWorkspaceSkills(input.workspaceSlug) : [];
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
    capabilityLanes: inferCapabilityLanes(availableTools),
    preferredCapabilityRoute: decision.preferredLane,
    reason: decision.reason
  };
}
