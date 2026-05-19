
import type { SDKMessage } from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentAskUserQuestionResponseInput,
  AgentThreadMessageDispatchResult,
  AgentMessageAppendedEvent,
  AgentToolPolicy,
  AgentToolPermissionRequest,
  AgentToolPermissionResponseInput,
  AgentGenerateTitleInput,
  LumeRuntimeEvent
} from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import { fetchTitle, getAdapter } from "../../providers";
import { decryptApiKey, listChannels, resolveChannelModelBinding } from "../channel/channel-manager";
import {
  appendAgentThreadSDKMessages,
  getAgentThreadMessages,
  getAgentThreadMeta,
  readRuntimeCoreTranscriptMessages,
  replaceAgentThreadTranscript,
  updateAgentThreadMeta
} from "./agent-thread-manager";
import {
  createAssistantMessageVersion,
  createUserMessageVersion,
  getLatestVisibleMessagesForThread
} from "./agent-message-versioning-service";
import { getAgentRuntimeStatusManager } from "./agent-runtime-status-manager";
import { getAgentWorkspace } from "./agent-workspace-manager";
import { resolveAgentRuntimeRoutingTrace } from "./agent-runtime-context";
import { createLogger } from "../infra/logger";
import { getSessionStateManager } from "../agent-runtime/runner/session-state-manager";
import { submitAskUserQuestionAnswers as submitRuntimeAskUserQuestionAnswers } from "../agent-runtime/interruption/ask-user-question-session";
import { submitToolPermissionDecision } from "../agent-runtime/interruption/tool-permission-session";
import {
  resolveAgentDefaultStrategy,
  resolveChannelModelSelection,
  resolveRequestedModelIdForChannel
} from "../channel/model-selection";
import {
  AGENT_TITLE_PROMPT_FROM_SUMMARY,
  isWeakGeneratedTitle,
  sanitizeGeneratedTitle
} from "./session-title-summarizer";
import { resolveSoftToolPolicyForPreferredRoute } from "./capability-routing";
import { buildAgentSendStartLogData } from "./agent-log-summary";
import { getEffectiveLumeConfig } from "../system/lume-config-service";
import { createAutoTitleJob } from "../agent-runtime/service-runtime/auto-title-job";
import { getServiceRuntime } from "../agent-runtime/service-runtime/service-runtime";
import { AgentRuntimeKernel } from "../agent-runtime/kernel/agent-runtime-kernel";

type AgentStreamEmitter = {
  onRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  onMessageAppended?: (event: AgentMessageAppendedEvent) => void;
  onComplete: (payload?: { reason?: "max_turns" }) => void;
  onError: (error: string) => void;
  onTitleUpdated: (title: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  onToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
};

const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";

const log = createLogger("agent-service");
const ROUTING_HEURISTIC_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Glob",
  "Grep",
  "ls",
  "browser",
  "WebSearch",
  "WebFetch",
  "memory.search",
  "memory.read",
  "memory.remember"
];

const agentRuntimeKernel = new AgentRuntimeKernel<AgentSendInput, AgentStreamEmitter>({
  execute: async (dispatch) => {
    await sendAgentMessage(dispatch.input, dispatch.emit);
  },
  onQueuedCountChange: (threadId, queuedCount) => {
    getAgentRuntimeStatusManager().setQueuedCount(threadId, queuedCount);
  },
  onDispatchError: (dispatch, error) => {
    dispatch.emit.onError(error instanceof Error ? error.message : String(error));
  }
});

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

function handleRuntimeThreadStateMessage(
  threadId: string,
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
      threadId,
      totalTokens,
      contextWindow
    );
  }

  if (message.type === "system" && message.subtype === "context_compaction_started") {
    log.info("线程开始压缩", { threadId: threadId.slice(0, 8) });
  }

  if (message.type === "system" && message.subtype === "compact_boundary") {
    sessionStateManager.incrementCompaction(threadId);
    log.info("线程压缩完成", { threadId: threadId.slice(0, 8) });
  }
}

export interface SubmitAskUserQuestionAnswersResult {
  ok: true;
  handledBy: "live" | "persisted" | "none";
  threadId: string;
  approvalThreadId?: string;
  runId?: string;
}

