import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentEvent,
  AgentToolPermissionRequest
} from "@lume/shared";
import { getSessionEventBus } from "../session-event-bus";
import {
  createAgentSession,
  deleteAgentSession,
  getAgentSessionMessages,
  getAgentSessionMeta,
  listAgentSessions,
  updateAgentSessionMeta
} from "../../agent/agent-session-manager";
import type { AgentMessage } from "@lume/shared";
import { decryptApiKey, listChannels } from "../../channel-manager";
import { resolveRequestedModelIdForChannel } from "../../model-selection";
import { runPiAgentMessage } from "../run-pi-agent-message";
import { stopPiAgent } from "../runner/run";
import { getSubagentRunRegistry } from "../subagents/subagent-run-registry";
import { announceSubagentCompletion } from "../subagents/subagent-announce-service";
import { resolveSubagentSpawnPolicy } from "../subagents/subagent-policy";
import { resolveSubagentThreadBinding } from "../subagents/subagent-thread-binding";
import { setAskUserQuestionApprovalSession } from "./ask-user-question-bridge";
import { setToolPermissionApprovalSession } from "./tool-permission-bridge";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_WEB_FETCH_MAX_CHARS = 12_000;
const DEFAULT_WEB_SEARCH_COUNT = 5;
const MAX_WEB_SEARCH_COUNT = 10;
const MAX_WEB_FETCH_CHARS = 40_000;
const DEFAULT_WEB_SEARCH_PROVIDER = "duckduckgo";
const WEB_SEARCH_CACHE_TTL_MS = 15 * 60 * 1000;
const WEB_SEARCH_MAX_ATTEMPTS = 2;
const WEB_SEARCH_TOTAL_TIMEOUT_MS = 40_000;
const DDG_SEARCH_ENDPOINTS = [
  "https://duckduckgo.com/html/",
  "https://html.duckduckgo.com/html/"
];

// Web Search 缓存
type WebSearchCacheEntry = { data: Record<string, unknown>; expiresAt: number };
const webSearchCache = new Map<string, WebSearchCacheEntry>();

function getWebSearchCache(key: string): Record<string, unknown> | null {
  const entry = webSearchCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    if (entry) webSearchCache.delete(key);
    return null;
  }
  return entry.data;
}

function setWebSearchCache(key: string, data: Record<string, unknown>): void {
  webSearchCache.set(key, { data, expiresAt: Date.now() + WEB_SEARCH_CACHE_TTL_MS });
}

function pickOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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

function extractSimpleTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeDdgRedirectUrl(rawUrl: string): string {
  const normalized = rawUrl.replace(/&amp;/gi, "&");
  const index = normalized.indexOf("uddg=");
  if (index < 0) return normalized;
  const encoded = normalized.slice(index + 5).split("&")[0] ?? "";
  try {
    return decodeURIComponent(encoded);
  } catch {
    return normalized;
  }
}

function parseDdgHtmlResults(
  html: string,
  query: string,
  maxResults: number
): Array<{ title: string; url: string; snippet: string }> {
  const linkRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi;

  const links: Array<{ url: string; title: string }> = [];
  const snippets: string[] = [];

  let match: RegExpExecArray | null;
  while ((match = linkRegex.exec(html)) && links.length < maxResults + 2) {
    links.push({
      url: decodeDdgRedirectUrl(match[1] ?? ""),
      title: stripHtmlTags(match[2] ?? "")
    });
  }
  while ((match = snippetRegex.exec(html)) && snippets.length < maxResults + 2) {
    snippets.push(stripHtmlTags(match[1] ?? ""));
  }

  if (links.length === 0) {
    return [{
      title: `No results found for: ${query}`,
      url: "",
      snippet: ""
    }];
  }

  return links.slice(0, maxResults).map((item, index) => ({
    title: item.title || `Result ${index + 1}`,
    url: item.url,
    snippet: snippets[index] ?? ""
  }));
}

function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (host === "0.0.0.0" || host === "127.0.0.1") return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const match172 = host.match(/^172\.(\d{1,3})\./);
  if (match172) {
    const second = Number(match172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers);
    if (!headers.has("user-agent")) {
      headers.set("user-agent", "Lume-Agent/1.0 (+web_tools)");
    }
    return await fetch(url, {
      ...(init ?? {}),
      method: init?.method ?? "GET",
      signal: controller.signal,
      headers
    });
  } finally {
    clearTimeout(timer);
  }
}

