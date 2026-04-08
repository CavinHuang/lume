import { updateAgentSessionMeta } from "../../agent/agent-session-manager";
import {
  appendSdkMessage,
  createAgentStreamAccumulatorState
} from "../../agent/agent-stream-accumulator";
import { createLogger } from "../../infra/logger";
import { waitForPiAskUserQuestionAnswers } from "../tools/bridges/ask-user-question-bridge";
import { waitForToolPermissionDecision } from "../tools/bridges/tool-permission-bridge";
import { getSubagentRunRegistry } from "../subagents/subagent-run-registry";
import { announceSubagentCompletion } from "../subagents/subagent-announce-service";
import { createRuntimeCoreSession } from "./run";
import type { PiAgentRunParams, PiAgentRunResult, PiAgentRuntimeEmitter } from "../runner/types";
import type { resolveRuntimeCoreChannelModel } from "./model";

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

const log = createLogger("pi-agent-runtime-core-mock");

/**
 * Resolves a mock handler for the current attempt, if any mock env var is active.
 * Returns `null` when no mock mode is enabled (i.e. production path).
 */
export function resolveMockAttempt(
  input: PiAgentRunParams["input"]
): ((
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  options: RunRuntimeCoreAttemptOptions,
  prepared: PreparedRuntimeCoreAttempt
) => Promise<PiAgentRunResult>) | null {
  if (process.env.LUME_PI_AGENT_MOCK_ERROR === "1") {
    return (_params, emit) => Promise.resolve(runRuntimeCoreMockErrorAttempt(emit));
  }
  const mockDelayMs = resolveMockDelayMs();
  if (mockDelayMs > 0) {
    return (params, emit, options, prepared) =>
      runRuntimeCoreMockDelayedAttempt(params, emit, options, mockDelayMs, prepared);
  }
  if (process.env.LUME_PI_AGENT_MOCK_SUCCESS === "1") {
    if (shouldRunMockCompaction(input.userMessage)) {
      return (params, emit, _options, prepared) =>
        runRuntimeCoreMockCompactionAttempt(params, emit, prepared);
    }
    return (params, emit, _options, prepared) =>
      runRuntimeCoreMockSuccessAttempt(params, emit, prepared);
  }
  return null;
}

// ─── Mock implementations ───

export function runRuntimeCoreMockErrorAttempt(
  emit: PiAgentRuntimeEmitter
): PiAgentRunResult {
  const errorMessage = (process.env.LUME_PI_AGENT_MOCK_ERROR_TEXT || "runtime-core mock error").trim();
  emit.onError(errorMessage);
  return {
    status: "errored",
    errorMessage
  };
}

export async function runRuntimeCoreMockSuccessAttempt(
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
    userMessage: input.userMessage,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resolvedModel: prepared.modelResolution.model,
    apiKey: prepared.apiKey,
    workspaceId: runtime.workspaceId,
    workspaceName: prepared.workspaceName,
    workspaceSlug: prepared.workspaceSlug,
    channelId: runtime.channelId,
    threadType: runtime.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    messageMetadata: input.messageMetadata,
    emitAskUserQuestion: emit.onAskUserQuestion,
    emitToolPermissionRequest: emit.onToolPermissionRequest
  });
  const { session, sessionManager } = upstream;
  logMockSessionPersistence("mock_success", runtime.sessionId, sessionManager);
  const accumulator = createAgentStreamAccumulatorState();
  appendSdkMessage(accumulator, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: mockText }]
    }
  } as any);
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
  emit.onSdkMessage({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: mockText }]
    }
  } as any);
  emit.onSdkMessage({
    type: "result",
    stop_reason: "completed",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  } as any);
  updateAgentSessionMeta(runtime.sessionId, {
    runtimeThreadId: session.threadId ?? session.sessionId
  });
  session.dispose();
  emit.onComplete();
  return { status: "completed" };
}

export async function runMockInteractiveBridges(
  threadId: string,
  emit: PiAgentRuntimeEmitter
): Promise<{ status: "ok" } | { status: "errored"; error: string }> {
  if (process.env.LUME_PI_AGENT_MOCK_TOOL_PERMISSION === "1") {
    const controller = new AbortController();
    const decision = await waitForToolPermissionDecision(
      {
        threadId,
        requestId: `mock-permission:${threadId}`,
        toolUseId: `mock-tool-use:${threadId}`,
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
      threadId,
      `mock-ask:${threadId}`,
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

export async function maybeEmitMockSubagentAnnounce(threadId: string): Promise<void> {
  if (process.env.LUME_PI_AGENT_MOCK_SUBAGENT_ANNOUNCE !== "1") {
    return;
  }
  const runId = `mock-subagent-run:${threadId}`;
  const registry = getSubagentRunRegistry();
  if (!registry.get(runId)) {
    registry.create({
      runId,
      parentThreadId: threadId,
      rootThreadId: threadId,
      childThreadId: `mock-child-session:${threadId}`,
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
      parentThreadId: threadId,
      rootThreadId: threadId,
      depth: 1,
      childThreadId: `mock-child-session:${threadId}`,
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

export async function runRuntimeCoreMockCompactionAttempt(
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
    userMessage: input.userMessage,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resolvedModel: prepared.modelResolution.model,
    apiKey: prepared.apiKey,
    workspaceId: runtime.workspaceId,
    workspaceName: prepared.workspaceName,
    workspaceSlug: prepared.workspaceSlug,
    channelId: runtime.channelId,
    threadType: runtime.threadType,
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
  emit.onSdkMessage({ type: "system", subtype: "compact_boundary" } as any);
  sessionManager.appendCompaction(summary, currentLeafId, 0, {
    source: "mock-runtime-core"
  });
  emit.onSdkMessage({
    type: "result",
    stop_reason: "completed",
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0
    }
  } as any);
  updateAgentSessionMeta(runtime.sessionId, {
    runtimeThreadId: session.threadId ?? session.sessionId
  });
  session.dispose();
  emit.onComplete();
  return { status: "completed" };
}

export async function runRuntimeCoreMockDelayedAttempt(
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
    threadType: runtime.threadType,
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
  appendSdkMessage(accumulator, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: mockText }]
    }
  } as any);
  emit.onSdkMessage({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "text", text: mockText }]
    }
  } as any);

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
        runtimeThreadId: session.threadId ?? session.sessionId
      });
      emit.onComplete();
      return { status: "aborted" };
    }

    emit.onSdkMessage({
      type: "result",
      stop_reason: "completed",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0
      }
    } as any);
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
      runtimeThreadId: session.threadId ?? session.sessionId
    });
    emit.onComplete();
    return { status: "completed" };
  } finally {
    session.dispose();
    options.unregisterAbort(runtime.sessionId);
  }
}

export function resolveMockDelayMs(): number {
  const raw = process.env.LUME_PI_AGENT_MOCK_DELAY_MS?.trim();
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function shouldRunMockCompaction(userMessage: string): boolean {
  if (process.env.LUME_PI_AGENT_MOCK_COMPACTION !== "1") {
    return false;
  }
  return userMessage.trim() === "/compact";
}

export function logMockSessionPersistence(kind: string, threadId: string, sessionManager: {
  getSessionDir(): string;
  getSessionFile(): string | undefined;
}): void {
  if (process.env.LUME_PI_AGENT_MOCK_TRACE_SESSION !== "1") {
    return;
  }
  log.info("runtime-core mock session persistence", {
    kind,
    threadId: threadId.slice(0, 8),
    sessionDir: sessionManager.getSessionDir(),
    sessionFile: sessionManager.getSessionFile()
  });
}





