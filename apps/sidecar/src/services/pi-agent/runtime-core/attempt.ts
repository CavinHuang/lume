import { randomUUID } from "node:crypto";
import { updateAgentSessionMeta } from "../../agent-session-manager";
import {
  appendAgentEvents,
  createAgentStreamAccumulatorState,
  hasRenderableAssistantOutput
} from "../../agent-stream-accumulator";
import { getAgentSessionWorkspacePath } from "../../config-paths";
import { decryptApiKey, listChannels } from "../../channel-manager";
import { ensurePluginManifest, getAgentWorkspace } from "../../agent-workspace-manager";
import { createLogger } from "../../logger";
import { waitForPiAskUserQuestionAnswers } from "../tools/ask-user-question-bridge";
import { waitForToolPermissionDecision } from "../tools/tool-permission-bridge";
import { getSubagentRunRegistry } from "../subagents/subagent-run-registry";
import { announceSubagentCompletion } from "../subagents/subagent-announce-service";
import { projectRuntimeCoreEventToLumeEvents } from "./subscribe";
import { createRuntimeCoreSession } from "./run";
import { getRuntimeCoreAgentDir } from "./session-store";
import { applyRuntimeCoreStreamWrappers, createRuntimeCoreStreamWrapperState } from "./stream-wrappers";
import { resolveRuntimeCoreChannelModel } from "./model";
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
  if (process.env.LUME_PI_AGENT_MOCK_ERROR === "1") {
    return runRuntimeCoreMockErrorAttempt(emit);
  }
  const prepared = prepareRuntimeCoreAttempt(params);
  if ("status" in prepared) {
    return prepared;
  }

  const mockDelayMs = resolveMockDelayMs();
  if (mockDelayMs > 0) {
    return runRuntimeCoreMockDelayedAttempt(params, emit, options, mockDelayMs, prepared);
  }
  if (process.env.LUME_PI_AGENT_MOCK_SUCCESS === "1") {
    if (shouldRunMockCompaction(input.userMessage)) {
      return runRuntimeCoreMockCompactionAttempt(params, emit, prepared);
    }
    return runRuntimeCoreMockSuccessAttempt(params, emit, prepared);
  }

  const upstream = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resolvedModel: prepared.modelResolution.model,
    apiKey: prepared.apiKey,
    workspaceId: runtime.workspaceId,
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
    const thinkingLevel = resolveAgentThinkingLevel(prepared.modelResolution.model, prepared.modelResolution.model.baseUrl);
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

async function runRuntimeCoreMockSuccessAttempt(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  prepared: PreparedRuntimeCoreAttempt
): Promise<PiAgentRunResult> {
  const { input, runtime } = params;
  const mockText = (process.env.LUME_PI_AGENT_MOCK_TEXT || "Lume runtime-core mock success").trim();
  const upstream = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resolvedModel: prepared.modelResolution.model,
    apiKey: prepared.apiKey,
    workspaceId: runtime.workspaceId,
    workspaceSlug: prepared.workspaceSlug,
    channelId: runtime.channelId,
    sessionType: runtime.sessionType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    messageMetadata: input.messageMetadata,
    emitAskUserQuestion: emit.onAskUserQuestion,
    emitToolPermissionRequest: emit.onToolPermissionRequest
  });
  const { session, sessionManager } = upstream;
  logMockSessionPersistence("mock_success", runtime.sessionId, sessionManager);
  const accumulator = createAgentStreamAccumulatorState();
  const textEvent = { type: "text_delta" as const, text: mockText };
  appendAgentEvents(accumulator, [textEvent]);
  sessionManager.appendModelChange(prepared.modelResolution.provider, prepared.modelResolution.resolvedModelId);
  sessionManager.appendThinkingLevelChange("medium");
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: input.userMessage }],
    timestamp: Date.now()
  });
  sessionManager.appendMessage({
    role: "assistant",
    provider: prepared.modelResolution.provider,
    model: prepared.modelResolution.resolvedModelId,
    api: "anthropic-messages",
    stopReason: "stop",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    content: [{ type: "text", text: mockText }],
    timestamp: Date.now()
  });
  const interactiveResult = await runMockInteractiveBridges(runtime.sessionId, emit);
  if (interactiveResult.status !== "ok") {
    session.dispose();
    return {
      status: "errored",
      errorMessage: interactiveResult.error
    };
  }
  await maybeEmitMockSubagentAnnounce(runtime.sessionId);
  emit.onEvent(textEvent);
  emit.onEvent({
    type: "complete",
    stopReason: "completed",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0
    }
  });
  updateAgentSessionMeta(runtime.sessionId, {
    piSessionId: session.sessionId
  });
  session.dispose();
  emit.onComplete();
  return { status: "completed" };
}

