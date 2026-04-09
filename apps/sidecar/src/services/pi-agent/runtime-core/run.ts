import {
  AskUserQuestionTool,
  BashTool,
  createAgent,
  EnterPlanModeTool,
  ExitPlanModeTool,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  LSPTool,
  NotebookEditTool,
  type SDKMessage,
  type Agent,
  type AgentOptions,
  type McpServerConfig,
  SkillTool,
  TodoWriteTool,
  defineTool,
  type ToolDefinition,
  WebFetchTool,
  WebSearchTool
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentToolPermissionRequest,
  WorkspaceMcpConfig
} from "@lume/shared";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildBuiltinAgents,
  buildDynamicContext,
  buildSystemPromptAppend
} from "../../agent/agent-prompt-builder";
import {
  resolveAgentDynamicContextInput,
  resolveAgentRuntimeRoutingTrace
} from "../../agent/agent-runtime-context";
import { getWorkspaceMcpConfig } from "../../agent/agent-workspace-manager";
import { createLogger } from "../../infra/logger";
import { resolveMemoryRuntimeConfig, shouldIncludeCitations } from "../../memory/memory-policy";
import { createLumePiTools } from "../tools/create-lume-tools";
import { applyPiToolPolicies } from "../tools/permissions/tool-policy";
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

interface RuntimeCoreToolset {
  tools: ToolDefinition[];
  availableToolNames: string[];
}

const ListDirectoryTool = defineTool({
  name: "ls",
  description: "List files and directories in a path.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative directory path. Defaults to current directory."
      }
    }
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    try {
      const targetPath = resolve(context.cwd, typeof input.path === "string" ? input.path : ".");
      const entries = await readdir(targetPath, { withFileTypes: true });
      return {
        data: {
          path: targetPath,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "dir" : "file"
          }))
        }
      };
    } catch (error) {
      return {
        data: `Error listing directory: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true
      };
    }
  }
});

function createBaseSdkAlignedTools(
  permissionMode: AgentSendInput["permissionMode"],
  options: { includeAskUserQuestion: boolean }
): ToolDefinition[] {
  const readOnlyTools: ToolDefinition[] = [
    FileReadTool,
    GlobTool,
    GrepTool,
    ListDirectoryTool,
    WebSearchTool,
    WebFetchTool
  ];

  if (permissionMode === "plan") {
    return [
      ...readOnlyTools,
      ...(options.includeAskUserQuestion ? [AskUserQuestionTool] : []),
      EnterPlanModeTool,
      ExitPlanModeTool,
      SkillTool
    ];
  }

  return [
    ...readOnlyTools,
    ...(options.includeAskUserQuestion ? [AskUserQuestionTool] : []),
    FileWriteTool,
    FileEditTool,
    BashTool,
    NotebookEditTool,
    SkillTool,
    TodoWriteTool,
    LSPTool,
    EnterPlanModeTool,
    ExitPlanModeTool
  ];
}

function buildRuntimeCoreTools(input: {
  cwd: string;
  sessionId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  channelId?: string;
  provider?: string;
  chatType?: AgentSendInput["chatType"];
  threadType?: AgentSendInput["threadType"];
  permissionMode?: AgentSendInput["permissionMode"];
  messageMetadata?: Record<string, unknown>;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}): RuntimeCoreToolset {
  const permissionMode = input.permissionMode ?? "default";
  const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
  const includeCitations = shouldIncludeCitations(
    memoryRuntimeConfig.citationsMode,
    input.chatType ?? "direct"
  );
  const automationExecution = isAutomationExecution(input.messageMetadata);
  const baseTools = createBaseSdkAlignedTools(permissionMode, {
    includeAskUserQuestion: automationExecution !== true
  });
  const lumeTools = createLumePiTools({
    threadId: input.sessionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadType: input.threadType,
    chatType: input.chatType,
    workspaceSlug: input.workspaceSlug,
    permissionMode,
    memoryToolPolicy: memoryRuntimeConfig.toolPolicy,
    includeCitations,
    automationExecution,
    emitSdkMessage: input.emitSdkMessage,
    emitAskUserQuestion: input.emitAskUserQuestion ?? (() => {}),
    emitToolPermissionRequest: input.emitToolPermissionRequest ?? (() => {})
  });

  const policyInput = {
    provider: input.provider,
    threadType: input.threadType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata
  };

  const customTools = applyPiToolPolicies(lumeTools.customTools as unknown as any[], policyInput) as unknown as ToolDefinition[];
  const filteredBaseTools = applyPiToolPolicies(baseTools as unknown as any[], policyInput) as unknown as ToolDefinition[];
  const tools = [...filteredBaseTools, ...customTools];

  return {
    tools,
    availableToolNames: Array.from(new Set(tools.map((tool) => tool.name)))
  };
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

function isAutomationExecution(messageMetadata?: Record<string, unknown>): boolean {
  if (!messageMetadata) {
    return false;
  }
  return typeof messageMetadata.automationJobId === "string"
    || typeof messageMetadata.automationTrigger === "string";
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
      threadId: input.lumeSessionId,
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
    agents: buildBuiltinAgents(),
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
