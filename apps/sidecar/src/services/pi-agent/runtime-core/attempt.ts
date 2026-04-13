import { clearQuestionHandler, setQuestionHandler, type CanUseToolFn } from "@lume/agent-sdk";
import { lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { updateAgentThreadMeta } from "../../agent/agent-thread-manager";
import {
  appendSdkMessage,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "../../agent/agent-stream-accumulator";
import { getAgentSessionWorkspacePath, getConfigDir } from "../../infra/config-paths";
import { decryptApiKey, listChannels } from "../../channel/channel-manager";
import { resolveChannelModelBinding } from "../../channel/channel-manager";
import { getAgentWorkspace } from "../../agent/agent-workspace-manager";
import { createLogger } from "../../infra/logger";
import { buildRuntimeAttemptLogData } from "../../agent/agent-log-summary";
import { resolveMockAttempt } from "./mock-attempt";
import type { PiAgentRunParams, PiAgentRunResult, PiAgentRuntimeEmitter } from "../runner/types";
import { resolveAgentThinkingLevel } from "../runner/model-capabilities";
import { resolveRuntimeCoreChannelModel } from "./model";
import { createRuntimeCoreSession } from "./run";
import { getRuntimeCoreAgentDir, hasRuntimeCoreSessionTranscript } from "./session-store";
import {
  isToolAlwaysAllowed,
  markToolAlwaysAllowed,
  waitForToolPermissionDecision
} from "../tools/bridges/tool-permission-bridge";
import {
  getToolMetadata,
  inferToolMetadata,
  isToolAllowedInPlanMode
} from "../tools/permissions/tool-metadata";
import { waitForPiAskUserQuestionAnswers } from "../tools/bridges/ask-user-question-bridge";
import type { AgentAskUserQuestionQuestion } from "@lume/shared";

interface RunRuntimeCoreAttemptOptions {
  registerAbort: (threadId: string, abort: () => Promise<void>) => void;
  unregisterAbort: (threadId: string) => void;
}

interface PreparedRuntimeCoreAttempt {
  agentCwd: string;
  agentDir: string;
  workspaceName?: string;
  workspaceSlug?: string;
  modelResolution: NonNullable<ReturnType<typeof resolveRuntimeCoreChannelModel>>;
  apiKey: string;
}

const LUME_CONFIG_MIRROR_DIRNAME = ".lume-config";

const log = createLogger("pi-agent-runtime-core-attempt");

const PARAM_DENY_RULES: Array<{ tool: string; param: string; pattern: RegExp; reason: string }> = [
  { tool: "bash", param: "command", pattern: /rm\s+-rf\s+\/(?:\s|$)/, reason: "禁止删除根目录" },
  { tool: "bash", param: "command", pattern: /:\s*\(\s*\)\s*\{.*\}\s*;.*:/, reason: "禁止 fork bomb" },
  { tool: "bash", param: "command", pattern: />\s*\/dev\/sd[a-z]/, reason: "禁止写入块设备" }
];

function sanitizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 2000) {
      copied[key] = `${value.slice(0, 2000)}...(truncated)`;
    } else {
      copied[key] = value;
    }
  }
  return copied;
}

function checkParamDenyRules(toolName: string, args: unknown): string | null {
  const normalized = toolName.trim().toLowerCase();
  const record = args && typeof args === "object" ? args as Record<string, unknown> : {};
  for (const rule of PARAM_DENY_RULES) {
    if (rule.tool !== normalized) continue;
    const value = record[rule.param];
    if (typeof value === "string" && rule.pattern.test(value)) {
      return rule.reason;
    }
  }
  return null;
}

function shouldRequireConfirmation(permissionMode: PiAgentRunParams["input"]["permissionMode"], toolName: string): boolean {
  const mode = permissionMode ?? "default";
  if (mode === "bypassPermissions") {
    return false;
  }
  const metadata = getToolMetadata(toolName) ?? inferToolMetadata(toolName);
  if (metadata.riskLevel === "low") {
    return false;
  }
  if (mode === "acceptEdits" && metadata.category === "write") {
    return false;
  }
  return true;
}

