/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts
 * Adaptation:
 * - Route all agent execution through Pi Agent runtime.
 * - Keep sidecar event emitter contract (no Electron webContents dependency).
 */

import type { SDKMessage } from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentAskUserQuestionResponseInput,
  AgentToolPolicy,
  AgentToolPermissionRequest,
  AgentToolPermissionResponseInput,
  AgentGenerateTitleInput
} from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import { fetchTitle, getAdapter } from "../../providers";
import { decryptApiKey, listChannels } from "../channel/channel-manager";
import {
  getAgentSessionMessages,
  getAgentSessionMeta,
  readRuntimeCoreTranscriptMessages,
  replaceAgentSessionTranscript,
  updateAgentSessionMeta
} from "./agent-session-manager";
import {
  createAssistantMessageVersion,
  createUserMessageVersion,
  getLatestVisibleMessagesForSession
} from "./agent-message-versioning-service";
import { getAgentRuntimeStatusManager } from "./agent-runtime-status-manager";
import { getAgentWorkspace } from "./agent-workspace-manager";
import { resolveAgentRuntimeRoutingTrace } from "./agent-runtime-context";
import { createLogger } from "../infra/logger";
import {
  getSessionStateManager,
  startSessionHeartbeat,
  stopSessionHeartbeat,
} from "../runtime/session-state-manager";
import { submitPiAskUserQuestionAnswers } from "../pi-agent/tools/bridges/ask-user-question-bridge";
import { submitToolPermissionDecision } from "../pi-agent/tools/bridges/tool-permission-bridge";
import {
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "../channel/model-selection";
import {
  AGENT_TITLE_PROMPT_FROM_SUMMARY,
  deriveFallbackAgentTitleFromSourceText,
  isWeakGeneratedTitle,
  resolveAgentTitleSourceText,
  sanitizeGeneratedTitle,
  shouldAutoGenerateSessionTitle
} from "./session-title-summarizer";
import { resolveSoftToolPolicyForPreferredRoute } from "./capability-routing";

type AgentStreamEmitter = {
  onSdkMessage: (message: SDKMessage) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onTitleUpdated: (title: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
};

// Memory Flush 待发送队列：sessionId -> prompt
const pendingMemoryFlushPrompts = new Map<string, string>();

export function consumeMemoryFlushPrompt(sessionId: string): string | undefined {
  const prompt = pendingMemoryFlushPrompts.get(sessionId);
  if (prompt) pendingMemoryFlushPrompts.delete(sessionId);
  return prompt;
}

const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";

const log = createLogger("agent-service");
const ROUTING_HEURISTIC_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "find",
  "grep",
  "ls",
  "browser",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
  "memory_save"
];

function mergeToolPolicies(
  base: AgentToolPolicy | undefined,
  overlay: AgentToolPolicy | undefined
): AgentToolPolicy | undefined {
  if (!base && !overlay) {
    return undefined;
  }
  const baseAllow = Array.isArray(base?.allow) ? base.allow.filter((v): v is string => typeof v === "string") : [];
  const baseDeny = Array.isArray(base?.deny) ? base.deny.filter((v): v is string => typeof v === "string") : [];
  const overlayAllow = Array.isArray(overlay?.allow) ? overlay.allow.filter((v): v is string => typeof v === "string") : [];
  const overlayDeny = Array.isArray(overlay?.deny) ? overlay.deny.filter((v): v is string => typeof v === "string") : [];
  const allow = Array.from(new Set([...baseAllow, ...overlayAllow]));
  const deny = Array.from(new Set([...baseDeny, ...overlayDeny]));
  if (allow.length === 0 && deny.length === 0) {
    return undefined;
  }
  return {
    ...(allow.length > 0 ? { allow } : {}),
    ...(deny.length > 0 ? { deny } : {})
  };
}

function handleRuntimeSessionStateMessage(
  sessionId: string,
  message: SDKMessage,
  sessionStateManager: ReturnType<typeof getSessionStateManager>
): void {
  if (message.type === "result" && message.usage) {
    const usage = message.usage;
    const totalTokens = (usage.input_tokens ?? 0)
      + (usage.output_tokens ?? 0)
      + (usage.cache_read_input_tokens ?? 0)
      + (usage.cache_creation_input_tokens ?? 0);
    const contextWindow = message.modelUsage ? Object.values(message.modelUsage)[0]?.contextWindow : undefined;
    sessionStateManager.updateTokens(
      sessionId,
      totalTokens,
      contextWindow
    );

    const flushCheck = sessionStateManager.checkMemoryFlush(sessionId);
    if (flushCheck.executed && flushCheck.prompt) {
      log.info("Memory Flush 触发条件满足，已加入待发送队列", {
        sessionId: sessionId.slice(0, 8),
        reason: flushCheck.reason,
      });
      pendingMemoryFlushPrompts.set(sessionId, flushCheck.prompt);
      sessionStateManager.markMemoryFlushExecuted(sessionId);
    }
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    sessionStateManager.incrementCompaction(sessionId);
    log.info("会话开始压缩", { sessionId: sessionId.slice(0, 8) });
    log.info("会话压缩完成", { sessionId: sessionId.slice(0, 8) });
  }
}

export function submitAskUserQuestionAnswers(input: AgentAskUserQuestionResponseInput): { ok: true } {
  const handledByPi = submitPiAskUserQuestionAnswers(input);
  if (handledByPi) {
    getAgentRuntimeStatusManager().markStreaming(input.threadId);
    return { ok: true };
  }
  throw new Error("未找到待确认的 AskUserQuestion 请求");
}

export function submitAgentToolPermission(input: AgentToolPermissionResponseInput): { ok: true } {
  const handled = submitToolPermissionDecision(input);
  if (handled) {
    getAgentRuntimeStatusManager().markStreaming(input.threadId);
    return { ok: true };
  }
  throw new Error("未找到待确认的工具权限请求");
}

function pickModelId(channelId: string | undefined, requestedModelId?: string): string {
  if (!channelId) return requestedModelId?.trim() || DEFAULT_MODEL_ID;
  const channel = listChannels().find((item) => item.id === channelId);
  if (!channel) return requestedModelId?.trim() || DEFAULT_MODEL_ID;
  return resolveRequestedModelIdForChannel(channel, requestedModelId) ?? DEFAULT_MODEL_ID;
}

function resolveLatestAssistantTranscriptMessage(sessionId: string) {
  const transcriptMessages = readRuntimeCoreTranscriptMessages(sessionId);
  for (let index = transcriptMessages.length - 1; index >= 0; index--) {
    const message = transcriptMessages[index]!;
    if (message.role === "assistant") {
      return message;
    }
  }
  return null;
}


export async function sendAgentMessage(
  input: AgentSendInput,
  emit: AgentStreamEmitter,
  options: { appendUserMessage?: boolean; allowResumeRetry?: boolean } = {}
): Promise<void> {
  const { threadId: sessionId, userMessage, workspaceId } = input;
  const messageHistoryBeforeSend = getAgentSessionMessages(sessionId);
  const assistantTurnCountBeforeSend = messageHistoryBeforeSend.filter((item) => item.role === "assistant").length;
  const sessionMeta = getAgentSessionMeta(sessionId);
  const resolvedChannelId = input.channelId ?? sessionMeta?.channelId;
  const resolvedModelId = pickModelId(resolvedChannelId, input.modelId);

  const shouldAppendUserMessage = options.appendUserMessage ?? true;
  const shouldTryAutoTitle = shouldAppendUserMessage && assistantTurnCountBeforeSend === 0;
  void options.allowResumeRetry;
  let activeTurnId: string | null = null;

  let stateWorkspaceSlug: string | undefined;
  if (workspaceId) {
    const workspace = getAgentWorkspace(workspaceId);
    if (workspace) {
      stateWorkspaceSlug = workspace.slug;
    }
  }

  const routingTrace = resolveAgentRuntimeRoutingTrace({
    workspaceSlug: stateWorkspaceSlug,
    userMessage,
    availableTools: ROUTING_HEURISTIC_TOOLS
  });
  const routingToolPolicy = resolveSoftToolPolicyForPreferredRoute(routingTrace.preferredCapabilityRoute);
  const existingToolPolicy =
    input.messageMetadata?.toolPolicy && typeof input.messageMetadata.toolPolicy === "object"
      ? (input.messageMetadata.toolPolicy as AgentToolPolicy)
      : undefined;
  const effectiveMessageMetadata = {
    ...(input.messageMetadata ?? {}),
    capabilityLanes: routingTrace.capabilityLanes,
    preferredCapabilityRoute: routingTrace.preferredCapabilityRoute,
    capabilityRoutingReason: routingTrace.reason,
    toolPolicy: mergeToolPolicies(existingToolPolicy, routingToolPolicy)
  };

  if (shouldAppendUserMessage) {
    const sourceMessageId = input.editFromMessageId ?? input.resendFromMessageId;
    const createdUserVersion = createUserMessageVersion({
      sessionId,
      content: userMessage,
      createdAt: Date.now(),
      metadata: effectiveMessageMetadata,
      sourceMessageId
    });
    activeTurnId = createdUserVersion.turnId;
    if (sourceMessageId) {
      replaceAgentSessionTranscript(sessionId, getLatestVisibleMessagesForSession(sessionId));
    }
  }

  const sessionStateManager = getSessionStateManager();
  const runtimeStatusManager = getAgentRuntimeStatusManager();
  sessionStateManager.getOrCreate(sessionId, stateWorkspaceSlug);
  if (stateWorkspaceSlug) {
    startSessionHeartbeat(sessionId, stateWorkspaceSlug, async () => {
      log.info("Heartbeat 检查完成", { sessionId: sessionId.slice(0, 8), workspaceSlug: stateWorkspaceSlug });
    });
  }

  updateAgentSessionMeta(sessionId, {
    channelId: resolvedChannelId,
    modelId: resolvedModelId
  });
  runtimeStatusManager.markStreaming(sessionId);
  let runtimeCompleted = false;

  if (!resolvedChannelId || !resolvedModelId) {
    const msg = "Pi Agent runtime 缺少 channelId/modelId。";
    runtimeStatusManager.markErrored(sessionId, msg);
    emit.onError(msg);
    return;
  }
  const { runPiAgent } = await import("../pi-agent/runtime-core/attempt");
  const piResult = await runPiAgent({
    input: {
      ...input,
      messageMetadata: effectiveMessageMetadata,
      channelId: resolvedChannelId,
      modelId: resolvedModelId
    },
    runtime: {
      sessionId,
      channelId: resolvedChannelId,
      modelId: resolvedModelId,
      workspaceId: input.workspaceId,
      threadType: input.threadType
    }
  }, {
    onSdkMessage: (message) => {
      handleRuntimeSessionStateMessage(sessionId, message, sessionStateManager);
      if (message.type === "system" && message.subtype === "compact_boundary") {
        runtimeStatusManager.markCompacting(sessionId);
      }
      emit.onSdkMessage(message);
    },
    onComplete: () => {
      runtimeCompleted = true;
    },
    onError: (error) => {
      runtimeStatusManager.markErrored(sessionId, error);
      emit.onError(error);
    },
    onAskUserQuestion: (request) => {
      runtimeStatusManager.markAwaitingUserAnswer(sessionId, {
        toolUseId: request.toolUseId,
        originThreadId: request.originThreadId,
        subagentRunId: request.subagentRunId
      });
      emit.onAskUserQuestion(request);
    },
    onToolPermissionRequest: (request) => {
      runtimeStatusManager.markAwaitingPermission(sessionId, {
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        originThreadId: request.originThreadId,
        subagentRunId: request.subagentRunId
      });
      emit.onToolPermissionRequest(request);
    }
  });
  if (piResult.status === "completed" && activeTurnId) {
    const latestAssistantMessage = resolveLatestAssistantTranscriptMessage(sessionId);
    if (latestAssistantMessage) {
      createAssistantMessageVersion({
        sessionId,
        turnId: activeTurnId,
        message: latestAssistantMessage
      });
    }
  }
  if (runtimeCompleted && piResult.status === "completed") {
    runtimeStatusManager.markCompleted(sessionId);
    emit.onComplete();
  }
  if (piResult.status === "completed" && shouldTryAutoTitle) {
    void autoGenerateAgentTitle(sessionId, userMessage, emit);
  }
  return;
}

export function stopAgent(sessionId: string): void {
  const sessionStateManager = getSessionStateManager();
  const state = sessionStateManager.getAll().find((s) => s.sessionId === sessionId);
  if (state?.workspaceSlug) {
    stopSessionHeartbeat(state.workspaceSlug);
  }
  sessionStateManager.delete(sessionId);
  getAgentRuntimeStatusManager().markIdle(sessionId);
  void import("../pi-agent/runtime-core/attempt")
    .then((module) => module.stopPiAgent(sessionId))
    .catch(() => undefined);
}

export function stopAllAgents(): void {
  // 停止所有 Heartbeat 定时器
  const { getHeartbeatService } = require("../runtime/heartbeat-service");
  const heartbeatService = getHeartbeatService();
  heartbeatService.stopAllTimers();
  void import("../pi-agent/runtime-core/attempt")
    .then((module) => module.stopAllPiAgents())
    .catch(() => undefined);
}

export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  const sourceText = (input.sourceText ?? input.userMessage ?? "").trim();
  if (!sourceText) {
    return null;
  }
  const channel = listChannels().find((item) => item.id === input.channelId);
  if (!channel) {
    log.warn("自动标题生成失败：渠道不存在", {
      channelId: input.channelId
    });
    return null;
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(input.channelId);
  } catch (error) {
    log.warn("自动标题生成失败：解密 API Key 失败", {
      channelId: input.channelId,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }

  try {
    const modelSelection = resolveChannelModelSelection({
      channelProvider: channel.provider,
      baseUrl: channel.baseUrl,
      modelId: input.modelId
    });
    const adapter = getAdapter(modelSelection.adapterProvider);
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId: modelSelection.resolvedModelId,
      prompt: AGENT_TITLE_PROMPT_FROM_SUMMARY + sourceText
    });
    const title = await fetchTitle(request, adapter);
    if (!title) return null;
    const cleaned = sanitizeGeneratedTitle(title);
    if (!cleaned || isWeakGeneratedTitle(cleaned)) {
      return null;
    }
    return cleaned;
  } catch (error) {
    log.warn("自动标题生成失败：模型调用异常", {
      channelId: input.channelId,
      modelId: input.modelId,
      baseUrl: channel.baseUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function autoGenerateAgentTitle(
  sessionId: string,
  fallbackUserMessage: string,
  emit: AgentStreamEmitter
): void {
  try {
    const meta = getAgentSessionMeta(sessionId);
    if (!meta) {
      log.debug("自动标题跳过：会话不存在", { sessionId });
      return;
    }
    if (!shouldAutoGenerateSessionTitle(meta.title)) {
      log.debug("自动标题跳过：会话标题不是默认值", {
        sessionId,
        currentTitle: meta.title
      });
      return;
    }
    const sessionMessages = getAgentSessionMessages(sessionId);
    const sourceText = resolveAgentTitleSourceText(sessionMessages, fallbackUserMessage);
    const fallbackTitle = sanitizeGeneratedTitle(deriveFallbackAgentTitleFromSourceText(sourceText) ?? "");
    if (!fallbackTitle) {
      log.debug("自动标题跳过：未能生成可用标题", { sessionId });
      return;
    }
    updateAgentSessionMeta(sessionId, { title: fallbackTitle });
    log.info("自动标题更新成功（临时）", {
      sessionId,
      title: fallbackTitle,
      source: "fallback"
    });
    emit.onTitleUpdated(fallbackTitle);
  } catch (error) {
    log.warn("自动标题生成流程异常", {
      sessionId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

