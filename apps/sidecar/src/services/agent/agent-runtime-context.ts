import type { AgentSendInput } from "@lume/shared";
import { getAgentThreadMeta } from "./agent-thread-manager";
import type { DynamicContext, EnabledPluginContextItem } from "./agent-prompt-builder";

export interface ResolveAgentDynamicContextInput {
  threadId: string;
  userMessage?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  agentCwd?: string;
  lumeWorkDir?: string;
  projectRoot?: string;
  availableTools?: string[];
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  fallbackModelRef?: string;
  fallbackModelId?: string;
  enabledPlugins?: EnabledPluginContextItem[];
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
    enabledPlugins: input.enabledPlugins
  };
}
