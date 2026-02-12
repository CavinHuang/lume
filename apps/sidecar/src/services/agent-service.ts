/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts
 * Adaptation:
 * - Use Claude Agent SDK query() in sidecar runtime for full tool/MCP/Skill parity.
 * - Keep sidecar event emitter contract (no Electron webContents dependency).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
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
import {
  getAgentSessionWorkspacePath,
  getAgentWorkspacePath
} from "./config-paths";
import { buildDynamicContext, buildSystemPromptAppend } from "./agent-prompt-builder";

type AgentEventEmitter = {
  onEvent: (event: AgentEvent) => void;
  onComplete: () => void;
  onError: (error: string) => void;
  onTitleUpdated: (title: string) => void;
};

const activeControllers = new Map<string, AbortController>();

const AGENT_TITLE_PROMPT =
  "根据用户的第一条消息，生成一个简短的会话标题（10字以内）。只输出标题，不要有任何其他内容、标点符号或引号。\n\n用户消息：";
const MAX_TITLE_LENGTH = 20;
const DEFAULT_AGENT_TITLE = "新 Agent 会话";
const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";
const MAX_CONTEXT_MESSAGES = 20;
const RESUME_RETRY_ERROR_PREFIX = "__LUME_RESUME_RETRY__:";

function isResumeSessionNotFoundError(message: string): boolean {
  return /No conversation found with session ID/i.test(message);
}

function pickModelId(channelId: string, requestedModelId?: string): string {
  if (requestedModelId) return requestedModelId;
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
    console.warn("[Agent 服务] createRequire 解析 SDK 路径失败:", error);
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

function buildMcpServers(workspaceSlug?: string): Record<string, McpServerConfig> {
  if (!workspaceSlug) return {};

  const mcpServers: Record<string, McpServerConfig> = {};
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
  const { sessionId, userMessage, channelId, workspaceId } = input;

  const channel = listChannels().find((item) => item.id === channelId);
  if (!channel) {
    emit.onError("渠道不存在");
    return;
  }

  let apiKey: string;
  try {
    apiKey = decryptApiKey(channelId);
  } catch {
    emit.onError("解密 API Key 失败");
    return;
  }

  const modelId = pickModelId(channelId, input.modelId);

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
  const converterState = createAgentStreamConverterState();

  const stderrChunks: string[] = [];
  let resolvedModel = modelId;
  let streamCompleted = false;

  let existingSdkSessionId = getAgentSessionMeta(sessionId)?.sdkSessionId;

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

      if (existingSdkSessionId) {
        try {
          const contents = readdirSync(agentCwd);
          if (contents.length === 0) {
            console.warn("[Agent 服务] 会话目录为空，但保留 sdkSessionId，避免每轮都回填历史上下文");
          }
        } catch {
          // 目录探测失败不影响主流程
        }
      }
    }
  }

  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const cliPath = resolveSdkCliPath();
    if (!existsSync(cliPath)) {
      emit.onError(`SDK CLI 文件不存在: ${cliPath}`);
      return;
    }

    const bunPath = getBunExecutablePath();
    console.log(
      `[Agent 服务] 启动 SDK — CLI: ${cliPath}, Bun: ${bunPath}, 模型: ${modelId}, resume: ${existingSdkSessionId ?? "无"}`
    );
    const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
    const mcpServers = buildMcpServers(workspaceSlug);
    const dynamicContext = buildDynamicContext({
      workspaceName,
      workspaceSlug,
      agentCwd
    });
    const contextualMessage = `${dynamicContext}\n\n${userMessage}`;

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
        model: modelId,
        maxTurns: 30,
        // SDK 0.2.37 默认会传入空的 --setting-sources，导致后续参数被错误解析。
        // 显式设置有效值，避免 "Invalid setting source: --permission-mode"。
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
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
            sessionId
          })
        },
        ...(existingSdkSessionId ? { resume: existingSdkSessionId } : {}),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(workspaceSlug
          ? { plugins: [{ type: "local" as const, path: getAgentWorkspacePath(workspaceSlug) }] }
          : {}),
        stderr: (data: string) => {
          stderrChunks.push(data);
          console.error(`[Agent SDK stderr] ${data}`);
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
    void autoGenerateAgentTitle(sessionId, userMessage, channelId, modelId, emit);
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
      void autoGenerateAgentTitle(sessionId, userMessage, channelId, modelId, emit);
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
    activeControllers.delete(sessionId);
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