function buildPermissionReason(toolName: string): string {
  const metadata = getToolMetadata(toolName) ?? inferToolMetadata(toolName);
  if (metadata.riskLevel === "high") {
    return `${toolName} 可能执行系统命令或高风险操作，需要你确认。`;
  }
  if (metadata.category === "write") {
    return `${toolName} 将修改文件或数据，需要你确认。`;
  }
  if (metadata.category === "execute") {
    return `${toolName} 将执行操作，需要你确认。`;
  }
  return `${toolName} 将触发操作，需要你确认。`;
}

function toReadableString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function parseAskUserQuestions(input: Record<string, unknown>): AgentAskUserQuestionQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const result: AgentAskUserQuestionQuestion[] = [];
  for (const item of rawQuestions) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = toReadableString(record.question);
    const header = toReadableString(record.header) || `问题${result.length + 1}`;
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options = rawOptions
      .map((option) => {
        if (typeof option === "string") {
          const text = option.trim();
          return text ? { label: text, description: text } : null;
        }
        if (!option || typeof option !== "object") return null;
        const optionRecord = option as Record<string, unknown>;
        const label = toReadableString(optionRecord.label) || toReadableString(optionRecord.text);
        const description = toReadableString(optionRecord.description) || label;
        if (!label) return null;
        return { label, description };
      })
      .filter((option): option is { label: string; description: string } => !!option);
    if (!question || options.length < 2) continue;
    result.push({
      header,
      question,
      options,
      multiSelect: record.multiSelect === true
    });
  }
  return result;
}

function createCanUseToolHandler(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  askUserSignal: AbortSignal
): CanUseToolFn {
  return async (tool, input, metadata) => {
    const toolName = tool.name || "unknown_tool";
    const mode = params.input.permissionMode ?? "default";
    if (mode === "plan" && !isToolAllowedInPlanMode(toolName)) {
      return {
        behavior: "deny",
        message: `当前是 plan 模式，只允许规划与只读工具，禁止执行: ${toolName}`
      };
    }

    const paramDenyReason = checkParamDenyRules(toolName, input);
    if (paramDenyReason) {
      return {
        behavior: "deny",
        message: `工具参数被拒绝: ${paramDenyReason}`
      };
    }

    if (toolName === "AskUserQuestion") {
      const normalizedInput = input && typeof input === "object"
        ? input as Record<string, unknown>
        : {};
      const questions = parseAskUserQuestions(normalizedInput);
      if (questions.length === 0) {
        return {
          behavior: "deny",
          message: "AskUserQuestion 缺少有效问题，已拒绝执行"
        };
      }
      const askResult = await waitForPiAskUserQuestionAnswers(
        params.runtime.sessionId,
        metadata?.toolUseId ?? toolName,
        questions,
        askUserSignal,
        emit.onAskUserQuestion
      );
      if (askResult.status !== "answered" || !askResult.answers) {
        if (askResult.status === "timeout") {
          return { behavior: "deny", message: "AskUserQuestion 等待用户回答超时" };
        }
        if (askResult.status === "aborted") {
          return { behavior: "deny", message: "AskUserQuestion 被线程中止" };
        }
        return { behavior: "deny", message: "用户取消了 AskUserQuestion" };
      }
      return {
        behavior: "allow",
        updatedInput: {
          ...normalizedInput,
          questions,
          answers: askResult.answers
        }
      };
    }

    if (!shouldRequireConfirmation(params.input.permissionMode, toolName)) {
      return { behavior: "allow" };
    }

    if (isToolAlwaysAllowed(params.runtime.sessionId, toolName)) {
      return { behavior: "allow" };
    }

    const request = {
      threadId: params.runtime.sessionId,
      requestId: metadata?.toolUseId ?? toolName,
      toolUseId: metadata?.toolUseId ?? toolName,
      toolName,
      risk: (getToolMetadata(toolName) ?? inferToolMetadata(toolName)).riskLevel,
      reason: buildPermissionReason(toolName),
      input: sanitizeToolInput(input)
    } as const;
    const decision = await waitForToolPermissionDecision(
      request,
      new AbortController().signal,
      emit.onToolPermissionRequest
    );
    if (decision === "allow_always") {
      markToolAlwaysAllowed(params.runtime.sessionId, toolName);
      return { behavior: "allow" };
    }
    if (decision === "allow_once") {
      return { behavior: "allow" };
    }
    return {
      behavior: "deny",
      message: `用户拒绝执行工具: ${toolName}`
    };
  };
}

