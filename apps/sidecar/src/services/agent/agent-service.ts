
import { createProvider, type ApiType, type SDKMessage } from "@lume/agent-sdk";
import type {
  AgentMessageQueueOperationResult,
  AgentMessageQueueSnapshot,
  AgentAskUserQuestionRequest,
  AgentAskUserQuestionResponseInput,
  AgentPendingGuidance,
  AgentPromoteQueuedMessageToGuidanceInput,
  AgentQueuedMessage,
  AgentRemoveQueuedMessageInput,
  AgentReorderMessageQueueInput,
  AgentThreadMessageDispatchResult,
  AgentMessageAppendedEvent,
  AgentToolPolicy,
  AgentToolPermissionRequest,
  AgentToolPermissionResponseInput,
  AgentGenerateTitleInput,
  AgentWelcomeSuggestion,
  AgentWelcomeSuggestionInput,
  AgentWelcomeSuggestionsResult,
  LumeRuntimeEvent
} from "@lume/shared";
import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import { fetchTitle, getAdapter } from "../../providers";
import { decryptApiKey, listChannels, resolveChannelModelBinding } from "../channel/channel-manager";
import {
  appendAgentThreadSDKMessages,
  getAgentThreadMessages,
  getAgentThreadMeta,
  readRuntimeCoreTranscriptMessages,
  replaceAgentThreadTranscript,
  tryUpdateAgentThreadMeta
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
import { AgentRuntimeKernel, type AgentRuntimeKernelQueuedDispatch } from "../agent-runtime/kernel/agent-runtime-kernel";
import { runGuidanceStore } from "../agent-runtime/guidance/run-guidance-store";
import { getRuntimeCoreSessionDir, hasRuntimeCoreSessionTranscript } from "../agent-runtime/runtime-core/session-store";
import { createFileBackedLumeRunStateStore } from "../agent-runtime/runner/run-state-store";
import type { LumeRunItem } from "../agent-runtime/runner/run-items";
import type { LumeRunState } from "../agent-runtime/runner/run-state";
import { emitAgentNotification } from "./agent-notification-service";

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

const DEFAULT_WELCOME_SUGGESTIONS: AgentWelcomeSuggestion[] = [
  {
    id: "fallback-plan-day",
    title: "规划今天的工作",
    prompt: "帮我梳理今天最重要的 3 件事，并给出可执行的时间安排。"
  },
  {
    id: "fallback-summarize-project",
    title: "总结这个项目",
    prompt: "阅读当前工作区，帮我总结项目结构、关键模块和下一步建议。"
  },
  {
    id: "fallback-debug-path",
    title: "排查一个问题",
    prompt: "我遇到一个问题，请先帮我设计最小复现和排查路径。"
  },
  {
    id: "fallback-memory-review",
    title: "整理近期记忆",
    prompt: "根据最近对话和项目上下文，帮我提炼需要长期保留的偏好和决策。"
  }
];

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

const TURN_LIMIT_CONTINUATION_PREFIX = "请继续完成上一轮未完成的原始任务。不要把这看作新任务；基于当前线程历史、已有工具结果和最后一个 assistant 状态继续。";
const STALE_RUN_CONTINUATION_PREFIX = "上一轮运行在进程退出前未正常完成。请继续完成上一轮未完成的原始任务，不要把这看作新任务；基于下面的运行记录摘要衔接执行。";
const VISIBLE_HISTORY_CONTINUATION_PREFIX = "当前 runtime transcript 不完整。请继续完成上一轮未完成的原始任务，不要把这看作新任务；基于下面可见聊天历史衔接执行。";
const CONTINUE_ONLY_MESSAGES = new Set([
  "继续",
  "请继续",
  "continue"
]);
const STALE_RUN_STATUSES = new Set<LumeRunState["status"]>(["created", "running"]);
const STALE_RUN_PROGRESS_HEAD_COUNT = 6;
const STALE_RUN_PROGRESS_TAIL_COUNT = 10;
const VISIBLE_HISTORY_CONTINUATION_TAIL_COUNT = 8;

const agentRuntimeKernel = new AgentRuntimeKernel<AgentSendInput, AgentStreamEmitter>({
  execute: async (dispatch) => {
    try {
      await sendAgentMessage(dispatch.input, dispatch.emit);
    } finally {
      restoreUnconsumedGuidanceToQueue(dispatch.input.threadId);
    }
  },
  onQueuedCountChange: (threadId, queuedCount) => {
    getAgentRuntimeStatusManager().setQueuedCount(threadId, queuedCount);
    emitAgentMessageQueueChanged(threadId);
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

function isContinueOnlyMessage(userMessage: string): boolean {
  return CONTINUE_ONLY_MESSAGES.has(userMessage.trim().toLowerCase());
}

function hasTurnLimitedMarker(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const record = item as Record<string, unknown>;
  if (record.type !== "system_event") return false;
  if (record.name === "turn_limited") return true;
  if (record.name !== "result") return false;
  const payload = record.payload;
  return Boolean(
    payload
    && typeof payload === "object"
    && (payload as Record<string, unknown>).subtype === "error_max_turns"
  );
}

async function shouldExpandTurnLimitedContinuation(threadId: string, userMessage: string): Promise<boolean> {
  if (!isContinueOnlyMessage(userMessage)) return false;
  const store = createFileBackedLumeRunStateStore(getRuntimeCoreSessionDir(threadId));
  const runs = await store.listByThread(threadId);
  const latestCompletedRun = [...runs].reverse().find((run) => run.status === "completed");
  return Boolean(latestCompletedRun?.generatedItems.some(hasTurnLimitedMarker));
}

async function findStaleRunningRun(threadId: string, userMessage: string): Promise<LumeRunState | null> {
  if (!isContinueOnlyMessage(userMessage)) return null;
  const store = createFileBackedLumeRunStateStore(getRuntimeCoreSessionDir(threadId));
  const runs = await store.listByThread(threadId);
  const latestRun = runs.at(-1);
  return latestRun && STALE_RUN_STATUSES.has(latestRun.status) && latestRun.input.userMessage.trim().length > 0
    ? latestRun
    : null;
}

async function resolveModelFacingUserMessage(threadId: string, userMessage: string): Promise<string> {
  const staleRun = await findStaleRunningRun(threadId, userMessage);
  if (staleRun) {
    return buildStaleRunContinuationMessage(staleRun, userMessage);
  }
  if (await shouldExpandTurnLimitedContinuation(threadId, userMessage)) {
    return [
      TURN_LIMIT_CONTINUATION_PREFIX,
      `用户发送的继续指令：${userMessage.trim()}`
    ].join("\n\n");
  }
  const visibleHistoryContinuation = buildVisibleHistoryContinuationMessage(threadId, userMessage);
  if (visibleHistoryContinuation) {
    return visibleHistoryContinuation;
  }
  return userMessage;
}

function buildStaleRunContinuationMessage(run: LumeRunState, userMessage: string): string {
  return [
    STALE_RUN_CONTINUATION_PREFIX,
    `原始任务：${compactRuntimeText(run.input.userMessage, 800)}`,
    `上次运行状态：${run.status}${run.currentStep?.type ? ` / ${run.currentStep.type}` : ""}`,
    "上次运行已完成的关键记录：",
    summarizeStaleRunProgress(run.generatedItems),
    `用户发送的继续指令：${userMessage.trim()}`
  ].filter((part) => part.trim().length > 0).join("\n\n");
}

function summarizeStaleRunProgress(items: LumeRunItem[]): string {
  const lines = items
    .map(formatStaleRunItem)
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return "- 没有可用的运行记录摘要。";
  }
  if (lines.length <= STALE_RUN_PROGRESS_HEAD_COUNT + STALE_RUN_PROGRESS_TAIL_COUNT) {
    return lines.map((line) => `- ${line}`).join("\n");
  }
  const head = lines.slice(0, STALE_RUN_PROGRESS_HEAD_COUNT);
  const tail = lines.slice(-STALE_RUN_PROGRESS_TAIL_COUNT);
  return [
    ...head.map((line) => `- ${line}`),
    `- ... 已省略 ${lines.length - head.length - tail.length} 条中间运行记录 ...`,
    ...tail.map((line) => `- ${line}`)
  ].join("\n");
}

function buildVisibleHistoryContinuationMessage(threadId: string, userMessage: string): string | null {
  if (!isContinueOnlyMessage(userMessage)) return null;
  if (hasRuntimeCoreSessionTranscript(threadId)) return null;
  const messages = getAgentThreadMessages(threadId)
    .filter((message) => message.content.trim().length > 0);
  while (messages.length > 0) {
    const latest = messages[messages.length - 1];
    if (latest?.role !== "user" || !isContinueOnlyMessage(latest.content)) break;
    messages.pop();
  }
  if (messages.length === 0) return null;
  const historyLines = messages
    .slice(-VISIBLE_HISTORY_CONTINUATION_TAIL_COUNT)
    .map((message) => `- ${message.role}: ${compactRuntimeText(message.content, 360)}`)
    .join("\n");
  return [
    VISIBLE_HISTORY_CONTINUATION_PREFIX,
    "可见聊天历史：",
    historyLines,
    `用户发送的继续指令：${userMessage.trim()}`
  ].join("\n\n");
}

function formatStaleRunItem(item: LumeRunItem): string | null {
  if (item.type === "assistant_message") {
    const text = extractAssistantRunText(item.content);
    return text ? `assistant: ${compactRuntimeText(text, 240)}` : null;
  }
  if (item.type === "tool_call") {
    return `tool ${item.toolName} called with ${compactRuntimeText(previewRuntimeValue(item.input), 240)}`;
  }
  if (item.type === "tool_result") {
    return `tool ${item.toolName ?? item.toolCallId} result: ${compactRuntimeText(previewRuntimeValue(item.output), 240)}`;
  }
  if (item.type === "subagent") {
    const output = item.output?.trim() ? `: ${compactRuntimeText(item.output, 240)}` : "";
    return `subagent ${item.status} ${item.task}${output}`;
  }
  if (item.type === "plan_preview") {
    return `plan preview: ${compactRuntimeText(item.title || item.summary, 240)}`;
  }
  return null;
}

function extractAssistantRunText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const record = block as Record<string, unknown>;
      return typeof record.text === "string"
        ? record.text
        : typeof record.thinking === "string"
          ? record.thinking
          : "";
    })
    .filter(Boolean)
    .join("");
}

function previewRuntimeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function compactRuntimeText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function handleRuntimeThreadStateMessage(
  threadId: string,
  message: SDKMessage,
  sessionStateManager: ReturnType<typeof getSessionStateManager>
): void {
  if (message.type === "result" && message.contextUsage) {
    const contextUsage = message.contextUsage;
    sessionStateManager.updateTokens(
      threadId,
      numberValue(contextUsage.totalTokens),
      numberValue(contextUsage.contextWindow) || undefined
    );
  }

  if (
    message.type === "system"
    && (message.subtype === "context_compaction_started" || message.subtype === "context_compaction_progress")
  ) {
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
    || message.subtype === "context_compaction_progress"
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

function extractAssistantTurnTokenUsage(messages: SDKMessage[]): Record<string, unknown> | undefined {
  const result = [...messages].reverse().find((message) => (
    message.type === "result" && message.contextUsage && message.billingUsage
  ));
  if (!result || result.type !== "result") {
    return undefined;
  }

  const contextUsage = (result as Extract<SDKMessage, { type: "result" }> & {
    contextUsage?: NonNullable<Extract<SDKMessage, { type: "result" }>["contextUsage"]>;
  }).contextUsage;
  const billingUsage = (result as Extract<SDKMessage, { type: "result" }> & {
    billingUsage?: NonNullable<Extract<SDKMessage, { type: "result" }>["billingUsage"]>;
  }).billingUsage;
  if (!contextUsage || !billingUsage) {
    return undefined;
  }
  const latestRecord = billingUsage.latestRecord ?? billingUsage.records[billingUsage.records.length - 1];
  const inputTokens = numberValue(latestRecord?.inputTokens ?? billingUsage.cumulative.inputTokens);
  const outputTokens = numberValue(latestRecord?.outputTokens ?? billingUsage.cumulative.outputTokens);
  const cacheReadInputTokens = numberValue(latestRecord?.cacheReadInputTokens ?? billingUsage.cumulative.cacheReadInputTokens);
  const cacheCreationInputTokens = numberValue(latestRecord?.cacheCreationInputTokens ?? billingUsage.cumulative.cacheCreationInputTokens);
  const directCachedTokens = numberValue((latestRecord as { cachedTokens?: number } | undefined)?.cachedTokens);
  const cachedTokens = directCachedTokens > 0
    ? directCachedTokens
    : cacheReadInputTokens + cacheCreationInputTokens;
  const totalTokens = numberValue(latestRecord?.totalTokens) || inputTokens + outputTokens + cachedTokens;
  return {
    source: "provider",
    scope: "assistant_turn",
    providerOutputTokens: outputTokens,
    contextUsage: {
      source: contextUsage.source,
      totalTokens: numberValue(contextUsage.totalTokens),
      contextWindow: numberValue(contextUsage.contextWindow)
    },
    billingUsage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      cachedTokens,
      totalTokens,
      costUSD: numberValue(latestRecord?.costUSD ?? billingUsage.totalCostUSD)
    }
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
  metadata?: Record<string, unknown>;
  sdkMessages: SDKMessage[];
} | null {
  const assistantMessages = input.sdkMessages.filter((message) => (
    message.type === "assistant" && !isSubagentAssistantSdkMessage(message)
  ));
  if (assistantMessages.length === 0) {
    return null;
  }
  const tokenUsage = extractAssistantTurnTokenUsage(input.sdkMessages);

  return {
    id: `sdk-turn:${input.threadId}:${resolveAssistantCreatedAtFromSdkMessages(input.sdkMessages)}`,
    role: "assistant",
    content: extractAssistantTextFromSdkMessages(input.sdkMessages),
    reasoning: extractAssistantReasoningFromSdkMessages(input.sdkMessages),
    createdAt: resolveAssistantCreatedAtFromSdkMessages(input.sdkMessages),
    model: input.modelId,
    ...(tokenUsage ? { metadata: { tokenUsage } } : {}),
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
      modelId: boundModel?.modelId ?? input.modelId ?? threadMeta?.modelId ?? resolvedModelId,
      channelProviderId: resolvedChannel.providerId
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
    ...(input.messageAttachments?.length ? { messageAttachments: input.messageAttachments } : {}),
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
  let modelFacingUserMessage = userMessage;

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
  modelFacingUserMessage = await resolveModelFacingUserMessage(threadId, userMessage);

  const sessionStateManager = getSessionStateManager();
  const runtimeStatusManager = getAgentRuntimeStatusManager();
  sessionStateManager.getOrCreate(threadId);

  if (hasExplicitSendSelection) {
    tryUpdateAgentThreadMeta(threadId, {
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
      userMessage: modelFacingUserMessage,
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
      if (
        stampedMessage.type === "system"
        && (stampedMessage.subtype === "context_compaction_started" || stampedMessage.subtype === "context_compaction_progress")
      ) {
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
    const titleModelRef = effectiveLumeConfig.models?.title?.defaultModelRef;
    const job = createAutoTitleJob({
      threadId,
      fallbackUserMessage: userMessage,
      // 未配置专用 title 模型时回退到当前会话的渠道/模型，确保 LLM 标题生成始终可触发
      generateTitle: (sourceText) => generateAgentTitle(
        titleModelRef
          ? { sourceText, modelRef: titleModelRef }
          : { sourceText, channelId: resolvedChannelId, modelId: boundModel?.modelId ?? resolvedModelId }
      ),
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

export function listAgentMessageQueue(threadId: string): AgentMessageQueueSnapshot {
  return {
    threadId,
    queuedMessages: agentRuntimeKernel.listQueued(threadId).map(toQueuedMessage),
    pendingGuidance: runGuidanceStore.listPending(threadId)
  };
}

export function reorderAgentMessageQueue(input: AgentReorderMessageQueueInput): AgentMessageQueueOperationResult {
  agentRuntimeKernel.reorderQueued(input.threadId, input.orderedMessageIds);
  return finishQueueOperation(input.threadId);
}

export function removeQueuedAgentMessage(input: AgentRemoveQueuedMessageInput): AgentMessageQueueOperationResult {
  const removed = agentRuntimeKernel.removeQueued(input.threadId, input.queuedMessageId);
  return finishQueueOperation(input.threadId, {
    ...(removed ? { removedMessage: toQueuedMessage(removed) } : {})
  });
}

export function promoteQueuedAgentMessageToGuidance(
  input: AgentPromoteQueuedMessageToGuidanceInput
): AgentMessageQueueOperationResult {
  const removed = agentRuntimeKernel.removeQueued(input.threadId, input.queuedMessageId);
  const promotedGuidance = removed ? runGuidanceStore.addQueuedDispatch(removed) : undefined;
  return finishQueueOperation(input.threadId, {
    ...(promotedGuidance ? { promotedGuidance } : {})
  });
}

export async function waitForAgentRuntimeKernelIdleForTest(): Promise<void> {
  await agentRuntimeKernel.waitForIdleForTest();
}

export function resetAgentRuntimeKernelForTest(): void {
  agentRuntimeKernel.resetForTest();
  runGuidanceStore.resetForTest();
}

function finishQueueOperation(
  threadId: string,
  extra: {
    removedMessage?: AgentQueuedMessage;
    promotedGuidance?: AgentPendingGuidance;
  } = {}
): AgentMessageQueueOperationResult {
  const snapshot = listAgentMessageQueue(threadId);
  emitAgentMessageQueueChanged(threadId, snapshot);
  return {
    ok: true,
    snapshot,
    ...extra
  };
}

function emitAgentMessageQueueChanged(threadId: string, snapshot = listAgentMessageQueue(threadId)): void {
  emitAgentNotification(AGENT_IPC_CHANNELS.MESSAGE_QUEUE_CHANGED, snapshot);
}

function restoreUnconsumedGuidanceToQueue(threadId: string): void {
  const dispatches = runGuidanceStore.drainUnconsumedDispatches<
    AgentRuntimeKernelQueuedDispatch<AgentSendInput, AgentStreamEmitter>
  >(threadId);
  if (dispatches.length === 0) {
    return;
  }
  agentRuntimeKernel.prependQueuedDispatches(threadId, dispatches);
  emitAgentMessageQueueChanged(threadId);
}

function toQueuedMessage(dispatch: AgentRuntimeKernelQueuedDispatch<AgentSendInput, AgentStreamEmitter>): AgentQueuedMessage {
  return {
    id: dispatch.id,
    threadId: dispatch.threadId,
    text: dispatch.text,
    createdAt: dispatch.createdAt
  };
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

export async function generateWelcomeSuggestions(
  input: AgentWelcomeSuggestionInput = {}
): Promise<AgentWelcomeSuggestionsResult> {
  const fallback = (): AgentWelcomeSuggestionsResult => ({
    suggestions: DEFAULT_WELCOME_SUGGESTIONS,
    source: "fallback"
  });
  const config = getEffectiveLumeConfig(input.workspaceSlug);
  const modelRef = config.models?.welcomeSuggestions?.defaultModelRef || config.models?.background?.defaultModelRef;
  if (!modelRef) return fallback();

  const binding = resolveChannelModelBinding(modelRef, "chat");
  if (!binding) return fallback();

  try {
    const provider = createProvider(resolveAgentServiceApiType(binding.channel.provider), {
      apiKey: decryptApiKey(binding.channel.id),
      baseURL: binding.channel.baseUrl,
    });
    const response = await provider.createMessage({
      model: binding.modelId,
      maxTokens: 900,
      system: WELCOME_SUGGESTIONS_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            workspaceName: input.workspaceName ?? "",
            examples: DEFAULT_WELCOME_SUGGESTIONS
          })
        }
      ],
    });
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { type: "text"; text: string }).text)
      .join("")
      .trim();
    const suggestions = parseWelcomeSuggestions(text);
    return suggestions.length > 0 ? { suggestions, source: "model" } : fallback();
  } catch (error) {
    log.warn("欢迎页建议生成失败，已回退默认建议", {
      modelRef,
      error: error instanceof Error ? error.message : String(error)
    });
    return fallback();
  }
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
    const modelId = boundModel?.modelId ?? input.modelId;
    if (!modelId) return null;
    const modelSelection = resolveChannelModelSelection({
      channelProvider: channel.provider,
      baseUrl: channel.baseUrl,
      modelId,
      openaiApiMode: channel.openaiApiMode,
      channelProviderId: channel.providerId,
    });
    const adapter = getAdapter(modelSelection.adapterProvider, modelSelection.openaiApiMode);
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

function parseWelcomeSuggestions(text: string): AgentWelcomeSuggestion[] {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    const items = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { suggestions?: unknown }).suggestions)
        ? (parsed as { suggestions: unknown[] }).suggestions
        : [];
    return items
      .map((item, index) => {
        if (!item || typeof item !== "object") return null;
        const title = typeof (item as { title?: unknown }).title === "string"
          ? (item as { title: string }).title.trim()
          : "";
        const prompt = typeof (item as { prompt?: unknown }).prompt === "string"
          ? (item as { prompt: string }).prompt.trim()
          : "";
        if (!title || !prompt) return null;
        return { id: `model-${index}`, title: title.slice(0, 20), prompt };
      })
      .filter((item): item is AgentWelcomeSuggestion => Boolean(item))
      .slice(0, 4);
  } catch {
    return [];
  }
}

function resolveAgentServiceApiType(provider: string): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") return "anthropic-messages";
  if (normalized === "deepseek") return "deepseek-chat-completions";
  return "openai-completions";
}

const WELCOME_SUGGESTIONS_SYSTEM_PROMPT = `你是 Lume 欢迎页的任务建议生成器。
根据当前工作区名称，生成 4 个用户一眼能理解、适合直接开始对话的建议。
要求：
- title 使用 4-8 个中文字符，像按钮文案
- prompt 是完整中文指令，点击后会填入输入框
- 不要解释，不要 markdown
- 只返回 JSON：
{"suggestions":[{"title":"规划今天","prompt":"..."}]}`;
