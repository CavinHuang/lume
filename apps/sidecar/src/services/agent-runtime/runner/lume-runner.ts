import { clearQuestionHandler, setQuestionHandler, type ApiType, type CanUseToolFn, type FileCheckpoint, type SandboxSettings } from "@lume/agent-sdk";
import { createHash } from "node:crypto";
import type { AdvisorReviewedDetail, LumeConfigHooksInternalSection, OpenAiApiMode, SDKMessage } from "@lume/shared";
import type { AgentAskUserQuestionQuestion } from "@lume/shared";
import type { AgentRuntimeRunParams, AgentRuntimeRunResult, AgentRuntimeEmitter } from "./types";
import { resolveAgentThinkingLevel } from "./model-capabilities";
import type { resolveRuntimeCoreChannelModel } from "../runtime-core/model";
import { getRuntimeCoreSessionDir } from "../runtime-core/session-store";
import { persistCodingRunCheckpoint } from "../runtime-core/coding-run-checkpoint-service";
import {
  createRuntimeCoreSession,
  type CreateRuntimeCoreSessionInput,
  type CreateRuntimeCoreSessionResult
} from "../runtime-core/run";
import { updateRuntimeThreadMetaIfPresent } from "../runtime-core/thread-meta-target";
import {
  consumeRuntimeCoreQueryStream,
  createObservedRuntimeEmitter,
  isAgentLifecycleEventsEnabled,
  normalizeRuntimeCoreQueryPermissionMode
} from "./run-loop";
import { getThreadEventBus } from "../events/thread-event-bus";
import { createLogger } from "../../infra/logger";
import { LumeRunObserver } from "./run-observer";
import { fromAgentRuntimeRunResult } from "./run-result";
import { applyResolvedThinkingLevel } from "./thinking-level";
import { appendDaily, appendRunArchive } from "../../memory-v2/markdown-store";
import { resolveMemoryRuntimeConfig } from "../../memory-v2/policy";
import { memoryFileRefForPath } from "../../memory-v2/source-files";
import { enqueueBackgroundMemoryExtraction } from "../../memory-v2/background-extractor";
import { smartAddMemoryV2Candidate } from "../../memory-v2/smart-add";
import type { LumeWorkflowHookEvent } from "../../workflow-hooks/hook-events";
import type { LumeWorkflowHookExecutionResult } from "../../workflow-hooks/hook-effects";
import {
  createLumeWorkflowHookRuntime,
  type LumeWorkflowHookRuntimeLike
} from "../../workflow-hooks/hook-runtime";
import {
  createMemoryWorkflowHookService,
  createPersonaWorkflowHookService,
  createRuntimeEventWorkflowHookService,
  createSecurityWorkflowHookService,
  createSuggestionWorkflowHookService,
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
import { createWikiProtectedSandbox, resolveWikiRuntimeCapability } from "../../wiki/wiki-runtime-capability";
import { WIKI_CAPABILITIES } from "../../wiki/wiki-capabilities";
import { resolveConfiguredAdditionalDirectories } from "../permissions/permission-config";

const log = createLogger("lume-runner");

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
  apiType?: ApiType;
  channelProvider: string;
  apiKey: string;
}

interface RunRuntimeCoreAttemptOptions {
  registerAbort: (threadId: string, abort: () => Promise<void>) => void;
  unregisterAbort: (threadId: string) => void;
}

interface RuntimeSessionRunInput {
  params: AgentRuntimeRunParams;
  prepared: PreparedRuntimeCoreAttempt;
  runtimeSession: Pick<CreateRuntimeCoreSessionResult, "agent" | "session" | "tools" | "userMessageForModel" | "memoryContextUsedItems">
    & Partial<Pick<CreateRuntimeCoreSessionResult, "getVerificationStatus" | "getVerificationReport" | "refreshCodingChangeSet" | "getLatestFileCheckpoint" | "getBaselineCommit" | "getBaselineCommits" | "getWorkspaceRoots">>;
  options: RunRuntimeCoreAttemptOptions;
  sandbox?: SandboxSettings;
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
  const requested = input.messageMetadata?.maxTurns;
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return Math.max(1, Math.min(80, Math.trunc(requested)));
  }
  return 80;
}

