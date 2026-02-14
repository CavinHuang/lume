/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts
 * Adaptation:
 * - Use Claude Agent SDK query() in sidecar runtime for full tool/MCP/Skill parity.
 * - Keep sidecar event emitter contract (no Electron webContents dependency).
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  AgentEvent,
  AgentAskUserQuestionQuestion,
  AgentAskUserQuestionRequest,
  AgentAskUserQuestionResponseInput,
  AgentGenerateTitleInput,
  AgentMessage
} from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import { fetchTitle, getAdapter } from "../providers";
import { decryptApiKey, listChannels } from "./channel-manager";
import {
  appendAgentMessage,
  getAgentSessionMeta,
  getAgentSessionMessages,
  updateAgentSessionMeta
} from "./agent-session-manager";
import {
  appendAgentEvents,
  buildAssistantAgentMessage,
  createAgentStreamAccumulatorState
} from "./agent-stream-accumulator";
import {
  convertAgentSdkMessage,
  createAgentStreamConverterState,
  type SDKMessage
} from "./agent-stream-converter";
import {
  ensurePluginManifest,
  getAgentWorkspace,
  getWorkspaceMcpConfig
} from "./agent-workspace-manager";
import { createLogger } from "./logger";
import {
  getAgentSessionWorkspacePath,
  getAgentWorkspacePath
} from "./config-paths";
import { buildDynamicContext, buildSystemPromptAppend } from "./agent-prompt-builder";
import {
  applyMemoryToolPolicy,
  deriveChatTypeFromSessionKey,
  normalizeMemoryChatType,
  type MemoryCitationsMode,
  resolveMemoryRuntimeConfig,
  shouldIncludeCitations
} from "./memory-policy";
import {
  getWorkspaceMemoryFile,
  getWorkspaceMemoryStatus,
  saveWorkspaceMemory,
  searchWorkspaceMemory
} from "./memory-service";
import {
  getSessionStateManager,
  startSessionHeartbeat,
  stopSessionHeartbeat,
} from "./session-state-manager";

type AgentEventEmitter = {
  onEvent: (event: AgentEvent) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onTitleUpdated: (title: string) => void;
  onAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
};

const activeControllers = new Map<string, AbortController>();
const pendingAskUserQuestionResolvers = new Map<
  string,
  {
    sessionId: string;
    resolve: (answers: Record<string, string> | null) => void;
  }
>();

const AGENT_TITLE_PROMPT =
  "根据用户的第一条消息，生成一个简短的会话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：";
const MAX_TITLE_LENGTH = 20;
const DEFAULT_AGENT_TITLE = "新 Agent 会话";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";
const MAX_CONTEXT_MESSAGES = 20;
const RESUME_RETRY_ERROR_PREFIX = "__LUME_RESUME_RETRY__:";
const EXIT_PLAN_TOOL_NAME = "ExitPlanMode";
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const MEMORY_SEARCH_TOOL_NAME = "memory_search";
const MEMORY_GET_TOOL_NAME = "memory_get";
const MEMORY_SAVE_TOOL_NAME = "memory_save";

// 创建日志器
const log = createLogger("agent-service");

type ClaudeSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

function formatCitation(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}#L${startLine}` : `${path}#L${startLine}-L${endLine}`;
}

function decorateMemorySearchResults(params: {
  includeCitations: boolean;
  results: Awaited<ReturnType<typeof searchWorkspaceMemory>>;
}): Awaited<ReturnType<typeof searchWorkspaceMemory>> {
  if (!params.includeCitations) {
    return params.results.map((entry) => ({ ...entry, citation: undefined }));
  }
  return params.results.map((entry) => {
    const citation = entry.citation ?? formatCitation(entry.path, entry.startLine, entry.endLine);
    const hasSourceLine = /\n\nSource:\s+/i.test(entry.snippet);
    const snippet = hasSourceLine ? entry.snippet : `${entry.snippet.trim()}\n\nSource: ${citation}`;
    return { ...entry, citation, snippet };
  });
}