async function runMockInteractiveBridges(
  sessionId: string,
  emit: PiAgentRuntimeEmitter
): Promise<{ status: "ok" } | { status: "errored"; error: string }> {
  if (process.env.LUME_PI_AGENT_MOCK_TOOL_PERMISSION === "1") {
    const controller = new AbortController();
    const decision = await waitForToolPermissionDecision(
      {
        sessionId,
        requestId: `mock-permission:${sessionId}`,
        toolUseId: `mock-tool-use:${sessionId}`,
        toolName: "write",
        risk: "high",
        reason: "mock permission request",
        input: { path: "mock-permission.txt" }
      },
      controller.signal,
      emit.onToolPermissionRequest
    );
    if (decision !== "allow_once" && decision !== "allow_always") {
      return {
        status: "errored",
        error: "mock tool permission denied"
      };
    }
  }

  if (process.env.LUME_PI_AGENT_MOCK_ASK_USER_QUESTION === "1") {
    const controller = new AbortController();
    const answerResult = await waitForPiAskUserQuestionAnswers(
      sessionId,
      `mock-ask:${sessionId}`,
      [
        {
          header: "范围",
          question: "是否继续执行 smoke bridge？",
          options: [
            { label: "继续", description: "继续后续步骤" }
          ],
          multiSelect: false
        }
      ],
      controller.signal,
      emit.onAskUserQuestion
    );
    if (answerResult.status !== "answered") {
      return {
        status: "errored",
        error: `mock ask user question not answered: ${answerResult.status}`
      };
    }
  }

  return { status: "ok" };
}

async function maybeEmitMockSubagentAnnounce(sessionId: string): Promise<void> {
  if (process.env.LUME_PI_AGENT_MOCK_SUBAGENT_ANNOUNCE !== "1") {
    return;
  }
  const runId = `mock-subagent-run:${sessionId}`;
  const registry = getSubagentRunRegistry();
  if (!registry.get(runId)) {
    registry.create({
      runId,
      parentSessionId: sessionId,
      rootSessionId: sessionId,
      childSessionId: `mock-child-session:${sessionId}`,
      label: "Mock Subagent",
      task: "mock subagent completion",
      cleanup: "keep",
      status: "completed",
      announceStatus: "pending"
    });
  }

  const result = await announceSubagentCompletion({
    run: {
      runId,
      parentSessionId: sessionId,
      rootSessionId: sessionId,
      depth: 1,
      childSessionId: `mock-child-session:${sessionId}`,
      label: "Mock Subagent",
      task: "mock subagent completion",
      status: "completed",
      cleanup: "keep",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      startedAt: Date.now() - 10,
      endedAt: Date.now(),
      outcome: {
        output: "mock subagent announce output",
        usageEvents: 1
      }
    }
  });

  registry.update(runId, {
    announceStatus: result.delivered ? "delivered" : "failed",
    announceAttempts: result.attempts,
    announceLastError: result.error,
    announceDeliveredAt: result.delivered ? Date.now() : undefined
  });
}

async function runRuntimeCoreMockCompactionAttempt(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  prepared: PreparedRuntimeCoreAttempt
): Promise<PiAgentRunResult> {
  const { input, runtime } = params;
  const summary = (process.env.LUME_PI_AGENT_MOCK_COMPACTION_SUMMARY || "mock compaction summary").trim();
  const upstream = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resolvedModel: prepared.modelResolution.model,
    apiKey: prepared.apiKey,
    workspaceId: runtime.workspaceId,
    workspaceSlug: prepared.workspaceSlug,
    channelId: runtime.channelId,
    sessionType: runtime.sessionType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    messageMetadata: input.messageMetadata,
    emitAskUserQuestion: emit.onAskUserQuestion,
    emitToolPermissionRequest: emit.onToolPermissionRequest
  });
  const { session, sessionManager } = upstream;
  logMockSessionPersistence("mock_compaction", runtime.sessionId, sessionManager);
  sessionManager.appendModelChange(prepared.modelResolution.provider, prepared.modelResolution.resolvedModelId);
  sessionManager.appendThinkingLevelChange("medium");
  const currentLeafId = sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: input.userMessage }],
    timestamp: Date.now()
  });
  emit.onEvent({ type: "compacting" });
  sessionManager.appendCompaction(summary, currentLeafId, 0, {
    source: "mock-runtime-core"
  });
  emit.onEvent({ type: "compact_complete" });
  emit.onEvent({
    type: "complete",
    stopReason: "completed",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0
    }
  });
  updateAgentSessionMeta(runtime.sessionId, {
    piSessionId: session.sessionId
  });
  session.dispose();
  emit.onComplete();
  return { status: "completed" };
}

