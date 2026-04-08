import {
  createAgent,
  type SDKMessage,
  type Agent,
  type AgentOptions,
  type McpServerConfig,
  type ToolDefinition
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentToolPermissionRequest,
  WorkspaceMcpConfig
} from "@lume/shared";
import { buildDynamicContext, buildSystemPromptAppend } from "../../agent/agent-prompt-builder";
import {
  resolveAgentDynamicContextInput,
  resolveAgentRuntimeRoutingTrace
} from "../../agent/agent-runtime-context";
import { getWorkspaceMcpConfig } from "../../agent/agent-workspace-manager";
import { createLogger } from "../../infra/logger";
import { resolveMemoryRuntimeConfig } from "../../memory/memory-policy";
import { buildRuntimeCoreTools } from "./pi-tools";
import {
  createOrResumeRuntimeCoreSessionManager,
  hasRuntimeCoreSessionTranscript,
  type RuntimeCoreSessionManager
} from "./session-store";

const log = createLogger("runtime-core-prompt");

interface RuntimeCoreResolvedModel {
  id: string;
  provider: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CreateRuntimeCoreSessionInput {
  lumeSessionId: string;
  cwd: string;
  agentDir: string;
  userMessage?: string;
  provider: string;
  modelId: string;
  resolvedModel?: RuntimeCoreResolvedModel;
  apiKey: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  channelId?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  messageMetadata?: Record<string, unknown>;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}

export interface RuntimeCoreSessionLike {
  sessionId: string;
  threadId?: string;
  model?: RuntimeCoreResolvedModel;
  messages: Array<{ role: string }>;
  agent: {
    state: {
      systemPrompt: string;
    };
  };
  getActiveToolNames(): string[];
  dispose(): Promise<void>;
}

export interface CreateRuntimeCoreSessionResult {
  agent: Agent;
  session: RuntimeCoreSessionLike;
  sessionManager: RuntimeCoreSessionManager;
  systemPrompt: string;
  tools: ToolDefinition[];
}

function resolveSdkApiType(provider: string): "anthropic-messages" | "openai-completions" {
  return provider.trim().toLowerCase() === "anthropic"
    ? "anthropic-messages"
    : "openai-completions";
}

function buildMcpServers(workspaceSlug?: string): Record<string, McpServerConfig> | undefined {
  if (!workspaceSlug) {
    return undefined;
  }
  const config = getWorkspaceMcpConfig(workspaceSlug);
  return mapWorkspaceMcpConfig(config);
}

function mapWorkspaceMcpConfig(config: WorkspaceMcpConfig): Record<string, McpServerConfig> | undefined {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(config.servers ?? {})) {
    if (!entry.enabled) continue;
    if (entry.type === "stdio" && entry.command) {
      servers[name] = {
        type: "stdio",
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.env ? { env: entry.env } : {})
      };
      continue;
    }
    if ((entry.type === "http" || entry.type === "sse") && entry.url) {
      servers[name] = {
        type: entry.type,
        url: entry.url,
        ...(entry.headers ? { headers: entry.headers } : {})
      };
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

function buildCombinedSystemPrompt(input: {
  lumeSessionId: string;
  cwd: string;
  modelId: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  channelId?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  userMessage?: string;
  availableTools: string[];
}): string {
  const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
  const systemPromptAppend = buildSystemPromptAppend({
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    sessionId: input.lumeSessionId,
    sessionType: input.threadType,
    chatType: input.chatType,
    availableTools: input.availableTools,
    memoryCitationsMode: memoryRuntimeConfig.citationsMode,
    permissionMode: input.permissionMode
  }).trim().replace("\n# Project Context\n", "\n## Project Context\n");

  const routingTrace = resolveAgentRuntimeRoutingTrace({
    workspaceSlug: input.workspaceSlug,
    userMessage: input.userMessage,
    availableTools: input.availableTools
  });
  log.debug("resolved capability routing trace", {
    sessionId: input.lumeSessionId,
    workspaceSlug: input.workspaceSlug,
    capabilityLanes: routingTrace.capabilityLanes,
    preferredCapabilityRoute: routingTrace.preferredCapabilityRoute,
    routingReason: routingTrace.reason
  });

  const dynamicContext = buildDynamicContext(
    resolveAgentDynamicContextInput({
      sessionId: input.lumeSessionId,
      userMessage: input.userMessage,
      workspaceName: input.workspaceName,
      workspaceSlug: input.workspaceSlug,
      agentCwd: input.cwd,
      availableTools: input.availableTools,
      threadType: input.threadType,
      chatType: input.chatType,
      fallbackModelId: input.modelId
    })
  ).trim();

  return [systemPromptAppend, dynamicContext]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n\n");
}

export async function createRuntimeCoreSession(
  input: CreateRuntimeCoreSessionInput
): Promise<CreateRuntimeCoreSessionResult> {
  const sessionManager = createOrResumeRuntimeCoreSessionManager(input.cwd, input.lumeSessionId, input.agentDir);
  const toolset = buildRuntimeCoreTools({
    cwd: input.cwd,
    sessionId: input.lumeSessionId,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    channelId: input.channelId,
    provider: input.provider,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    messageMetadata: input.messageMetadata,
    emitSdkMessage: input.emitSdkMessage,
    emitAskUserQuestion: input.emitAskUserQuestion,
    emitToolPermissionRequest: input.emitToolPermissionRequest
  });

  const systemPrompt = buildCombinedSystemPrompt({
    lumeSessionId: input.lumeSessionId,
    cwd: input.cwd,
    modelId: input.resolvedModel?.id ?? input.modelId,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    channelId: input.channelId,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    userMessage: input.userMessage,
    availableTools: toolset.availableToolNames
  });

  const agentOptions: AgentOptions = {
    apiType: resolveSdkApiType(input.provider),
    apiKey: input.apiKey,
    ...(input.resolvedModel?.baseUrl ? { baseURL: input.resolvedModel.baseUrl } : {}),
    model: input.resolvedModel?.id ?? input.modelId,
    cwd: input.cwd,
    systemPrompt,
    tools: toolset.tools,
    sessionId: input.lumeSessionId,
    ...(hasRuntimeCoreSessionTranscript(input.lumeSessionId, input.agentDir)
      ? { resume: input.lumeSessionId }
      : {}),
    ...(buildMcpServers(input.workspaceSlug) ? { mcpServers: buildMcpServers(input.workspaceSlug) } : {}),
    permissionMode: input.permissionMode === "bypassPermissions" ? "bypassPermissions" : "default",
    includePartialMessages: true,
    additionalDirectories: input.workspaceSlug ? [input.cwd] : undefined,
    persistSession: true
  };

  const agent = createAgent(agentOptions);
  await agent.getInitializationResult();

  const context = sessionManager.buildSessionContext();
  const session: RuntimeCoreSessionLike = {
    sessionId: input.lumeSessionId,
    threadId: input.lumeSessionId,
    model: input.resolvedModel ?? {
      id: input.modelId,
      provider: input.provider
    },
    messages: context.messages.map((message) => ({ role: message.role })),
    agent: {
      state: {
        systemPrompt
      }
    },
    getActiveToolNames() {
      return toolset.tools.map((tool) => tool.name);
    },
    async dispose() {
      await agent.close();
    }
  };

  return {
    agent,
    session,
    sessionManager,
    systemPrompt,
    tools: toolset.tools
  };
}

