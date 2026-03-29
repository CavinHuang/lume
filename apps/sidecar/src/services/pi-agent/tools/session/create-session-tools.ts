import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentEvent,
  AgentToolPermissionRequest
} from "@lume/shared";
import { getSessionEventBus } from "../../session-event-bus";
import {
  createAgentSession,
  deleteAgentSession,
  getAgentSessionMessages,
  getAgentSessionMeta,
  listAgentSessions,
  updateAgentSessionMeta
} from "../../../agent/agent-session-manager";
import type { AgentMessage } from "@lume/shared";
import { decryptApiKey, listChannels } from "../../../channel/channel-manager";
import { resolveRequestedModelIdForChannel } from "../../../channel/model-selection";
import { runPiAgentMessage } from "../../run-pi-agent-message";
import { stopPiAgent } from "../../runner/run";
import { getSubagentRunRegistry } from "../../subagents/subagent-run-registry";
import { announceSubagentCompletion } from "../../subagents/subagent-announce-service";
import { resolveSubagentSpawnPolicy } from "../../subagents/subagent-policy";
import { resolveSubagentThreadBinding } from "../../subagents/subagent-thread-binding";
import { setAskUserQuestionApprovalSession } from "../bridges/ask-user-question-bridge";
import { setToolPermissionApprovalSession } from "../bridges/tool-permission-bridge";

interface CreateOpenClawAlignedToolsInput {
  sessionId: string;
  workspaceId?: string;
  channelId?: string;
  sessionType?: AgentSendInput["sessionType"];
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}

interface ResolveSessionTargetInput {
  currentSessionId: string;
  sessionKey?: unknown;
  label?: unknown;
  agentId?: unknown;
}

interface ResolveSpawnRouteInput {
  spawnAgentId: string;
  currentSessionId: string;
  fallbackChannelId?: string;
  requestedModel?: string;
}

function isSubagentSessionId(sessionId: string): boolean {
  const normalized = sessionId.trim().toLowerCase();
  if (!normalized) return false;
  const tokens = new Set(normalized.split(":").filter(Boolean));
  return tokens.has("subagent") || tokens.has("sub-agent");
}

const SUBAGENT_BLOCKED_TOOL_NAMES = new Set([
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_delete",
  "sessions_spawn",
  "session_status",
  "subagents_list",
  "subagents_kill",
  "subagents_send",
  "subagents_steer"
]);

function isSubagentTeamV2Enabled(): boolean {
  const raw = (process.env.ENABLE_SUBAGENT_TEAM_V2 ?? "true").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

function buildSubagentBlockedResult(toolName: string): AgentToolResult<{
  status: "error";
  error: string;
}> {
  return toTextResult({
    status: "error",
    error: `${toolName} is not allowed from sub-agent sessions`
  });
}

function buildSubagentFeatureDisabledResult(toolName: string): AgentToolResult<{
  status: "unavailable";
  error: string;
}> {
  return toTextResult({
    status: "unavailable",
    error: `${toolName} disabled by ENABLE_SUBAGENT_TEAM_V2=false`
  });
}

function toTextResult<TDetails>(details: TDetails): AgentToolResult<TDetails> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(details, null, 2)
      }
    ],
    details
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

function pickSessionId(rawValue: unknown, currentSessionId: string): string {
  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return currentSessionId;
  }
  const normalized = rawValue.trim();
  if (normalized === "current" || normalized === "main") {
    return currentSessionId;
  }
  return normalized;
}

function resolveSessionByLabel(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return null;
  const matched = listAgentSessions().find((session) => session.title.trim().toLowerCase() === normalized);
  return matched?.id ?? null;
}

function resolveSessionIdsByLabel(label: string): string[] {
  const normalized = label.trim().toLowerCase();
  if (!normalized) return [];
  return listAgentSessions()
    .filter((session) => session.title.trim().toLowerCase() === normalized)
    .map((session) => session.id);
}

function resolveSessionTarget(input: ResolveSessionTargetInput): {
  ok: true;
  sessionId: string;
} | {
  ok: false;
  error: string;
} {
  const sessionKey = typeof input.sessionKey === "string" ? input.sessionKey.trim() : "";
  const label = typeof input.label === "string" ? input.label.trim() : "";
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";

  if (sessionKey && label) {
    return { ok: false, error: "Provide either sessionKey or label (not both)." };
  }
  if (sessionKey) {
    return { ok: true, sessionId: pickSessionId(sessionKey, input.currentSessionId) };
  }
  if (label) {
    if (agentId) {
      return {
        ok: false,
        error: "当前 Lume 尚未实现 label + agentId 的联合解析，请直接传 sessionKey。"
      };
    }
    const resolved = resolveSessionByLabel(label);
    if (!resolved) {
      return { ok: false, error: `No session found with label: ${label}` };
    }
    return { ok: true, sessionId: resolved };
  }
  return { ok: true, sessionId: input.currentSessionId };
}