function normalizeAskUserQuestions(input: Record<string, unknown>): AgentAskUserQuestionQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const normalized: AgentAskUserQuestionQuestion[] = [];
  for (const item of rawQuestions) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const header = typeof record.header === "string" ? record.header.trim() : "";
    const question = typeof record.question === "string" ? record.question.trim() : "";
    const multiSelect = record.multiSelect === true;
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options = rawOptions
      .filter((option): option is { label: string; description: string } => {
        if (!option || typeof option !== "object") return false;
        const value = option as Record<string, unknown>;
        return typeof value.label === "string" && typeof value.description === "string";
      })
      .map((option) => ({
        label: option.label.trim(),
        description: option.description.trim()
      }))
      .filter((option) => option.label.length > 0);
    if (!header || !question || options.length < 2) continue;
    normalized.push({
      header,
      question,
      options,
      multiSelect
    });
  }
  return normalized;
}

function toReadableString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function sanitizeAskUserQuestionInput(input: Record<string, unknown>): Record<string, unknown> {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const questions = rawQuestions.slice(0, 4).map((item, questionIndex) => {
    const questionRecord = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const rawOptions = Array.isArray(questionRecord.options) ? questionRecord.options : [];
    const options = rawOptions.slice(0, 4).map((option, optionIndex) => {
      const optionRecord = option && typeof option === "object" ? (option as Record<string, unknown>) : {};
      const rawLabel =
        toReadableString(optionRecord.label) ||
        toReadableString(optionRecord.text) ||
        toReadableString(optionRecord.title) ||
        toReadableString(optionRecord.name) ||
        toReadableString(optionRecord.value);
      const rawDescription =
        toReadableString(optionRecord.description) ||
        toReadableString(optionRecord.desc) ||
        toReadableString(optionRecord.detail) ||
        toReadableString(optionRecord.reason);
      const fallbackLabel = rawLabel || rawDescription || `选项${optionIndex + 1}`;
      const fallbackDescription = rawDescription || fallbackLabel;
      return {
        label: fallbackLabel,
        description: fallbackDescription
      };
    });

    while (options.length < 2) {
      const index = options.length + 1;
      options.push({
        label: `选项${index}`,
        description: `候选项${index}`
      });
    }

    const header = toReadableString(questionRecord.header) || `问题${questionIndex + 1}`;
    const question = toReadableString(questionRecord.question) || `${header}？`;
    const multiSelect = questionRecord.multiSelect === true;
    return {
      header: header.slice(0, 12),
      question,
      options,
      multiSelect
    };
  });

  return {
    ...input,
    questions
  };
}

function waitForAskUserQuestionAnswers(
  sessionId: string,
  toolUseId: string,
  questions: AgentAskUserQuestionQuestion[],
  signal: AbortSignal,
  emit: AgentEventEmitter
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const done = (answers: Record<string, string> | null): void => {
      pendingAskUserQuestionResolvers.delete(toolUseId);
      signal.removeEventListener("abort", onAbort);
      resolve(answers);
    };

    const onAbort = (): void => {
      done(null);
    };

    pendingAskUserQuestionResolvers.set(toolUseId, {
      sessionId,
      resolve: done
    });
    signal.addEventListener("abort", onAbort, { once: true });

    emit.onAskUserQuestion({
      sessionId,
      toolUseId,
      questions
    });
  });
}

export function submitAskUserQuestionAnswers(input: AgentAskUserQuestionResponseInput): { ok: true } {
  const pending = pendingAskUserQuestionResolvers.get(input.toolUseId);
  if (!pending) {
    throw new Error("未找到待确认的 AskUserQuestion 请求");
  }
  if (pending.sessionId !== input.sessionId) {
    throw new Error("AskUserQuestion 会话不匹配");
  }
  if (input.canceled) {
    pending.resolve(null);
    return { ok: true };
  }
  pending.resolve(input.answers ?? {});
  return { ok: true };
}