export async function runRuntimeCoreAttempt(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  options: RunRuntimeCoreAttemptOptions
): Promise<PiAgentRunResult> {
  const { input, runtime } = params;

  const mockHandler = resolveMockAttempt(input);
  const prepared = await prepareRuntimeCoreAttempt(params);
  if (mockHandler) {
    if ("status" in prepared) {
      return prepared;
    }
    return mockHandler(params, emit, options, prepared);
  }
  if ("status" in prepared) {
    return prepared;
  }

  const resumeExistingSession = hasRuntimeCoreSessionTranscript(runtime.sessionId, prepared.agentDir);
  log.info("[Agent 编排] 准备启动 runtime", buildRuntimeAttemptLogData({
    sessionId: runtime.sessionId,
    workspaceSlug: prepared.workspaceSlug,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resume: resumeExistingSession,
    permissionMode: input.permissionMode,
    cwd: prepared.agentCwd
  }));

  const runtimeSession = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    userMessage: input.userMessage,
    provider: prepared.modelResolution.provider,
    modelRef: runtime.modelRef,
    resolvedModelId: prepared.modelResolution.resolvedModelId,
    resolvedModel: {
      id: prepared.modelResolution.model.id,
      provider: prepared.modelResolution.model.provider,
      baseUrl: prepared.modelResolution.model.baseUrl,
      contextWindow: prepared.modelResolution.model.contextWindow,
      maxTokens: prepared.modelResolution.model.maxTokens
    },
    apiKey: prepared.apiKey,
    workspaceId: runtime.workspaceId,
    workspaceName: prepared.workspaceName,
    workspaceSlug: prepared.workspaceSlug,
    channelId: runtime.channelId,
    threadType: runtime.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    messageMetadata: input.messageMetadata,
    emitSdkMessage: emit.onSdkMessage,
    emitAskUserQuestion: emit.onAskUserQuestion,
    emitToolPermissionRequest: emit.onToolPermissionRequest
  });

  const { agent, session } = runtimeSession;
  log.info("[Agent 编排] runtime session 已建立", buildRuntimeAttemptLogData({
    sessionId: runtime.sessionId,
    workspaceSlug: prepared.workspaceSlug,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resume: resumeExistingSession,
    permissionMode: input.permissionMode,
    cwd: prepared.agentCwd,
    toolCount: runtimeSession.tools.length
  }));
  const accumulator = createAgentStreamAccumulatorState();
  let finalResult: PiAgentRunResult = { status: "completed" };
  let finalError = "";
  const askUserAbortController = new AbortController();

  options.registerAbort(runtime.sessionId, async () => {
    askUserAbortController.abort();
    await agent.interrupt();
  });

  try {
    setQuestionHandler((async (request: {
      questions: AgentAskUserQuestionQuestion[];
      answers?: Record<string, string>;
    }) => {
      if (request.answers && typeof request.answers === "object") {
        return {
          questions: request.questions,
          answers: request.answers as Record<string, string>
        };
      }
      throw new Error("AskUserQuestion answers missing");
    }) as any);
    await agent.setModel(prepared.modelResolution.resolvedModelId);
    const thinkingLevel = resolveAgentThinkingLevel(
      prepared.modelResolution.model,
      prepared.modelResolution.model.baseUrl,
      input.thinkingLevel
    );
    if (thinkingLevel === "high") {
      await agent.setMaxThinkingTokens(8_192);
    } else if (thinkingLevel === "medium") {
      await agent.setMaxThinkingTokens(4_096);
    } else if (thinkingLevel === "low") {
      await agent.setMaxThinkingTokens(1_024);
    } else if (thinkingLevel === "xhigh") {
      await agent.setMaxThinkingTokens(16_384);
    } else if (thinkingLevel === "off") {
      await agent.setMaxThinkingTokens(null);
    }

    log.info("[Agent 编排] 开始遍历事件流", {
      sessionId: runtime.sessionId.slice(0, 8),
      modelId: prepared.modelResolution.resolvedModelId,
      thinkingLevel,
      permissionMode: input.permissionMode ?? "default"
    });

    const query = agent.query(input.userMessage, {
      canUseTool: createCanUseToolHandler(params, emit, askUserAbortController.signal),
      permissionMode: input.permissionMode === "bypassPermissions"
        ? "bypassPermissions"
        : input.permissionMode === "plan"
          ? "plan"
          : input.permissionMode === "acceptEdits"
            ? "acceptEdits"
            : "default",
      includePartialMessages: true
    });

    for await (const message of query) {
      emit.onSdkMessage(message);
      appendSdkMessage(accumulator, message);

      const errorMessage = getLastError(message);
      if (errorMessage) {
        finalError = errorMessage;
      }
      if (message.type === "result" && message.is_error) {
        finalResult = {
          status: "errored",
          errorMessage: errorMessage || "Agent SDK 执行失败"
        };
      }
    }

    if (finalResult.status === "errored") {
      return finalResult;
    }

    if (!hasRenderableAssistantOutput(accumulator)) {
      return {
        status: "errored",
        errorMessage: "runtime-core 未检测到可渲染输出。"
      };
    }

    updateAgentThreadMeta(runtime.sessionId, {
      sdkThreadId: session.threadId ?? session.sessionId,
      runtimeThreadId: session.threadId ?? session.sessionId
    });

    log.info("[Agent 编排] 事件流结束", {
      sessionId: runtime.sessionId.slice(0, 8),
      status: "completed",
      sdkSessionId: (session.threadId ?? session.sessionId)?.slice(0, 8),
      hasRenderableOutput: true
    });
    emit.onComplete();
    return { status: "completed" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (/abort|interrupted/i.test(errorMessage)) {
      log.warn("[Agent 编排] 事件流中止", {
        sessionId: runtime.sessionId.slice(0, 8),
        status: "aborted",
        errorMessage
      });
      emit.onComplete();
      return { status: "aborted" };
    }
    log.error("[Agent 编排] 事件流失败", {
      sessionId: runtime.sessionId.slice(0, 8),
      status: "errored",
      errorMessage: finalError || errorMessage
    });
    emit.onError(finalError || errorMessage);
    return {
      status: "errored",
      errorMessage: finalError || errorMessage
    };
  } finally {
    clearQuestionHandler();
    askUserAbortController.abort();
    await session.dispose();
    options.unregisterAbort(runtime.sessionId);
  }
}