function pickModelIdForChannel(channelId: string | undefined, requestedModelId?: string): string | null {
  if (!channelId) return requestedModelId?.trim() || null;
  const channel = listChannels().find((item) => item.id === channelId);
  if (!channel) return requestedModelId?.trim() || null;
  return resolveRequestedModelIdForChannel(channel, requestedModelId) ?? null;
}

function extractLatestModelFromSession(sessionId: string): string | undefined {
  const messages = getAgentSessionMessages(sessionId);
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
  ownerSessionId: string;
  runId: string;
}) {
  const matched = params.runRegistry.get(params.runId);
  if (!matched) {
    return {
      ok: false as const,
      error: `runId not found: ${params.runId}`
    };
  }
  const owned = matched.parentSessionId === params.ownerSessionId || matched.rootSessionId === params.ownerSessionId;
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
  childSessionId: string;
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
      deleteAgentSession(params.childSessionId);
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
  const currentMeta = getAgentSessionMeta(input.currentSessionId);
  const normalizedAgentId = input.spawnAgentId.trim();

  if (!normalizedAgentId || normalizedAgentId === "lume") {
    return {
      ok: true,
      resolvedAgentId: normalizedAgentId || undefined,
      channelId: currentMeta?.channelId ?? input.fallbackChannelId,
      modelHint: input.requestedModel || extractLatestModelFromSession(input.currentSessionId)
    };
  }

  const targetMeta = getAgentSessionMeta(normalizedAgentId);
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
      || extractLatestModelFromSession(targetMeta.id)
      || extractLatestModelFromSession(input.currentSessionId)
  };
}

function collectTextFromEvent(event: AgentEvent): string {
  if (event.type === "text_delta" || event.type === "text_complete") {
    return event.text;
  }
  return "";
}