function extractPlanText(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  if (Array.isArray(value)) {
    const lines = value
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .filter((item) => item && item !== "null")
      .join("\n")
      .trim();
    return lines || null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidateKeys = ["plan", "content", "markdown", "text"];
    for (const key of candidateKeys) {
      const candidate = extractPlanText(record[key]);
      if (candidate) return candidate;
    }
    try {
      const serialized = JSON.stringify(record, null, 2).trim();
      return serialized || null;
    } catch {
      return null;
    }
  }
  return null;
}

function persistExitPlan(agentCwd: string, planText: string): void {
  const plansDir = join(agentCwd, "plans");
  const planPath = join(plansDir, "plan.md");
  mkdirSync(plansDir, { recursive: true });
  writeFileSync(planPath, planText.endsWith("\n") ? planText : `${planText}\n`, "utf-8");
  log.info("已保存计划文件", { planPath });
}

function isResumeSessionNotFoundError(message: string): boolean {
  return /No conversation found with session ID/i.test(message);
}

function pickModelId(channelId: string | undefined, requestedModelId?: string): string {
  if (requestedModelId) return requestedModelId;
  if (!channelId) return DEFAULT_MODEL_ID;
  const channel = listChannels().find((item) => item.id === channelId);
  const enabledModel = channel?.models.find((model) => model.enabled);
  if (enabledModel) return enabledModel.id;
  return channel?.models[0]?.id ?? DEFAULT_MODEL_ID;
}

function resolveSdkCliPath(): string {
  let cliPath: string | null = null;

  try {
    const cjsRequire = createRequire(import.meta.url);
    const sdkEntryPath = cjsRequire.resolve("@anthropic-ai/claude-agent-sdk");
    cliPath = join(dirname(sdkEntryPath), "cli.js");
  } catch (error) {
    log.warn("createRequire 解析 SDK 路径失败", { error: String(error) });
  }

  if (!cliPath) {
    cliPath = join(
      process.cwd(),
      "node_modules",
      "@anthropic-ai",
      "claude-agent-sdk",
      "cli.js"
    );
  }

  return cliPath;
}

function getBunExecutablePath(): string {
  const fromEnv = process.env.LUME_BUN_BIN?.trim();
  if (fromEnv) return fromEnv;
  return "bun";
}

function buildContextPrompt(sessionId: string, currentUserMessage: string): string {
  const allMessages = getAgentSessionMessages(sessionId);
  if (allMessages.length === 0) return currentUserMessage;

  const history = allMessages.slice(0, -1);
  if (history.length === 0) return currentUserMessage;

  const recent = history.slice(-MAX_CONTEXT_MESSAGES);
  const lines = recent
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content)
    .map((message) => `[${message.role}]: ${message.content}`);

  if (lines.length === 0) return currentUserMessage;

  return `<conversation_history>\n${lines.join("\n")}\n</conversation_history>\n\n${currentUserMessage}`;
}

