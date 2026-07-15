import { clearQuestionHandler, setQuestionHandler, type CanUseToolFn } from "@lume/agent-sdk";
import type { LumeConfigHooksInternalSection, OpenAiApiMode, SDKMessage } from "@lume/shared";
import type { AgentAskUserQuestionQuestion } from "@lume/shared";
import type { AgentRuntimeRunParams, AgentRuntimeRunResult, AgentRuntimeEmitter } from "./types";
import { resolveAgentThinkingLevel } from "./model-capabilities";
import type { resolveRuntimeCoreChannelModel } from "../runtime-core/model";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import {
  createRuntimeCoreSession,
  type CreateRuntimeCoreSessionInput,
  type CreateRuntimeCoreSessionResult
} from "../runtime-core/run";
import { updateRuntimeThreadMetaIfPresent } from "../runtime-core/thread-meta-target";
import {
  consumeRuntimeCoreQueryStream,
  createObservedRuntimeEmitter,
  normalizeRuntimeCoreQueryPermissionMode
} from "./run-loop";
import { LumeRunObserver } from "./run-observer";
import { fromAgentRuntimeRunResult } from "./run-result";
import { applyResolvedThinkingLevel } from "./thinking-level";
import { appendDaily, appendRunArchive } from "../../memory-v2/markdown-store";
import { resolveMemoryRuntimeConfig } from "../../memory-v2/policy";
import { memoryFileRefForPath } from "../../memory-v2/source-files";
import { extractMemoryCandidatesWithLlm } from "../../memory-v2/extraction";
import { smartAddMemoryV2Candidate } from "../../memory-v2/smart-add";
import type { LumeWorkflowHookEvent } from "../../workflow-hooks/hook-events";
import type { LumeWorkflowHookExecutionResult } from "../../workflow-hooks/hook-effects";
import {
  createLumeWorkflowHookRuntime,
  type LumeWorkflowHookRuntimeLike
} from "../../workflow-hooks/hook-runtime";
import {
  createMemoryWorkflowHookService,
  createRuntimeEventWorkflowHookService,
  createSecurityWorkflowHookService,
  createTraceWorkflowHookService
} from "../../workflow-hooks/hook-services";
import {
  compactMemorySummaryText,
  createMemoryConversationSummarizer,
  summarizeMemoryConversationFallback,
  type MemoryConversationSummarizer
} from "../../memory-v2/conversation-summary";
import type { LumeRunState } from "./run-state";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";

interface PreparedRuntimeCoreAttempt {
  agentCwd: string;
  lumeWorkDir: string;
  filesRoot: string;
  plansRoot: string;
  artifactsRoot: string;
  projectRoot?: string;
  fileContextId: string;
  agentDir: string;
  workspaceName?: string;
  workspaceSlug?: string;
  modelResolution: NonNullable<ReturnType<typeof resolveRuntimeCoreChannelModel>>;
  openaiApiMode?: OpenAiApiMode;
  apiKey: string;
}

interface RunRuntimeCoreAttemptOptions {
  registerAbort: (threadId: string, abort: () => Promise<void>) => void;
  unregisterAbort: (threadId: string) => void;
}

interface RuntimeSessionRunInput {
  params: AgentRuntimeRunParams;
  prepared: PreparedRuntimeCoreAttempt;
  runtimeSession: Pick<CreateRuntimeCoreSessionResult, "agent" | "session" | "tools" | "userMessageForModel" | "memoryContextUsedItems">;
  options: RunRuntimeCoreAttemptOptions;
  createCanUseTool: (
    askUserSignal: AbortSignal,
    workflowHooks?: LumeWorkflowHookRuntimeLike
  ) => CanUseToolFn;
}

interface PreparedRuntimeCoreRunInput {
  params: AgentRuntimeRunParams;
  prepared: PreparedRuntimeCoreAttempt;
  options: RunRuntimeCoreAttemptOptions;
  createCanUseTool: (
    askUserSignal: AbortSignal,
    workflowHooks?: LumeWorkflowHookRuntimeLike
  ) => CanUseToolFn;
  createRuntimeSession?: (input: CreateRuntimeCoreSessionInput) => Promise<CreateRuntimeCoreSessionResult>;
}

export function resolveRuntimeCoreMaxTurns(input: AgentRuntimeRunParams["input"]): number | undefined {
  void input;
  return 80;
}

export class LumeRunner {
  readonly emit: AgentRuntimeEmitter;
  private latestMemoryContextUsedItems: CreateRuntimeCoreSessionResult["memoryContextUsedItems"] = [];