async function raceWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> {
  if (timeoutMs <= 0) {
    onTimeout?.();
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function fetchTextWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<{ response: Response; bodyText: string }> {
  const controller = new AbortController();
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "Lume-Agent/1.0 (+web_tools)");
  }
  const response = await raceWithTimeout(
    fetch(url, {
      ...(init ?? {}),
      method: init?.method ?? "GET",
      signal: controller.signal,
      headers
    }),
    timeoutMs,
    () => controller.abort()
  );
  const bodyText = await raceWithTimeout(
    response.text(),
    timeoutMs,
    () => controller.abort()
  );
  return { response, bodyText };
}

async function fetchJsonWithTimeout<TPayload>(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<{ response: Response; payload: TPayload }> {
  const controller = new AbortController();
  const headers = new Headers(init?.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "Lume-Agent/1.0 (+web_tools)");
  }
  const response = await raceWithTimeout(
    fetch(url, {
      ...(init ?? {}),
      method: init?.method ?? "GET",
      signal: controller.signal,
      headers
    }),
    timeoutMs,
    () => controller.abort()
  );
  const payload = await raceWithTimeout(
    response.json() as Promise<TPayload>,
    timeoutMs,
    () => controller.abort()
  );
  return { response, payload };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("aborted") || message.includes("abort");
}

