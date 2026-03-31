import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionResult
} from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentToolPermissionRequest
} from "@lume/shared";
import { buildDynamicContext, buildSystemPromptAppend } from "../../agent/agent-prompt-builder";
import {
  resolveAgentDynamicContextInput,
  resolveAgentRuntimeRoutingTrace
} from "../../agent/agent-runtime-context";
import { getWorkspaceSkills } from "../../agent/agent-workspace-manager";
import { createLogger } from "../../infra/logger";
import { resolveMemoryRuntimeConfig } from "../../memory/memory-policy";
import { resolveRuntimeCoreModel } from "./model";
import { discoverRuntimeCoreModelRegistry } from "./pi-model-discovery";
import { buildRuntimeCoreTools } from "./pi-tools";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { createOrResumeRuntimeCoreSessionManager } from "./session-store";

const log = createLogger("runtime-core-prompt");

export interface CreateRuntimeCoreSessionInput {
  lumeSessionId: string;
  cwd: string;
  agentDir: string;
  userMessage?: string;
  provider: KnownProvider;
  modelId: string;
  resolvedModel?: Model<Api>;
  apiKey: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  channelId?: string;
  sessionType?: AgentSendInput["sessionType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  messageMetadata?: Record<string, unknown>;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  sessionManager?: SessionManager;
}

export interface CreateRuntimeCoreSessionResult {
  session: AgentSession;
  upstream: CreateAgentSessionResult;
  sessionManager: SessionManager;
}

function collectAvailableToolNames(toolset: {
  tools: Array<{ name?: string }>;
  customTools: Array<{ name?: string }>;
}, options?: { workspaceSlug?: string }): string[] {
  const names = [
    ...toolset.tools.map((tool) => tool.name),
    ...toolset.customTools.map((tool) => tool.name)
  ]
    .filter((name): name is string => typeof name === "string")
    .map((name) => name.trim())
    .filter(Boolean);
  if (options?.workspaceSlug) {
    const skills = getWorkspaceSkills(options.workspaceSlug);
    if (skills.length > 0) {
      names.push("Skill");
    }
  }
  return Array.from(new Set(names));
}

export async function createRuntimeCoreResourceLoader(input: {
  cwd: string;
  agentDir: string;
  lumeSessionId: string;
  modelId: string;
  userMessage?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  sessionType?: AgentSendInput["sessionType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  availableTools: string[];
  messageMetadata?: Record<string, unknown>;
}): Promise<DefaultResourceLoader> {
  const automationExecution = typeof input.messageMetadata?.automationJobId === "string"
    || typeof input.messageMetadata?.automationTrigger === "string";
  const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
  const systemPromptAppend = buildSystemPromptAppend({
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    sessionId: input.lumeSessionId,
    sessionType: input.sessionType,
    chatType: input.chatType,
    availableTools: input.availableTools,
    memoryCitationsMode: memoryRuntimeConfig.citationsMode,
    automationExecution,
    permissionMode: input.permissionMode
  }).trim();
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
      sessionType: input.sessionType,
      chatType: input.chatType,
      fallbackModelId: input.modelId
    })
  ).trim();

  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    // Lume 已自行注入 AGENTS/SOUL/IDENTITY/USER/MEMORY 等 workspace context，
    // 这里关闭默认 AGENTS.md 自动发现，避免与 Project Context 重复。
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    appendSystemPromptOverride: (base) => [
      ...base,
      systemPromptAppend,
      dynamicContext
    ].filter((part) => typeof part === "string" && part.trim().length > 0)
  });
  await loader.reload();
  return loader;
}

export async function createRuntimeCoreSession(
  input: CreateRuntimeCoreSessionInput
): Promise<CreateRuntimeCoreSessionResult> {
  const model = input.resolvedModel ?? resolveRuntimeCoreModel({
    provider: input.provider,
    modelId: input.modelId
  });
  if (!model) {
    throw new Error(`runtime-core 未找到模型: ${input.provider}/${input.modelId}`);
  }

  const sessionManager = input.sessionManager ?? createOrResumeRuntimeCoreSessionManager(input.cwd, input.lumeSessionId, input.agentDir);
  const modelRegistry = discoverRuntimeCoreModelRegistry({ agentDir: input.agentDir });
  modelRegistry.registerProvider(input.provider, {
    apiKey: input.apiKey
  });
  const toolset = buildRuntimeCoreTools({
    cwd: input.cwd,
    sessionId: input.lumeSessionId,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    channelId: input.channelId,
    provider: input.provider,
    sessionType: input.sessionType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    messageMetadata: input.messageMetadata,
    emitAskUserQuestion: input.emitAskUserQuestion,
    emitToolPermissionRequest: input.emitToolPermissionRequest
  });
  const resourceLoader = await createRuntimeCoreResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    lumeSessionId: input.lumeSessionId,
    modelId: input.modelId,
    userMessage: input.userMessage,
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    sessionType: input.sessionType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    availableTools: collectAvailableToolNames(toolset, {
      workspaceSlug: input.workspaceSlug
    }),
    messageMetadata: input.messageMetadata
  });
  const upstream = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    model,
    modelRegistry,
    sessionManager,
    resourceLoader,
    tools: toolset.tools,
    customTools: toolset.customTools
  });

  return {
    session: upstream.session,
    upstream,
    sessionManager
  };
}
