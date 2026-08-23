import {
  appendSdkMessage,
  createAgentStreamAccumulatorState
} from "./agent-stream-accumulator";
import { createLogger } from "../../infra/logger";
import { waitForAskUserQuestionAnswers } from "../interruption/ask-user-question-session";
import { waitForToolPermissionDecision } from "../interruption/tool-permission-session";
import { getSubagentRunRegistry } from "../../agent/subagents/subagent-run-registry";
import { announceSubagentCompletion } from "../../agent/subagents/subagent-announce-service";
import { createRuntimeCoreSession } from "../runtime-core/run";
import type { AgentRuntimeRunParams, AgentRuntimeRunResult, AgentRuntimeEmitter, RunRuntimeCoreAttemptOptions } from "./types";
import type { resolveRuntimeCoreChannelModel } from "../runtime-core/model";
import type { PreparedRuntimeCoreAttempt } from "./prepare-attempt";
import { updateRuntimeThreadMetaIfPresent } from "../runtime-core/thread-meta-target";

/** mock 场景只消费导出接口的子集；Pick 派生以跟踪字段演进（channelProvider 可选→必填，消费点入参可选，兼容）。 */
type MockPreparedAttempt = Pick<
  PreparedRuntimeCoreAttempt,
  "agentCwd" | "agentDir" | "workspaceName" | "workspaceSlug" | "modelResolution" | "channelProvider" | "apiKey"
>;

const log = createLogger("runtime-core-mock");

/**
 * Resolves a mock handler for the current attempt, if any mock env var is active.
 * Returns `null` when no mock mode is enabled (i.e. production path).
 */