function buildMemoryMcpServer(
  workspaceSlug: string,
  sdk: ClaudeSdkModule,
  options: {
    enabledTools: Set<string>;
    includeCitations: boolean;
    citationsMode: MemoryCitationsMode;
  }
): McpServerConfig {
  const asText = (payload: unknown): string => JSON.stringify(payload, null, 2);
  const memorySearchSchema = z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(20).optional(),
    minScore: z.number().min(0).max(1).optional()
  });
  const memoryGetSchema = z.object({
    path: z.string().min(1),
    from: z.number().int().min(1).optional(),
    lines: z.number().int().min(1).max(2000).optional()
  });
  const memorySaveSchema = z.object({
    content: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  });

  return sdk.createSdkMcpServer({
    name: "lume-memory",
    tools: [
      ...(options.enabledTools.has(MEMORY_SEARCH_TOOL_NAME)
        ? [{
        name: MEMORY_SEARCH_TOOL_NAME,
        description:
          "Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.",
        inputSchema: memorySearchSchema.shape,
        handler: async (rawArgs: unknown) => {
          try {
            const { query, maxResults, minScore } = memorySearchSchema.parse(rawArgs);
            const [results, status] = await Promise.all([
              searchWorkspaceMemory({ workspaceSlug, query, maxResults, minScore }),
              Promise.resolve(getWorkspaceMemoryStatus(workspaceSlug))
            ]);
            const decorated = decorateMemorySearchResults({
              includeCitations: options.includeCitations,
              results
            });
            const payload = {
              results: decorated,
              provider: status.provider,
              model: status.model,
              fallback: status.fallback,
              citations: options.citationsMode
            };
            return { content: [{ type: "text", text: asText(payload) }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: asText({ results: [], disabled: true, error: message }) }],
              isError: true
            };
          }
        }
      }]
        : []),
      ...(options.enabledTools.has(MEMORY_GET_TOOL_NAME)
        ? [{
        name: MEMORY_GET_TOOL_NAME,
        description:
          "Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.",
        inputSchema: memoryGetSchema.shape,
        handler: async (rawArgs: unknown) => {
          try {
            const { path, from, lines } = memoryGetSchema.parse(rawArgs);
            const result = getWorkspaceMemoryFile({ workspaceSlug, path, from, lines });
            return { content: [{ type: "text", text: asText(result) }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const fallbackPath =
              rawArgs && typeof rawArgs === "object" && typeof (rawArgs as { path?: unknown }).path === "string"
                ? (rawArgs as { path: string }).path
                : "";
            return {
              content: [{ type: "text", text: asText({ path: fallbackPath, text: "", disabled: true, error: message }) }],
              isError: true
            };
          }
        }
      }]
        : []),
      ...(options.enabledTools.has(MEMORY_SAVE_TOOL_NAME)
        ? [{
        name: MEMORY_SAVE_TOOL_NAME,
        description: "将新记忆写入 memory/YYYY-MM-DD.md 并立即索引。",
        inputSchema: memorySaveSchema.shape,
        handler: async (rawArgs: unknown) => {
          try {
            const { content, date } = memorySaveSchema.parse(rawArgs);
            const result = await saveWorkspaceMemory({ workspaceSlug, content, date });
            return { content: [{ type: "text", text: asText(result) }] };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: asText({ disabled: true, error: message }) }],
              isError: true
            };
          }
        }
      }]
        : [])
    ]
  });
}

function buildMcpServers(
  workspaceSlug: string | undefined,
  sdk: ClaudeSdkModule,
  options: {
    enabledMemoryTools: Set<string>;
    includeCitations: boolean;
    citationsMode: MemoryCitationsMode;
  }
): Record<string, McpServerConfig> {
  if (!workspaceSlug) return {};

  const mcpServers: Record<string, McpServerConfig> = {};
  if (options.enabledMemoryTools.size > 0) {
    mcpServers["lume-memory"] = buildMemoryMcpServer(workspaceSlug, sdk, {
      enabledTools: options.enabledMemoryTools,
      includeCitations: options.includeCitations,
      citationsMode: options.citationsMode
    });
  }
  const mcpConfig = getWorkspaceMcpConfig(workspaceSlug);

  for (const [name, entry] of Object.entries(mcpConfig.servers ?? {})) {
    if (!entry.enabled) continue;

    if (entry.type === "stdio" && entry.command) {
      const mergedEnv: Record<string, string> = {
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
        ...(entry.env ?? {})
      };

      mcpServers[name] = {
        type: "stdio",
        command: entry.command,
        ...(entry.args && entry.args.length > 0 ? { args: entry.args } : {}),
        ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {})
      };
      continue;
    }

    if ((entry.type === "http" || entry.type === "sse") && entry.url) {
      mcpServers[name] = {
        type: entry.type,
        url: entry.url,
        ...(entry.headers && Object.keys(entry.headers).length > 0 ? { headers: entry.headers } : {})
      };
    }
  }

  return mcpServers;
}