/**
 * 批次5 第二入口:advisor 审查结论在旧路(recordAdvisorReview → run items →
 * advisor.reviewed RuntimeEvent)之外,flag on 时经 ThreadEventBus 再发一份
 * advisor.reviewed 领域事件——detail.review 为旧路 payload 同引用
 * (severity/summary/details?/modelRef/durationMs)。flag off 时零行为。
 */
export function publishAdvisorReviewedToBus(input: {
  sessionDir: string;
  threadId: string;
  runId: string;
  review: {
    severity: "clear" | "suggestion" | "concern" | "blocker";
    summary: string;
    details?: string;
    modelRef: string;
    durationMs: number;
  };
}): void {
  if (!isAgentLifecycleEventsEnabled()) return;
  const detail: AdvisorReviewedDetail = { type: "advisor.reviewed", review: input.review };
  if (input.review.summary) detail.summary = input.review.summary;
  void getThreadEventBus(input.sessionDir)
    .publish(input.threadId, input.runId, {
      runId: input.runId,
      turnId: null,
      ts: Date.now(),
      kind: "run",
      phase: "event",
      detail
    })
    .catch((error) => {
      log.warn("advisor.reviewed 总线 publish 失败", {
        threadId: input.threadId,
        runId: input.runId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
}

export class LumeRunner {
  readonly emit: AgentRuntimeEmitter;
  private latestMemoryContextUsedItems: CreateRuntimeCoreSessionResult["memoryContextUsedItems"] = [];
  private latestModelVisibleMessage = "";

  private constructor(
    private readonly observer: LumeRunObserver,
    emit: AgentRuntimeEmitter,
    private readonly params: AgentRuntimeRunParams,
    private readonly prepared: PreparedRuntimeCoreAttempt,
    private readonly summarizeMemoryConversation: MemoryConversationSummarizer | undefined,
    private readonly workflowHooks: LumeWorkflowHookRuntimeLike | undefined,
    private readonly addMemoryCandidate: typeof smartAddMemoryV2Candidate
  ) {
    this.emit = createObservedRuntimeEmitter(emit, observer, {
      sessionDir: getRuntimeCoreSessionDir(params.runtime.sessionId, prepared.agentDir)
    });
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
      fileReferenceBinding: params.runtime.fileReferenceBinding,
      userMessage: params.runtime.visibleUserMessage ?? params.input.userMessage,
      permissionMode: params.input.permissionMode,
      threadType: params.runtime.threadType,
      chatType: params.input.chatType,
      messageMetadata: params.input.messageMetadata,
      traceContext: params.input.traceContext,
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
    await this.observer.finalize(lumeResult.status, lumeResult.error, lumeResult.verificationStatus, lumeResult.codingReport);
    return result;
  }

  async finalizeError(error: unknown): Promise<void> {
    await this.fireRunAfterFailure(error instanceof Error ? error.message : String(error));
    await this.observer.finalize("failed", error instanceof Error ? error : String(error));
  }

  async runQueryStream(
    query: AsyncIterable<SDKMessage>,
    coding?: {
      getVerificationStatus?: () => AgentRuntimeRunResult["verificationStatus"];
      getVerificationReport?: () => AgentRuntimeRunResult["codingReport"];
      refreshCodingChangeSet?: () => Promise<unknown>;
      getLatestFileCheckpoint?: () => FileCheckpoint | undefined;
      getBaselineCommit?: () => string | undefined;
      getBaselineCommits?: () => Record<string, string>;
      getWorkspaceRoots?: () => string[];
    }
  ): Promise<AgentRuntimeRunResult> {
    const result = await consumeRuntimeCoreQueryStream({
      query,
      emit: this.emit,
      // flag off 时 consume 内部不启用，这里只提供投影所需的线程上下文
      lifecycle: {
        threadId: this.params.runtime.sessionId,
        sessionDir: getRuntimeCoreSessionDir(this.params.runtime.sessionId, this.prepared.agentDir),
        runId: this.observer.getRunId()
      }
    });
    // Soft abort no longer throws from the SDK: it fills interrupted tool
    // placeholders and ends with an error result. Classify by the abort signal
    // so a user stop finalizes as cancelled, not failed.
    if (result.status === "errored" && this.params.runtime.abortSignal?.aborted) {
      return this.abort();
    }
    await coding?.refreshCodingChangeSet?.();
    const verificationReport = coding?.getVerificationReport?.();
    const checkpoint = coding?.getLatestFileCheckpoint?.();
    let canRewind = false;
    if (checkpoint) {
      try {
        canRewind = await persistCodingRunCheckpoint({
          sessionDir: getRuntimeCoreSessionDir(this.params.runtime.sessionId, this.prepared.agentDir),
          runId: this.observer.getRunId(),
          cwd: this.prepared.agentCwd,
          roots: [
            ...(coding?.getWorkspaceRoots?.() ?? []),
            this.prepared.projectRoot,
            this.prepared.lumeWorkDir,
          ].filter((root): root is string => Boolean(root)),
          baselineCommit: coding?.getBaselineCommit?.(),
          baselineCommits: coding?.getBaselineCommits?.(),
          changedPaths: verificationReport?.changedFiles ?? [],
          checkpoint,
        });
      } catch {
        // A missing rewind record must not change the agent result.
      }
    }
    const resultWithCoding = {
      ...result,
      ...(coding?.getVerificationStatus ? { verificationStatus: coding.getVerificationStatus() } : {}),
      ...(verificationReport ? {
        codingReport: {
          ...verificationReport,
          runId: this.observer.getRunId(),
          checkpointId: canRewind ? this.observer.getRunId() : undefined,
          rewindState: verificationReport.gitActions?.some((action) => action.kind === "commit" && action.status === "completed")
            ? "committed_boundary"
            : canRewind ? "available" : "unavailable",
          // A commit only makes the affected repository files non-rewindable.
          // Other roots can still be restored from the same Turn checkpoint.
          canRewind,
        }
      } : {})
    } satisfies AgentRuntimeRunResult;
    if (resultWithCoding.status === "turn_limited") {
      this.observer.recordTurnLimited(resultWithCoding.errorMessage);
      await this.observer.flush();
      this.emit.onRuntimeEvent?.({
        id: `${this.observer.getRunId()}:run.turn_limited`,
        type: "run.turn_limited",
        threadId: this.observer.getThreadId(),
        runId: this.observer.getRunId(),
        createdAt: new Date().toISOString(),
        reason: resultWithCoding.errorMessage,
        ...(resultWithCoding.verificationStatus ? { verificationStatus: resultWithCoding.verificationStatus } : {}),
        ...(resultWithCoding.codingReport ? { codingReport: resultWithCoding.codingReport } : {})
      });
      return this.finalizeResult(resultWithCoding);
    }
    if (resultWithCoding.status !== "completed") {
      await this.observer.flush();
      this.emit.onRuntimeEvent?.({
        id: `${this.observer.getRunId()}:run.failed`,
        type: "run.failed",
        threadId: this.observer.getThreadId(),
        runId: this.observer.getRunId(),
        createdAt: new Date().toISOString(),
        error: {
          code: "runtime_error",
          message: resultWithCoding.errorMessage
        },
        ...(resultWithCoding.verificationStatus ? { verificationStatus: resultWithCoding.verificationStatus } : {}),
        ...(resultWithCoding.codingReport ? { codingReport: resultWithCoding.codingReport } : {})
      });
      return this.finalizeResult(resultWithCoding);
    }
    return resultWithCoding;
  }

  async runRuntimeSession({
    params,
    prepared,
    runtimeSession,
    options,
    sandbox,
    createCanUseTool
  }: RuntimeSessionRunInput): Promise<AgentRuntimeRunResult> {
    const { input, runtime } = params;
    const { agent, session } = runtimeSession;
    const askUserAbortController = new AbortController();
    let abortPromise: Promise<void> | undefined;
    const abortRuntime = () => {
      abortPromise ??= (async () => {
        askUserAbortController.abort();
        await agent.interrupt();
      })();
      return abortPromise;
    };
    const onParentAbort = () => {
      void abortRuntime().catch(() => undefined);
    };

    options.registerAbort(runtime.sessionId, abortRuntime);
    runtime.abortSignal?.addEventListener("abort", onParentAbort, { once: true });

    try {
      if (runtime.abortSignal?.aborted) {
        await abortRuntime();
      }
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

      const canUseTool = createContinuationPermissionHandler(
        createCanUseTool(askUserAbortController.signal, this.workflowHooks),
        input.messageMetadata,
      );
      const query = agent.query(runtimeSession.userMessageForModel || input.userMessage, {
        canUseTool,
        permissionMode: normalizeRuntimeCoreQueryPermissionMode(input.permissionMode),
        includePartialMessages: true,
        sandbox: sandbox ?? createWikiProtectedSandbox(),
        ...(runtime.abortSignal ? { abortSignal: runtime.abortSignal } : {}),
        ...(maxTurns === undefined ? {} : { maxTurns })
      });

      const streamResult = await this.runQueryStream(query, {
        getVerificationStatus: runtimeSession.getVerificationStatus,
        getVerificationReport: runtimeSession.getVerificationReport,
        refreshCodingChangeSet: runtimeSession.refreshCodingChangeSet,
        getLatestFileCheckpoint: runtimeSession.getLatestFileCheckpoint,
        getBaselineCommit: runtimeSession.getBaselineCommit,
        getBaselineCommits: runtimeSession.getBaselineCommits,
        getWorkspaceRoots: runtimeSession.getWorkspaceRoots
      });
      if (streamResult.status !== "completed") {
        return streamResult;
      }

      this.emitMemoryContextUsed(runtimeSession.memoryContextUsedItems ?? []);

      updateRuntimeThreadMetaIfPresent(runtime, {
        sdkThreadId: session.threadId ?? session.sessionId,
        runtimeThreadId: session.threadId ?? session.sessionId
      });
      await runtimeSession.refreshCodingChangeSet?.();
      return this.complete(
        streamResult.verificationStatus ?? runtimeSession.getVerificationStatus?.(),
        streamResult.codingReport ?? runtimeSession.getVerificationReport?.(),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/abort|interrupted/i.test(errorMessage)) {
        return this.abort();
      }
      return this.fail(errorMessage);
    } finally {
      clearQuestionHandler();
      askUserAbortController.abort();
      runtime.abortSignal?.removeEventListener("abort", onParentAbort);
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
    if (runtime.abortSignal?.aborted) return this.abort();
    const wikiCapability = await resolveWikiRuntimeCapability({
      threadId: runtime.sessionId,
      cwd: prepared.agentCwd,
      lumeWorkDir: prepared.lumeWorkDir,
      filesRoot: prepared.filesRoot,
      plansRoot: prepared.plansRoot,
      artifactsRoot: prepared.artifactsRoot,
      workspaceId: runtime.workspaceId,
      threadType: runtime.threadType,
      chatType: input.chatType
    });
    if (runtime.abortSignal?.aborted) return this.abort();
    const runtimeSession = await createRuntimeSession({
      lumeSessionId: runtime.sessionId,
      cwd: prepared.agentCwd,
      lumeWorkDir: prepared.lumeWorkDir,
      filesRoot: prepared.filesRoot,
      plansRoot: prepared.plansRoot,
      artifactsRoot: prepared.artifactsRoot,
      projectRoot: prepared.projectRoot,
      additionalDirectories: resolveConfiguredAdditionalDirectories(
        getEffectiveLumeConfig(prepared.workspaceSlug).permissions?.privateWriteRoots,
        prepared.agentCwd,
      ),
      fileContextId: prepared.fileContextId,
      fileReferenceBinding: runtime.fileReferenceBinding,
      agentDir: prepared.agentDir,
      userMessage: input.userMessage,
      messageParts: input.messageParts,
      provider: prepared.modelResolution.provider,
      channelProvider: prepared.channelProvider,
      openaiApiMode: prepared.openaiApiMode,
      apiType: prepared.apiType,
      modelRef: runtime.modelRef,
      resolvedModelId: prepared.modelResolution.resolvedModelId,
      resolvedModel: {
        id: prepared.modelResolution.model.id,
        provider: prepared.modelResolution.model.provider,
        baseUrl: prepared.modelResolution.model.baseUrl,
        contextWindow: prepared.modelResolution.model.contextWindow,
        maxTokens: prepared.modelResolution.model.maxTokens,
        input: prepared.modelResolution.model.input,
        reasoning: prepared.modelResolution.model.reasoning
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
      commentAttachments: input.commentAttachments,
      browserAttachments: input.browserAttachments,
      messageMetadata: input.messageMetadata,
      planningClientSubmissionId: input.trustedPlanningClientSubmissionId,
      emitSdkMessage: this.emit.onSdkMessage,
      emitRuntimeEvent: this.emit.onRuntimeEvent,
      persistCodingReport: (report) => this.observer.recordCodingReport(report),
      emitAdvisorReview: (review) => {
        this.observer.recordAdvisorReview(review, this.emit.onRuntimeEvent);
        // 批次5 第二入口:advisor.reviewed 领域事件经 ThreadEventBus 双发(与旧路互不替代)
        publishAdvisorReviewedToBus({
          sessionDir: getRuntimeCoreSessionDir(this.params.runtime.sessionId, this.prepared.agentDir),
          threadId: this.observer.getThreadId(),
          runId: this.observer.getRunId(),
          review
        });
      },
      emitAskUserQuestion: this.emit.onAskUserQuestion,
      emitBrowserAuthRequest: this.emit.onBrowserAuthRequest,
      emitDesktopActionRequest: this.emit.onDesktopActionRequest,
      emitToolPermissionRequest: this.emit.onToolPermissionRequest,
      emitTodoUpdated: this.emit.onTodoUpdated,
      runId: this.observer.getRunId(),
      workflowHooks: this.workflowHooks,
      applyWorkflowHookEffects: (result) => this.applyWorkflowHookEffects(result),
      trace: this.observer.getContextAssemblyTrace(),
      wikiProposalEnabled: WIKI_CAPABILITIES.askWikiProposal,
      processSandbox: wikiCapability.sandbox,
      abortSignal: runtime.abortSignal
    });
    this.latestMemoryContextUsedItems = runtimeSession.memoryContextUsedItems ?? [];
    this.latestModelVisibleMessage = typeof runtimeSession.userMessageForModel === "string"
      ? runtimeSession.userMessageForModel
      : "";

    return this.runRuntimeSession({
      params,
      prepared,
      runtimeSession,
      options,
      sandbox: wikiCapability.sandbox,
      createCanUseTool
    });
  }

  async complete(verificationStatus?: AgentRuntimeRunResult["verificationStatus"], codingReport?: AgentRuntimeRunResult["codingReport"]): Promise<AgentRuntimeRunResult> {
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
            threadType: this.params.runtime.threadType,
            chatType: this.params.input.chatType,
            userMessage: compactMemoryHistoryText(this.observer.getUserMessage()),
            summary: historySummary
          }
        });
        this.scheduleConversationSummary(workspaceSlug, runState, historySummary);
        if (!this.workflowHooks && runState) {
          enqueueBackgroundMemoryExtraction({
            threadId: this.observer.getThreadId(),
            runId: this.observer.getRunId(),
            workspaceSlug,
            modelRef: runState.model.modelRef,
            modelVisibleMessage: this.latestModelVisibleMessage,
            threadType: this.params.runtime.threadType,
            chatType: this.params.input.chatType,
            items: this.memoryExtractionRunItems(runState)
          });
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
      createdAt: new Date().toISOString(),
      ...(verificationStatus ? { verificationStatus } : {}),
      ...(codingReport ? { codingReport } : {})
    });
    this.emit.onComplete();
    return this.finalizeResult({ status: "completed", verificationStatus, codingReport });
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
    // 第二注入路径:flag on 时同一 items 经 ThreadEventBus 再发一份(run 级领域事件),
    // 与旧路双发互不替代;sessionDir 与 run-loop tee 一致,保证同一 bus 单例与单调 seq。
    if (isAgentLifecycleEventsEnabled()) {
      const threadId = this.observer.getThreadId();
      const runId = this.observer.getRunId();
      void getThreadEventBus(getRuntimeCoreSessionDir(this.params.runtime.sessionId, this.prepared.agentDir))
        .publish(threadId, runId, {
          runId,
          turnId: null,
          ts: Date.now(),
          kind: "run",
          phase: "event",
          detail: { type: "memory.context.used", items: event.items }
        })
        .catch((error) => {
          log.warn("memory.context.used 总线 publish 失败", {
            threadId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }
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
      memoryContextUsedItems: this.latestMemoryContextUsedItems,
      modelVisibleMessage: this.latestModelVisibleMessage,
      runItems: this.memoryExtractionRunItems(runState)
    });
  }

  private memoryExtractionRunItems(runState: LumeRunState | null) {
    return [{
      type: "user_message" as const,
      id: `${this.observer.getRunId()}:user`,
      content: this.observer.getUserMessage(),
      createdAt: runState?.createdAt ?? new Date().toISOString()
    }, ...(runState?.generatedItems ?? [])];
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
      messageMetadata: this.params.input.messageMetadata,
      modelRef: this.params.runtime.modelRef
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

function createContinuationPermissionHandler(
  base: CanUseToolFn,
  messageMetadata: Record<string, unknown> | undefined,
): CanUseToolFn {
  const runtimeContinuation = messageMetadata?.runtimeContinuation;
  if (!runtimeContinuation || typeof runtimeContinuation !== "object") return base;
  const checkpoint = (runtimeContinuation as Record<string, unknown>).checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return base;
  const toolCall = (checkpoint as Record<string, unknown>).toolCall;
  if (!toolCall || typeof toolCall !== "object") return base;
  const call = toolCall as Record<string, unknown>;
  if (typeof call.id !== "string" || typeof call.name !== "string" || typeof call.inputHash !== "string") return base;
  let consumed = false;
  return async (tool, input, metadata) => {
    const inputHash = createHash("sha256").update(JSON.stringify(input ?? null)).digest("hex");
    if (
      !consumed
      && metadata?.toolUseId === call.id
      && tool.name === call.name
      && inputHash === call.inputHash
    ) {
      consumed = true;
      return {
        behavior: "allow",
        decisionReason: "cold_start_exact_tool_continuation",
      };
    }
    return base(tool, input, metadata);
  };
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
      suggestion: createSuggestionWorkflowHookService(),
      persona: createPersonaWorkflowHookService(),
      runtimeEvents: createRuntimeEventWorkflowHookService(),
      trace: createTraceWorkflowHookService(),
      clock: { now: () => new Date() }
    }
  });
}
