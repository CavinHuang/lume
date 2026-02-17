import { homedir } from "node:os";
import type { AgentEventUsage } from "@lume/shared";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, type Api, type KnownProvider, type Model } from "@mariozechner/pi-ai";
import {
  appendAgentMessage,
  getAgentSessionMessages,
  getAgentSessionMeta,
  updateAgentSessionMeta
} from "../../agent-session-manager";
import {
  appendAgentEvents,
  buildAssistantAgentMessage,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "../../agent-stream-accumulator";
import {
  deriveChatTypeFromSessionKey,
  deriveChatTypeFromSessionType,
  normalizeMemoryChatType,
  resolveMemoryRuntimeConfig,
  shouldIncludeCitations
} from "../../memory-policy";
import { resolveModelCandidatesForChannel } from "../../model-selection";
import {
  buildDynamicContext,
  buildSystemPromptAppend,
  resolveSystemPromptMode
} from "../../agent-prompt-builder";
import { decryptApiKey, listChannels } from "../../channel-manager";
import { getAgentSessionWorkspacePath } from "../../config-paths";
import { ensurePluginManifest, getAgentWorkspace } from "../../agent-workspace-manager";
import { cancelPendingPiAskUserQuestionBySession } from "../tools/ask-user-question-bridge";
import { createCoreCodingTools } from "../tools/create-core-coding-tools";
import { createLumePiTools } from "../tools/create-lume-tools";
import { wrapToolsWithPermissionGate } from "../tools/tool-permission-gate";
import { cancelPendingToolPermissionBySession } from "../tools/tool-permission-bridge";
import { handlePiSessionEvent } from "../subscribe/handlers";
import type { PiAgentRunParams, PiAgentRunResult, PiAgentRuntimeEmitter } from "./types";
import { resolvePiProviderCandidates } from "./provider-resolution";

const MAX_CONTEXT_MESSAGES = 20;

interface RunPiAgentAttemptOptions {
  registerAbort: (sessionId: string, abort: () => Promise<void>) => void;
  unregisterAbort: (sessionId: string) => void;
}

export async function runPiAgentAttempt(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  options: RunPiAgentAttemptOptions
): Promise<PiAgentRunResult> {
  const { input, runtime } = params;
  if (process.env.LUME_PI_AGENT_MOCK_SUCCESS === "1") {
    return runMockSuccessAttempt(params, emit);
  }
  const channel = listChannels().find((item) => item.id === runtime.channelId);
  if (!channel) {
    return { status: "errored", errorMessage: "Pi Agent runtime 未找到可用渠道。" };
  }

  let apiKey = "";
  try {
    apiKey = decryptApiKey(runtime.channelId);
  } catch {
    return { status: "errored", errorMessage: "Pi Agent runtime 解密 API Key 失败。" };
  }
  const modelResolution = resolvePiModelForChannel({
    channel,
    channelProvider: channel.provider,
    modelId: runtime.modelId,
    baseUrl: channel.baseUrl
  });
  if (!modelResolution) {
    return {
      status: "errored",
      errorMessage: `Pi Agent runtime 未找到模型: ${channel.provider}/${runtime.modelId}`
    };
  }
  const { provider, resolvedModelId, model } = modelResolution;

  let workspaceSlug: string | undefined;
  let workspaceName: string | undefined;
  let agentCwd = homedir();
  if (runtime.workspaceId) {
    const workspace = getAgentWorkspace(runtime.workspaceId);
    if (workspace) {
      workspaceSlug = workspace.slug;
      workspaceName = workspace.name;
      agentCwd = getAgentSessionWorkspacePath(workspace.slug, runtime.sessionId);
      ensurePluginManifest(workspace.slug, workspace.name);
    }
  }

  const runtimeConfig = resolveMemoryRuntimeConfig();
  const chatType = normalizeMemoryChatType(input.chatType)
    ?? deriveChatTypeFromSessionType(input.sessionType)
    ?? deriveChatTypeFromSessionKey(runtime.sessionId);
  const includeCitations = shouldIncludeCitations(runtimeConfig.citationsMode, chatType);
  const lumeTools = createLumePiTools({
    agentCwd,
    sessionId: runtime.sessionId,
    workspaceId: runtime.workspaceId,
    channelId: runtime.channelId,
    workspaceSlug,
    permissionMode: input.permissionMode,
    includeCitations,
    memoryToolPolicy: runtimeConfig.toolPolicy,
    emitAskUserQuestion: emit.onAskUserQuestion
  });

  const systemPrompt = buildSystemPromptAppend({
    workspaceName,
    workspaceSlug,
    sessionId: runtime.sessionId,
    sessionType: input.sessionType,
    chatType,
    availableTools: lumeTools.availableToolNames,
    memoryCitationsMode: runtimeConfig.citationsMode,
    promptMode: resolveSystemPromptMode({
      sessionId: runtime.sessionId,
      sessionType: input.sessionType,
      chatType
    })
  });
  const dynamicContext = buildDynamicContext({
    workspaceName,
    workspaceSlug,
    agentCwd
  });
  const contextPrompt = buildContextPrompt(runtime.sessionId, input.userMessage);
  const contextualMessage = [dynamicContext, contextPrompt.text]
    .filter((item) => item.trim().length > 0)
    .join("\n\n");

  const accumulator = createAgentStreamAccumulatorState();
  if (contextPrompt.compacted) {
    appendAgentEvents(accumulator, [{ type: "compacting" }]);
    emit.onEvent({ type: "compacting" });
  }
  const existingMeta = getAgentSessionMeta(runtime.sessionId);
  const allTools = wrapToolsWithPermissionGate(
    [...createCoreCodingTools(agentCwd, input.permissionMode), ...lumeTools.customTools],
    {
      sessionId: runtime.sessionId,
      permissionMode: input.permissionMode,
      emitToolPermissionRequest: emit.onToolPermissionRequest
    }
  );
  const agent = new Agent({
    getApiKey: async (providerId) => {
      if (providerId === provider || providerId.startsWith(provider)) {
        return apiKey;
      }
      return undefined;
    },
    initialState: {
      model,
      systemPrompt,
      thinkingLevel: "medium",
      tools: allTools
    }
  });
  agent.sessionId = existingMeta?.piSessionId ?? runtime.sessionId;
  updateAgentSessionMeta(runtime.sessionId, {
    piSessionId: agent.sessionId
  });

  const unsubscribe = agent.subscribe((event) => {
    handlePiSessionEvent({
      event,
      contextWindow: (model as { contextWindow?: number }).contextWindow,
      accumulator,
      onEvent: emit.onEvent
    });
  });

  options.registerAbort(runtime.sessionId, async () => {
    agent.abort();
  });

  try {
    await agent.prompt(contextualMessage);
    backfillAssistantTextFromAgentState(agent.state.messages, accumulator, emit.onEvent);
    if (!hasRenderableAssistantOutput(accumulator)) {
      return {
        status: "errored",
        errorMessage: `模型返回空内容，请检查渠道配置（provider=${channel.provider}, baseUrl=${channel.baseUrl}, model=${resolvedModelId}）`
      };
    }
    if (contextPrompt.compacted) {
      appendAgentEvents(accumulator, [{ type: "compact_complete" }]);
      emit.onEvent({ type: "compact_complete" });
    }
    const usage = buildCompleteUsage(agent.state.messages);
    const stopReason = resolveStopReason(agent.state.messages);
    emit.onEvent({ type: "complete", stopReason, ...(usage ? { usage } : {}) });
    updateAgentSessionMeta(runtime.sessionId, {
      piSessionId: agent.sessionId
    });

    const assistant = buildAssistantAgentMessage(accumulator, `${provider}/${resolvedModelId}`);
    if (assistant) {
      appendAgentMessage(runtime.sessionId, assistant);
    }
    emit.onComplete();
    return { status: stopReason === "aborted" ? "aborted" : "completed" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(errorMessage)) {
      backfillAssistantTextFromAgentState(agent.state.messages, accumulator, emit.onEvent);
      const assistant = buildAssistantAgentMessage(accumulator, `${provider}/${resolvedModelId}`);
      if (assistant) {
        appendAgentMessage(runtime.sessionId, assistant);
      }
      emit.onComplete();
      return { status: "aborted" };
    }
    return { status: "errored", errorMessage };
  } finally {
    cancelPendingPiAskUserQuestionBySession(runtime.sessionId);
    cancelPendingToolPermissionBySession(runtime.sessionId);
    unsubscribe();
    options.unregisterAbort(runtime.sessionId);
  }
}

function runMockSuccessAttempt(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter
): PiAgentRunResult {
  const { runtime } = params;
  const mockText = (process.env.LUME_PI_AGENT_MOCK_TEXT || "Lume Pi Agent mock success").trim();
  const accumulator = createAgentStreamAccumulatorState();
  const textEvent = { type: "text_delta" as const, text: mockText };
  appendAgentEvents(accumulator, [textEvent]);
  emit.onEvent(textEvent);
  emit.onEvent({
    type: "complete",
    stopReason: "completed",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0
    }
  });
  const assistant = buildAssistantAgentMessage(accumulator, `mock/${runtime.modelId}`);
  if (assistant) {
    appendAgentMessage(runtime.sessionId, assistant);
  }
  updateAgentSessionMeta(runtime.sessionId, {
    piSessionId: runtime.sessionId
  });
  emit.onComplete();
  return { status: "completed" };
}

