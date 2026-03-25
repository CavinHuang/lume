/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts
 * Adaptation:
 * - Route all agent execution through Pi Agent runtime.
 * - Keep sidecar event emitter contract (no Electron webContents dependency).
 */

import type {
  AgentEvent,
  AgentAskUserQuestionRequest,
  AgentAskUserQuestionResponseInput,
  AgentToolPermissionRequest,
  AgentToolPermissionResponseInput,
  AgentGenerateTitleInput
} from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import { fetchTitle, getAdapter } from "../../providers";
import { decryptApiKey, listChannels } from "../channel-manager";
import {
  getAgentSessionMessages,
  getAgentSessionMeta,
  updateAgentSessionMeta
} from "./agent-session-manager";
import { getAgentRuntimeStatusManager } from "./agent-runtime-status-manager";
import { getAgentWorkspace } from "./agent-workspace-manager";
import { createLogger } from "../logger";
import {
  getSessionStateManager,
  startSessionHeartbeat,
  stopSessionHeartbeat,
} from "../session-state-manager";
import { submitPiAskUserQuestionAnswers } from "../pi-agent/tools/ask-user-question-bridge";
import { submitToolPermissionDecision } from "../pi-agent/tools/tool-permission-bridge";
import { resolveAgentEventTotalTokens } from "../pi-agent/usage";
import {
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "../model-selection";
import {
  AGENT_TITLE_PROMPT_FROM_SUMMARY,
  deriveFallbackAgentTitleFromSourceText,
  isWeakGeneratedTitle,
  resolveAgentTitleSourceText,
  sanitizeGeneratedTitle,
  shouldAutoGenerateSessionTitle
} from "./session-title-summarizer";

type AgentEventEmitter = {
  onEvent: (event: AgentEvent) => void;
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

function handleRuntimeSessionStateEvent(
  sessionId: string,
  event: AgentEvent,
  sessionStateManager: ReturnType<typeof getSessionStateManager>
): void {
  const usage = event.type === "usage_update"
    ? event.usage
    : event.type === "complete"
      ? event.usage
      : undefined;

  if (usage) {
    sessionStateManager.updateTokens(
      sessionId,
      resolveAgentEventTotalTokens(usage),
      usage.contextWindow
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

  if (event.type === "compacting") {
    sessionStateManager.incrementCompaction(sessionId);
    log.info("会话开始压缩", { sessionId: sessionId.slice(0, 8) });
  }

  if (event.type === "compact_complete") {
    log.info("会话压缩完成", { sessionId: sessionId.slice(0, 8) });
  }
}

export function submitAskUserQuestionAnswers(input: AgentAskUserQuestionResponseInput): { ok: true } {
  const handledByPi = submitPiAskUserQuestionAnswers(input);
  if (handledByPi) {
    getAgentRuntimeStatusManager().markStreaming(input.sessionId);
    return { ok: true };
  }
  throw new Error("未找到待确认的 AskUserQuestion 请求");
}

export function submitAgentToolPermission(input: AgentToolPermissionResponseInput): { ok: true } {
  const handled = submitToolPermissionDecision(input);
  if (handled) {
    getAgentRuntimeStatusManager().markStreaming(input.sessionId);
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


export async function sendAgentMessage(
  input: AgentSendInput,
  emit: AgentEventEmitter,
  options: { appendUserMessage?: boolean; allowResumeRetry?: boolean } = {}
): Promise<void> {
  const { sessionId, userMessage, workspaceId } = input;
  const messageHistoryBeforeSend = getAgentSessionMessages(sessionId);
  const assistantTurnCountBeforeSend = messageHistoryBeforeSend.filter((item) => item.role === "assistant").length;
  const sessionMeta = getAgentSessionMeta(sessionId);
  const resolvedChannelId = input.channelId ?? sessionMeta?.channelId;
  const resolvedModelId = pickModelId(resolvedChannelId, input.modelId);

  const shouldAppendUserMessage = options.appendUserMessage ?? true;
  const shouldTryAutoTitle = shouldAppendUserMessage && assistantTurnCountBeforeSend === 0;
  void options.allowResumeRetry;

  let stateWorkspaceSlug: string | undefined;
  if (workspaceId) {
    const workspace = getAgentWorkspace(workspaceId);
    if (workspace) {
      stateWorkspaceSlug = workspace.slug;
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

  const { runPiAgentMessage } = await import("../pi-agent/run-pi-agent-message");
  const piResult = await runPiAgentMessage({
    ...input,
    channelId: resolvedChannelId,
    modelId: resolvedModelId
  }, {
    onEvent: (event) => {
      handleRuntimeSessionStateEvent(sessionId, event, sessionStateManager);
      if (event.type === "compacting") {
        runtimeStatusManager.markCompacting(sessionId);
      }
      emit.onEvent(event);
    },
    onComplete: () => {
      runtimeStatusManager.markCompleted(sessionId);
      emit.onComplete();
    },
    onError: (error) => {
      runtimeStatusManager.markErrored(sessionId, error);
      emit.onError(error);
    },
    onAskUserQuestion: (request) => {
      runtimeStatusManager.markAwaitingUserAnswer(sessionId, {
        toolUseId: request.toolUseId,
        originSessionId: request.originSessionId,
        subagentRunId: request.subagentRunId
      });
      emit.onAskUserQuestion(request);
    },
    onToolPermissionRequest: (request) => {
      runtimeStatusManager.markAwaitingPermission(sessionId, {
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        originSessionId: request.originSessionId,
        subagentRunId: request.subagentRunId
      });
      emit.onToolPermissionRequest(request);
    }
  });
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
  void import("../pi-agent/runner/run")
    .then((module) => module.stopPiAgent(sessionId))
    .catch(() => undefined);
}

export function stopAllAgents(): void {
  // 停止所有 Heartbeat 定时器
  const { getHeartbeatService } = require("../heartbeat-service");
  const heartbeatService = getHeartbeatService();
  heartbeatService.stopAllTimers();
  void import("../pi-agent/runner/run")
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
  emit: AgentEventEmitter
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