function getLastError(message: import("@lume/agent-sdk").SDKMessage): string | null {
  if (message.type === "result" && message.is_error) {
    const firstError = Array.isArray(message.errors) ? message.errors[0] : undefined;
    const detailedResult = typeof message.result === "string" ? message.result.trim() : "";
    return typeof firstError === "string" && firstError.trim()
      ? firstError
      : detailedResult || "Agent SDK 执行失败";
  }
  if (message.type === "assistant" && message.error) {
    const text = (message.message?.content ?? [])
      .filter((block) => !!block && typeof block === "object")
      .map((block) => block as { type?: string; text?: string })
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
    return text || message.error;
  }
  if (message.type === "system" && message.subtype === "status" && typeof message.message === "string") {
    return message.message;
  }
  return null;
}

async function prepareRuntimeCoreAttempt(
  params: PiAgentRunParams
): Promise<PreparedRuntimeCoreAttempt | PiAgentRunResult> {
  const { runtime } = params;
  const boundModel = resolveChannelModelBinding(runtime.modelRef ?? "", "chat");
  const channel = boundModel?.channel ?? listChannels().find((item) => item.id === runtime.channelId);
  if (!channel) {
    return { status: "errored", errorMessage: "runtime-core 未找到可用渠道。" };
  }

  let apiKey = "";
  try {
    apiKey = decryptApiKey(runtime.channelId);
  } catch {
    return { status: "errored", errorMessage: "runtime-core 解密 API Key 失败。" };
  }

  const modelResolution = resolveRuntimeCoreChannelModel({
    channel,
    channelProvider: channel.provider,
    requestedModelRefOrId: runtime.modelRef ?? boundModel?.modelId ?? runtime.resolvedModelId,
    baseUrl: channel.baseUrl
  });
  if (!modelResolution) {
    return {
      status: "errored",
      errorMessage: `runtime-core 未找到模型: ${runtime.modelRef ?? `${channel.provider}/${runtime.resolvedModelId}`}`
    };
  }

  let agentCwd = process.cwd();
  let workspaceName: string | undefined;
  let workspaceSlug: string | undefined;
  if (runtime.workspaceId) {
    const workspace = getAgentWorkspace(runtime.workspaceId);
    if (workspace) {
      workspaceName = workspace.name;
      workspaceSlug = workspace.slug;
      agentCwd = getAgentSessionWorkspacePath(workspace.slug, runtime.sessionId);
    }
  }

  await ensureConfigDirMirror(agentCwd);

  return {
    agentCwd,
    agentDir: getRuntimeCoreAgentDir(),
    workspaceName,
    workspaceSlug,
    modelResolution,
    apiKey
  };
}