  private constructor(
    private readonly observer: LumeRunObserver,
    emit: AgentRuntimeEmitter,
    private readonly params: AgentRuntimeRunParams,
    private readonly prepared: PreparedRuntimeCoreAttempt,
    private readonly summarizeMemoryConversation: MemoryConversationSummarizer | undefined,
    private readonly workflowHooks: LumeWorkflowHookRuntimeLike | undefined,
    private readonly addMemoryCandidate: typeof smartAddMemoryV2Candidate
  ) {
    this.emit = createObservedRuntimeEmitter(emit, observer);
  }

  static async create(input: {
    params: AgentRuntimeRunParams;
    prepared: PreparedRuntimeCoreAttempt;
    emit: AgentRuntimeEmitter;
    summarizeMemoryConversation?: MemoryConversationSummarizer;
    workflowHooks?: LumeWorkflowHookRuntimeLike | null;
    createWorkflowHooks?: (config: LumeConfigHooksInternalSection) => LumeWorkflowHookRuntimeLike;
    hooksConfig?: LumeConfigHooksInternalSection;
    addMemoryCandidate?: typeof smartAddMemoryV2Candidate;
  }): Promise<LumeRunner> {
    const { params, prepared } = input;
    const observer = await LumeRunObserver.create({
      sessionDir: getRuntimeCoreSessionDir(params.runtime.sessionId, prepared.agentDir),
      threadId: params.runtime.sessionId,
      workspaceId: params.runtime.workspaceId,
      workspaceSlug: prepared.workspaceSlug,
      userMessage: params.runtime.visibleUserMessage ?? params.input.userMessage,
      permissionMode: params.input.permissionMode,
      threadType: params.runtime.threadType,
      chatType: params.input.chatType,
      messageMetadata: params.input.messageMetadata,
      model: {
        provider: prepared.modelResolution.provider,
        modelId: prepared.modelResolution.resolvedModelId,
        modelRef: params.runtime.modelRef,
        channelId: params.runtime.channelId,
        contextWindow: prepared.modelResolution.model.contextWindow
      }
    });
    const workflowHooks = resolveWorkflowHooks({
      explicit: input.workflowHooks,
      hooksConfig: input.hooksConfig ?? getEffectiveLumeConfig(prepared.workspaceSlug).hooks?.internal,
      createWorkflowHooks: input.createWorkflowHooks
    });
    const runner = new LumeRunner(
      observer,
      input.emit,
      params,
      prepared,
      input.summarizeMemoryConversation ?? createMemoryConversationSummarizer({
        workspaceSlug: prepared.workspaceSlug
      }),
      workflowHooks,
      input.addMemoryCandidate ?? smartAddMemoryV2Candidate
    );
    await runner.fireRunBeforeStart();
    return runner;
  }

  getRunId(): string {
    return this.observer.getRunId();
  }

  async finalizeResult(result: AgentRuntimeRunResult): Promise<AgentRuntimeRunResult> {
    const lumeResult = fromAgentRuntimeRunResult(result);
    await this.observer.finalize(lumeResult.status, lumeResult.error);
    return result;
  }

  async finalizeError(error: unknown): Promise<void> {
    await this.fireRunAfterFailure(error instanceof Error ? error.message : String(error));
    await this.observer.finalize("failed", error instanceof Error ? error : String(error));
  }

  async runQueryStream(query: AsyncIterable<SDKMessage>): Promise<AgentRuntimeRunResult> {
    const result = await consumeRuntimeCoreQueryStream({
      query,
      emit: this.emit
    });
    if (result.status === "turn_limited") {
      this.observer.recordTurnLimited(result.errorMessage);
      await this.observer.flush();
      this.emit.onRuntimeEvent?.({
        id: `${this.observer.getRunId()}:run.turn_limited`,
        type: "run.turn_limited",
        threadId: this.observer.getThreadId(),
        runId: this.observer.getRunId(),
        createdAt: new Date().toISOString(),
        reason: result.errorMessage
      });
      return this.finalizeResult(result);
    }
    if (result.status !== "completed") {
      await this.observer.flush();
      this.emit.onRuntimeEvent?.({
        id: `${this.observer.getRunId()}:run.failed`,
        type: "run.failed",
        threadId: this.observer.getThreadId(),
        runId: this.observer.getRunId(),
        createdAt: new Date().toISOString(),
        error: {
          code: "runtime_error",
          message: result.errorMessage
        }
      });
      return this.finalizeResult(result);
    }
    return result;
  }