export async function sendAgentMessage(
  input: AgentSendInput,
  emit: AgentEventEmitter,
  options: { appendUserMessage?: boolean; allowResumeRetry?: boolean } = {}
): Promise<void> {
  const { sessionId, userMessage, workspaceId } = input;
  const permissionMode = input.permissionMode ?? "bypassPermissions";
  const sessionMeta = getAgentSessionMeta(sessionId);
  const resolvedChannelId = input.channelId ?? sessionMeta?.channelId;
  const resolvedModelId = pickModelId(resolvedChannelId, input.modelId);

  const shouldAppendUserMessage = options.appendUserMessage ?? true;
  const allowResumeRetry = options.allowResumeRetry ?? true;
  if (shouldAppendUserMessage) {
    const userMessageRecord: AgentMessage = {
      id: randomUUID(),
      role: "user",
      content: userMessage,
      createdAt: Date.now()
    };
    appendAgentMessage(sessionId, userMessageRecord);
  }

  const controller = new AbortController();
  activeControllers.set(sessionId, controller);

  const accumulator = createAgentStreamAccumulatorState();

  let agentCwd = homedir();
  let workspaceSlug: string | undefined;
  let workspaceName: string | undefined;

  if (workspaceId) {
    const workspace = getAgentWorkspace(workspaceId);
    if (workspace) {
      workspaceSlug = workspace.slug;
      workspaceName = workspace.name;
      agentCwd = getAgentSessionWorkspacePath(workspace.slug, sessionId);
      ensurePluginManifest(workspace.slug, workspace.name);
    }
  }

  const runtimeConfig = resolveMemoryRuntimeConfig();
  const chatType = normalizeMemoryChatType(input.chatType) ?? deriveChatTypeFromSessionKey(sessionId);
  const includeCitations = shouldIncludeCitations(runtimeConfig.citationsMode, chatType);
  const enabledMemoryToolNames = applyMemoryToolPolicy({
    baseTools: [MEMORY_SEARCH_TOOL_NAME, MEMORY_GET_TOOL_NAME, MEMORY_SAVE_TOOL_NAME],
    policy: runtimeConfig.toolPolicy
  });
  const enabledMemoryTools = new Set(enabledMemoryToolNames);

  // 初始化会话状态（用于 Memory Flush 和 Heartbeat）
  const sessionStateManager = getSessionStateManager();
  sessionStateManager.getOrCreate(sessionId, workspaceSlug);

  // 启动 Heartbeat 定时器（如果工作区有 HEARTBEAT.md）
  if (workspaceSlug) {
    startSessionHeartbeat(sessionId, workspaceSlug, async () => {
      // Heartbeat 回调：可以在这里执行定期检查任务
      // 目前仅记录状态，实际任务由 HEARTBEAT.md 定义
      log.info("Heartbeat 检查完成", { sessionId: sessionId.slice(0, 8), workspaceSlug });
    });
  }

  const channel = resolvedChannelId ? listChannels().find((item) => item.id === resolvedChannelId) : undefined;
  if (!channel || !resolvedChannelId) {
    activeControllers.delete(sessionId);
    emit.onError("未找到可用的 Anthropic 渠道，Claude SDK 模式需要 channelId");
    return;
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(resolvedChannelId);
  } catch {
    activeControllers.delete(sessionId);
    emit.onError("解密 API Key 失败");
    return;
  }

  const converterState = createAgentStreamConverterState();
  const stderrChunks: string[] = [];
  let resolvedModel = resolvedModelId;
  let streamCompleted = false;
  const pendingExitPlans = new Map<string, string>();
  let existingSdkSessionId = sessionMeta?.sdkSessionId;
  if (existingSdkSessionId) {
    try {
      const contents = readdirSync(agentCwd);
      if (contents.length === 0) {
        log.warn("会话目录为空，但保留 sdkSessionId", { sessionId: sessionId.slice(0, 8) });
      }
    } catch {
      // 目录探测失败不影响主流程
    }
  }
  updateAgentSessionMeta(sessionId, {
    channelId: resolvedChannelId
  });

  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const cliPath = resolveSdkCliPath();
    if (!existsSync(cliPath)) {
      emit.onError(`SDK CLI 文件不存在: ${cliPath}`);
      return;
    }

    const bunPath = getBunExecutablePath();
    log.info("启动 SDK 查询", {
      sessionId: sessionId.slice(0, 8),
      model: resolvedModelId,
      permission: permissionMode,
      resume: existingSdkSessionId ? "yes" : "no"
    });
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const mcpServers = buildMcpServers(workspaceSlug, sdk, {
      enabledMemoryTools,
      includeCitations,
      citationsMode: runtimeConfig.citationsMode
    });
    const dynamicContext = buildDynamicContext({
      workspaceName,
      workspaceSlug,
      agentCwd
    });
    const contextualMessage = [dynamicContext, userMessage]
      .filter((part) => part.trim().length > 0)
      .join("\n\n");

    const isCompactCommand = userMessage.trim() === "/compact";
    const prompt = isCompactCommand
      ? "/compact"
      : existingSdkSessionId
        ? contextualMessage
        : buildContextPrompt(sessionId, contextualMessage);

    const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";
    const sdkEnv: Record<string, string | undefined> = {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey
    };
    if (channel.baseUrl && channel.baseUrl !== DEFAULT_ANTHROPIC_URL) {
      sdkEnv.ANTHROPIC_BASE_URL = channel.baseUrl;
    } else {
      delete sdkEnv.ANTHROPIC_BASE_URL;
    }

    const queryIterator = sdk.query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: cliPath,
        executable: bunPath as "bun",
        executableArgs: [`--env-file=${nullDevice}`],
        model: resolvedModelId,
        maxTurns: 30,
        // SDK 0.2.37 默认会传入空的 --setting-sources，导致后续参数被错误解析。
        // 显式设置有效值，避免 "Invalid setting source: --permission-mode"。
        settingSources: ["user", "project", "local"],
        extraArgs: {
          settings: JSON.stringify({
            plansDirectory: "./plans"
          })
        },
        permissionMode,
        ...(permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        canUseTool: async (toolName, toolInput, permissionOptions) => {
          if (toolName === EXIT_PLAN_TOOL_NAME) {
            return { behavior: "allow", updatedInput: {} };
          }
          if (toolName === ASK_USER_QUESTION_TOOL_NAME) {
            const sanitizedInput = sanitizeAskUserQuestionInput(toolInput);
            const questions = normalizeAskUserQuestions(sanitizedInput);
            if (questions.length === 0) {
              return {
                behavior: "deny",
                message: "AskUserQuestion 缺少有效问题，已拒绝执行"
              };
            }
            const answers = await waitForAskUserQuestionAnswers(
              sessionId,
              permissionOptions.toolUseID,
              questions,
              permissionOptions.signal,
              emit
            );
            if (!answers) {
              return {
                behavior: "deny",
                message: "用户取消了 AskUserQuestion"
              };
            }
            return {
              behavior: "allow",
              updatedInput: {
                ...sanitizedInput,
                answers
              }
            };
          }
          if (
            (toolName === MEMORY_SEARCH_TOOL_NAME ||
              toolName === MEMORY_GET_TOOL_NAME ||
              toolName === MEMORY_SAVE_TOOL_NAME) &&
            !enabledMemoryTools.has(toolName.toLowerCase())
          ) {
            return {
              behavior: "deny",
              message: `工具策略已禁用 ${toolName}`
            };
          }
          // Sidecar 当前无交互式权限确认 UI；保持非阻塞执行。
          return { behavior: "allow", updatedInput: {} };
        },
        includePartialMessages: true,
        cwd: agentCwd,
        abortController: controller,
        env: sdkEnv,
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: buildSystemPromptAppend({
            workspaceName,
            workspaceSlug,
            sessionId,
            availableTools: enabledMemoryToolNames,
            memoryCitationsMode: runtimeConfig.citationsMode
          })
        },
        ...(existingSdkSessionId ? { resume: existingSdkSessionId } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(workspaceSlug
          ? { plugins: [{ type: "local" as const, path: getAgentWorkspacePath(workspaceSlug) }] }
          : {}),
        stderr: (data: string) => {
          stderrChunks.push(data);
          log.debug("SDK stderr", { sessionId: sessionId.slice(0, 8), stderr: data.slice(0, 200) });
        }
      }
    });

    for await (const sdkMessage of queryIterator) {
      if (controller.signal.aborted) {
        break;
      }

      const message = sdkMessage as SDKMessage & {
        session_id?: string;
        subtype?: string;
        model?: string;
        skills?: string[];
        tools?: string[];
      };

      if (message.type === "system" && message.subtype === "init" && typeof message.model === "string") {
        resolvedModel = message.model;
      }

      if (typeof message.session_id === "string" && message.session_id) {
        if (message.session_id !== existingSdkSessionId) {
          updateAgentSessionMeta(sessionId, { sdkSessionId: message.session_id });
          existingSdkSessionId = message.session_id;
        }
      }

      const events = convertAgentSdkMessage(message, converterState);
      for (const event of events) {
        if (event.type === "tool_start" && event.toolName === EXIT_PLAN_TOOL_NAME) {
          const planText = extractPlanText(event.input);
          if (planText) {
            pendingExitPlans.set(event.toolUseId, planText);
          }
          continue;
        }

        if (event.type === "tool_result") {
          const pendingPlan = pendingExitPlans.get(event.toolUseId);
          const isExitPlanResult = event.toolName === EXIT_PLAN_TOOL_NAME || pendingPlan !== undefined;
          if (isExitPlanResult) {
            if (!event.isError) {
              const planText = pendingPlan ?? extractPlanText(event.result);
              if (planText) {
                persistExitPlan(agentCwd, planText);
              }
            }
            pendingExitPlans.delete(event.toolUseId);
          }
        }

        // 处理 usage_update 事件：更新 token 使用量并检查 Memory Flush
        if (event.type === "usage_update") {
          sessionStateManager.updateTokens(
            sessionId,
            event.usage.inputTokens,
            event.usage.contextWindow
          );

          // 检查是否需要触发 Memory Flush
          const flushCheck = sessionStateManager.checkMemoryFlush(sessionId);
          if (flushCheck.executed && flushCheck.prompt) {
            log.info("Memory Flush 触发条件满足", {
              sessionId: sessionId.slice(0, 8),
              reason: flushCheck.reason,
            });
            // 注意：这里只记录日志，实际的 Memory Flush 由 Agent 自动处理
            // 因为 SDK 会自动压缩，我们只需要确保 Agent 知道要写记忆
          }
        }

        // 处理 compacting 事件：增加压缩计数
        if (event.type === "compacting") {
          sessionStateManager.incrementCompaction(sessionId);
          log.info("会话开始压缩", { sessionId: sessionId.slice(0, 8) });
        }

        // 处理 compact_complete 事件：可以在这里执行压缩后的清理
        if (event.type === "compact_complete") {
          log.info("会话压缩完成", { sessionId: sessionId.slice(0, 8) });
        }
      }

      const resumeNotFound = events.find((event): event is Extract<AgentEvent, { type: "error" }> =>
        event.type === "error" && isResumeSessionNotFoundError(event.message)
      );
      if (resumeNotFound && existingSdkSessionId && !accumulator.text && allowResumeRetry) {
        throw new Error(`${RESUME_RETRY_ERROR_PREFIX}${resumeNotFound.message}`);
      }
      if (events.some((event) => event.type === "complete")) {
        streamCompleted = true;
      }
      appendAgentEvents(accumulator, events);
      for (const event of events) {
        emit.onEvent(event);
      }
    }

    const assistant = buildAssistantAgentMessage(accumulator, resolvedModel);
    if (assistant) {
      appendAgentMessage(sessionId, assistant);
    }

    updateAgentSessionMeta(sessionId, {});
    emit.onComplete();

    // 与 Proma 对齐：流结束后异步生成标题，不阻塞主流程。
    void autoGenerateAgentTitle(sessionId, userMessage, resolvedChannelId, resolvedModelId, emit);
  } catch (error) {
    if (controller.signal.aborted) {
      const assistant = buildAssistantAgentMessage(accumulator, resolvedModel);
      if (assistant) {
        appendAgentMessage(sessionId, assistant);
      }

      updateAgentSessionMeta(sessionId, {});
      emit.onComplete();
      return;
    }

    // Claude Agent SDK 在部分版本会在 result 后额外抛出 Q.trim 相关异常。
    // 若已经收到 complete 事件，按成功流程收尾，避免错误覆盖已完成响应。
    if (streamCompleted) {
      const assistant = buildAssistantAgentMessage(accumulator, resolvedModel);
      if (assistant) {
        appendAgentMessage(sessionId, assistant);
      }

      updateAgentSessionMeta(sessionId, {});
      emit.onComplete();
      // 兼容 SDK 在 complete 后抛出异常的场景，仍然触发自动标题更新。
      void autoGenerateAgentTitle(sessionId, userMessage, resolvedChannelId, resolvedModelId, emit);
      return;
    }

    const errorMessage = error instanceof Error ? error.message : "未知错误";
    if (errorMessage.startsWith(RESUME_RETRY_ERROR_PREFIX) && existingSdkSessionId && allowResumeRetry) {
      try {
        updateAgentSessionMeta(sessionId, { sdkSessionId: undefined });
      } catch {
        // 清理失败不影响重试
      }
      return sendAgentMessage(input, emit, {
        appendUserMessage: false,
        allowResumeRetry: false
      });
    }

    if (existingSdkSessionId) {
      try {
        updateAgentSessionMeta(sessionId, { sdkSessionId: undefined });
      } catch {
        // 清理失败不影响错误上报
      }
    }

    const stderrOutput = stderrChunks.join("").trim();
    const detailedError = stderrOutput
      ? `${errorMessage}\n\nstderr: ${stderrOutput.slice(0, 500)}`
      : errorMessage;

    emit.onError(detailedError);
  } finally {
    for (const [toolUseId, pending] of pendingAskUserQuestionResolvers) {
      if (pending.sessionId === sessionId) {
        pending.resolve(null);
        pendingAskUserQuestionResolvers.delete(toolUseId);
      }
    }
    activeControllers.delete(sessionId);

    // 清理会话状态（可选：保留状态用于后续查询）
    // sessionStateManager.delete(sessionId);

    // 注意：不在这里停止 Heartbeat，因为 Heartbeat 应该持续运行
    // 即使当前会话结束，Heartbeat 也应该定期检查
  }
}

