import { randomUUID } from "node:crypto";
import {
  type SDKMessage,
  type ToolDefinition
} from "@lume/agent-sdk";
import { Type } from "@sinclair/typebox";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentToolPermissionRequest
} from "@lume/shared";
import {
  createAgentThread,
  deleteAgentThread,
  getAgentThreadMessages,
  getAgentThreadMeta,
  listAgentThreads,
  updateAgentThreadMeta
} from "../../../agent/agent-thread-manager";
import type { AgentMessage } from "@lume/shared";
import { decryptApiKey, listChannels } from "../../../channel/channel-manager";
import { resolveRequestedModelIdForChannel } from "../../../channel/model-selection";
import { runPiAgent, stopPiAgent } from "../../runtime-core/attempt";
import { getSubagentRunRegistry } from "../../../agent/subagents/subagent-run-registry";
import { announceSubagentCompletion } from "../../../agent/subagents/subagent-announce-service";
import { resolveSubagentSpawnPolicy } from "../../../agent/subagents/subagent-policy";
import { resolveSubagentThreadBinding } from "../../../agent/subagents/subagent-thread-binding";
import { setAskUserQuestionApprovalSession } from "../bridges/ask-user-question-bridge";
import { setToolPermissionApprovalSession } from "../bridges/tool-permission-bridge";
import { createSdkJsonResultTool } from "../sdk-tool-result";
import { createSdkWebTools } from "../web/create-web-tools";

interface CreateSessionToolsInput {
  threadId: string;
  workspaceId?: string;
  channelId?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  includeWebTools?: boolean;
}

