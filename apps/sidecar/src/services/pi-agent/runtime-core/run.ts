import {
  SessionManager,
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionResult
} from "@mariozechner/pi-coding-agent";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentToolPermissionRequest
} from "@lume/shared";
import { resolveRuntimeCoreModel } from "./model";
import { discoverRuntimeCoreModelRegistry } from "./pi-model-discovery";
import { buildRuntimeCoreTools } from "./pi-tools";
import type { KnownProvider } from "@mariozechner/pi-ai";
import { createOrResumeRuntimeCoreSessionManager } from "./session-store";

export interface CreateRuntimeCoreSessionInput {
  lumeSessionId: string;
  cwd: string;
  agentDir: string;
  provider: KnownProvider;
  modelId: string;
  apiKey: string;
  workspaceId?: string;
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

export async function createRuntimeCoreSession(
  input: CreateRuntimeCoreSessionInput
): Promise<CreateRuntimeCoreSessionResult> {
  const model = resolveRuntimeCoreModel({
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
  const upstream = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    model,
    modelRegistry,
    sessionManager,
    tools: toolset.tools,
    customTools: toolset.customTools
  });

  return {
    session: upstream.session,
    upstream,
    sessionManager
  };
}