async function executeAgentTurn(params: {
  sessionId: string;
  userMessage: string;
  workspaceId?: string;
  channelId?: string;
  modelId?: string;
  permissionMode?: AgentSendInput["permissionMode"];
  timeoutSeconds?: number;
  sessionType?: AgentSendInput["sessionType"];
  chatType?: AgentSendInput["chatType"];
  messageMetadata?: Record<string, unknown>;
  approvalSessionId?: string;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  parentSessionId?: string;
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
    sessionId: params.sessionId,
    userMessage: params.userMessage,
    workspaceId: params.workspaceId,
    channelId: params.channelId,
    modelId: params.modelId,
    permissionMode: params.permissionMode,
    sessionType: params.sessionType,
    chatType: params.chatType,
    messageMetadata: params.messageMetadata
  };
  let lastToolName = "";
  let toolUseCount = 0;
  const startedAt = Date.now();
  let progressInterval: ReturnType<typeof setInterval> | undefined;

  if (params.parentSessionId && params.runId) {
    const bus = getSessionEventBus();
    progressInterval = setInterval(() => {
      bus.emit(params.parentSessionId!, {
        type: 'task_progress',
        toolUseId: params.runId!,
        elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
        taskId: params.runId!,
        description: params.taskDescription,
        lastToolName,
        usage: { toolUses: toolUseCount, durationMs: Date.now() - startedAt }
      });
    }, 3000);
  }

  const execution = runPiAgentMessage(input, {
    onEvent(event) {
      if (event.type === 'tool_start') {
        lastToolName = event.toolName;
        toolUseCount++;
      }
      const text = collectTextFromEvent(event);
      if (text) {
        collectedChunks.push(text);
      }
      if (event.type === "usage_update" || event.type === "complete") {
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
        void stopPiAgent(params.sessionId);
        return;
      }
      const approvalSessionId = params.approvalSessionId?.trim();
      if (approvalSessionId && approvalSessionId !== request.sessionId) {
        setAskUserQuestionApprovalSession(request.toolUseId, approvalSessionId);
        params.emitAskUserQuestion({
          ...request,
          sessionId: approvalSessionId,
          originSessionId: request.sessionId,
          ...(params.runId ? { subagentRunId: params.runId } : {})
        });
        return;
      }
      params.emitAskUserQuestion(request);
    },
    onToolPermissionRequest(request) {
      if (!params.emitToolPermissionRequest) {
        runtimeError = `目标会话工具需要用户确认，但当前未配置交互回调，已中止: ${request.toolName}`;
        void stopPiAgent(params.sessionId);
        return;
      }
      const approvalSessionId = params.approvalSessionId?.trim();
      if (approvalSessionId && approvalSessionId !== request.sessionId) {
        setToolPermissionApprovalSession(request.requestId, approvalSessionId);
        params.emitToolPermissionRequest({
          ...request,
          sessionId: approvalSessionId,
          originSessionId: request.sessionId,
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
      return { status: "errored", error: errorMsg || "子会话执行异常", runText, usageEvents };
    }
    return { status: result.status, runText, usageEvents };
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stopPiAgent(params.sessionId);
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
      return { status: "errored", error: errorMsg || "子会话执行异常", runText, usageEvents };
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

export function createSessionTools(input: CreateOpenClawAlignedToolsInput): AgentTool[] {
  return [
    {
      name: "agents_list",
      label: "agents_list",
      description: "List agent ids you can target with sessions_spawn.",
      parameters: Type.Object({}),
      async execute() {
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("agents_list")) {
          return buildSubagentBlockedResult("agents_list");
        }
        const sessionAgents = listAgentSessions()
          .slice(0, 50)
          .map((session) => ({
            id: session.id,
            name: session.title,
            configured: Boolean(session.channelId),
            channelId: session.channelId
          }));

        return toTextResult({
          requester: "lume",
          allowAny: false,
          agents: [{ id: "lume", name: "Lume Agent", configured: true }, ...sessionAgents]
        });
      }
    },
    {
      name: "sessions_list",
      label: "sessions_list",
      description: "List sessions with optional filters and recent messages.",
      parameters: Type.Object({
        kinds: Type.Optional(Type.Array(Type.String())),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
        activeMinutes: Type.Optional(Type.Number({ minimum: 1 })),
        messageLimit: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("sessions_list")) {
          return buildSubagentBlockedResult("sessions_list");
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

        let sessions = listAgentSessions();
        if (activeMinutes > 0) {
          const minUpdatedAt = Date.now() - activeMinutes * 60 * 1000;
          sessions = sessions.filter((session) => session.updatedAt >= minUpdatedAt);
        }
        if (kinds.length > 0 && !kinds.includes("main")) {
          sessions = [];
        }
        sessions = sessions.slice(0, limit);

        const rows = sessions.map((session) => {
          const allMessages = getAgentSessionMessages(session.id);
          const lastAssistant = [...allMessages].reverse().find((message) => message.role === "assistant");
          const withMessages = messageLimit > 0
            ? mapMessagesForTool(allMessages.slice(Math.max(0, allMessages.length - messageLimit)))
            : undefined;
          return {
            key: session.id,
            kind: "main",
            label: session.title,
            updatedAt: session.updatedAt,
            channelId: session.channelId,
            workspaceId: session.workspaceId,
            model: lastAssistant?.model,
            ...(withMessages ? { messages: withMessages } : {})
          };
        });

        return toTextResult({
          count: rows.length,
          sessions: rows
        });
      }
    },
    {
      name: "sessions_history",
      label: "sessions_history",
      description: "Fetch message history for a session.",
      parameters: Type.Object({
        sessionKey: Type.Optional(Type.String({ minLength: 1 })),
        label: Type.Optional(Type.String()),
        agentId: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
        includeTools: Type.Optional(Type.Boolean())
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("sessions_history")) {
          return buildSubagentBlockedResult("sessions_history");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const hasSessionKey = typeof params.sessionKey === "string" && params.sessionKey.trim().length > 0;
        const hasLabel = typeof params.label === "string" && params.label.trim().length > 0;
        if (!hasSessionKey && !hasLabel) {
          return toTextResult({
            status: "error",
            error: "Either sessionKey or label is required"
          });
        }
        const resolvedTarget = resolveSessionTarget({
          currentSessionId: input.sessionId,
          sessionKey: params.sessionKey,
          label: params.label,
          agentId: params.agentId
        });
        if (!resolvedTarget.ok) {
          return toTextResult({
            status: "error",
            error: resolvedTarget.error
          });
        }
        const sessionId = resolvedTarget.sessionId;
        const limit = clampInt(params.limit, 1, 500, 100);
        const includeTools = params.includeTools === true;
        const meta = getAgentSessionMeta(sessionId);
        if (!meta) {
          return toTextResult({
            status: "not_found",
            error: `Session not found: ${sessionId}`
          });
        }
        let messages = getAgentSessionMessages(sessionId);
        if (!includeTools) {
          messages = messages.filter((message) => message.role === "user" || message.role === "assistant");
        }
        messages = messages.slice(Math.max(0, messages.length - limit));
        return toTextResult({
          status: "ok",
          sessionKey: sessionId,
          count: messages.length,
          messages: mapMessagesForTool(messages)
        });
      }
    },
    {
      name: "session_status",
      label: "session_status",
      description: "Show current session status and summary.",
      parameters: Type.Object({
        sessionKey: Type.Optional(Type.String()),
        model: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("session_status")) {
          return buildSubagentBlockedResult("session_status");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const resolvedTarget = resolveSessionTarget({
          currentSessionId: input.sessionId,
          sessionKey: params.sessionKey
        });
        if (!resolvedTarget.ok) {
          return toTextResult({
            status: "error",
            error: resolvedTarget.error
          });
        }
        const sessionId = resolvedTarget.sessionId;
        const meta = getAgentSessionMeta(sessionId);
        if (!meta) {
          return toTextResult({
            status: "not_found",
            error: `Session not found: ${sessionId}`
          });
        }
        const messages = getAgentSessionMessages(sessionId);
        const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
        return toTextResult({
          status: "ok",
          sessionKey: sessionId,
          title: meta.title,
          messageCount: messages.length,
          updatedAt: meta.updatedAt,
          channelId: meta.channelId ?? input.channelId,
          workspaceId: meta.workspaceId ?? input.workspaceId,
          currentModel: lastAssistant?.model ?? null,
          requestedModel: typeof params.model === "string" ? params.model.trim() || null : null
        });
      }
    },
    {
      name: "sessions_send",
      label: "sessions_send",
      description: "Send a message into another session.",
      parameters: Type.Object({
        sessionKey: Type.Optional(Type.String()),
        label: Type.Optional(Type.String()),
        agentId: Type.Optional(Type.String()),
        message: Type.String({ minLength: 1 }),
        timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 }))
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("sessions_send")) {
          return buildSubagentBlockedResult("sessions_send");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const hasSessionKey = typeof params.sessionKey === "string" && params.sessionKey.trim().length > 0;
        const hasLabel = typeof params.label === "string" && params.label.trim().length > 0;
        if (!hasSessionKey && !hasLabel) {
          return toTextResult({
            status: "error",
            runId: randomUUID(),
            error: "Either sessionKey or label is required"
          });
        }
        const resolvedTarget = resolveSessionTarget({
          currentSessionId: input.sessionId,
          sessionKey: params.sessionKey,
          label: params.label,
          agentId: params.agentId
        });
        if (!resolvedTarget.ok) {
          return toTextResult({
            status: "error",
            runId: randomUUID(),
            error: resolvedTarget.error
          });
        }
        const sessionId = resolvedTarget.sessionId;
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!message) {
          return toTextResult({ status: "error", error: "message 不能为空" });
        }
        const meta = getAgentSessionMeta(sessionId);
        if (!meta) {
          return toTextResult({ status: "not_found", error: `Session not found: ${sessionId}` });
        }
        const resolvedChannelId = meta.channelId ?? input.channelId;
        if (!resolvedChannelId) {
          return toTextResult({
            status: "error",
            error: `目标会话缺少 channelId，无法执行: ${sessionId}`
          });
        }
        try {
          decryptApiKey(resolvedChannelId);
        } catch (error) {
          return toTextResult({
            status: "error",
            error: `目标会话渠道不可用: ${error instanceof Error ? error.message : String(error)}`
          });
        }
        const timeoutSeconds = clampInt(params.timeoutSeconds, 0, 600, 60);
        const requestedModel = extractLatestModelFromSession(sessionId);
        const resolvedModelId = pickModelIdForChannel(resolvedChannelId, requestedModel);
        if (!resolvedModelId) {
          return toTextResult({
            status: "error",
            error: `目标会话缺少可用模型: ${sessionId}`
          });
        }

        const runResult = await executeAgentTurn({
          sessionId,
          userMessage: message,
          workspaceId: meta.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          permissionMode: input.permissionMode,
          approvalSessionId: input.sessionId,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
          timeoutSeconds,
          sessionType: input.sessionType,
          chatType: input.chatType
        });
        updateAgentSessionMeta(sessionId, {});
        return toTextResult({
          status: runResult.status,
          runId: randomUUID(),
          sessionKey: sessionId,
          model: resolvedModelId,
          usageEvents: runResult.usageEvents,
          output: runResult.runText,
          ...(runResult.error ? { error: runResult.error } : {})
        });
      }
    },
    {
      name: "sessions_delete",
      label: "sessions_delete",
      description: "Delete an existing session and its persisted data.",
      parameters: Type.Object({
        sessionKey: Type.Optional(Type.String()),
        sessionKeys: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        label: Type.Optional(Type.String()),
        labels: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        agentId: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("sessions_delete")) {
          return buildSubagentBlockedResult("sessions_delete");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const singleSessionKey = typeof params.sessionKey === "string" ? params.sessionKey.trim() : "";
        const hasSessionKey = singleSessionKey.length > 0;
        const sessionKeys = Array.isArray(params.sessionKeys)
          ? params.sessionKeys
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
        const hasBatchSessionKeys = sessionKeys.length > 0;
        const hasBatchLabels = labels.length > 0;
        if (!hasSessionKey && !hasLabel && !hasBatchSessionKeys && !hasBatchLabels) {
          return toTextResult({
            status: "error",
            error: "Either sessionKey/label or sessionKeys/labels is required"
          });
        }

        const resolvedSessionIds: string[] = [];
        const seen = new Set<string>();
        const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";

        const appendSessionId = (sessionId: string): void => {
          if (seen.has(sessionId)) return;
          seen.add(sessionId);
          resolvedSessionIds.push(sessionId);
        };

        if (hasSessionKey) {
          appendSessionId(pickSessionId(singleSessionKey, input.sessionId));
        }
        for (const item of sessionKeys) {
          appendSessionId(pickSessionId(item, input.sessionId));
        }

        const allLabels: string[] = [];
        if (hasLabel) allLabels.push(singleLabel);
        allLabels.push(...labels);
        for (const targetLabel of allLabels) {
          if (agentId) {
            return toTextResult({
              status: "error",
              error: "当前 Lume 尚未实现 label + agentId 的联合解析，请直接传 sessionKey。"
            });
          }
          const matchedIds = resolveSessionIdsByLabel(targetLabel);
          if (matchedIds.length === 0) {
            return toTextResult({
              status: "error",
              error: `No session found with label: ${targetLabel}`
            });
          }
          for (const matchedId of matchedIds) {
            appendSessionId(matchedId);
          }
        }
        if (resolvedSessionIds.length === 0) {
          return toTextResult({
            status: "error",
            error: "未解析到可删除的会话"
          });
        }
        if (resolvedSessionIds.includes(input.sessionId)) {
          return toTextResult({
            status: "error",
            error: "不能删除当前会话"
          });
        }

        const metas = resolvedSessionIds.map((sessionId) => ({
          sessionId,
          meta: getAgentSessionMeta(sessionId)
        }));
        const missing = metas.find((item) => !item.meta);
        if (missing) {
          return toTextResult({
            status: "not_found",
            error: `Session not found: ${missing.sessionId}`
          });
        }

        const deletedSessionKeys: string[] = [];
        const deletedTitles: string[] = [];
        try {
          for (const item of metas) {
            deleteAgentSession(item.sessionId);
            deletedSessionKeys.push(item.sessionId);
            deletedTitles.push(item.meta?.title ?? "");
          }
        } catch (error) {
          return toTextResult({
            status: "error",
            error: `删除会话失败: ${error instanceof Error ? error.message : String(error)}`,
            deletedCount: deletedSessionKeys.length,
            sessionKeys: deletedSessionKeys
          });
        }
        if (deletedSessionKeys.length === 1) {
          return toTextResult({
            status: "ok",
            deleted: true,
            sessionKey: deletedSessionKeys[0],
            title: deletedTitles[0]
          });
        }
        return toTextResult({
          status: "ok",
          deleted: true,
          deletedCount: deletedSessionKeys.length,
          sessionKeys: deletedSessionKeys,
          titles: deletedTitles
        });
      }
    },
    {
      name: "sessions_spawn",
      label: "sessions_spawn",
      description: "Spawn an isolated sub-session for a task.",
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
        deliverySessionKey: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        if (!isSubagentTeamV2Enabled()) {
          return buildSubagentFeatureDisabledResult("sessions_spawn");
        }
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("sessions_spawn")) {
          return buildSubagentBlockedResult("sessions_spawn");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const task = typeof params.task === "string" ? params.task.trim() : "";
        if (!task) {
          return toTextResult({ status: "error", error: "task 不能为空" });
        }
        const cleanup =
          params.cleanup === "delete" || params.cleanup === "keep"
            ? params.cleanup
            : "keep";
        const sandbox = params.sandbox === "require" ? "require" : "inherit";
        const threadRequested = params.thread === true;
        const deliverySessionKeyRaw = typeof params.deliverySessionKey === "string"
          ? params.deliverySessionKey.trim()
          : "";
        const requestedDeliverySessionId = deliverySessionKeyRaw
          ? pickSessionId(deliverySessionKeyRaw, input.sessionId)
          : undefined;
        if (requestedDeliverySessionId && !getAgentSessionMeta(requestedDeliverySessionId)) {
          return toTextResult({
            status: "error",
            error: `deliverySessionKey 不存在: ${requestedDeliverySessionId}`
          });
        }
        const policyDecision = resolveSubagentSpawnPolicy({
          parentSessionId: input.sessionId,
          parentPermissionMode: input.permissionMode,
          requestedSandbox: sandbox
        });
        if (!policyDecision.ok) {
          return toTextResult({
            status: "forbidden",
            error: policyDecision.error
          });
        }
        const currentMeta = getAgentSessionMeta(input.sessionId);
        const label = typeof params.label === "string" ? params.label.trim() : "";
        const modelOverride = typeof params.model === "string" ? params.model.trim() : "";
        const spawnAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
        const route = resolveSpawnRoute({
          spawnAgentId,
          currentSessionId: input.sessionId,
          fallbackChannelId: currentMeta?.channelId ?? input.channelId,
          requestedModel: modelOverride
        });
        if (!route.ok) {
          return toTextResult({
            status: "error",
            error: route.error
          });
        }
        const created = createAgentSession(
          label || "子会话",
          route.channelId ?? currentMeta?.channelId ?? input.channelId,
          currentMeta?.workspaceId ?? input.workspaceId,
          input.sessionId
        );
        const requestedModel = route.modelHint || extractLatestModelFromSession(input.sessionId);
        const thinking = typeof params.thinking === "string" ? params.thinking.trim() : "";
        const resolvedChannelId = created.channelId;
        const resolvedModelId = pickModelIdForChannel(resolvedChannelId, requestedModel);
        if (!resolvedChannelId || !resolvedModelId) {
          return toTextResult({
            status: "error",
            error: "子会话缺少 channel/model，无法执行",
            childSessionKey: created.id
          });
        }
        const runRegistry = getSubagentRunRegistry();
        const runId = randomUUID();
        const threadBinding = resolveSubagentThreadBinding({
          parentSessionId: input.sessionId,
          childSessionId: created.id,
          threadRequested,
          requestedDeliverySessionId
        });
        runRegistry.create({
          runId,
          parentSessionId: input.sessionId,
          parentRunId: policyDecision.parentRunId,
          rootSessionId: policyDecision.rootSessionId,
          depth: policyDecision.depth,
          childSessionId: created.id,
          deliverySessionId: threadBinding.deliverySessionId,
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
          const bus = getSessionEventBus();
          bus.emit(input.sessionId, {
            type: 'task_started',
            taskId: runId,
            toolUseId: _toolCallId,
            description: task,
            agentName: label || 'Subagent'
          });
          runRegistry.update(runId, {
            status: "running",
            startedAt: Date.now()
          });
          const runResult = await executeAgentTurn({
            sessionId: created.id,
            userMessage: task,
            workspaceId: created.workspaceId,
            channelId: resolvedChannelId,
            modelId: resolvedModelId,
            permissionMode: policyDecision.childPermissionMode,
            approvalSessionId: input.sessionId,
            emitAskUserQuestion: input.emitAskUserQuestion,
            emitToolPermissionRequest: input.emitToolPermissionRequest,
            timeoutSeconds: waitSeconds,
            sessionType: "subagent",
            chatType: input.chatType,
            messageMetadata: {
              spawnedBy: input.sessionId,
              spawnDepth: policyDecision.depth
            },
            parentSessionId: input.sessionId,
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
          bus.emit(input.sessionId, {
            type: 'task_notification',
            taskId: runId,
            toolUseId: _toolCallId,
            status: runResult.status === 'completed' ? 'completed' : 'failed',
            summary: truncateText(runResult.runText, 200),
            usage: { toolUses: runResult.usageEvents, durationMs: Date.now() - (runRegistry.get(runId)?.startedAt ?? Date.now()) }
          });
          if (cleanup === "delete") {
            try {
              deleteAgentSession(created.id);
            } catch {
              // ignore cleanup failure to keep tool result stable
            }
          }
          return toTextResult({
            status: runResult.status,
            childSessionKey: created.id,
            runId,
            model: resolvedModelId,
            output: runResult.runText,
            cleanup,
            ...(spawnAgentId ? { requestedAgentId: spawnAgentId } : {}),
            ...(route.resolvedAgentId ? { resolvedAgentId: route.resolvedAgentId } : {}),
            ...(thinking ? { requestedThinking: thinking } : {}),
            spawnDepth: policyDecision.depth,
            rootSessionKey: policyDecision.rootSessionId,
            deliverySessionKey: threadBinding.deliverySessionId,
            thread: threadBinding.threadRequested,
            threadBound: threadBinding.threadBound,
            ...(runResult.error ? { error: runResult.error } : {})
          });
        }

        runRegistry.update(runId, {
          status: "running",
          startedAt: Date.now()
        });
        const bus = getSessionEventBus();
        bus.emit(input.sessionId, {
          type: 'task_started',
          taskId: runId,
          toolUseId: _toolCallId,
          description: task,
          agentName: label || 'Subagent'
        });
        void executeAgentTurn({
          sessionId: created.id,
          userMessage: task,
          workspaceId: created.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          permissionMode: policyDecision.childPermissionMode,
          approvalSessionId: input.sessionId,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
          timeoutSeconds: 0,
          sessionType: "subagent",
          chatType: input.chatType,
          messageMetadata: {
            spawnedBy: input.sessionId,
            spawnDepth: policyDecision.depth
          },
          parentSessionId: input.sessionId,
          runId,
          taskDescription: task
        }).then(async (runResult) => {
          await finalizeSubagentRun({
            runRegistry,
            runId,
            cleanup,
            childSessionId: created.id,
            result: runResult
          });
          bus.emit(input.sessionId, {
            type: 'task_notification',
            taskId: runId,
            toolUseId: _toolCallId,
            status: runResult.status === 'completed' ? 'completed' : 'failed',
            summary: truncateText(runResult.runText, 200),
            usage: {
              toolUses: runResult.usageEvents,
              durationMs: Date.now() - (runRegistry.get(runId)?.startedAt ?? Date.now())
            }
          });
        }).catch((error) => {
          void finalizeSubagentRun({
            runRegistry,
            runId,
            cleanup,
            childSessionId: created.id,
            result: {
              status: "errored",
              error: error instanceof Error ? error.message : String(error),
              runText: "",
              usageEvents: 0
            }
          });
        });
        return toTextResult({
          status: "accepted",
          childSessionKey: created.id,
          runId,
          model: resolvedModelId,
          cleanup,
          ...(spawnAgentId ? { requestedAgentId: spawnAgentId } : {}),
          ...(route.resolvedAgentId ? { resolvedAgentId: route.resolvedAgentId } : {}),
          ...(thinking ? { requestedThinking: thinking } : {}),
          spawnDepth: policyDecision.depth,
          rootSessionKey: policyDecision.rootSessionId,
          deliverySessionKey: threadBinding.deliverySessionId,
          thread: threadBinding.threadRequested,
          threadBound: threadBinding.threadBound,
          sandbox,
          note: "已启动后台子会话执行（runTimeoutSeconds=0 为异步模式）"
        });
      }
    },
    {
      name: "subagents_list",
      label: "subagents_list",
      description: "List spawned subagent runs controlled by current session.",
      parameters: Type.Object({
        sessionKey: Type.Optional(Type.String()),
        status: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
        runId: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        if (!isSubagentTeamV2Enabled()) {
          return buildSubagentFeatureDisabledResult("subagents_list");
        }
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("subagents_list")) {
          return buildSubagentBlockedResult("subagents_list");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const ownerSessionId = pickSessionId(params.sessionKey, input.sessionId);
        const statusFilter = typeof params.status === "string" ? params.status.trim() : "";
        const runIdFilter = typeof params.runId === "string" ? params.runId.trim() : "";
        const limit = clampInt(params.limit, 1, 200, 50);
        const runRegistry = getSubagentRunRegistry();

        if (runIdFilter) {
          const resolved = resolveOwnedSubagentRun({
            runRegistry,
            ownerSessionId,
            runId: runIdFilter
          });
          if (!resolved.ok) {
            return toTextResult({
              status: resolved.error.startsWith("runId not found") ? "not_found" : "forbidden",
              error: resolved.error
            });
          }
          return toTextResult({
            status: "ok",
            count: 1,
            runs: [resolved.run]
          });
        }

        let runs = runRegistry.listControlledBySession(ownerSessionId);
        if (statusFilter) {
          runs = runs.filter((run) => run.status === statusFilter);
        }
        const sliced = runs.slice(Math.max(0, runs.length - limit));
        return toTextResult({
          status: "ok",
          count: sliced.length,
          runs: sliced
        });
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
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("subagents_kill")) {
          return buildSubagentBlockedResult("subagents_kill");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const runId = typeof params.runId === "string" ? params.runId.trim() : "";
        if (!runId) {
          return toTextResult({
            status: "error",
            error: "runId 不能为空"
          });
        }
        const runRegistry = getSubagentRunRegistry();
        const resolved = resolveOwnedSubagentRun({
          runRegistry,
          ownerSessionId: input.sessionId,
          runId
        });
        if (!resolved.ok) {
          return toTextResult({
            status: resolved.error.startsWith("runId not found") ? "not_found" : "forbidden",
            error: resolved.error
          });
        }
        const matched = resolved.run;
        const cascade = params.cascade !== false;
        const descendants = cascade ? runRegistry.listDescendants(runId) : [];
        const targets = [matched, ...descendants];
        const runningTargets = targets.filter((run) => !isTerminalSubagentStatus(run.status));
        if (runningTargets.length === 0) {
          return toTextResult({
            status: "ok",
            killed: false,
            runId,
            reason: `run 已结束: ${matched.status}`,
            cascade
          });
        }
        for (const target of runningTargets) {
          void stopPiAgent(target.childSessionId);
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
              deleteAgentSession(target.childSessionId);
            } catch {
              // keep result deterministic
            }
          }
        }
        return toTextResult({
          status: "ok",
          killed: true,
          runId,
          killedCount: runningTargets.length,
          cascade,
          childSessionKey: matched.childSessionId,
          killedRunIds: runningTargets.map((item) => item.runId)
        });
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
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("subagents_send")) {
          return buildSubagentBlockedResult("subagents_send");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const runId = typeof params.runId === "string" ? params.runId.trim() : "";
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!runId || !message) {
          return toTextResult({
            status: "error",
            error: !runId ? "runId 不能为空" : "message 不能为空"
          });
        }
        const runRegistry = getSubagentRunRegistry();
        const resolved = resolveOwnedSubagentRun({
          runRegistry,
          ownerSessionId: input.sessionId,
          runId
        });
        if (!resolved.ok) {
          return toTextResult({
            status: resolved.error.startsWith("runId not found") ? "not_found" : "forbidden",
            error: resolved.error
          });
        }
        const matched = resolved.run;
        const childMeta = getAgentSessionMeta(matched.childSessionId);
        if (!childMeta) {
          return toTextResult({
            status: "not_found",
            error: `child session not found: ${matched.childSessionId}`
          });
        }
        const resolvedChannelId = matched.channelId ?? childMeta.channelId ?? input.channelId;
        const requestedModel = matched.modelId || extractLatestModelFromSession(matched.childSessionId);
        const resolvedModelId = pickModelIdForChannel(resolvedChannelId, requestedModel);
        if (!resolvedChannelId || !resolvedModelId) {
          return toTextResult({
            status: "error",
            error: "目标子会话缺少 channel/model，无法执行"
          });
        }
        runRegistry.update(matched.runId, {
          status: "running",
          startedAt: Date.now()
        });
        const timeoutSeconds = clampInt(params.timeoutSeconds, 0, 600, 60);
        const runResult = await executeAgentTurn({
          sessionId: matched.childSessionId,
          userMessage: message,
          workspaceId: childMeta.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          permissionMode: input.permissionMode,
          approvalSessionId: input.sessionId,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
          timeoutSeconds,
          sessionType: "subagent",
          chatType: input.chatType,
          messageMetadata: {
            spawnedBy: matched.parentSessionId,
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
        return toTextResult({
          status: runResult.status,
          runId: matched.runId,
          childSessionKey: matched.childSessionId,
          model: resolvedModelId,
          output: runResult.runText,
          ...(runResult.error ? { error: runResult.error } : {})
        });
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
        if (isSubagentSessionId(input.sessionId) && SUBAGENT_BLOCKED_TOOL_NAMES.has("subagents_steer")) {
          return buildSubagentBlockedResult("subagents_steer");
        }
        const params = (args ?? {}) as Record<string, unknown>;
        const runId = typeof params.runId === "string" ? params.runId.trim() : "";
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!runId || !message) {
          return toTextResult({
            status: "error",
            error: !runId ? "runId 不能为空" : "message 不能为空"
          });
        }
        const runRegistry = getSubagentRunRegistry();
        const resolved = resolveOwnedSubagentRun({
          runRegistry,
          ownerSessionId: input.sessionId,
          runId
        });
        if (!resolved.ok) {
          return toTextResult({
            status: resolved.error.startsWith("runId not found") ? "not_found" : "forbidden",
            error: resolved.error
          });
        }
        const matched = resolved.run;
        const childMeta = getAgentSessionMeta(matched.childSessionId);
        if (!childMeta) {
          return toTextResult({
            status: "not_found",
            error: `child session not found: ${matched.childSessionId}`
          });
        }
        if (!isTerminalSubagentStatus(matched.status)) {
          void stopPiAgent(matched.childSessionId);
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
        const requestedModel = matched.modelId || extractLatestModelFromSession(matched.childSessionId);
        const resolvedModelId = pickModelIdForChannel(resolvedChannelId, requestedModel);
        if (!resolvedChannelId || !resolvedModelId) {
          return toTextResult({
            status: "error",
            error: "目标子会话缺少 channel/model，无法执行"
          });
        }
        const nextRunId = randomUUID();
        runRegistry.create({
          runId: nextRunId,
          parentSessionId: input.sessionId,
          parentRunId: matched.parentRunId,
          rootSessionId: matched.rootSessionId || input.sessionId,
          depth: matched.depth,
          childSessionId: matched.childSessionId,
          deliverySessionId: matched.deliverySessionId,
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
            sessionId: matched.childSessionId,
            userMessage: message,
            workspaceId: childMeta.workspaceId,
            channelId: resolvedChannelId,
            modelId: resolvedModelId,
            permissionMode: input.permissionMode,
            approvalSessionId: input.sessionId,
            emitAskUserQuestion: input.emitAskUserQuestion,
            emitToolPermissionRequest: input.emitToolPermissionRequest,
            timeoutSeconds: waitSeconds,
            sessionType: "subagent",
            chatType: input.chatType,
            messageMetadata: {
              spawnedBy: matched.parentSessionId,
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
          return toTextResult({
            status: runResult.status,
            runId: nextRunId,
            replacedRunId: matched.runId,
            childSessionKey: matched.childSessionId,
            model: resolvedModelId,
            output: runResult.runText,
            ...(runResult.error ? { error: runResult.error } : {})
          });
        }

        void executeAgentTurn({
          sessionId: matched.childSessionId,
          userMessage: message,
          workspaceId: childMeta.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          permissionMode: input.permissionMode,
          approvalSessionId: input.sessionId,
          emitAskUserQuestion: input.emitAskUserQuestion,
          emitToolPermissionRequest: input.emitToolPermissionRequest,
          timeoutSeconds: 0,
          sessionType: "subagent",
          chatType: input.chatType,
          messageMetadata: {
            spawnedBy: matched.parentSessionId,
            controlCommand: "steer",
            steeredFromRunId: matched.runId
          }
        }).then(async (runResult) => {
          await finalizeSubagentRun({
            runRegistry,
            runId: nextRunId,
            cleanup: matched.cleanup,
            childSessionId: matched.childSessionId,
            result: runResult
          });
        }).catch((error) => {
          void finalizeSubagentRun({
            runRegistry,
            runId: nextRunId,
            cleanup: matched.cleanup,
            childSessionId: matched.childSessionId,
            result: {
              status: "errored",
              error: error instanceof Error ? error.message : String(error),
              runText: "",
              usageEvents: 0
            }
          });
        });
        return toTextResult({
          status: "accepted",
          runId: nextRunId,
          replacedRunId: matched.runId,
          childSessionKey: matched.childSessionId,
          model: resolvedModelId,
          note: "已提交 steer 指令，子会话将在后台继续执行"
        });
      }
    }
  ];
}

export const createOpenClawAlignedTools = createSessionTools;


