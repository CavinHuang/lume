/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts
 * Adaptation:
 * - Route all agent execution through Pi Agent runtime.
 * - Keep sidecar event emitter contract (no Electron webContents dependency).
 */

import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentAskUserQuestionRequest,
  AgentAskUserQuestionResponseInput,
  AgentToolPermissionRequest,
  AgentToolPermissionResponseInput,
  AgentGenerateTitleInput,
  AgentMessage
} from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import { fetchTitle, getAdapter } from "../providers";
import { decryptApiKey, listChannels } from "./channel-manager";
import {
  appendAgentMessage,
  getAgentSessionMeta,
  updateAgentSessionMeta
} from "./agent-session-manager";
import { getAgentWorkspace } from "./agent-workspace-manager";
import { createLogger } from "./logger";
import {
  getSessionStateManager,
  startSessionHeartbeat,
} from "./session-state-manager";
import { submitPiAskUserQuestionAnswers } from "./pi-agent/tools/ask-user-question-bridge";
import { submitToolPermissionDecision } from "./pi-agent/tools/tool-permission-bridge";
import {
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "./model-selection";

type AgentEventEmitter = {
  onEvent: (event: AgentEvent) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onTitleUpdated: (title: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
};

const AGENT_TITLE_PROMPT =
  "根据用户的第一条消息，生成一个简短的会话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：";
const MAX_TITLE_LENGTH = 20;
const DEFAULT_AGENT_TITLE = "新 Agent 会话";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";

const log = createLogger("agent-service");

function handleRuntimeSessionStateEvent(
  sessionId: string,
  event: AgentEvent,
  sessionStateManager: ReturnType<typeof getSessionStateManager>
): void {
  if (event.type === "usage_update") {
    sessionStateManager.updateTokens(
      sessionId,
      event.usage.inputTokens,
      event.usage.contextWindow
    );

    const flushCheck = sessionStateManager.checkMemoryFlush(sessionId);
    if (flushCheck.executed && flushCheck.prompt) {
      log.info("Memory Flush 触发条件满足", {
        sessionId: sessionId.slice(0, 8),
        reason: flushCheck.reason,
      });
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
    return { ok: true };
  }
  throw new Error("未找到待确认的 AskUserQuestion 请求");
}

export function submitAgentToolPermission(input: AgentToolPermissionResponseInput): { ok: true } {
  const handled = submitToolPermissionDecision(input);
  if (handled) {
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
  const sessionMeta = getAgentSessionMeta(sessionId);
  const resolvedChannelId = input.channelId ?? sessionMeta?.channelId;
  const resolvedModelId = pickModelId(resolvedChannelId, input.modelId);

  const shouldAppendUserMessage = options.appendUserMessage ?? true;
  void options.allowResumeRetry;
  if (shouldAppendUserMessage) {
    const userMessageRecord: AgentMessage = {
      id: randomUUID(),
      role: "user",
      content: userMessage,
      createdAt: Date.now(),
      metadata: input.messageMetadata
    };
    appendAgentMessage(sessionId, userMessageRecord);
  }

  let stateWorkspaceSlug: string | undefined;
  if (workspaceId) {
    const workspace = getAgentWorkspace(workspaceId);
    if (workspace) {
      stateWorkspaceSlug = workspace.slug;
    }
  }

  const sessionStateManager = getSessionStateManager();
  sessionStateManager.getOrCreate(sessionId, stateWorkspaceSlug);
  if (stateWorkspaceSlug) {
    startSessionHeartbeat(sessionId, stateWorkspaceSlug, async () => {
      log.info("Heartbeat 检查完成", { sessionId: sessionId.slice(0, 8), workspaceSlug: stateWorkspaceSlug });
    });
  }

  updateAgentSessionMeta(sessionId, {
    channelId: resolvedChannelId
  });

  const { runPiAgentMessage } = await import("./pi-agent/run-pi-agent-message");
  const piResult = await runPiAgentMessage({
    ...input,
    channelId: resolvedChannelId,
    modelId: resolvedModelId
  }, {
    onEvent: (event) => {
      handleRuntimeSessionStateEvent(sessionId, event, sessionStateManager);
      emit.onEvent(event);
    },
    onComplete: emit.onComplete,
    onError: emit.onError,
    onAskUserQuestion: emit.onAskUserQuestion,
    onToolPermissionRequest: emit.onToolPermissionRequest
  });
  if (piResult.status === "completed" && resolvedChannelId) {
    void autoGenerateAgentTitle(sessionId, userMessage, resolvedChannelId, resolvedModelId, emit);
  }
  return;
}

export function stopAgent(sessionId: string): void {
  void import("./pi-agent/runner/run")
    .then((module) => module.stopPiAgent(sessionId))
    .catch(() => undefined);
}

export function stopAllAgents(): void {
  // 停止所有 Heartbeat 定时器
  const { getHeartbeatService } = require("./heartbeat-service");
  const heartbeatService = getHeartbeatService();
  heartbeatService.stopAllTimers();
  void import("./pi-agent/runner/run")
    .then((module) => module.stopAllPiAgents())
    .catch(() => undefined);
}

export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
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
      prompt: AGENT_TITLE_PROMPT + input.userMessage
    });
    const title = await fetchTitle(request, adapter);
    if (!title) return null;
    const cleaned = title.trim().replace(/^["']+|["']+$/g, "").trim();
    return cleaned.slice(0, MAX_TITLE_LENGTH) || null;
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

async function autoGenerateAgentTitle(
  sessionId: string,
  userMessage: string,
  channelId: string,
  modelId: string,
  emit: AgentEventEmitter
): Promise<void> {
  try {
    const meta = getAgentSessionMeta(sessionId);
    if (!meta || meta.title !== DEFAULT_AGENT_TITLE) return;

    const title = await generateAgentTitle({ userMessage, channelId, modelId });
    if (!title) return;

    updateAgentSessionMeta(sessionId, { title });
    emit.onTitleUpdated(title);
  } catch (error) {
    log.warn("自动标题生成流程异常", {
      sessionId,
      channelId,
      modelId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