interface SessionTool {
  name: string;
  label: string;
  description: string;
  parameters: Parameters<typeof createSdkJsonResultTool>[0]["inputSchema"];
  execute: (toolCallId: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface ResolveThreadTargetInput {
  currentThreadId: string;
  threadId?: unknown;
  label?: unknown;
  agentId?: unknown;
}

interface ResolveSpawnRouteInput {
  spawnAgentId: string;
  currentThreadId: string;
  fallbackChannelId?: string;
  requestedModel?: string;
}

function isSubagentSessionId(threadId: string): boolean {
  const normalized = threadId.trim().toLowerCase();
  if (!normalized) return false;
  const tokens = new Set(normalized.split(":").filter(Boolean));
  return tokens.has("subagent") || tokens.has("sub-agent");
}

const SUBAGENT_BLOCKED_TOOL_NAMES = new Set([
  "agents_list",
  "threads_list",
  "threads_history",
  "threads_send",
  "threads_delete",
  "threads_spawn",
  "thread_status",
  "subagents_list",
  "subagents_kill",
  "subagents_send",
  "subagents_steer"
]);

function isSubagentTeamV2Enabled(): boolean {
  const raw = (process.env.ENABLE_SUBAGENT_TEAM_V2 ?? "true").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function buildSubagentBlockedResult(toolName: string): {
  status: "error";
  error: string;
} {
  return {
    status: "error",
    error: `${toolName} is not allowed from sub-agent threads`
  };
}

function buildSubagentFeatureDisabledResult(toolName: string): {
  status: "unavailable";
  error: string;
} {
  return {
    status: "unavailable",
    error: `${toolName} disabled by ENABLE_SUBAGENT_TEAM_V2=false`
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return Math.min(max, Math.max(min, parsed));
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...(truncated)...`;
}

function pickThreadId(rawValue: unknown, currentThreadId: string): string {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return currentThreadId;
  }
  const normalized = rawValue.trim();
  if (normalized === "current" || normalized === "main") {
    return currentThreadId;
  }
  return normalized;
}

function resolveThreadByLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return null;
  const matched = listAgentThreads().find((session) => session.title.trim().toLowerCase() === normalized);
  return matched?.id ?? null;
}

function resolveThreadIdsByLabel(label: string): string[] {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return [];
  return listAgentThreads()
    .filter((session) => session.title.trim().toLowerCase() === normalized)
    .map((session) => session.id);
}

function resolveThreadTarget(input: ResolveThreadTargetInput): {
  ok: true;
  threadId: string;
} | {
  ok: false;
  error: string;
} {
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";

  if (threadId && label) {
    return { ok: false, error: "Provide either threadId or label (not both)." };
  }
  if (threadId) {
    return { ok: true, threadId: pickThreadId(threadId, input.currentThreadId) };
  }
  if (label) {
    if (agentId) {
      return {
        ok: false,
        error: "当前 Lume 尚未实现 label + agentId 的联合解析，请直接传 threadId。"
      };
    }
    const resolved = resolveThreadByLabel(label);
    if (!resolved) {
      return { ok: false, error: `No thread found with label: ${label}` };
    }
    return { ok: true, threadId: resolved };
  }
  return { ok: true, threadId: input.currentThreadId };
}

function pickModelIdForChannel(channelId: string | undefined, requestedModelId?: string): string | null {
  if (!channelId) return requestedModelId?.trim() || null;
  const channel = listChannels().find((item) => item.id === channelId);
  if (!channel) return requestedModelId?.trim() || null;
  return resolveRequestedModelIdForChannel(channel, requestedModelId) ?? null;
}

function extractLatestModelFromThread(threadId: string): string | undefined {
  const messages = getAgentThreadMessages(threadId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || typeof message.model !== "string") {
      continue;
    }
    const model = message.model.trim();
    if (model) return model;
  }
  return undefined;
}

function mapRunStatusToSubagent(status: "completed" | "aborted" | "errored" | "timed_out"): "completed" | "aborted" | "errored" | "timed_out" {
  switch (status) {
    case "completed":
      return "completed";
    case "aborted":
      return "aborted";
    case "timed_out":
      return "timed_out";
    default:
      return "errored";
  }
}

const TERMINAL_SUBAGENT_STATUSES = new Set(["completed", "errored", "aborted", "timed_out", "canceled"]);

function isTerminalSubagentStatus(status: string): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status);
}

function resolveSubagentErrorCode(params: {
  status: "completed" | "aborted" | "errored" | "timed_out" | "canceled";
  error?: string;
}): string | undefined {
  if (params.status === "completed") return undefined;
  if (params.status === "timed_out") return "SUBAGENT_TIMEOUT";
  if (params.status === "aborted") return "SUBAGENT_ABORTED";
  if (params.status === "canceled") return "SUBAGENT_CANCELED";
  if (!params.error) return "SUBAGENT_RUNTIME_ERROR";
  const message = params.error.toLowerCase();
  if (message.includes("permission")) return "SUBAGENT_PERMISSION_REQUIRED";
  if (message.includes("askuserquestion")) return "SUBAGENT_ASK_USER_REQUIRED";
  if (message.includes("timeout")) return "SUBAGENT_TIMEOUT";
  return "SUBAGENT_RUNTIME_ERROR";
}

function resolveOwnedSubagentRun(params: {
  runRegistry: ReturnType<typeof getSubagentRunRegistry>;
  ownerThreadId: string;
  runId: string;
}) {
  const matched = params.runRegistry.get(params.runId);
  if (!matched) {
    return {
      ok: false as const,
      error: `runId not found: ${params.runId}`
    };
  }
  const owned = matched.parentThreadId === params.ownerThreadId || matched.rootThreadId === params.ownerThreadId;
  if (!owned) {
    return {
      ok: false as const,
      error: "仅允许操作当前会话可控的 subagent run"
    };
  }
  return {
    ok: true as const,
    run: matched
  };
}

async function finalizeSubagentRun(params: {
  runRegistry: ReturnType<typeof getSubagentRunRegistry>;
  runId: string;
  cleanup: "keep" | "delete";
  childThreadId: string;
  result: {
    status: "completed" | "aborted" | "errored" | "timed_out";
    error?: string;
    runText: string;
    usageEvents: number;
  };
}): Promise<void> {
  const terminalStatus = mapRunStatusToSubagent(params.result.status);
  const finalized = params.runRegistry.update(params.runId, {
    status: terminalStatus,
    endedAt: Date.now(),
      outcome: {
        output: params.result.runText,
        error: params.result.error,
        errorCode: resolveSubagentErrorCode({
          status: terminalStatus,
          error: params.result.error
        }),
        usageEvents: params.result.usageEvents
      }
    });
  if (params.cleanup === "delete") {
    try {
      deleteAgentThread(params.childThreadId);
    } catch {
      // ignore cleanup failure to keep status stable
    }
  }
  if (!finalized) {
    return;
  }
  const announceResult = await announceSubagentCompletion({
    run: finalized
  });
  params.runRegistry.update(params.runId, {
    announceStatus: announceResult.delivered ? "delivered" : "failed",
    announceAttempts: announceResult.attempts,
    announceLastError: announceResult.error,
    announceDeliveredAt: announceResult.delivered ? Date.now() : undefined
  });
}

function resolveSpawnRoute(input: ResolveSpawnRouteInput): {
  ok: true;
  resolvedAgentId?: string;
  channelId?: string;
  modelHint?: string;
} | {
  ok: false;
  error: string;
} {
  const currentMeta = getAgentThreadMeta(input.currentThreadId);
  const normalizedAgentId = input.spawnAgentId.trim();

  if (!normalizedAgentId || normalizedAgentId === "lume") {
    return {
      ok: true,
      resolvedAgentId: normalizedAgentId || undefined,
      channelId: currentMeta?.channelId ?? input.fallbackChannelId,
      modelHint: input.requestedModel || extractLatestModelFromThread(input.currentThreadId)
    };
  }

  const targetMeta = getAgentThreadMeta(normalizedAgentId);
  if (!targetMeta) {
    return {
      ok: false,
      error: `agentId 不存在: ${normalizedAgentId}`
    };
  }

  return {
    ok: true,
    resolvedAgentId: targetMeta.id,
    channelId: targetMeta.channelId ?? currentMeta?.channelId ?? input.fallbackChannelId,
    modelHint: input.requestedModel
      || extractLatestModelFromThread(targetMeta.id)
      || extractLatestModelFromThread(input.currentThreadId)
  };
}

function collectTextFromSdkMessage(message: SDKMessage): string {
  if (message.type === "stream_event") {
    const delta = message.event?.type === "content_block_delta"
      ? message.event.delta as { type?: string; text?: string } | undefined
      : undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return delta.text;
    }
  }
  if (message.type === "assistant") {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    return content
      .filter((block) => !!block && typeof block === "object")
      .map((block) => block as { type?: string; text?: string })
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("");
  }
  return "";
}

function createTaskSystemMessage(message: Record<string, unknown>): SDKMessage {
  return {
    type: "system",
    ...message
  } as SDKMessage;
}

async function executeAgentTurn(params: {
  threadId: string;
  userMessage: string;
  workspaceId?: string;
  channelId?: string;
  modelId?: string;
  permissionMode?: AgentSendInput["permissionMode"];
  timeoutSeconds?: number;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  messageMetadata?: Record<string, unknown>;
  approvalSessionId?: string;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  parentThreadId?: string;
  runId?: string;
  taskDescription?: string;
}): Promise<{
  status: "completed" | "aborted" | "errored" | "timed_out";
  error?: string;
  runText: string;
  usageEvents: number;
}> {
  const timeoutSeconds = clampInt(params.timeoutSeconds, 0, 3600, 60);
  const timeoutMs = timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
  const collectedChunks: string[] = [];
  let usageEvents = 0;
  let runtimeError = "";
  const input: AgentSendInput = {
    threadId: params.threadId,
    userMessage: params.userMessage,
    workspaceId: params.workspaceId,
    channelId: params.channelId,
    modelId: params.modelId,
    permissionMode: params.permissionMode,
    threadType: params.threadType,
    chatType: params.chatType,
    messageMetadata: params.messageMetadata
  };
  let lastToolName = "";
  let toolUseCount = 0;
  const startedAt = Date.now();
  let progressInterval: ReturnType<typeof setInterval> | undefined;

  if (params.parentThreadId && params.runId) {
    progressInterval = setInterval(() => {
      params.emitSdkMessage?.(createTaskSystemMessage({
        subtype: "task_progress",
        task_id: params.runId!,
        tool_use_id: params.runId!,
        description: params.taskDescription ?? "子任务执行中",
        last_tool_name: lastToolName || undefined,
        usage: {
          total_tokens: 0,
          tool_uses: toolUseCount,
          duration_ms: Date.now() - startedAt
        }
      }));
    }, 3000);
  }

  const execution = runPiAgent({
    input,
    runtime: {
      sessionId: input.threadId,
      channelId: input.channelId ?? "",
      modelId: input.modelId ?? "",
      workspaceId: input.workspaceId,
      threadType: input.threadType
    }
  }, {
    onSdkMessage(message) {
      if (message.type === "assistant") {
        for (const block of message.message?.content ?? []) {
          if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
          lastToolName = typeof block.name === "string" ? block.name : lastToolName;
          toolUseCount += 1;
        }
      }
      const text = collectTextFromSdkMessage(message);
      if (text) {
        collectedChunks.push(text);
      }
      if (message.type === "result" && message.usage) {
        usageEvents += 1;
      }
    },
    onComplete() {
      return;
    },
    onError(error) {
      runtimeError = error;
    },
    onAskUserQuestion(request) {
      if (!params.emitAskUserQuestion) {
        runtimeError = "目标会话在自动执行中触发 AskUserQuestion，但当前未配置交互回调，已中止";
        void stopPiAgent(params.threadId);
        return;
      }
      const approvalSessionId = params.approvalSessionId?.trim();
      if (approvalSessionId && approvalSessionId !== request.threadId) {
        setAskUserQuestionApprovalSession(request.toolUseId, approvalSessionId);
        params.emitAskUserQuestion({
          ...request,
          threadId: approvalSessionId,
          originThreadId: request.threadId,
          ...(params.runId ? { subagentRunId: params.runId } : {})
        });
        return;
      }
      params.emitAskUserQuestion(request);
    },
    onToolPermissionRequest(request) {
      if (!params.emitToolPermissionRequest) {
        runtimeError = `目标会话工具需要用户确认，但当前未配置交互回调，已中止: ${request.toolName}`;
        void stopPiAgent(params.threadId);
        return;
      }
      const approvalSessionId = params.approvalSessionId?.trim();
      if (approvalSessionId && approvalSessionId !== request.threadId) {
        setToolPermissionApprovalSession(request.requestId, approvalSessionId);
        params.emitToolPermissionRequest({
          ...request,
          threadId: approvalSessionId,
          originThreadId: request.threadId,
          ...(params.runId ? { subagentRunId: params.runId } : {})
        });
        return;
      }
      params.emitToolPermissionRequest(request);
    }
  });

  if (timeoutMs <= 0) {
    const result = await execution;
    if (progressInterval) clearInterval(progressInterval);
    const runText = truncateText(collectedChunks.join(""), 8_000);
    const errorMsg = runtimeError || result.errorMessage;
    if (errorMsg || result.status === "errored") {
      return { status: "errored", error: errorMsg || "子线程执行异常", runText, usageEvents };
    }
    return { status: result.status, runText, usageEvents };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stopPiAgent(params.threadId);
  }, timeoutMs);
  try {
    const result = await execution;
    const runText = truncateText(collectedChunks.join(""), 8_000);
    if (timedOut) {
      return {
        status: "timed_out",
        error: `执行超过 ${timeoutSeconds}s，已发出停止请求`,
        runText,
        usageEvents
      };
    }
    const errorMsg = runtimeError || result.errorMessage;
    if (errorMsg || result.status === "errored") {
      return { status: "errored", error: errorMsg || "子线程执行异常", runText, usageEvents };
    }
    return { status: result.status, runText, usageEvents };
  } finally {
    clearTimeout(timer);
    if (progressInterval) clearInterval(progressInterval);
  }
}

function mapMessagesForTool(messages: AgentMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: typeof message.content === "string" ? truncateText(message.content, 4_000) : "",
    createdAt: message.createdAt,
    model: message.model
  }));
}

function createSessionTools(input: CreateSessionToolsInput): ToolDefinition[] {
  const toolSpecs: SessionTool[] = [
    {
      name: "agents_list",
      label: "agents_list",
      description: "List agent ids you can target with threads_spawn.",
      parameters: Type.Object({}),
      async execute() {
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("agents_list")) {
          return buildSubagentBlockedResult("agents_list");
        }
        const threadAgents = listAgentThreads()
          .slice(0, 50)
          .map((session) => ({
            id: session.id,
            name: session.title,
            configured: Boolean(session.channelId),
            channelId: session.channelId
          }));

        return {
          requester: "lume",
          allowAny: false,
          agents: [{ id: "lume", name: "Lume Agent", configured: true }, ...threadAgents]
        };
      }
    },
    {
      name: "threads_list",
      label: "threads_list",
      description: "List threads with optional filters and recent messages.",
      parameters: Type.Object({
        kinds: Type.Optional(Type.Array(Type.String())),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
        activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
        messageLimit: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("threads_list")) {
          return buildSubagentBlockedResult("threads_list");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const limit = clampInt(params.limit, 1, 200, 50);
        const activeMinutes = clampInt(params.activeMinutes, 1, 60 * 24 * 365, 0);
        const messageLimit = clampInt(params.messageLimit, 0, 20, 0);
        const kinds = Array.isArray(params.kinds)
          ? params.kinds
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim().toLowerCase())
          : [];

        let threads = listAgentThreads();
        if (activeMinutes > 0) {
          const minUpdatedAt = Date.now() - activeMinutes * 60 * 1000;
          threads = threads.filter((thread) => thread.updatedAt >= minUpdatedAt);
        }
        if (kinds.length > 0 && !kinds.includes("main")) {
          threads = [];
        }
        threads = threads.slice(0, limit);

        const rows = threads.map((thread) => {
          const allMessages = getAgentThreadMessages(thread.id);
          const lastAssistant = [...allMessages].reverse().find((message) => message.role === "assistant");
          const withMessages = messageLimit > 0
            ? mapMessagesForTool(allMessages.slice(Math.max(0, allMessages.length - messageLimit)))
            : undefined;
          return {
            key: thread.id,
            kind: "main",
            label: thread.title,
            updatedAt: thread.updatedAt,
            channelId: thread.channelId,
            workspaceId: thread.workspaceId,
            model: lastAssistant?.model,
            ...(withMessages ? { messages: withMessages } : {})
          };
        });

        return {
          count: rows.length,
          threads: rows
        };
      }
    },
    {
      name: "threads_history",
      label: "threads_history",
      description: "Fetch message history for a thread.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String({ minLength: 1 })),
        label: Type.Optional(Type.String()),
        agentId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
        includeTools: Type.Optional(Type.Boolean())
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("threads_history")) {
          return buildSubagentBlockedResult("threads_history");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const hasThreadId = typeof params.threadId === "string" && params.threadId.trim().length > 0;
        const hasLabel = typeof params.label === "string" && params.label.trim().length > 0;
        if (!hasThreadId && !hasLabel) {
          return {
            status: "error",
            error: "Either threadId or label is required"
          };
        }
        const resolvedTarget = resolveThreadTarget({
          currentThreadId: input.threadId,
          threadId: params.threadId,
          label: params.label,
          agentId: params.agentId
        });
        if (!resolvedTarget.ok) {
          return {
            status: "error",
            error: resolvedTarget.error
          };
        }
        const sessionId = resolvedTarget.threadId;
        const limit = clampInt(params.limit, 1, 500, 100);
        const includeTools = params.includeTools === true;
        const meta = getAgentThreadMeta(sessionId);
        if (!meta) {
          return {
            status: "not_found",
            error: `Thread not found: ${sessionId}`
          };
        }
        let messages = getAgentThreadMessages(sessionId);
        if (!includeTools) {
          messages = messages.filter((message) => message.role === "user" || message.role === "assistant");
        }
        messages = messages.slice(Math.max(0, messages.length - limit));
        return {
          status: "ok",
          threadId: sessionId,
          count: messages.length,
          messages: mapMessagesForTool(messages)
        };
      }
    },
    {
      name: "thread_status",
      label: "thread_status",
      description: "Show current thread status and summary.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        model: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("thread_status")) {
          return buildSubagentBlockedResult("thread_status");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const resolvedTarget = resolveThreadTarget({
          currentThreadId: input.threadId,
          threadId: params.threadId
        });
        if (!resolvedTarget.ok) {
          return {
            status: "error",
            error: resolvedTarget.error
          };
        }
        const sessionId = resolvedTarget.threadId;
        const meta = getAgentThreadMeta(sessionId);
        if (!meta) {
          return {
            status: "not_found",
            error: `Thread not found: ${sessionId}`
          };
        }
        const messages = getAgentThreadMessages(sessionId);
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        return {
          status: "ok",
          threadId: sessionId,
          title: meta.title,
          messageCount: messages.length,
          updatedAt: meta.updatedAt,
          channelId: meta.channelId ?? input.channelId,
          workspaceId: meta.workspaceId ?? input.workspaceId,
          currentModel: lastAssistant?.model ?? null,
          requestedModel: typeof params.model === "string" ? params.model.trim() || null : null
        };
      }
    },
    {
      name: "threads_send",
      label: "threads_send",
      description: "Send a message into another thread.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        label: Type.Optional(Type.String()),
        agentId: Type.Optional(Type.String()),
        message: Type.String({ minLength: 1 }),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("threads_send")) {
          return buildSubagentBlockedResult("threads_send");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const hasThreadId = typeof params.threadId === "string" && params.threadId.trim().length > 0;
        const hasLabel = typeof params.label === "string" && params.label.trim().length > 0;
        if (!hasThreadId && !hasLabel) {
          return {
            status: "error",
            runId: randomUUID(),
            error: "Either threadId or label is required"
          };
        }
        const resolvedTarget = resolveThreadTarget({
          currentThreadId: input.threadId,
          threadId: params.threadId,
          label: params.label,
          agentId: params.agentId
        });
        if (!resolvedTarget.ok) {
          return {
            status: "error",
            runId: randomUUID(),
            error: resolvedTarget.error
          };
        }
        const sessionId = resolvedTarget.threadId;
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!message) {
          return { status: "error", error: "message 不能为空" };
        }
        const meta = getAgentThreadMeta(sessionId);
        if (!meta) {
          return { status: "not_found", error: `Thread not found: ${sessionId}` };
        }
        const resolvedChannelId = meta.channelId ?? input.channelId;
        if (!resolvedChannelId) {
          return {
            status: "error",
            error: `目标会话缺少 channelId，无法执行: ${sessionId}`
          };
        }
        try {
          decryptApiKey(resolvedChannelId);
        } catch (error) {
          return {
            status: "error",
            error: `目标会话渠道不可用: ${error instanceof Error ? error.message : String(error)}`
          };
        }
        const timeoutSeconds = clampInt(params.timeoutSeconds, 0, 600, 60);
        const requestedModel = extractLatestModelFromThread(sessionId);
        const resolvedModelId = pickModelIdForChannel(resolvedChannelId, requestedModel);
        if (!resolvedModelId) {
          return {
            status: "error",
            error: `目标会话缺少可用模型: ${sessionId}`
          };
        }

        const runResult = await executeAgentTurn({
          threadId: sessionId,
          userMessage: message,
          workspaceId: meta.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          permissionMode: input.permissionMode,
          approvalSessionId: input.threadId,
          emitSdkMessage: input.emitSdkMessage,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
          timeoutSeconds,
          threadType: input.threadType,
          chatType: input.chatType
        });
        updateAgentThreadMeta(sessionId, {});
        return {
          status: runResult.status,
          runId: randomUUID(),
          threadId: sessionId,
          model: resolvedModelId,
          usageEvents: runResult.usageEvents,
          output: runResult.runText,
          ...(runResult.error ? { error: runResult.error } : {})
        };
      }
    },
    {
      name: "threads_delete",
      label: "threads_delete",
      description: "Delete an existing thread and its persisted data.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        threadIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        label: Type.Optional(Type.String()),
        labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        agentId: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("threads_delete")) {
          return buildSubagentBlockedResult("threads_delete");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const singleThreadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
        const hasThreadId = singleThreadId.length > 0;
        const threadIds = Array.isArray(params.threadIds)
          ? params.threadIds
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
          : [];
        const singleLabel = typeof params.label === "string" ? params.label.trim() : "";
        const hasLabel = singleLabel.length > 0;
        const labels = Array.isArray(params.labels)
          ? params.labels
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
          : [];
        const hasBatchThreadIds = threadIds.length > 0;
        const hasBatchLabels = labels.length > 0;
        if (!hasThreadId && !hasLabel && !hasBatchThreadIds && !hasBatchLabels) {
          return {
            status: "error",
            error: "Either threadId/label or threadIds/labels is required"
          };
        }

        const resolvedThreadIds: string[] = [];
        const seen = new Set<string>();
        const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";

        const appendThreadId = (threadId: string): void => {
          if (seen.has(threadId)) return;
          seen.add(threadId);
          resolvedThreadIds.push(threadId);
        };

        if (hasThreadId) {
          appendThreadId(pickThreadId(singleThreadId, input.threadId));
        }
        for (const item of threadIds) {
          appendThreadId(pickThreadId(item, input.threadId));
        }

        const allLabels: string[] = [];
        if (hasLabel) allLabels.push(singleLabel);
        allLabels.push(...labels);
        for (const targetLabel of allLabels) {
          if (agentId) {
            return {
              status: "error",
              error: "当前 Lume 尚未实现 label + agentId 的联合解析，请直接传 threadId。"
            };
          }
          const matchedIds = resolveThreadIdsByLabel(targetLabel);
          if (matchedIds.length === 0) {
            return {
              status: "error",
              error: `No thread found with label: ${targetLabel}`
            };
          }
          for (const matchedId of matchedIds) {
            appendThreadId(matchedId);
          }
        }
        if (resolvedThreadIds.length === 0) {
          return {
            status: "error",
            error: "未解析到可删除的线程"
          };
        }
        if (resolvedThreadIds.includes(input.threadId)) {
          return {
            status: "error",
            error: "不能删除当前线程"
          };
        }

        const metas = resolvedThreadIds.map((threadId) => ({
          threadId,
          meta: getAgentThreadMeta(threadId)
        }));
        const missing = metas.find((item) => !item.meta);
        if (missing) {
          return {
            status: "not_found",
            error: `Thread not found: ${missing.threadId}`
          };
        }

        const deletedThreadIds: string[] = [];
        const deletedTitles: string[] = [];
        try {
          for (const item of metas) {
            deleteAgentThread(item.threadId);
            deletedThreadIds.push(item.threadId);
            deletedTitles.push(item.meta?.title ?? "");
          }
        } catch (error) {
          return {
            status: "error",
            error: `删除线程失败: ${error instanceof Error ? error.message : String(error)}`,
            deletedCount: deletedThreadIds.length,
            threadIds: deletedThreadIds
          };
        }
        if (deletedThreadIds.length === 1) {
          return {
            status: "ok",
            deleted: true,
            threadId: deletedThreadIds[0],
            title: deletedTitles[0]
          };
        }
        return {
          status: "ok",
          deleted: true,
          deletedCount: deletedThreadIds.length,
          threadIds: deletedThreadIds,
          titles: deletedTitles
        };
      }
    },
    {
      name: "threads_spawn",
      label: "threads_spawn",
      description: "Spawn an isolated sub-thread for a task.",
      parameters: Type.Object({
        task: Type.String({ minLength: 1 }),
        label: Type.Optional(Type.String()),
        agentId: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(Type.String()),
        runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
        cleanup: Type.Optional(Type.Union([Type.Literal("delete"), Type.Literal("keep")])),
        sandbox: Type.Optional(Type.Union([Type.Literal("inherit"), Type.Literal("require")])),
        thread: Type.Optional(Type.Boolean()),
        deliveryThreadId: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        if (!isSubagentTeamV2Enabled()) {
          return buildSubagentFeatureDisabledResult("threads_spawn");
        }
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("threads_spawn")) {
          return buildSubagentBlockedResult("threads_spawn");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const task = typeof params.task === "string" ? params.task.trim() : "";
        if (!task) {
          return { status: "error", error: "task 不能为空" };
        }
        const cleanup =
          params.cleanup === "delete" || params.cleanup === "keep"
            ? params.cleanup
            : "keep";
        const sandbox = params.sandbox === "require" ? "require" : "inherit";
        const threadRequested = params.thread === true;
        const deliveryThreadIdRaw = typeof params.deliveryThreadId === "string"
          ? params.deliveryThreadId.trim()
          : "";
        const requestedDeliverySessionId = deliveryThreadIdRaw
          ? pickThreadId(deliveryThreadIdRaw, input.threadId)
          : undefined;
        if (requestedDeliverySessionId && !getAgentThreadMeta(requestedDeliverySessionId)) {
          return {
            status: "error",
            error: `deliveryThreadId 不存在: ${requestedDeliverySessionId}`
          };
        }
        const policyDecision = resolveSubagentSpawnPolicy({
          parentThreadId: input.threadId,
          parentPermissionMode: input.permissionMode,
          requestedSandbox: sandbox
        });
        if (!policyDecision.ok) {
          return {
            status: "forbidden",
            error: policyDecision.error
          };
        }
        const currentMeta = getAgentThreadMeta(input.threadId);
        const label = typeof params.label === "string" ? params.label.trim() : "";
        const modelOverride = typeof params.model === "string" ? params.model.trim() : "";
        const spawnAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
        const route = resolveSpawnRoute({
          spawnAgentId,
          currentThreadId: input.threadId,
          fallbackChannelId: currentMeta?.channelId ?? input.channelId,
          requestedModel: modelOverride
        });
        if (!route.ok) {
          return {
            status: "error",
            error: route.error
          };
        }
        const created = createAgentThread(
          label || "子会话",
          route.channelId ?? currentMeta?.channelId ?? input.channelId,
          currentMeta?.workspaceId ?? input.workspaceId,
          input.threadId
        );
        const requestedModel = route.modelHint || extractLatestModelFromThread(input.threadId);
        const thinking = typeof params.thinking === "string" ? params.thinking.trim() : "";
        const resolvedChannelId = created.channelId;
        const resolvedModelId = pickModelIdForChannel(resolvedChannelId, requestedModel);
        if (!resolvedChannelId || !resolvedModelId) {
          return {
            status: "error",
            error: "子线程缺少 channel/model，无法执行",
            childThreadId: created.id
          };
        }
        const runRegistry = getSubagentRunRegistry();
        const runId = randomUUID();
        const threadBinding = resolveSubagentThreadBinding({
          parentThreadId: input.threadId,
          childThreadId: created.id,
          threadRequested,
          requestedDeliverySessionId
        });
        runRegistry.create({
          runId,
          parentThreadId: input.threadId,
          parentRunId: policyDecision.parentRunId,
          rootThreadId: policyDecision.rootThreadId,
          depth: policyDecision.depth,
          childThreadId: created.id,
          deliveryThreadId: threadBinding.deliveryThreadId,
          threadRequested: threadBinding.threadRequested,
          threadBound: threadBinding.threadBound,
          label: label || undefined,
          task,
          cleanup,
          status: "accepted",
          parentToolUseId: _toolCallId,
          requestedAgentId: spawnAgentId || undefined,
          resolvedAgentId: route.resolvedAgentId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          announceStatus: "pending"
        });

        const waitSeconds = clampInt(
          params.runTimeoutSeconds ?? params.timeoutSeconds,
          0,
          600,
          0
        );
        if (waitSeconds > 0) {
          input.emitSdkMessage?.(createTaskSystemMessage({
            subtype: "task_started",
            task_id: runId,
            tool_use_id: _toolCallId,
            description: task,
            workflow_name: label || "Subagent"
          }));
          runRegistry.update(runId, {
            status: "running",
            startedAt: Date.now()
          });
          const runResult = await executeAgentTurn({
            threadId: created.id,
            userMessage: task,
            workspaceId: created.workspaceId,
            channelId: resolvedChannelId,
            modelId: resolvedModelId,
            permissionMode: policyDecision.childPermissionMode,
            approvalSessionId: input.threadId,
            emitSdkMessage: input.emitSdkMessage,
            emitAskUserQuestion: input.emitAskUserQuestion,
            emitToolPermissionRequest: input.emitToolPermissionRequest,
            timeoutSeconds: waitSeconds,
            threadType: "subagent",
            chatType: input.chatType,
            messageMetadata: {
              spawnedBy: input.threadId,
              spawnDepth: policyDecision.depth
            },
            parentThreadId: input.threadId,
            runId,
            taskDescription: task
          });
          runRegistry.update(runId, {
            status: mapRunStatusToSubagent(runResult.status),
            endedAt: Date.now(),
            outcome: {
              output: runResult.runText,
              error: runResult.error,
              errorCode: resolveSubagentErrorCode({
                status: mapRunStatusToSubagent(runResult.status),
                error: runResult.error
              }),
              usageEvents: runResult.usageEvents
            },
            announceStatus: "delivered",
            announceAttempts: 0
          });
          input.emitSdkMessage?.(createTaskSystemMessage({
            subtype: "task_notification",
            task_id: runId,
            tool_use_id: _toolCallId,
            status: runResult.status === "completed" ? "completed" : "failed",
            summary: truncateText(runResult.runText, 200),
            usage: {
              total_tokens: 0,
              tool_uses: runResult.usageEvents,
              duration_ms: Date.now() - (runRegistry.get(runId)?.startedAt ?? Date.now())
            }
          }));
          if (cleanup === "delete") {
            try {
              deleteAgentThread(created.id);
            } catch {
              // ignore cleanup failure to keep tool result stable
            }
          }
          return {
            status: runResult.status,
            childThreadId: created.id,
            runId,
            model: resolvedModelId,
            output: runResult.runText,
            cleanup,
            ...(spawnAgentId ? { requestedAgentId: spawnAgentId } : {}),
            ...(route.resolvedAgentId ? { resolvedAgentId: route.resolvedAgentId } : {}),
            ...(thinking ? { requestedThinking: thinking } : {}),
            spawnDepth: policyDecision.depth,
            rootThreadId: policyDecision.rootThreadId,
            deliveryThreadId: threadBinding.deliveryThreadId,
            thread: threadBinding.threadRequested,
            threadBound: threadBinding.threadBound,
            ...(runResult.error ? { error: runResult.error } : {})
          };
        }

        runRegistry.update(runId, {
          status: "running",
          startedAt: Date.now()
        });
        input.emitSdkMessage?.(createTaskSystemMessage({
          subtype: "task_started",
          task_id: runId,
          tool_use_id: _toolCallId,
          description: task,
          workflow_name: label || "Subagent"
        }));
        void executeAgentTurn({
          threadId: created.id,
          userMessage: task,
          workspaceId: created.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          permissionMode: policyDecision.childPermissionMode,
          approvalSessionId: input.threadId,
          emitSdkMessage: input.emitSdkMessage,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
          timeoutSeconds: 0,
          threadType: "subagent",
          chatType: input.chatType,
          messageMetadata: {
            spawnedBy: input.threadId,
            spawnDepth: policyDecision.depth
          },
          parentThreadId: input.threadId,
          runId,
          taskDescription: task
        }).then(async (runResult) => {
          await finalizeSubagentRun({
            runRegistry,
            runId,
            cleanup,
            childThreadId: created.id,
            result: runResult
          });
          input.emitSdkMessage?.(createTaskSystemMessage({
            subtype: "task_notification",
            task_id: runId,
            tool_use_id: _toolCallId,
            status: runResult.status === "completed" ? "completed" : "failed",
            summary: truncateText(runResult.runText, 200),
            usage: {
              total_tokens: 0,
              tool_uses: runResult.usageEvents,
              duration_ms: Date.now() - (runRegistry.get(runId)?.startedAt ?? Date.now())
            }
          }));
        }).catch((error) => {
          void finalizeSubagentRun({
            runRegistry,
            runId,
            cleanup,
            childThreadId: created.id,
            result: {
              status: "errored",
              error: error instanceof Error ? error.message : String(error),
              runText: "",
              usageEvents: 0
            }
          });
        });
        return {
          status: "accepted",
          childThreadId: created.id,
          runId,
          model: resolvedModelId,
          cleanup,
          ...(spawnAgentId ? { requestedAgentId: spawnAgentId } : {}),
          ...(route.resolvedAgentId ? { resolvedAgentId: route.resolvedAgentId } : {}),
          ...(thinking ? { requestedThinking: thinking } : {}),
          spawnDepth: policyDecision.depth,
          rootThreadId: policyDecision.rootThreadId,
          deliveryThreadId: threadBinding.deliveryThreadId,
          thread: threadBinding.threadRequested,
          threadBound: threadBinding.threadBound,
          sandbox,
          note: "已启动后台子线程执行（runTimeoutSeconds=0 为异步模式）"
        };
      }
    },
    {
      name: "subagents_list",
      label: "subagents_list",
      description: "List spawned subagent runs controlled by current session.",
      parameters: Type.Object({
        threadId: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
        runId: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        if (!isSubagentTeamV2Enabled()) {
          return buildSubagentFeatureDisabledResult("subagents_list");
        }
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("subagents_list")) {
          return buildSubagentBlockedResult("subagents_list");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const ownerThreadId = pickThreadId(params.threadId, input.threadId);
        const statusFilter = typeof params.status === "string" ? params.status.trim() : "";
        const runIdFilter = typeof params.runId === "string" ? params.runId.trim() : "";
        const limit = clampInt(params.limit, 1, 200, 50);
        const runRegistry = getSubagentRunRegistry();

        if (runIdFilter) {
          const resolved = resolveOwnedSubagentRun({
            runRegistry,
            ownerThreadId,
            runId: runIdFilter
          });
          if (!resolved.ok) {
            return {
              status: resolved.error.startsWith("runId not found") ? "not_found" : "forbidden",
              error: resolved.error
            };
          }
          return {
            status: "ok",
            count: 1,
            runs: [resolved.run]
          };
        }

        let runs = runRegistry.listControlledByThread(ownerThreadId);
        if (statusFilter) {
          runs = runs.filter((run) => run.status === statusFilter);
        }
        const sliced = runs.slice(Math.max(0, runs.length - limit));
        return {
          status: "ok",
          count: sliced.length,
          runs: sliced
        };
      }
    },
    {
      name: "subagents_kill",
      label: "subagents_kill",
      description: "Kill a running subagent run and optional descendant runs.",
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
        cascade: Type.Optional(Type.Boolean())
      }),
      async execute(_toolCallId, args) {
        if (!isSubagentTeamV2Enabled()) {
          return buildSubagentFeatureDisabledResult("subagents_kill");
        }
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("subagents_kill")) {
          return buildSubagentBlockedResult("subagents_kill");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const runId = typeof params.runId === "string" ? params.runId.trim() : "";
        if (!runId) {
          return {
            status: "error",
            error: "runId 不能为空"
          };
        }
        const runRegistry = getSubagentRunRegistry();
        const resolved = resolveOwnedSubagentRun({
          runRegistry,
          ownerThreadId: input.threadId,
          runId
        });
        if (!resolved.ok) {
          return {
            status: resolved.error.startsWith("runId not found") ? "not_found" : "forbidden",
            error: resolved.error
          };
        }
        const matched = resolved.run;
        const cascade = params.cascade !== false;
        const descendants = cascade ? runRegistry.listDescendants(runId) : [];
        const targets = [matched, ...descendants];
        const runningTargets = targets.filter((run) => !isTerminalSubagentStatus(run.status));
        if (runningTargets.length === 0) {
          return {
            status: "ok",
            killed: false,
            runId,
            reason: `run 已结束: ${matched.status}`,
            cascade
          };
        }
        for (const target of runningTargets) {
          void stopPiAgent(target.childThreadId);
          runRegistry.update(target.runId, {
            status: "canceled",
            endedAt: Date.now(),
            outcome: {
              output: target.outcome?.output,
              usageEvents: target.outcome?.usageEvents,
              error: "killed by subagents_kill",
              errorCode: "SUBAGENT_CANCELED"
            }
          });
          if (target.cleanup === "delete") {
            try {
              deleteAgentThread(target.childThreadId);
            } catch {
              // keep result deterministic
            }
          }
        }
        return {
          status: "ok",
          killed: true,
          runId,
          killedCount: runningTargets.length,
          cascade,
          childThreadId: matched.childThreadId,
          killedRunIds: runningTargets.map((item) => item.runId)
        };
      }
    },
    {
      name: "subagents_send",
      label: "subagents_send",
      description: "Send a follow-up message to a controlled subagent run.",
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      async execute(_toolCallId, args) {
        if (!isSubagentTeamV2Enabled()) {
          return buildSubagentFeatureDisabledResult("subagents_send");
        }
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("subagents_send")) {
          return buildSubagentBlockedResult("subagents_send");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const runId = typeof params.runId === "string" ? params.runId.trim() : "";
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!runId || !message) {
          return {
            status: "error",
            error: !runId ? "runId 不能为空" : "message 不能为空"
          };
        }
        const runRegistry = getSubagentRunRegistry();
        const resolved = resolveOwnedSubagentRun({
          runRegistry,
          ownerThreadId: input.threadId,
          runId
        });
        if (!resolved.ok) {
          return {
            status: resolved.error.startsWith("runId not found") ? "not_found" : "forbidden",
            error: resolved.error
          };
        }
        const matched = resolved.run;
        const childMeta = getAgentThreadMeta(matched.childThreadId);
        if (!childMeta) {
          return {
            status: "not_found",
            error: `child thread not found: ${matched.childThreadId}`
          };
        }
        const resolvedChannelId = matched.channelId ?? childMeta.channelId ?? input.channelId;
        const requestedModel = matched.modelId || extractLatestModelFromThread(matched.childThreadId);
        const resolvedModelId = pickModelIdForChannel(resolvedChannelId, requestedModel);
        if (!resolvedChannelId || !resolvedModelId) {
          return {
            status: "error",
            error: "目标子线程缺少 channel/model，无法执行"
          };
        }
        runRegistry.update(matched.runId, {
          status: "running",
          startedAt: Date.now()
        });
        const timeoutSeconds = clampInt(params.timeoutSeconds, 0, 600, 60);
        const runResult = await executeAgentTurn({
          threadId: matched.childThreadId,
          userMessage: message,
          workspaceId: childMeta.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          permissionMode: input.permissionMode,
          approvalSessionId: input.threadId,
          emitSdkMessage: input.emitSdkMessage,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
          timeoutSeconds,
          threadType: "subagent",
          chatType: input.chatType,
          messageMetadata: {
            spawnedBy: matched.parentThreadId,
            controlCommand: "send"
          }
        });
        runRegistry.update(matched.runId, {
          status: mapRunStatusToSubagent(runResult.status),
          endedAt: Date.now(),
          outcome: {
            output: runResult.runText,
            error: runResult.error,
            errorCode: resolveSubagentErrorCode({
              status: mapRunStatusToSubagent(runResult.status),
              error: runResult.error
            }),
            usageEvents: runResult.usageEvents
          },
          announceStatus: "delivered",
          announceAttempts: 0
        });
        return {
          status: runResult.status,
          runId: matched.runId,
          childThreadId: matched.childThreadId,
          model: resolvedModelId,
          output: runResult.runText,
          ...(runResult.error ? { error: runResult.error } : {})
        };
      }
    },
    {
      name: "subagents_steer",
      label: "subagents_steer",
      description: "Steer a controlled subagent run with a new directive.",
      parameters: Type.Object({
        runId: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
        runTimeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      async execute(_toolCallId, args) {
        if (!isSubagentTeamV2Enabled()) {
          return buildSubagentFeatureDisabledResult("subagents_steer");
        }
        if (isSubagentSessionId(input.threadId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("subagents_steer")) {
          return buildSubagentBlockedResult("subagents_steer");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const runId = typeof params.runId === "string" ? params.runId.trim() : "";
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!runId || !message) {
          return {
            status: "error",
            error: !runId ? "runId 不能为空" : "message 不能为空"
          };
        }
        const runRegistry = getSubagentRunRegistry();
        const resolved = resolveOwnedSubagentRun({
          runRegistry,
          ownerThreadId: input.threadId,
          runId
        });
        if (!resolved.ok) {
          return {
            status: resolved.error.startsWith("runId not found") ? "not_found" : "forbidden",
            error: resolved.error
          };
        }
        const matched = resolved.run;
        const childMeta = getAgentThreadMeta(matched.childThreadId);
        if (!childMeta) {
          return {
            status: "not_found",
            error: `child thread not found: ${matched.childThreadId}`
          };
        }
        if (!isTerminalSubagentStatus(matched.status)) {
          void stopPiAgent(matched.childThreadId);
          runRegistry.update(matched.runId, {
            status: "canceled",
            endedAt: Date.now(),
            outcome: {
              output: matched.outcome?.output,
              usageEvents: matched.outcome?.usageEvents,
              error: "steered by subagents_steer",
              errorCode: "SUBAGENT_CANCELED"
            }
          });
        }
        const resolvedChannelId = matched.channelId ?? childMeta.channelId ?? input.channelId;
        const requestedModel = matched.modelId || extractLatestModelFromThread(matched.childThreadId);
        const resolvedModelId = pickModelIdForChannel(resolvedChannelId, requestedModel);
        if (!resolvedChannelId || !resolvedModelId) {
          return {
            status: "error",
            error: "目标子线程缺少 channel/model，无法执行"
          };
        }
        const nextRunId = randomUUID();
        runRegistry.create({
          runId: nextRunId,
          parentThreadId: input.threadId,
          parentRunId: matched.parentRunId,
          rootThreadId: matched.rootThreadId || input.threadId,
          depth: matched.depth,
          childThreadId: matched.childThreadId,
          deliveryThreadId: matched.deliveryThreadId,
          threadRequested: matched.threadRequested,
          threadBound: matched.threadBound,
          label: matched.label,
          task: message,
          cleanup: matched.cleanup,
          status: "accepted",
          parentToolUseId: _toolCallId,
          requestedAgentId: matched.requestedAgentId,
          resolvedAgentId: matched.resolvedAgentId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          announceStatus: "pending"
        });

        const waitSeconds = clampInt(params.runTimeoutSeconds ?? params.timeoutSeconds, 0, 600, 0);
        runRegistry.update(nextRunId, {
          status: "running",
          startedAt: Date.now()
        });
        if (waitSeconds > 0) {
          const runResult = await executeAgentTurn({
            threadId: matched.childThreadId,
            userMessage: message,
            workspaceId: childMeta.workspaceId,
            channelId: resolvedChannelId,
            modelId: resolvedModelId,
            permissionMode: input.permissionMode,
            approvalSessionId: input.threadId,
            emitSdkMessage: input.emitSdkMessage,
            emitAskUserQuestion: input.emitAskUserQuestion,
            emitToolPermissionRequest: input.emitToolPermissionRequest,
            timeoutSeconds: waitSeconds,
            threadType: "subagent",
            chatType: input.chatType,
            messageMetadata: {
              spawnedBy: matched.parentThreadId,
              controlCommand: "steer",
              steeredFromRunId: matched.runId
            }
          });
          runRegistry.update(nextRunId, {
            status: mapRunStatusToSubagent(runResult.status),
            endedAt: Date.now(),
            outcome: {
              output: runResult.runText,
              error: runResult.error,
              errorCode: resolveSubagentErrorCode({
                status: mapRunStatusToSubagent(runResult.status),
                error: runResult.error
              }),
              usageEvents: runResult.usageEvents
            },
            announceStatus: "delivered",
            announceAttempts: 0
          });
          return {
            status: runResult.status,
            runId: nextRunId,
            replacedRunId: matched.runId,
            childThreadId: matched.childThreadId,
            model: resolvedModelId,
            output: runResult.runText,
            ...(runResult.error ? { error: runResult.error } : {})
          };
        }

        void executeAgentTurn({
          threadId: matched.childThreadId,
          userMessage: message,
          workspaceId: childMeta.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          permissionMode: input.permissionMode,
          approvalSessionId: input.threadId,
          emitSdkMessage: input.emitSdkMessage,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
          timeoutSeconds: 0,
          threadType: "subagent",
          chatType: input.chatType,
          messageMetadata: {
            spawnedBy: matched.parentThreadId,
            controlCommand: "steer",
            steeredFromRunId: matched.runId
          }
        }).then(async (runResult) => {
          await finalizeSubagentRun({
            runRegistry,
            runId: nextRunId,
            cleanup: matched.cleanup,
            childThreadId: matched.childThreadId,
            result: runResult
          });
        }).catch((error) => {
          void finalizeSubagentRun({
            runRegistry,
            runId: nextRunId,
            cleanup: matched.cleanup,
            childThreadId: matched.childThreadId,
            result: {
              status: "errored",
              error: error instanceof Error ? error.message : String(error),
              runText: "",
              usageEvents: 0
            }
          });
        });
        return {
          status: "accepted",
          runId: nextRunId,
          replacedRunId: matched.runId,
          childThreadId: matched.childThreadId,
          model: resolvedModelId,
          note: "已提交 steer 指令，子线程将在后台继续执行"
        };
      }
    },
  ];
  return toolSpecs.map((tool) => createSdkJsonResultTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as Parameters<typeof createSdkJsonResultTool>[0]["inputSchema"],
    isReadOnly: SESSION_READ_ONLY_TOOL_NAMES.has(tool.name),
    isConcurrencySafe: SESSION_READ_ONLY_TOOL_NAMES.has(tool.name),
    call: (args) => tool.execute(randomUUID(), args)
  }));
}

const SESSION_READ_ONLY_TOOL_NAMES = new Set([
  "agents_list",
  "threads_list",
  "threads_history",
  "thread_status",
  "subagents_list",
  "WebSearch",
  "WebFetch"
]);

export function createSdkSessionTools(input: CreateSessionToolsInput): ToolDefinition[] {
  const tools = createSessionTools(input);
  if (input.includeWebTools !== false) {
    tools.push(...createSdkWebTools());
  }
  return tools;
}