function applyChannelBaseUrl(model: Model<any>, baseUrl?: string): Model<any> {
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedBaseUrl) {
    return model;
  }
  return {
    ...model,
    baseUrl: trimmedBaseUrl
  };
}

function resolvePiModelForChannel(params: {
  channel: {
    models: Array<{ id: string; enabled: boolean; alias?: string; name: string }>;
    defaultModelId?: string;
    fallbackModelIds?: string[];
  };
  channelProvider?: string;
  modelId: string;
  baseUrl?: string;
}): { provider: KnownProvider; resolvedModelId: string; model: Model<Api> } | null {
  const candidateModelIds = resolveModelCandidatesForChannel(params.channel, params.modelId);
  for (const candidateModelId of candidateModelIds) {
    const { modelId, candidates } = resolvePiProviderCandidates({
      channelProvider: params.channelProvider,
      modelId: candidateModelId,
      baseUrl: params.baseUrl
    });
    for (const provider of candidates) {
      const catalogModel = getModel(provider, modelId as never);
      if (catalogModel) {
        return {
          provider,
          resolvedModelId: modelId,
          model: applyChannelBaseUrl(catalogModel, params.baseUrl)
        };
      }
    }
  }

  const firstModelId = candidateModelIds[0]?.trim();
  if (!firstModelId) {
    return null;
  }
  const { modelId, candidates } = resolvePiProviderCandidates({
    channelProvider: params.channelProvider,
    modelId: firstModelId,
    baseUrl: params.baseUrl
  });
  const fallbackProvider = candidates[0];
  if (!fallbackProvider) {
    return null;
  }
  return {
    provider: fallbackProvider,
    resolvedModelId: modelId,
    model: createFallbackModel(fallbackProvider, modelId, params.baseUrl)
  };
}