function asWebSearchErrorDetails(
  error: unknown,
  provider: "duckduckgo" | "brave",
  query: string,
  timeoutMs: number,
  attempt: number
): {
  error: string;
  code: string;
  retryable: boolean;
  provider: "duckduckgo" | "brave";
  query: string;
  timeoutMs: number;
  attempt: number;
  results: [];
} {
  const abort = isAbortError(error);
  return {
    error: abort
      ? `web_search(${provider}) 请求超时（>${timeoutMs}ms）`
      : (error instanceof Error ? error.message : String(error)),
    code: abort ? "WEB_SEARCH_TIMEOUT" : "WEB_SEARCH_REQUEST_FAILED",
    retryable: true,
    provider,
    query,
    timeoutMs,
    attempt,
    results: []
  };
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

export function createOpenClawAlignedTools(input: CreateOpenClawAlignedToolsInput): AgentTool[] {
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
    },
    {
      name: "web_search",
      label: "web_search",
      description: `Search the web for current information. Use when you need:
- Real-time data (news, prices, events)
- Information beyond your knowledge cutoff
- Verify facts or find documentation

Providers: duckduckgo (default, free), brave/tavily (need API key)
Example: { "query": "React 19 new features", "count": 5 }`,
      parameters: Type.Object({
        query: Type.String({ minLength: 1, description: "Search keywords" }),
        provider: Type.Optional(Type.Union([Type.Literal("duckduckgo"), Type.Literal("ddg"), Type.Literal("brave"), Type.Literal("tavily")])),
        braveApiKey: Type.Optional(Type.String()),
        tavilyApiKey: Type.Optional(Type.String()),
        count: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_WEB_SEARCH_COUNT })),
        country: Type.Optional(Type.String()),
        search_lang: Type.Optional(Type.String()),
        ui_lang: Type.Optional(Type.String()),
        freshness: Type.Optional(Type.String({ description: "pd=day, pw=week, pm=month, py=year (brave only)" }))
      }),
      async execute(_toolCallId, args) {
        const params = (args ?? {}) as Record<string, unknown>;
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) {
          return toTextResult({ error: "query 不能为空", results: [] });
        }
        const providerRaw = typeof params.provider === "string" ? params.provider.trim().toLowerCase() : "";
        const provider = providerRaw === "ddg" ? "duckduckgo" : (providerRaw || DEFAULT_WEB_SEARCH_PROVIDER);
        const count = clampInt(params.count, 1, MAX_WEB_SEARCH_COUNT, DEFAULT_WEB_SEARCH_COUNT);
        const country = pickOptionalString(params.country);
        const searchLang = pickOptionalString(params.search_lang);
        const uiLang = pickOptionalString(params.ui_lang);
        const freshness = pickOptionalString(params.freshness);
        const braveApiKey = (
          typeof params.braveApiKey === "string" ? params.braveApiKey.trim() : process.env.BRAVE_SEARCH_API_KEY
        ) ?? "";
        const tavilyApiKey = (
          typeof params.tavilyApiKey === "string" ? params.tavilyApiKey.trim() : process.env.TAVILY_API_KEY
        ) ?? "";
        const startedAt = Date.now();
        const remainingBudgetMs = (): number => WEB_SEARCH_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);

        // 检查缓存
        const cacheKey = `${provider}:${query}:${count}:${country ?? ""}:${searchLang ?? ""}:${uiLang ?? ""}:${freshness ?? ""}`;
        const cached = getWebSearchCache(cacheKey);
        if (cached) {
          return toTextResult({ ...cached, cached: true });
        }

        try {
          if (provider === "duckduckgo") {
            let ddgLastError: ReturnType<typeof asWebSearchErrorDetails> | null = null;
            let ddgAttempt = 0;
            const hasFallbackProvider = Boolean(braveApiKey || tavilyApiKey);
            const reservedFallbackBudgetMs = hasFallbackProvider ? 12_000 : 0;
            for (const endpoint of DDG_SEARCH_ENDPOINTS) {
              if (remainingBudgetMs() <= reservedFallbackBudgetMs) break;

              const ddgUrl = new URL(endpoint);
              ddgUrl.searchParams.set("q", query);
              if (country) {
                ddgUrl.searchParams.set("kl", country.toLowerCase());
              }

              for (let attempt = 1; attempt <= WEB_SEARCH_MAX_ATTEMPTS; attempt += 1) {
                ddgAttempt += 1;
                try {
                  const requestTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
                  const { response, bodyText } = await fetchTextWithTimeout(ddgUrl.toString(), requestTimeoutMs, {
                    headers: {
                      "accept-language": [uiLang, searchLang, "en-US", "en;q=0.9"].filter(Boolean).join(",")
                    }
                  });
                  if (!response.ok) {
                    if (response.status >= 500 && attempt < WEB_SEARCH_MAX_ATTEMPTS) {
                      await new Promise((resolve) => setTimeout(resolve, 800));
                      continue;
                    }
                    ddgLastError = {
                      error: `web_search(duckduckgo) 请求失败: ${response.status} (${endpoint})`,
                      code: "WEB_SEARCH_HTTP_ERROR",
                      retryable: response.status >= 500,
                      provider: "duckduckgo",
                      query,
                      timeoutMs: requestTimeoutMs,
                      attempt: ddgAttempt,
                      results: []
                    };
                    break;
                  }
                  const rows = parseDdgHtmlResults(bodyText, query, count);
                  const result = {
                    provider: "duckduckgo",
                    query,
                    endpoint,
                    count: rows.filter((item) => item.url).length,
                    country,
                    search_lang: searchLang,
                    ui_lang: uiLang,
                    results: rows
                  };
                  setWebSearchCache(cacheKey, result);
                  return toTextResult(result);
                } catch (error) {
                  const timeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
                  const errorDetails = asWebSearchErrorDetails(error, "duckduckgo", query, timeoutMs, ddgAttempt);
                  ddgLastError = {
                    ...errorDetails,
                    error: `${errorDetails.error} (${endpoint})`
                  };
                  if (attempt < WEB_SEARCH_MAX_ATTEMPTS && ddgLastError.retryable) {
                    if (remainingBudgetMs() <= reservedFallbackBudgetMs) {
                      break;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 800));
                    continue;
                  }
                  break;
                }
              }
            }
            if (remainingBudgetMs() <= 0 && !hasFallbackProvider) {
              return toTextResult({
                error: `web_search 总超时（>${WEB_SEARCH_TOTAL_TIMEOUT_MS}ms）`,
                code: "WEB_SEARCH_TOTAL_TIMEOUT",
                provider: "duckduckgo",
                query,
                results: []
              });
            }
            const baseFallbackError = ddgLastError ?? {
              error: "web_search(duckduckgo) 请求失败",
              code: "WEB_SEARCH_REQUEST_FAILED",
              retryable: true,
              provider: "duckduckgo",
              query,
              timeoutMs: DEFAULT_TIMEOUT_MS,
              attempt: WEB_SEARCH_MAX_ATTEMPTS,
              results: []
            };

            if (braveApiKey) {
              const braveUrl = new URL("https://api.search.brave.com/res/v1/web/search");
              braveUrl.searchParams.set("q", query);
              braveUrl.searchParams.set("count", String(count));
              if (country) braveUrl.searchParams.set("country", country);
              if (searchLang) braveUrl.searchParams.set("search_lang", searchLang);
              if (uiLang) braveUrl.searchParams.set("ui_lang", uiLang);
              if (freshness) braveUrl.searchParams.set("freshness", freshness);

              const fallbackTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
              const { response, payload } = await fetchJsonWithTimeout<{
                web?: {
                  results?: Array<{ title?: string; url?: string; description?: string }>;
                };
              }>(braveUrl.toString(), fallbackTimeoutMs, {
                headers: {
                  Accept: "application/json",
                  "X-Subscription-Token": braveApiKey
                }
              });
              if (response.ok) {
                const rows = (payload.web?.results ?? []).slice(0, count).map((item, index) => ({
                  title: item.title?.trim() || `Result ${index + 1}`,
                  url: item.url?.trim() || "",
                  snippet: item.description?.trim() || ""
                }));
                const result = {
                  provider: "brave",
                  fallbackFrom: "duckduckgo",
                  query,
                  count: rows.length,
                  country,
                  search_lang: searchLang,
                  ui_lang: uiLang,
                  freshness,
                  results: rows
                };
                setWebSearchCache(cacheKey, result);
                return toTextResult(result);
              }
              if (!tavilyApiKey) {
                return toTextResult({
                  ...baseFallbackError,
                  fallback: {
                    provider: "brave",
                    error: `web_search(brave) 请求失败: ${response.status}`
                  }
                });
              }
            }

            if (!tavilyApiKey) {
              return toTextResult({
                ...baseFallbackError,
                fallback: {
                  provider: "none",
                  error: "可选回退 provider 缺失 API Key（BRAVE_SEARCH_API_KEY / TAVILY_API_KEY）"
                }
              });
            }

            const tavilyTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
            const { response, payload } = await fetchJsonWithTimeout<{
              results?: Array<{ title?: string; url?: string; content?: string }>;
            }>(
              "https://api.tavily.com/search",
              tavilyTimeoutMs,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  Accept: "application/json"
                },
                body: JSON.stringify({
                  api_key: tavilyApiKey,
                  query,
                  max_results: count,
                  include_answer: false
                })
              }
            );
            if (!response.ok) {
              return toTextResult({
                ...baseFallbackError,
                fallback: {
                  provider: "tavily",
                  error: `web_search(tavily) 请求失败: ${response.status}`
                }
              });
            }
            const rows = (payload.results ?? []).slice(0, count).map((item, index) => ({
              title: item.title?.trim() || `Result ${index + 1}`,
              url: item.url?.trim() || "",
              snippet: item.content?.trim() || ""
            }));
            const result = {
              provider: "tavily",
              fallbackFrom: "duckduckgo",
              query,
              count: rows.length,
              results: rows
            };
            setWebSearchCache(cacheKey, result);
            return toTextResult(result);
          }

          if (provider === "brave") {
            const braveApiKey = (
              typeof params.braveApiKey === "string" ? params.braveApiKey.trim() : process.env.BRAVE_SEARCH_API_KEY
            ) ?? "";
            if (!braveApiKey) {
              return toTextResult({
                error: "Brave provider 需要 braveApiKey 或环境变量 BRAVE_SEARCH_API_KEY",
                provider: "brave",
                query,
                results: []
              });
            }
            const braveUrl = new URL("https://api.search.brave.com/res/v1/web/search");
            braveUrl.searchParams.set("q", query);
            braveUrl.searchParams.set("count", String(count));
            if (country) braveUrl.searchParams.set("country", country);
            if (searchLang) braveUrl.searchParams.set("search_lang", searchLang);
            if (uiLang) braveUrl.searchParams.set("ui_lang", uiLang);
            if (freshness) braveUrl.searchParams.set("freshness", freshness);
            const requestTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
            const { response, payload } = await fetchJsonWithTimeout<{
              web?: {
                results?: Array<{ title?: string; url?: string; description?: string }>;
              };
            }>(braveUrl.toString(), requestTimeoutMs, {
              headers: {
                Accept: "application/json",
                "X-Subscription-Token": braveApiKey
              }
            });
            if (!response.ok) {
              return toTextResult({
                error: `web_search(brave) 请求失败: ${response.status}`,
                provider: "brave",
                query,
                results: []
              });
            }
            const rows = (payload.web?.results ?? []).slice(0, count).map((item, index) => ({
              title: item.title?.trim() || `Result ${index + 1}`,
              url: item.url?.trim() || "",
              snippet: item.description?.trim() || ""
            }));
            const result = {
              provider: "brave",
              query,
              count: rows.length,
              country,
              search_lang: searchLang,
              ui_lang: uiLang,
              freshness,
              results: rows
            };
            setWebSearchCache(cacheKey, result);
            return toTextResult(result);
          }
          if (provider === "tavily") {
            const tavilyApiKey = (
              typeof params.tavilyApiKey === "string" ? params.tavilyApiKey.trim() : process.env.TAVILY_API_KEY
            ) ?? "";
            if (!tavilyApiKey) {
              return toTextResult({
                error: "Tavily provider 需要 tavilyApiKey 或环境变量 TAVILY_API_KEY",
                provider: "tavily",
                query,
                results: []
              });
            }
            const requestTimeoutMs = Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, remainingBudgetMs()));
            const { response, payload } = await fetchJsonWithTimeout<{
              results?: Array<{ title?: string; url?: string; content?: string }>;
            }>(
              "https://api.tavily.com/search",
              requestTimeoutMs,
              {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  Accept: "application/json"
                },
                body: JSON.stringify({
                  api_key: tavilyApiKey,
                  query,
                  max_results: count,
                  include_answer: false
                })
              }
            );
            if (!response.ok) {
              return toTextResult({
                error: `web_search(tavily) 请求失败: ${response.status}`,
                provider: "tavily",
                query,
                results: []
              });
            }
            const rows = (payload.results ?? []).slice(0, count).map((item, index) => ({
              title: item.title?.trim() || `Result ${index + 1}`,
              url: item.url?.trim() || "",
              snippet: item.content?.trim() || ""
            }));
            const result = {
              provider: "tavily",
              query,
              count: rows.length,
              results: rows
            };
            setWebSearchCache(cacheKey, result);
            return toTextResult(result);
          }
          return toTextResult({
            error: `不支持的 provider: ${provider}`,
            provider,
            query,
            results: []
          });
        } catch (error) {
          return toTextResult({
            error: error instanceof Error ? error.message : String(error),
            provider,
            query,
            results: []
          });
        }
      }
    },
    {
      name: "web_fetch",
      label: "web_fetch",
      description: "Fetch a web page and return extracted text.",
      parameters: Type.Object({
        url: Type.String({ minLength: 1 }),
        extractMode: Type.Optional(Type.Union([Type.Literal("markdown"), Type.Literal("text")])),
        maxChars: Type.Optional(Type.Number({ minimum: 100 }))
      }),
      async execute(_toolCallId, args) {
        const params = (args ?? {}) as Record<string, unknown>;
        const rawUrl = typeof params.url === "string" ? params.url.trim() : "";
        if (!rawUrl) {
          return toTextResult({ error: "url 不能为空", url: rawUrl });
        }

        let parsedUrl: URL;
        try {
          parsedUrl = new URL(rawUrl);
        } catch {
          return toTextResult({ error: `无效 URL: ${rawUrl}`, url: rawUrl });
        }
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          return toTextResult({ error: "仅支持 http/https URL", url: rawUrl });
        }
        if (isBlockedHost(parsedUrl.hostname)) {
          return toTextResult({ error: "出于安全策略，拒绝访问该主机", url: rawUrl });
        }

        const maxChars = clampInt(
          params.maxChars,
          100,
          MAX_WEB_FETCH_CHARS,
          DEFAULT_WEB_FETCH_MAX_CHARS
        );
        try {
          const response = await fetchWithTimeout(parsedUrl.toString(), DEFAULT_TIMEOUT_MS);
          const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
          const bodyText = await response.text();
          const extracted = contentType.includes("text/html")
            ? extractSimpleTextFromHtml(bodyText)
            : bodyText.trim();
          return toTextResult({
            url: parsedUrl.toString(),
            status: response.status,
            contentType,
            text: truncateText(extracted, maxChars),
            truncated: extracted.length > maxChars
          });
        } catch (error) {
          return toTextResult({
            url: parsedUrl.toString(),
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }
  ];
}
