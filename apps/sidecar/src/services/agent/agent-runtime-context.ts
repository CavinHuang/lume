import type { AgentSendInput } from "@lume/shared";
import { getAgentSessionMeta } from "./agent-session-manager";
import { getWorkspaceSkills } from "./agent-workspace-manager";
import type { DynamicContext } from "./agent-prompt-builder";
import { inferCapabilityLanes, resolvePreferredCapabilityRoute, type CapabilityLane } from "./capability-routing";

interface ResolveAgentDynamicContextInput {
  sessionId: string;
  threadId?: string;
  userMessage?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  agentCwd?: string;
  availableTools?: string[];
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
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
  const sessionMeta = getAgentSessionMeta(input.sessionId);
  return {
    sessionId: input.threadId ?? input.sessionId,
    sessionTitle: sessionMeta?.title,
    sessionType: input.threadType,
    chatType: input.chatType,
    parentSessionId: sessionMeta?.parentThreadId,
    workspaceId: sessionMeta?.workspaceId,
    channelId: sessionMeta?.channelId,
    modelId: sessionMeta?.modelId ?? input.fallbackModelId,
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