function createFallbackModel(provider: KnownProvider, modelId: string, baseUrl?: string): Model<Api> {
  const normalizedBaseUrl = baseUrl?.trim() || "https://api.openai.com/v1";
  const api =
    provider === "anthropic"
      ? "anthropic-messages"
      : provider === "google"
        ? "google-generative-ai"
        : "openai-responses";
  return {
    id: modelId,
    name: modelId,
    provider,
    api,
    baseUrl: normalizedBaseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 32768
  };
}

function buildContextPrompt(
  sessionId: string,
  currentUserMessage: string
): { text: string; compacted: boolean } {
  const allMessages = getAgentSessionMessages(sessionId);
  if (allMessages.length === 0) {
    return { text: currentUserMessage, compacted: false };
  }
  const history = allMessages.slice(0, -1);
  if (history.length === 0) {
    return { text: currentUserMessage, compacted: false };
  }
  const compacted = history.length > MAX_CONTEXT_MESSAGES;
  const recent = history.slice(-MAX_CONTEXT_MESSAGES);
  const lines = recent
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content)
    .map((message) => `[${message.role}]: ${message.content}`);
  if (lines.length === 0) {
    return { text: currentUserMessage, compacted };
  }
  return {
    text: `<conversation_history>\n${lines.join("\n")}\n</conversation_history>\n\n${currentUserMessage}`,
    compacted
  };
}

function resolveStopReason(messages: Array<{ role: string; stopReason?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    return message.stopReason ?? "completed";
  }
  return "completed";
}

function buildCompleteUsage(
  messages: Array<{ role: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } } }>
): AgentEventUsage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) {
      continue;
    }
    if (message.role !== "assistant" || !message.usage) {
      continue;
    }
    return {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheCreationTokens: message.usage.cacheWrite,
      costUsd: message.usage.cost?.total
    };
  }
  return undefined;
}

function backfillAssistantTextFromAgentState(
  messages: Array<{ role: string; content?: unknown }>,
  accumulator: ReturnType<typeof createAgentStreamAccumulatorState>,
  emitEvent: (event: import("@lume/shared").AgentEvent) => void
): void {
  const finalAssistantText = extractLatestAssistantText(messages);
  if (!finalAssistantText) {
    return;
  }
  if (accumulator.text === finalAssistantText) {
    return;
  }

  const event = finalAssistantText.startsWith(accumulator.text)
    ? {
      type: "text_delta" as const,
      text: finalAssistantText.slice(accumulator.text.length)
    }
    : {
      type: "text_complete" as const,
      text: finalAssistantText,
      isIntermediate: false
    };
  appendAgentEvents(accumulator, [event]);
  emitEvent(event);
}

function extractLatestAssistantText(
  messages: Array<{ role: string; content?: unknown }>
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    const textParts: string[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const item = block as { type?: string; text?: unknown };
      if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
        textParts.push(item.text);
      }
    }
    const combined = textParts.join("");
    if (combined.length > 0) {
      return combined;
    }
  }
  return "";
}