async function ensureConfigDirMirror(agentCwd: string): Promise<void> {
  const configDir = getConfigDir();
  const mirrorPath = join(agentCwd, LUME_CONFIG_MIRROR_DIRNAME);
  try {
    const existing = await lstat(mirrorPath);
    if (existing.isSymbolicLink() || existing.isDirectory()) {
      return;
    }
    log.warn("runtime-core 配置目录映射路径已被占用，跳过映射", {
      agentCwd,
      mirrorPath
    });
    return;
  } catch {
    // no-op: mirror path does not exist
  }

  try {
    await symlink(
      configDir,
      mirrorPath,
      process.platform === "win32" ? "junction" : "dir"
    );
  } catch (error) {
    log.warn("runtime-core 配置目录映射失败，继续使用绝对路径访问", {
      agentCwd,
      mirrorPath,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

// ─── Pi Agent runner (migrated from runner/run.ts) ───

const activePiSessions = new Map<string, { abort: () => Promise<void> }>();
const DEFAULT_MAX_ATTEMPTS = 1;
const RETRY_DELAY_MS = 700;

export async function runPiAgent(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter
): Promise<PiAgentRunResult> {
  const maxAttempts = resolveMaxAttempts();
  let attempt = 0;
  let lastResult: PiAgentRunResult = { status: "errored", errorMessage: "Pi Agent 未执行" };

  while (attempt < maxAttempts) {
    attempt += 1;
    log.info("[Agent 编排] 开始执行 attempt", {
      threadId: params.runtime.sessionId.slice(0, 8),
      attempt,
      maxAttempts
    });
    const result = await runRuntimeCoreAttempt(params, emit, {
      registerAbort: (sessionId, abort) => {
        activePiSessions.set(sessionId, { abort });
      },
      unregisterAbort: (sessionId) => {
        activePiSessions.delete(sessionId);
      }
    });
    lastResult = result;
    log.info("[Agent 编排] attempt 结束", {
      threadId: params.runtime.sessionId.slice(0, 8),
      attempt,
      status: result.status,
      errorMessage: result.status === "errored" ? result.errorMessage : undefined
    });
    if (result.status !== "errored") {
      return result;
    }
    const retryable = shouldRetryError(result.errorMessage);
    if (!retryable || attempt >= maxAttempts) {
      const message = result.errorMessage ?? "未知错误";
      emit.onError(`Pi Agent runtime 执行失败: ${message}`);
      return result;
    }

    log.warn("Pi Agent attempt 失败，准备重试", {
      threadId: params.runtime.sessionId.slice(0, 8),
      attempt,
      maxAttempts,
      errorMessage: result.errorMessage
    });
    await sleep(RETRY_DELAY_MS);
  }

  const fallbackMessage = lastResult.errorMessage ?? "未知错误";
  emit.onError(`Pi Agent runtime 执行失败: ${fallbackMessage}`);
  return lastResult;
}

function resolveMaxAttempts(): number {
  const raw = process.env.LUME_PI_AGENT_MAX_ATTEMPTS?.trim();
  const parsed = raw ? Number(raw) : DEFAULT_MAX_ATTEMPTS;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.min(3, Math.floor(parsed)));
}

function shouldRetryError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const value = errorMessage.toLowerCase();
  return (
    value.includes("timeout")
    || value.includes("timed out")
    || value.includes("rate limit")
    || value.includes("429")
    || value.includes("temporar")
    || value.includes("econnreset")
    || value.includes("enotfound")
    || value.includes("network")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

export async function stopPiAgent(threadId: string): Promise<boolean> {
  const active = activePiSessions.get(threadId);
  if (!active) {
    return false;
  }
  await active.abort();
  activePiSessions.delete(threadId);
  return true;
}

export function isPiAgentSessionActive(threadId: string): boolean {
  return activePiSessions.has(threadId);
}

export async function stopAllPiAgents(): Promise<void> {
  const all = Array.from(activePiSessions.entries());
  for (const [sessionId, active] of all) {
    await active.abort();
    activePiSessions.delete(sessionId);
  }
}