export function resolveMockAttempt(
  input: AgentRuntimeRunParams["input"]
): ((
  params: AgentRuntimeRunParams,
  emit: AgentRuntimeEmitter,
  options: RunRuntimeCoreAttemptOptions,
  prepared: MockPreparedAttempt
) => Promise<AgentRuntimeRunResult>) | null {
  if (process.env.LUME_AGENT_RUNTIME_MOCK_ERROR === "1") {
    return (_params, emit) => Promise.resolve(runRuntimeCoreMockErrorAttempt(emit));
  }
  const mockDelayMs = resolveMockDelayMs();
  if (mockDelayMs > 0) {
    return (params, emit, options, prepared) =>
      runRuntimeCoreMockDelayedAttempt(params, emit, options, mockDelayMs, prepared);
  }
  if (process.env.LUME_AGENT_RUNTIME_MOCK_SUCCESS === "1") {
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
  emit: AgentRuntimeEmitter
): AgentRuntimeRunResult {
  const errorMessage = (process.env.LUME_AGENT_RUNTIME_MOCK_ERROR_TEXT || "runtime-core mock error").trim();
  emit.onError(errorMessage);
  return {
    status: "errored",
    errorMessage
  };
}

export async function runRuntimeCoreMockSuccessAttempt(
  params: AgentRuntimeRunParams,
  emit: AgentRuntimeEmitter,
  prepared: MockPreparedAttempt
): Promise<AgentRuntimeRunResult> {
  const { input, runtime } = params;
  const mockText = (process.env.LUME_AGENT_RUNTIME_MOCK_TEXT || "Lume runtime-core mock success").trim();
  const upstream = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    userMessage: input.userMessage,
    provider: prepared.modelResolution.provider,
    channelProvider: prepared.channelProvider,
    modelRef: runtime.modelRef,
    resolvedModelId: prepared.modelResolution.resolvedModelId,
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
    emitBrowserAuthRequest: emit.onBrowserAuthRequest,
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
    channelProvider: prepared.channelProvider,
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
  const interactiveResult = await runMockInteractiveSessions(runtime.sessionId, emit);
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
  updateRuntimeThreadMetaIfPresent(runtime, {
    runtimeThreadId: session.threadId ?? session.sessionId
  });
  session.dispose();
  emit.onComplete();
  return { status: "completed" };
}

export async function runMockInteractiveSessions(
  threadId: string,
  emit: AgentRuntimeEmitter
): Promise<{ status: "ok" } | { status: "errored"; error: string }> {
  if (process.env.LUME_AGENT_RUNTIME_MOCK_TOOL_PERMISSION === "1") {
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

  if (process.env.LUME_AGENT_RUNTIME_MOCK_ASK_USER_QUESTION === "1") {
    const controller = new AbortController();
    const answerResult = await waitForAskUserQuestionAnswers(
      threadId,
      `mock-ask:${threadId}`,
      [
        {
          header: "范围",
          question: "是否继续执行 smoke interruption？",
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
  if (process.env.LUME_AGENT_RUNTIME_MOCK_SUBAGENT_ANNOUNCE !== "1") {
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
        modelRef: "mock/mock-subagent",
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
        modelRef: "mock/mock-subagent",
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
  params: AgentRuntimeRunParams,
  emit: AgentRuntimeEmitter,
  prepared: MockPreparedAttempt
): Promise<AgentRuntimeRunResult> {
  const { input, runtime } = params;
  const summary = (process.env.LUME_AGENT_RUNTIME_MOCK_COMPACTION_SUMMARY || "mock compaction summary").trim();
  const upstream = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    userMessage: input.userMessage,
    provider: prepared.modelResolution.provider,
    channelProvider: prepared.channelProvider,
    modelRef: runtime.modelRef,
    resolvedModelId: prepared.modelResolution.resolvedModelId,
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
    emitBrowserAuthRequest: emit.onBrowserAuthRequest,
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
  emit.onSdkMessage({
    type: "system",
    subtype: "context_compaction_progress",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 0,
      stage: "summarizing",
      progress: 45,
      message: "正在生成上下文摘要",
      policy: "mock-runtime-core",
      source: "mock-runtime-core"
    }
  } as any);
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
  updateRuntimeThreadMetaIfPresent(runtime, {
    runtimeThreadId: session.threadId ?? session.sessionId
  });
  session.dispose();
  emit.onComplete();
  return { status: "completed" };
}

export async function runRuntimeCoreMockDelayedAttempt(
  params: AgentRuntimeRunParams,
  emit: AgentRuntimeEmitter,
  options: RunRuntimeCoreAttemptOptions,
  delayMs: number,
  prepared: MockPreparedAttempt
): Promise<AgentRuntimeRunResult> {
  const { input, runtime } = params;
  const mockText = (process.env.LUME_AGENT_RUNTIME_MOCK_TEXT || "Lume runtime-core delayed mock").trim();
  const upstream = await createRuntimeCoreSession({
    lumeSessionId: runtime.sessionId,
    cwd: prepared.agentCwd,
    agentDir: prepared.agentDir,
    provider: prepared.modelResolution.provider,
    channelProvider: prepared.channelProvider,
    modelRef: runtime.modelRef,
    resolvedModelId: prepared.modelResolution.resolvedModelId,
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
    emitBrowserAuthRequest: emit.onBrowserAuthRequest,
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
      updateRuntimeThreadMetaIfPresent(runtime, {
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
    updateRuntimeThreadMetaIfPresent(runtime, {
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
  const raw = process.env.LUME_AGENT_RUNTIME_MOCK_DELAY_MS?.trim();
  const parsed = raw ? Number(raw) : 0;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function shouldRunMockCompaction(userMessage: string): boolean {
  if (process.env.LUME_AGENT_RUNTIME_MOCK_COMPACTION !== "1") {
    return false;
  }
  return userMessage.trim() === "/compact";
}

export function logMockSessionPersistence(kind: string, threadId: string, sessionManager: {
  getSessionDir(): string;
  getSessionFile(): string | undefined;
}): void {
  if (process.env.LUME_AGENT_RUNTIME_MOCK_TRACE_SESSION !== "1") {
    return;
  }
  log.info("runtime-core mock session persistence", {
    kind,
    threadId: threadId.slice(0, 8),
    sessionDir: sessionManager.getSessionDir(),
    sessionFile: sessionManager.getSessionFile()
  });
}