export async function submitAskUserQuestionAnswers(
  input: AgentAskUserQuestionResponseInput
): Promise<SubmitAskUserQuestionAnswersResult> {
  const handledByRuntime = await submitRuntimeAskUserQuestionAnswers(input);
  if (handledByRuntime) {
    if (handledByRuntime.handledBy === "live") {
      getAgentRuntimeStatusManager().markStreaming(input.threadId);
    }
    return { ok: true, ...handledByRuntime };
  }
  if (input.canceled) {
    return {
      ok: true,
      handledBy: "none",
      threadId: input.threadId
    };
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

function resolveLatestAssistantTranscriptMessage(threadId: string) {
  const transcriptMessages = readRuntimeCoreTranscriptMessages(threadId);
  for (let index = transcriptMessages.length - 1; index >= 0; index--) {
    const message = transcriptMessages[index]!;
    if (message.role === "assistant") {
      return message;
    }
  }
  return null;
}

function buildUserSdkMessage(input: {
  threadId: string;
  userMessage: string;
  createdAt: number;
}): SDKMessage {
  return {
    type: "user",
    uuid: `user:${input.threadId}:${input.createdAt}`,
    session_id: input.threadId,
    timestamp: new Date(input.createdAt).toISOString(),
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{
        type: "text",
        text: input.userMessage
      }]
    }
  } as SDKMessage;
}

function ensureSdkMessageCreatedAt(message: SDKMessage): SDKMessage {
  const record = message as SDKMessage & { _createdAt?: number };
  if (typeof record._createdAt === "number") {
    return message;
  }
  return ({
    ...message,
    _createdAt: Date.now()
  } as unknown) as SDKMessage;
}

function shouldPersistAssistantTurnSdkMessage(message: SDKMessage): boolean {
  if (message.type === "assistant" || message.type === "result") {
    return true;
  }
  if (message.type === "tool_result") {
    return true;
  }
  if (message.type === "user") {
    return Array.isArray(message.message?.content)
      && message.message.content.some((block) => !!block && typeof block === "object" && block.type === "tool_result");
  }
  return message.type === "system" && (
    message.subtype === "context_compaction_started"
    || message.subtype === "compact_boundary"
    || message.subtype === "task_started"
    || message.subtype === "task_progress"
    || message.subtype === "task_notification"
  );
}

function isSubagentAssistantSdkMessage(message: SDKMessage): boolean {
  return message.type === "assistant"
    && typeof (message as SDKMessage & { subagent_run_id?: unknown }).subagent_run_id === "string"
    && ((message as SDKMessage & { subagent_run_id?: string }).subagent_run_id?.trim().length ?? 0) > 0;
}

