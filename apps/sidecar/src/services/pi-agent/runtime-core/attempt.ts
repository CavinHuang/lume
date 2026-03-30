import { updateAgentSessionMeta } from "../../agent/agent-session-manager";
import {
  appendAgentEvents,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "../../agent/agent-stream-accumulator";
import { getAgentSessionWorkspacePath } from "../../infra/config-paths";
import { decryptApiKey, listChannels } from "../../channel/channel-manager";
import { ensurePluginManifest, getAgentWorkspace } from "../../agent/agent-workspace-manager";
import { createLogger } from "../../infra/logger";
import { projectRuntimeCoreEventToLumeEvents } from "./subscribe";
import { createRuntimeCoreSession } from "./run";
import { getRuntimeCoreAgentDir } from "./session-store";
import { applyRuntimeCoreStreamWrappers, createRuntimeCoreStreamWrapperState } from "./stream-wrappers";
import { resolveRuntimeCoreChannelModel } from "./model";
import { resolveMockAttempt } from "./mock-attempt";
import type { PiAgentRunParams, PiAgentRunResult, PiAgentRuntimeEmitter } from "../runner/types";
import { resolveAgentThinkingLevel } from "../runner/model-capabilities";

interface RunRuntimeCoreAttemptOptions {
  registerAbort: (sessionId: string, abort: () => Promise<void>) => void;
  unregisterAbort: (sessionId: string) => void;
}

interface PreparedRuntimeCoreAttempt {
  agentCwd: string;
  agentDir: string;
  workspaceName?: string;
  workspaceSlug?: string;
  modelResolution: NonNullable<ReturnType<typeof resolveRuntimeCoreChannelModel>>;
  apiKey: string;
}

const log = createLogger("pi-agent-runtime-core-attempt");

export async function runRuntimeCoreAttempt(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  options: RunRuntimeCoreAttemptOptions
): Promise<PiAgentRunResult> {
  const { input, runtime } = params;

  // Mock 分支委托到 mock-attempt.ts，生产路径无 mock 分支
  const mockHandler = resolveMockAttempt(input);

  const prepared = prepareRuntimeCoreAttempt(params);
  if (mockHandler) {
    if ("status" in prepared) {
      return prepared;
    }
    return mockHandler(params, emit, options, prepared);
  }
  if ("status" in prepared) {
    return prepared;
  }

  const upstream = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    userMessage: input.userMessage,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resolvedModel: prepared.modelResolution.model,
    apiKey: prepared.apiKey,
    workspaceId: runtime.workspaceId,
    workspaceName: prepared.workspaceName,
    workspaceSlug: prepared.workspaceSlug,
    channelId: runtime.channelId,
    sessionType: runtime.sessionType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    messageMetadata: input.messageMetadata,
    emitAskUserQuestion: emit.onAskUserQuestion,
    emitToolPermissionRequest: emit.onToolPermissionRequest
  });

  const session = upstream.session;
  if (prepared.workspaceName) {
    log.info("runtime-core 已创建 upstream session", {
      sessionId: runtime.sessionId.slice(0, 8),
      workspaceName: prepared.workspaceName,
      provider: prepared.modelResolution.provider,
      modelId: prepared.modelResolution.resolvedModelId
    });
  }

  const accumulator = createAgentStreamAccumulatorState();
  const streamWrapperState = createRuntimeCoreStreamWrapperState();
  const unsubscribe = session.subscribe((event) => {
    const mappedEvents = projectRuntimeCoreEventToLumeEvents(event, {
      contextWindow: session.model?.contextWindow
    });
    const wrappedEvents = applyRuntimeCoreStreamWrappers(mappedEvents, streamWrapperState, {
      provider: session.model?.provider,
      baseUrl: session.model?.baseUrl
    });
    for (const mappedEvent of wrappedEvents) {
      emit.onEvent(mappedEvent);
    }
    if (wrappedEvents.length > 0) {
      appendAgentEvents(accumulator, wrappedEvents);
    }
  });

  options.registerAbort(runtime.sessionId, async () => {
    await session.abort();
  });

  try {
    await session.setModel(prepared.modelResolution.model);
    const thinkingLevel = resolveAgentThinkingLevel(
      prepared.modelResolution.model,
      prepared.modelResolution.model.baseUrl,
      input.thinkingLevel
    );
    if (thinkingLevel) {
      session.setThinkingLevel(thinkingLevel);
    }
    await session.prompt(input.userMessage);

    if (!hasRenderableAssistantOutput(accumulator)) {
      return {
        status: "errored",
        errorMessage: "runtime-core 未检测到可渲染输出。"
      };
    }

    emit.onEvent({
      type: "complete",
      stopReason: resolveStopReason(session.messages),
      ...(buildCompleteUsage(session.messages) ? { usage: buildCompleteUsage(session.messages) } : {})
    });

    updateAgentSessionMeta(runtime.sessionId, {
      piSessionId: session.sessionId
    });

    emit.onComplete();
    return { status: "completed" };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (/abort/i.test(errorMessage)) {
      emit.onComplete();
      return { status: "aborted" };
    }
    return { status: "errored", errorMessage };
  } finally {
    unsubscribe();
    session.dispose();
    options.unregisterAbort(runtime.sessionId);
  }
}

