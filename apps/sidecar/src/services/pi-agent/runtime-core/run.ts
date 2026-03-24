import {
  SessionManager,
  createAgentSession,
  type AgentSession,
  type CreateAgentSessionResult
} from "@mariozechner/pi-coding-agent";
import type { AgentSendInput } from "@lume/shared";
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
  permissionMode?: AgentSendInput["permissionMode"];
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
  const upstream = await createAgentSession({
    cwd: input.cwd,
    agentDir: input.agentDir,
    model,
    modelRegistry,
    sessionManager,
    tools: buildRuntimeCoreTools(input.cwd, input.permissionMode)
  });

  return {
    session: upstream.session,
    upstream,
    sessionManager
  };
}