function extractAssistantTextFromSdkMessages(messages: SDKMessage[]): string {
  return messages
    .filter((message): message is Extract<SDKMessage, { type: "assistant" }> => (
      message.type === "assistant" && !isSubagentAssistantSdkMessage(message)
    ))
    .flatMap((message) => Array.isArray(message.message?.content) ? message.message.content : [])
    .filter((block): block is { type: "text"; text: string } => !!block && typeof block === "object" && block.type === "text" && typeof (block as { text?: string }).text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function extractAssistantReasoningFromSdkMessages(messages: SDKMessage[]): string | undefined {
  const reasoning = messages
    .filter((message): message is Extract<SDKMessage, { type: "assistant" }> => (
      message.type === "assistant" && !isSubagentAssistantSdkMessage(message)
    ))
    .flatMap((message) => Array.isArray(message.message?.content) ? message.message.content : [])
    .filter((block) => !!block && typeof block === "object" && block.type === "thinking")
    .map((block) => {
      const value = block as { thinking?: string; text?: string };
      return value.thinking ?? value.text ?? "";
    })
    .filter((value) => value.trim().length > 0)
    .join("\n\n")
    .trim();
  return reasoning || undefined;
}

function resolveAssistantCreatedAtFromSdkMessages(messages: SDKMessage[]): number {
  for (const message of messages) {
    const createdAt = (message as SDKMessage & { _createdAt?: number })._createdAt;
    if (typeof createdAt === "number") {
      return createdAt;
    }
  }
  return Date.now();
}

function projectAssistantMessageFromSdkMessages(input: {
  threadId: string;
  sdkMessages: SDKMessage[];
  modelId: string;
}): {
  id: string;
  role: "assistant";
  content: string;
  reasoning?: string;
  createdAt: number;
  model: string;
  sdkMessages: SDKMessage[];
} | null {
  const assistantMessages = input.sdkMessages.filter((message) => (
    message.type === "assistant" && !isSubagentAssistantSdkMessage(message)
  ));
  if (assistantMessages.length === 0) {
    return null;
  }

  return {
    id: `sdk-turn:${input.threadId}:${resolveAssistantCreatedAtFromSdkMessages(input.sdkMessages)}`,
    role: "assistant",
    content: extractAssistantTextFromSdkMessages(input.sdkMessages),
    reasoning: extractAssistantReasoningFromSdkMessages(input.sdkMessages),
    createdAt: resolveAssistantCreatedAtFromSdkMessages(input.sdkMessages),
    model: input.modelId,
    sdkMessages: input.sdkMessages
  };
}


export async function sendAgentMessage(
  input: AgentSendInput,
  emit: AgentStreamEmitter,
  options: { appendUserMessage?: boolean; allowResumeRetry?: boolean } = {}
): Promise<void> {
  const { threadId, userMessage } = input;
  const messageHistoryBeforeSend = getAgentThreadMessages(threadId);
  const assistantTurnCountBeforeSend = messageHistoryBeforeSend.filter((item) => item.role === "assistant").length;
  const threadMeta = getAgentThreadMeta(threadId);
  const effectiveWorkspaceId = input.workspaceId ?? threadMeta?.workspaceId;
  const effectiveWorkspace = effectiveWorkspaceId ? getAgentWorkspace(effectiveWorkspaceId) : undefined;
  const shouldRecomputeInheritedSelection = threadMeta?.modelSelectionSource === "inherited"
    && input.channelId === undefined
    && input.modelRef === undefined;
  const effectiveLumeConfig = getEffectiveLumeConfig(effectiveWorkspace?.slug);
  const effectiveSelection = resolveAgentDefaultStrategy({
    thread: shouldRecomputeInheritedSelection
      ? {}
      : {
          channelId: input.channelId ?? threadMeta?.channelId,
          modelRef: input.modelRef ?? threadMeta?.modelRef
        },
    globalDefault: effectiveLumeConfig.models?.agent
  });
  const boundModel = resolveChannelModelBinding(effectiveSelection.modelRef ?? "", "chat");
  const resolvedChannelId = boundModel?.channel.id ?? effectiveSelection.channelId;
  const resolvedModelId = boundModel?.modelId ?? pickModelId(resolvedChannelId, input.modelId ?? threadMeta?.modelId);
  const resolvedChannel = resolvedChannelId
    ? listChannels().find((item) => item.id === resolvedChannelId)
    : undefined;
  const canonicalModelRef = resolvedChannel
    ? resolveChannelModelSelection({
      channelProvider: resolvedChannel.provider,
      baseUrl: resolvedChannel.baseUrl,
      modelId: boundModel?.modelId ?? input.modelId ?? threadMeta?.modelId ?? resolvedModelId
    }).modelRef
    : effectiveSelection.modelRef;
  const hasExplicitSendSelection = input.modelRef !== undefined || input.channelId !== undefined || input.modelId !== undefined;

  const isManualCompactCommand = userMessage.trim() === "/compact";
  const shouldAppendUserMessage = (options.appendUserMessage ?? true)
    && input.messageMetadata?.hiddenFromChat !== true
    && !isManualCompactCommand;
  const shouldTryAutoTitle = shouldAppendUserMessage && assistantTurnCountBeforeSend === 0;
  void options.allowResumeRetry;
  let activeTurnId: string | null = null;
  const persistedSdkMessages: SDKMessage[] = [];
  let userSdkMessage: SDKMessage | null = null;

  const stateWorkspaceSlug = effectiveWorkspace?.slug;

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
    ...(isManualCompactCommand ? {
      hiddenFromChat: true,
      manualCommand: "compact"
    } : {}),
    capabilityLanes: routingTrace.capabilityLanes,
    preferredCapabilityRoute: routingTrace.preferredCapabilityRoute,
    capabilityRoutingReason: routingTrace.reason,
    toolPolicy: mergeToolPolicies(existingToolPolicy, routingToolPolicy)
  };
  let runtimeMessageMetadata: Record<string, unknown> = effectiveMessageMetadata;

  const sendStartTime = Date.now();
  log.info("[Agent 会话] 开始发送消息", buildAgentSendStartLogData({
    threadId,
    workspaceId: effectiveWorkspaceId,
    channelId: resolvedChannelId,
    modelId: resolvedModelId,
    modelRef: canonicalModelRef,
    appendUserMessage: shouldAppendUserMessage,
    preferredCapabilityRoute: routingTrace.preferredCapabilityRoute ?? undefined,
    capabilityLanes: routingTrace.capabilityLanes,
    userMessage
  }));

  if (shouldAppendUserMessage) {
    const sourceMessageId = input.editFromMessageId ?? input.resendFromMessageId;
    userSdkMessage = ensureSdkMessageCreatedAt(buildUserSdkMessage({
      threadId,
      userMessage,
      createdAt: Date.now()
    }));
    const createdUserVersion = createUserMessageVersion({
      sessionId: threadId,
      content: userMessage,
      createdAt: (userSdkMessage as SDKMessage & { _createdAt?: number })._createdAt ?? Date.now(),
      metadata: {
        ...effectiveMessageMetadata,
        ...(sourceMessageId ? { sourceMessageId } : {})
      },
      sourceMessageId,
      sdkMessages: [userSdkMessage]
    });
    runtimeMessageMetadata = {
      ...effectiveMessageMetadata,
      messageId: createdUserVersion.message.id,
      versionGroupId: createdUserVersion.message.versionGroupId,
      versionIndex: createdUserVersion.message.versionIndex,
      versionCount: createdUserVersion.message.versionCount,
      ...(sourceMessageId ? { sourceMessageId } : {})
    };
    activeTurnId = createdUserVersion.turnId;
    if (sourceMessageId) {
      replaceAgentThreadTranscript(threadId, getLatestVisibleMessagesForThread(threadId));
    }
    appendAgentThreadSDKMessages(threadId, [userSdkMessage]);
    emit.onMessageAppended?.({
      threadId,
      message: createdUserVersion.message
    });
  }

  const sessionStateManager = getSessionStateManager();
  const runtimeStatusManager = getAgentRuntimeStatusManager();
  sessionStateManager.getOrCreate(threadId);

  if (hasExplicitSendSelection) {
    updateAgentThreadMeta(threadId, {
      ...(canonicalModelRef !== undefined ? { modelRef: canonicalModelRef } : {}),
      ...(resolvedChannelId !== undefined ? { channelId: resolvedChannelId } : {}),
      ...(resolvedModelId !== undefined ? { modelId: resolvedModelId } : {}),
      modelSelectionSource: "thread-override"
    });
  }
  runtimeStatusManager.markStreaming(threadId);
  let runtimeCompleted = false;

  if (!resolvedChannelId || !resolvedModelId) {
    const msg = "Agent Runtime 缺少 channelId/modelId。";
    log.error("[Agent 会话] 启动失败：缺少模型或渠道", {
      threadId: threadId.slice(0, 8),
      channelId: resolvedChannelId,
      modelId: resolvedModelId
    });
    runtimeStatusManager.markErrored(threadId, msg);
    emit.onError(msg);
    return;
  }
  const { runAgentRuntime } = await import("../agent-runtime/runtime-core/attempt");
  const configThinkingLevel = effectiveLumeConfig.agent?.thinkingLevel;
  const configPermissionMode = effectiveLumeConfig.agent?.permissionMode;
  const runtimeResult = await runAgentRuntime({
    input: {
      ...input,
      ...(effectiveWorkspaceId ? { workspaceId: effectiveWorkspaceId } : {}),
      messageMetadata: runtimeMessageMetadata,
      channelId: resolvedChannelId,
      modelId: resolvedModelId,
      ...(input.thinkingLevel === undefined && configThinkingLevel
        ? { thinkingLevel: configThinkingLevel }
        : {}),
      ...(input.permissionMode === undefined && configPermissionMode
        ? { permissionMode: configPermissionMode }
        : {}),
    },
    runtime: {
      sessionId: threadId,
      modelRef: canonicalModelRef,
      channelId: resolvedChannelId,
      resolvedModelId,
      workspaceId: effectiveWorkspaceId,
      threadType: input.threadType
    }
  }, {
    onSdkMessage: (message) => {
      const stampedMessage = ensureSdkMessageCreatedAt(message);
      handleRuntimeThreadStateMessage(threadId, stampedMessage, sessionStateManager);
      if (stampedMessage.type === "system" && stampedMessage.subtype === "context_compaction_started") {
        runtimeStatusManager.markCompacting(threadId);
      }
      if (shouldPersistAssistantTurnSdkMessage(stampedMessage)) {
        persistedSdkMessages.push(stampedMessage);
      }
    },
    onComplete: () => {
      runtimeCompleted = true;
    },
    onRuntimeEvent: (event) => {
      emit.onRuntimeEvent?.(event);
    },
    onError: (error) => {
      runtimeStatusManager.markErrored(threadId, error);
      emit.onError(error);
    },
    onAskUserQuestion: (request) => {
      runtimeStatusManager.markAwaitingUserAnswer(threadId, {
        toolUseId: request.toolUseId,
        originThreadId: request.originThreadId,
        subagentRunId: request.subagentRunId
      });
      emit.onAskUserQuestion(request);
    },
    onToolPermissionRequest: (request) => {
      runtimeStatusManager.markAwaitingPermission(threadId, {
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        originThreadId: request.originThreadId,
        subagentRunId: request.subagentRunId
      });
      emit.onToolPermissionRequest(request);
    }
  });
  if (persistedSdkMessages.length > 0) {
    appendAgentThreadSDKMessages(threadId, persistedSdkMessages);
  }
  if ((runtimeResult.status === "completed" || runtimeResult.status === "turn_limited") && activeTurnId) {
    const latestAssistantMessage = projectAssistantMessageFromSdkMessages({
      threadId,
      sdkMessages: persistedSdkMessages,
      modelId: resolvedModelId
    }) ?? resolveLatestAssistantTranscriptMessage(threadId);
    if (latestAssistantMessage) {
      const visibleAssistantMessage = createAssistantMessageVersion({
        sessionId: threadId,
        turnId: activeTurnId,
        message: latestAssistantMessage
      });
      if (visibleAssistantMessage) {
        emit.onMessageAppended?.({
          threadId,
          message: visibleAssistantMessage
        });
      }
    }
  }
  if (runtimeCompleted && runtimeResult.status === "completed") {
    log.info("[Agent 会话] 运行完成", {
      threadId: threadId.slice(0, 8),
      durationMs: Date.now() - sendStartTime,
      persistedSdkMessageCount: persistedSdkMessages.length,
      visibleAssistantTurnCreated: activeTurnId !== null,
      autoTitlePending: shouldTryAutoTitle
    });
    runtimeStatusManager.markCompleted(threadId);
    emit.onComplete();
  }
  if (runtimeResult.status === "turn_limited") {
    log.info("[Agent 会话] 运行达到最大回合数，等待继续执行", {
      threadId: threadId.slice(0, 8),
      persistedSdkMessageCount: persistedSdkMessages.length
    });
    runtimeStatusManager.markCompleted(threadId);
    emit.onComplete({ reason: "max_turns" });
  }
  if (runtimeResult.status === "aborted") {
    log.warn("[Agent 会话] 运行中止", {
      threadId: threadId.slice(0, 8),
      durationMs: Date.now() - sendStartTime,
      persistedSdkMessageCount: persistedSdkMessages.length
    });
  }
  if (runtimeResult.status === "errored") {
    log.error("[Agent 会话] 运行失败", {
      threadId: threadId.slice(0, 8),
      durationMs: Date.now() - sendStartTime,
      persistedSdkMessageCount: persistedSdkMessages.length,
      errorMessage: runtimeResult.errorMessage
    });
  }
  if (runtimeResult.status === "completed" && shouldTryAutoTitle) {
    const job = createAutoTitleJob({
      threadId,
      fallbackUserMessage: userMessage,
      onTitleUpdated: (title) => {
        emit.onTitleUpdated(title);
      }
    });
    if (job) {
      getServiceRuntime().schedule(job);
    }
  }
  return;
}

export function appendAgentMessage(
  input: AgentSendInput,
  emit: AgentStreamEmitter,
  options?: {
    onExecutionStarted?: () => void;
  }
): AgentThreadMessageDispatchResult {
  return agentRuntimeKernel.dispatch(input, emit, options);
}

export async function waitForAgentRuntimeKernelIdleForTest(): Promise<void> {
  await agentRuntimeKernel.waitForIdleForTest();
}

export function resetAgentRuntimeKernelForTest(): void {
  agentRuntimeKernel.resetForTest();
}

export function stopAgent(threadId: string): void {
  const sessionStateManager = getSessionStateManager();
  sessionStateManager.delete(threadId);
  getAgentRuntimeStatusManager().markIdle(threadId);
  void import("../agent-runtime/runtime-core/attempt")
    .then((module) => module.stopAgentRuntime(threadId))
    .catch(() => undefined);
}

export function stopAllAgents(): void {
  void import("../agent-runtime/runtime-core/attempt")
    .then((module) => module.stopAllAgentRuntimeSessions())
    .catch(() => undefined);
}

export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  const sourceText = (input.sourceText ?? input.userMessage ?? "").trim();
  if (!sourceText) {
    return null;
  }
  const boundModel = resolveChannelModelBinding(input.modelRef ?? "", "chat");
  const channel = boundModel?.channel ?? listChannels().find((item) => item.id === input.channelId);
  if (!channel) {
    log.warn("自动标题生成失败：渠道不存在", {
      channelId: input.channelId
    });
    return null;
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(channel.id);
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
      modelId: boundModel?.modelId ?? input.modelId
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