  async runRuntimeSession({
    params,
    prepared,
    runtimeSession,
    options,
    createCanUseTool
  }: RuntimeSessionRunInput): Promise<AgentRuntimeRunResult> {
    const { input, runtime } = params;
    const { agent, session } = runtimeSession;
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
      await applyResolvedThinkingLevel(agent, thinkingLevel);
      const maxTurns = resolveRuntimeCoreMaxTurns(input);

      const query = agent.query(runtimeSession.userMessageForModel || input.userMessage, {
        canUseTool: createCanUseTool(askUserAbortController.signal, this.workflowHooks),
        permissionMode: normalizeRuntimeCoreQueryPermissionMode(input.permissionMode),
        includePartialMessages: true,
        ...(maxTurns === undefined ? {} : { maxTurns })
      });

      const streamResult = await this.runQueryStream(query);
      if (streamResult.status !== "completed") {
        return streamResult;
      }

      this.emitMemoryContextUsed(runtimeSession.memoryContextUsedItems ?? []);

      updateRuntimeThreadMetaIfPresent(runtime, {
        sdkThreadId: session.threadId ?? session.sessionId,
        runtimeThreadId: session.threadId ?? session.sessionId
      });
      return this.complete();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/abort|interrupted/i.test(errorMessage)) {
        return this.abort();
      }
      return this.fail(errorMessage);
    } finally {
      clearQuestionHandler();
      askUserAbortController.abort();
      await session.dispose();
      options.unregisterAbort(runtime.sessionId);
    }
  }

  async runPreparedRuntimeCoreAttempt({
    params,
    prepared,
    options,
    createCanUseTool,
    createRuntimeSession = createRuntimeCoreSession
  }: PreparedRuntimeCoreRunInput): Promise<AgentRuntimeRunResult> {
    const { input, runtime } = params;
    const runtimeSession = await createRuntimeSession({
      lumeSessionId: runtime.sessionId,
      cwd: prepared.agentCwd,
      lumeWorkDir: prepared.lumeWorkDir,
      filesRoot: prepared.filesRoot,
      plansRoot: prepared.plansRoot,
      artifactsRoot: prepared.artifactsRoot,
      projectRoot: prepared.projectRoot,
      fileContextId: prepared.fileContextId,
      agentDir: prepared.agentDir,
      userMessage: input.userMessage,
      provider: prepared.modelResolution.provider,
      openaiApiMode: prepared.openaiApiMode,
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
      subagentType: runtime.subagentType,
      subagentRunId: runtime.subagentRunId,
      subagentId: runtime.subagentId,
      subagentTaskId: runtime.subagentTaskId,
      subagentAttempt: runtime.subagentAttempt,
      chatType: input.chatType,
      permissionMode: input.permissionMode,
      messageAttachments: input.messageAttachments,
      messageMetadata: input.messageMetadata,
      emitSdkMessage: this.emit.onSdkMessage,
      emitRuntimeEvent: this.emit.onRuntimeEvent,
      emitAskUserQuestion: this.emit.onAskUserQuestion,
      emitBrowserAuthRequest: this.emit.onBrowserAuthRequest,
      emitDesktopActionRequest: this.emit.onDesktopActionRequest,
      emitToolPermissionRequest: this.emit.onToolPermissionRequest,
      emitTaskContractUpdated: this.emit.onTaskContractUpdated,
      emitTodoUpdated: this.emit.onTodoUpdated,
      runId: this.observer.getRunId(),
      workflowHooks: this.workflowHooks,
      applyWorkflowHookEffects: (result) => this.applyWorkflowHookEffects(result),
      trace: this.observer.getContextAssemblyTrace()
    });
    this.latestMemoryContextUsedItems = runtimeSession.memoryContextUsedItems ?? [];

    return this.runRuntimeSession({
      params,
      prepared,
      runtimeSession,
      options,
      createCanUseTool
    });
  }

  async complete(): Promise<AgentRuntimeRunResult> {
    await this.observer.flush();
    const workspaceSlug = this.observer.getWorkspaceSlug();
    const runState = await this.observer.getRunState();
    if (workspaceSlug) {
      try {
        const historySummary = summarizeMemoryConversationFallback({
          userMessage: this.observer.getUserMessage(),
          runState
        });
        appendDaily({
          scope: "workspace",
          workspaceSlug,
          heading: `Run ${this.observer.getRunId()} completed`,
          body: historySummary
        });
        appendRunArchive({
          workspaceSlug,
          runId: this.observer.getRunId(),
          record: {
            type: "run.completed",
            threadId: this.observer.getThreadId(),
            userMessage: compactMemoryHistoryText(this.observer.getUserMessage()),
            summary: historySummary
          }
        });
        this.scheduleConversationSummary(workspaceSlug, runState, historySummary);
        if (!this.workflowHooks) {
          for (const candidate of await extractMemoryCandidatesWithLlm({
            text: this.observer.getUserMessage(),
            workspaceSlug
          })) {
            await smartAddMemoryV2Candidate({
              workspaceSlug,
              candidate: {
                ...candidate,
                evidence: {
                  ...candidate.evidence,
                  runId: this.observer.getRunId()
                }
              }
            });
          }
        }
      } catch {
        // Memory capture must not block completion.
      }
    }
    await this.fireRunAfterComplete(runState);
    this.emit.onRuntimeEvent?.({
      id: `${this.observer.getRunId()}:run.completed`,
      type: "run.completed",
      threadId: this.observer.getThreadId(),
      runId: this.observer.getRunId(),
      createdAt: new Date().toISOString()
    });
    this.emit.onComplete();
    return this.finalizeResult({ status: "completed" });
  }

  private scheduleConversationSummary(
    workspaceSlug: string,
    runState: LumeRunState | null,
    fallbackSummary: string
  ): void {
    if (!this.summarizeMemoryConversation || !runState) return;
    void this.writeConversationSummary(workspaceSlug, runState, fallbackSummary);
  }

  private async writeConversationSummary(
    workspaceSlug: string,
    runState: LumeRunState,
    fallbackSummary: string
  ): Promise<void> {
    try {
      const generated = await this.summarizeMemoryConversation?.({
        workspaceSlug,
        runId: this.observer.getRunId(),
        threadId: this.observer.getThreadId(),
        userMessage: this.observer.getUserMessage(),
        runState,
        fallbackSummary
      });
      const summary = compactMemorySummaryText(generated ?? "", 700);
      if (!summary || summary === compactMemorySummaryText(fallbackSummary, 700)) return;
      appendDaily({
        scope: "workspace",
        workspaceSlug,
        heading: `Run ${this.observer.getRunId()} summarized`,
        body: summary
      });
      appendRunArchive({
        workspaceSlug,
        runId: this.observer.getRunId(),
        record: {
          type: "run.summary.generated",
          summary
        }
      });
    } catch {
      // Background memory summaries are best-effort.
    }
  }

  private emitMemoryContextUsed(items: CreateRuntimeCoreSessionResult["memoryContextUsedItems"]): void {
    if (items.length === 0) return;
    if (resolveMemoryRuntimeConfig().citationsMode === "off") return;
    const event = {
      id: `${this.observer.getRunId()}:memory-context-used:memory.context.used`,
      type: "memory.context.used",
      threadId: this.observer.getThreadId(),
      runId: this.observer.getRunId(),
      createdAt: new Date().toISOString(),
      items: items.map((item) => ({
        id: item.id,
        kind: item.kind,
        scope: item.scope,
        status: item.status,
        citation: item.citation,
        ...(() => {
          const fileRef = memoryFileRefForPath({
            scope: item.scope,
            workspaceSlug: this.observer.getWorkspaceSlug(),
            path: item.citation
          });
          return fileRef ? { fileRef } : {};
        })(),
        reason: item.reason,
        ...(item.claim ? { claim: item.claim } : {})
      })),
      hidden: true
    } as const;
    this.observer.recordMemoryContextUsed(event);
    this.emit.onRuntimeEvent?.(event);
  }

  async abort(): Promise<AgentRuntimeRunResult> {
    await this.observer.flush();
    this.emit.onRuntimeEvent?.({
      id: `${this.observer.getRunId()}:run.cancelled`,
      type: "run.cancelled",
      threadId: this.observer.getThreadId(),
      runId: this.observer.getRunId(),
      createdAt: new Date().toISOString()
    });
    this.emit.onComplete();
    return this.finalizeResult({ status: "aborted" });
  }

  async fail(errorMessage: string): Promise<AgentRuntimeRunResult> {
    await this.fireRunAfterFailure(errorMessage);
    await this.observer.flush();
    this.emit.onError(errorMessage);
    this.emit.onRuntimeEvent?.({
      id: `${this.observer.getRunId()}:run.failed`,
      type: "run.failed",
      threadId: this.observer.getThreadId(),
      runId: this.observer.getRunId(),
      createdAt: new Date().toISOString(),
      error: {
        code: "runtime_error",
        message: errorMessage
      }
    });
    return this.finalizeResult({ status: "errored", errorMessage });
  }

  private async fireRunBeforeStart(): Promise<void> {
    await this.executeWorkflowHook({
      ...this.buildHookEventBase(),
      event: "run.beforeStart",
      userMessage: this.observer.getUserMessage()
    });
  }

  private async fireRunAfterComplete(runState: LumeRunState | null): Promise<void> {
    await this.executeWorkflowHook({
      ...this.buildHookEventBase(),
      event: "run.afterComplete",
      userMessage: this.observer.getUserMessage(),
      runStateSummary: {
        status: runState?.status ?? "completed",
        generatedItemCount: runState?.generatedItems.length ?? 0,
        pendingInterruptionCount: runState?.pendingInterruptions.length ?? 0
      },
      usage: runState?.usage,
      memoryContextUsedItems: this.latestMemoryContextUsedItems
    });
  }

  private async fireRunAfterFailure(errorMessage: string): Promise<void> {
    await this.executeWorkflowHook({
      ...this.buildHookEventBase(),
      event: "run.afterFailure",
      userMessage: this.observer.getUserMessage(),
      errorMessage
    });
  }

  private buildHookEventBase(): Omit<LumeWorkflowHookEvent, "event"> {
    return {
      runId: this.observer.getRunId(),
      threadId: this.observer.getThreadId(),
      workspaceId: this.params.runtime.workspaceId,
      workspaceSlug: this.prepared.workspaceSlug,
      cwd: this.prepared.agentCwd,
      permissionMode: this.params.input.permissionMode,
      threadType: this.params.runtime.threadType,
      chatType: this.params.input.chatType,
      messageMetadata: this.params.input.messageMetadata
    } as Omit<LumeWorkflowHookEvent, "event">;
  }

  private async executeWorkflowHook(event: LumeWorkflowHookEvent): Promise<void> {
    if (!this.workflowHooks) return;
    try {
      const result = await this.workflowHooks.execute(event);
      await this.applyWorkflowHookEffects(result);
    } catch {
      // Workflow hooks are observe-only at the runner boundary.
    }
  }

  private async applyWorkflowHookEffects(result: LumeWorkflowHookExecutionResult): Promise<void> {
    for (const envelope of result.effects) {
      if (envelope.effect.type === "emitRuntimeEvent") {
        this.emit.onRuntimeEvent?.({
          id: `${this.observer.getRunId()}:${envelope.sourceContributionId}:${envelope.effect.event.type}`,
          createdAt: envelope.createdAt,
          ...envelope.effect.event,
          runId: this.observer.getRunId(),
          threadId: this.observer.getThreadId()
        } as any);
      }
      if (envelope.effect.type === "recordTrace") {
        await this.observer.recordWorkflowHookTrace({
          sourceContributionId: envelope.sourceContributionId,
          createdAt: envelope.createdAt,
          record: envelope.effect.record
        });
      }
      if (envelope.effect.type === "enqueueMemoryCandidate") {
        const workspaceSlug = this.observer.getWorkspaceSlug();
        if (!workspaceSlug) continue;
        for (const candidate of envelope.effect.candidates) {
          await this.addMemoryCandidate({
            workspaceSlug,
            candidate: {
              ...candidate,
              evidence: {
                ...(candidate.evidence ?? {}),
                runId: candidate.evidence?.runId ?? this.observer.getRunId()
              }
            }
          });
        }
      }
    }
  }
}

function compactMemoryHistoryText(value: string, maxLength = 220): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function resolveWorkflowHooks(input: {
  explicit?: LumeWorkflowHookRuntimeLike | null;
  hooksConfig?: LumeConfigHooksInternalSection;
  createWorkflowHooks?: (config: LumeConfigHooksInternalSection) => LumeWorkflowHookRuntimeLike;
}): LumeWorkflowHookRuntimeLike | undefined {
  if (input.explicit !== undefined) return input.explicit ?? undefined;
  const config = input.hooksConfig ?? {
    enabled: true,
    memory: true,
    security: true,
    observability: true
  };
  if (config.enabled === false) return undefined;
  if (input.createWorkflowHooks) return input.createWorkflowHooks(config);
  return createLumeWorkflowHookRuntime({
    config,
    services: {
      memory: createMemoryWorkflowHookService(),
      security: createSecurityWorkflowHookService(),
      runtimeEvents: createRuntimeEventWorkflowHookService(),
      trace: createTraceWorkflowHookService(),
      clock: { now: () => new Date() }
    }
  });
}