function prepareRuntimeCoreAttempt(
  params: PiAgentRunParams
): PreparedRuntimeCoreAttempt | PiAgentRunResult {
  const { runtime } = params;
  const channel = listChannels().find((item) => item.id === runtime.channelId);
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
    modelId: runtime.modelId,
    baseUrl: channel.baseUrl
  });
  if (!modelResolution) {
    return {
      status: "errored",
      errorMessage: `runtime-core 未找到模型: ${channel.provider}/${runtime.modelId}`
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
      ensurePluginManifest(workspace.slug, workspace.name);
    }
  }

  return {
    agentCwd,
    agentDir: getRuntimeCoreAgentDir(),
    workspaceName,
    workspaceSlug,
    modelResolution,
    apiKey
  };
}

function resolveStopReason(messages: Array<{ role: string; stopReason?: string }>): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant") {
      return message.stopReason ?? "completed";
    }
  }
  return "completed";
}

function buildCompleteUsage(
  messages: Array<{
    role: string;
    usage?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens?: number;
      cost?: { total: number };
    }
  }>
) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant" || !message.usage) {
      continue;
    }
    return {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheCreationTokens: message.usage.cacheWrite,
      totalTokens:
        message.usage.totalTokens
        ?? (message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite),
      costUsd: message.usage.cost?.total
    };
  }
  return undefined;
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
    const result = await runRuntimeCoreAttempt(params, emit, {
      registerAbort: (sessionId, abort) => {
        activePiSessions.set(sessionId, { abort });
      },
      unregisterAbort: (sessionId) => {
        activePiSessions.delete(sessionId);
      }
    });
    lastResult = result;
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
      sessionId: params.runtime.sessionId.slice(0, 8),
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
    value.includes("timeout") ||
    value.includes("timed out") ||
    value.includes("rate limit") ||
    value.includes("429") ||
    value.includes("temporar") ||
    value.includes("econnreset") ||
    value.includes("enotfound") ||
    value.includes("network")
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

export async function stopPiAgent(sessionId: string): Promise<boolean> {
  const active = activePiSessions.get(sessionId);
  if (!active) {
    return false;
  }
  await active.abort();
  activePiSessions.delete(sessionId);
  return true;
}

export function isPiAgentSessionActive(sessionId: string): boolean {
  return activePiSessions.has(sessionId);
}

export async function stopAllPiAgents(): Promise<void> {
  const all = Array.from(activePiSessions.entries());
  for (const [sessionId, active] of all) {
    await active.abort();
    activePiSessions.delete(sessionId);
  }
}
