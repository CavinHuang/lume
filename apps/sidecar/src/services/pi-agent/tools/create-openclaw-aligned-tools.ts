import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { AgentSendInput, AgentEvent } from "@lume/shared";
import {
  appendAgentMessage,
  createAgentSession,
  deleteAgentSession,
  getAgentSessionMessages,
  getAgentSessionMeta,
  listAgentSessions,
  updateAgentSessionMeta
} from "../../agent-session-manager";
import type { AgentMessage } from "@lume/shared";
import { decryptApiKey, listChannels } from "../../channel-manager";
import { resolveRequestedModelIdForChannel } from "../../model-selection";
import { runPiAgentMessage } from "../run-pi-agent-message";
import { stopPiAgent } from "../runner/run";

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_WEB_FETCH_MAX_CHARS = 12_000;
const DEFAULT_WEB_SEARCH_COUNT = 5;
const MAX_WEB_SEARCH_COUNT = 10;
const MAX_WEB_FETCH_CHARS = 40_000;

interface CreateOpenClawAlignedToolsInput {
  sessionId: string;
  workspaceId?: string;
  channelId?: string;
}

interface ResolveSessionTargetInput {
  currentSessionId: string;
  sessionKey?: unknown;
  label?: unknown;
  agentId?: unknown;
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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "Lume-Agent/1.0 (+web_tools)"
      }
    });
  } finally {
    clearTimeout(timer);
  }
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
  timeoutSeconds?: number;
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
    modelId: params.modelId
  };
  const userMessageRecord: AgentMessage = {
    id: randomUUID(),
    role: "user",
    content: params.userMessage,
    createdAt: Date.now()
  };
  appendAgentMessage(params.sessionId, userMessageRecord);

  const execution = runPiAgentMessage(input, {
    onEvent(event) {
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
    onAskUserQuestion() {
      runtimeError = "目标会话在自动执行中触发 AskUserQuestion，已中止";
      void stopPiAgent(params.sessionId);
    },
    onToolPermissionRequest(request) {
      runtimeError = `目标会话工具需要用户确认，自动执行已中止: ${request.toolName}`;
      void stopPiAgent(params.sessionId);
    }
  });

  if (timeoutMs <= 0) {
    const result = await execution;
    const runText = truncateText(collectedChunks.join(""), 8_000);
    if (runtimeError) {
      return { status: "errored", error: runtimeError, runText, usageEvents };
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
    if (runtimeError) {
      return { status: "errored", error: runtimeError, runText, usageEvents };
    }
    return { status: result.status, runText, usageEvents };
  } finally {
    clearTimeout(timer);
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
        return toTextResult({
          requester: "lume",
          allowAny: false,
          agents: [{ id: "lume", name: "Lume Agent", configured: true }]
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
        sessionKey: Type.String({ minLength: 1 }),
        limit: Type.Optional(Type.Number({ minimum: 1 })),
        includeTools: Type.Optional(Type.Boolean())
      }),
      async execute(_toolCallId, args) {
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
          timeoutSeconds
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
        cleanup: Type.Optional(Type.Union([Type.Literal("delete"), Type.Literal("keep")]))
      }),
      async execute(_toolCallId, args) {
        const params = (args ?? {}) as Record<string, unknown>;
        const task = typeof params.task === "string" ? params.task.trim() : "";
        if (!task) {
          return toTextResult({ status: "error", error: "task 不能为空" });
        }
        const cleanup =
          params.cleanup === "delete" || params.cleanup === "keep"
            ? params.cleanup
            : "keep";
        const currentMeta = getAgentSessionMeta(input.sessionId);
        const label = typeof params.label === "string" ? params.label.trim() : "";
        const created = createAgentSession(
          label || "子会话",
          currentMeta?.channelId ?? input.channelId,
          currentMeta?.workspaceId ?? input.workspaceId
        );
        const modelOverride = typeof params.model === "string" ? params.model.trim() : "";
        const requestedModel = modelOverride || extractLatestModelFromSession(input.sessionId);
        const spawnAgentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
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

        const waitSeconds = clampInt(
          params.runTimeoutSeconds ?? params.timeoutSeconds,
          0,
          600,
          0
        );
        if (waitSeconds > 0) {
          const runResult = await executeAgentTurn({
            sessionId: created.id,
            userMessage: task,
            workspaceId: created.workspaceId,
            channelId: resolvedChannelId,
            modelId: resolvedModelId,
            timeoutSeconds: waitSeconds
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
            runId: randomUUID(),
            model: resolvedModelId,
            output: runResult.runText,
            cleanup,
            ...(spawnAgentId ? { requestedAgentId: spawnAgentId } : {}),
            ...(thinking ? { requestedThinking: thinking } : {}),
            ...(spawnAgentId ? { warning: "当前实现暂未启用多 agent 路由，agentId 仅记录不生效" } : {}),
            ...(runResult.error ? { error: runResult.error } : {})
          });
        }

        void executeAgentTurn({
          sessionId: created.id,
          userMessage: task,
          workspaceId: created.workspaceId,
          channelId: resolvedChannelId,
          modelId: resolvedModelId,
          timeoutSeconds: 0
        });
        return toTextResult({
          status: "accepted",
          childSessionKey: created.id,
          runId: randomUUID(),
          model: resolvedModelId,
          cleanup,
          ...(spawnAgentId ? { requestedAgentId: spawnAgentId } : {}),
          ...(thinking ? { requestedThinking: thinking } : {}),
          ...(spawnAgentId ? { warning: "当前实现暂未启用多 agent 路由，agentId 仅记录不生效" } : {}),
          note: "已启动后台子会话执行（runTimeoutSeconds=0 为异步模式）"
        });
      }
    },
    {
      name: "web_search",
      label: "web_search",
      description: "Search the web and return top results.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1 }),
        count: Type.Optional(Type.Number({ minimum: 1, maximum: MAX_WEB_SEARCH_COUNT })),
        country: Type.Optional(Type.String()),
        search_lang: Type.Optional(Type.String()),
        ui_lang: Type.Optional(Type.String()),
        freshness: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, args) {
        const params = (args ?? {}) as Record<string, unknown>;
        const query = typeof params.query === "string" ? params.query.trim() : "";
        if (!query) {
          return toTextResult({ error: "query 不能为空", results: [] });
        }
        const count = clampInt(params.count, 1, MAX_WEB_SEARCH_COUNT, DEFAULT_WEB_SEARCH_COUNT);
        const endpoint = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1`;
        try {
          const response = await fetchWithTimeout(endpoint, DEFAULT_TIMEOUT_MS);
          if (!response.ok) {
            return toTextResult({
              error: `web_search 请求失败: ${response.status}`,
              provider: "duckduckgo",
              results: []
            });
          }
          const payload = (await response.json()) as {
            AbstractText?: string;
            AbstractURL?: string;
            Heading?: string;
            RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
          };
          const rows: Array<{ title: string; url: string; snippet: string }> = [];
          if (payload.AbstractText && payload.AbstractURL) {
            rows.push({
              title: payload.Heading?.trim() || "Abstract",
              url: payload.AbstractURL,
              snippet: payload.AbstractText
            });
          }
          for (const item of payload.RelatedTopics ?? []) {
            if (rows.length >= count) break;
            if (item.Text && item.FirstURL) {
              rows.push({ title: item.Text.split(" - ")[0] ?? item.Text, url: item.FirstURL, snippet: item.Text });
              continue;
            }
            for (const sub of item.Topics ?? []) {
              if (rows.length >= count) break;
              if (!sub.Text || !sub.FirstURL) continue;
              rows.push({ title: sub.Text.split(" - ")[0] ?? sub.Text, url: sub.FirstURL, snippet: sub.Text });
            }
          }
          return toTextResult({
            provider: "duckduckgo",
            query,
            count: rows.length,
            results: rows.slice(0, count)
          });
        } catch (error) {
          return toTextResult({
            error: error instanceof Error ? error.message : String(error),
            provider: "duckduckgo",
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