export function stopAgent(sessionId: string): void {
  const controller = activeControllers.get(sessionId);
  if (!controller) return;
  controller.abort();
  activeControllers.delete(sessionId);
}

export function stopAllAgents(): void {
  for (const [sessionId, controller] of activeControllers) {
    controller.abort();
    activeControllers.delete(sessionId);
  }

  // 停止所有 Heartbeat 定时器
  const { getHeartbeatService } = require("./heartbeat-service");
  const heartbeatService = getHeartbeatService();
  heartbeatService.stopAllTimers();
}

export async function generateAgentTitle(input: AgentGenerateTitleInput): Promise<string | null> {
  const channel = listChannels().find((item) => item.id === input.channelId);
  if (!channel) return null;

  let apiKey: string;
  try {
    apiKey = decryptApiKey(input.channelId);
  } catch {
    return null;
  }

  try {
    const adapter = getAdapter(channel.provider);
    const request = adapter.buildTitleRequest({
      baseUrl: channel.baseUrl,
      apiKey,
      modelId: input.modelId,
      prompt: AGENT_TITLE_PROMPT + input.userMessage
    });
    const title = await fetchTitle(request, adapter);
    if (!title) return null;
    const cleaned = title.trim().replace(/^["']+|["']+$/g, "").trim();
    return cleaned.slice(0, MAX_TITLE_LENGTH) || null;
  } catch {
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
  } catch {
    // 标题生成失败不影响主流程
  }
}