function runRuntimeCoreMockErrorAttempt(
  emit: PiAgentRuntimeEmitter
): PiAgentRunResult {
  const errorMessage = (process.env.LUME_PI_AGENT_MOCK_ERROR_TEXT || "runtime-core mock error").trim();
  emit.onError(errorMessage);
  return {
    status: "errored",
    errorMessage
  };
}

async function runRuntimeCoreMockDelayedAttempt(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  options: RunRuntimeCoreAttemptOptions,
  delayMs: number,
  prepared: PreparedRuntimeCoreAttempt
): Promise<PiAgentRunResult> {
  const { input, runtime } = params;
  const mockText = (process.env.LUME_PI_AGENT_MOCK_TEXT || "Lume runtime-core delayed mock").trim();
  const upstream = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resolvedModel: prepared.modelResolution.model,
    apiKey: prepared.apiKey,
    workspaceId: runtime.workspaceId,
    workspaceSlug: prepared.workspaceSlug,
    channelId: runtime.channelId,
    sessionType: runtime.sessionType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    messageMetadata: input.messageMetadata,
    emitAskUserQuestion: emit.onAskUserQuestion,
    emitToolPermissionRequest: emit.onToolPermissionRequest
  });
  const { session, sessionManager } = upstream;
  logMockSessionPersistence("mock_delayed", runtime.sessionId, sessionManager);
  sessionManager.appendModelChange(prepared.modelResolution.provider, prepared.modelResolution.resolvedModelId);
  sessionManager.appendThinkingLevelChange("medium");
  sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: input.userMessage }],
    timestamp: Date.now()
  });
  const accumulator = createAgentStreamAccumulatorState();
  const textEvent = { type: "text_delta" as const, text: mockText };
  appendAgentEvents(accumulator, [textEvent]);
  emit.onEvent(textEvent);

  let aborted = false;
  let resolveWait: (() => void) | undefined;
  const waitForAbortOrTimeout = new Promise<void>((resolve) => {
    resolveWait = resolve;
    const timer = setTimeout(() => {
      resolve();
    }, delayMs);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });

  options.registerAbort(runtime.sessionId, async () => {
    aborted = true;
    resolveWait?.();
  });

  try {
    await waitForAbortOrTimeout;
    if (aborted) {
      sessionManager.appendMessage({
        role: "assistant",
        provider: prepared.modelResolution.provider,
        model: prepared.modelResolution.resolvedModelId,
        api: "anthropic-messages",
        stopReason: "aborted",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        content: [{ type: "text", text: mockText }],
        timestamp: Date.now()
      });
      updateAgentSessionMeta(runtime.sessionId, {
        piSessionId: session.sessionId
      });
      emit.onComplete();
      return { status: "aborted" };
    }

    emit.onEvent({
      type: "complete",
      stopReason: "completed",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0
      }
    });
    sessionManager.appendMessage({
      role: "assistant",
      provider: prepared.modelResolution.provider,
      model: prepared.modelResolution.resolvedModelId,
      api: "anthropic-messages",
      stopReason: "stop",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      content: [{ type: "text", text: mockText }],
      timestamp: Date.now()
    });
    updateAgentSessionMeta(runtime.sessionId, {
      piSessionId: session.sessionId
    });
    emit.onComplete();
    return { status: "completed" };
  } finally {
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

function resolveMockDelayMs(): number {
  const raw = process.env.LUME_PI_AGENT_MOCK_DELAY_MS?.trim();
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function shouldRunMockCompaction(userMessage: string): boolean {
  if (process.env.LUME_PI_AGENT_MOCK_COMPACTION !== "1") {
    return false;
  }
  return userMessage.trim() === "/compact";
}

function logMockSessionPersistence(kind: string, sessionId: string, sessionManager: {
  getSessionDir(): string;
  getSessionFile(): string | undefined;
}): void {
  if (process.env.LUME_PI_AGENT_MOCK_TRACE_SESSION !== "1") {
    return;
  }
  log.info("runtime-core mock session persistence", {
    kind,
    sessionId: sessionId.slice(0, 8),
    sessionDir: sessionManager.getSessionDir(),
    sessionFile: sessionManager.getSessionFile()
  });
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
