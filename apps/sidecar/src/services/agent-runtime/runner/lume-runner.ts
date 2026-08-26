import { clearQuestionHandler, setQuestionHandler, type CanUseToolFn, type FileCheckpoint } from "@lume/agent-sdk";
import { createHash } from "node:crypto";
import type { AdvisorReviewedDetail, LumeConfigHooksInternalSection, SDKMessage } from "@lume/shared";
import type { AgentAskUserQuestionQuestion } from "@lume/shared";
import type { AgentRuntimeRunParams, AgentRuntimeRunResult, AgentRuntimeEmitter, RunRuntimeCoreAttemptOptions } from "../runtime-core/types";
import { resolveAgentThinkingLevel } from "../runtime-core/model-capabilities";
import type { PreparedRuntimeCoreAttempt } from "./prepare-attempt";
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
  normalizeRuntimeCoreQueryPermissionMode
} from "./run-loop";
import { getThreadEventBus } from "../events/thread-event-bus";
import { publishRunDomainEvent } from "../events/bus-bridge";
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
import type { LumeRunState } from "../runtime-core/run-state";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import { getActiveBrowserBroker } from "../../browser/browser-broker-holder";
import { getBrowserToolSessionRegistry } from "../tools/browser/browser-tool-session";

const log = createLogger("lume-runner");

interface RuntimeSessionRunInput {
  params: AgentRuntimeRunParams;
  prepared: PreparedRuntimeCoreAttempt;
  runtimeSession: Pick<CreateRuntimeCoreSessionResult, "agent" | "session" | "tools" | "userMessageForModel" | "memoryContextUsedItems">
    & Partial<Pick<CreateRuntimeCoreSessionResult, "getVerificationStatus" | "getVerificationReport" | "refreshCodingChangeSet" | "getLatestFileCheckpoint" | "getBaselineCommit" | "getBaselineCommits" | "getWorkspaceRoots">>
    & Partial<Pick<CreateRuntimeCoreSessionResult, "setLiveEventSink">>;
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
  const requested = input.messageMetadata?.maxTurns;
  if (typeof requested === "number" && Number.isFinite(requested)) {
    return Math.max(1, Math.min(80, Math.trunc(requested)));
  }
  return 80;
}

/**
 * 批次5 第二入口:advisor 审查结论经 ThreadEventBus 发布 advisor.reviewed 领域
 * 事件(T7c 起恒开,flag 已退役)——detail.review 为旧路 payload 同引用
 * (severity/summary/details?/modelRef/durationMs)。
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
  const detail: AdvisorReviewedDetail = { type: "advisor.reviewed", review: input.review };
  if (input.review.summary) detail.summary = input.review.summary;
  publishRunDomainEvent({ sessionDir: input.sessionDir, threadId: input.threadId, runId: input.runId, label: "advisor.reviewed", detail });
}

export class LumeRunner {
  readonly emit: AgentRuntimeEmitter;
  private latestMemoryContextUsedItems: CreateRuntimeCoreSessionResult["memoryContextUsedItems"] = [];
  private latestModelVisibleMessage = "";
  /** F3:投影链(tee→projector)是否已为本 run 交付 run.end 终值——异常路径
   * 补发错误终值前查询,保证同一 run 只有一个总线终值(projector 与 LumeRunner 互斥)。 */
  private busRunEndEmitted = false;

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
    },
    live?: {
      setSink: (sink: ((event: unknown) => void) | null) => void;
    }
  ): Promise<AgentRuntimeRunResult> {
    const result = await consumeRuntimeCoreQueryStream({
      query,
      emit: this.emit,
      // 投影线程上下文(T7c 起总线恒开,tee 无条件启用)
      lifecycle: {
        threadId: this.params.runtime.sessionId,
        sessionDir: getRuntimeCoreSessionDir(this.params.runtime.sessionId, this.prepared.agentDir),
        runId: this.observer.getRunId(),
        // F3 互斥:projector 交付 run.end 即置位,后续 fail() 不再补发终值
        onRunEnd: () => { this.busRunEndEmitted = true; }
      },
      onLiveInject: (inject) => {
        live?.setSink(inject as (event: unknown) => void);
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
      this.observer.recordTurnLimited(resultWithCoding.errorMessage, resultWithCoding.terminationReason);
      await this.observer.flush();
      // T7a:run.turn_limited 已迁事件总线(run.end{stopReason:'max_turns'}),旧路 emit 删除
      // #550:投影泵被单次 publish 同步 throw 终结时终值未交付——补发防永久卡
      // streaming;形状对齐 projector 正常交付(error_max_turns/isError:true)
      await this.publishRunEndIfMissing("error_max_turns", resultWithCoding.errorMessage);
      return this.finalizeResult(resultWithCoding);
    }
    if (resultWithCoding.status !== "completed") {
      // T7a:run.failed 已迁事件总线(run.end{isError}),旧路 emit 删除
      // F3:空流/引擎早夭(无 result 消息)时 projector 未开 run,总线无终值——补发
      await this.publishRunEndIfMissing("error", resultWithCoding.errorMessage ?? "Agent SDK 执行失败");
      await this.observer.flush();
      return this.finalizeResult(resultWithCoding);
    }
    // #550:同上,completed 正常返回前校验终值已交付
    await this.publishRunEndIfMissing("end_turn");
    return resultWithCoding;
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
        // Real answers arrive via canUseTool updatedInput (attempt.ts) and
        // never reach this handler; echoing request.answers back here would
        // resurrect the forged-answer channel (#196).
        void request;
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
        // 主链路 maxTokens 接线(#561):仅当渠道配置/内置目录真实提供输出上限时抬升。
        // modelResolution.model.maxTokens 是 createFallbackModel 的 32768 兜底猜测而非目录真值,
        // 直接透传会让无目录条目的自建网关出网 max_tokens 从 16384 翻倍,上游拒绝即 400
        // 且 shouldTryNextPiAiRoute 对 400 不切 fallback——无真值时保持 SDK 16384 默认(#631 review)。
        ...(prepared.modelResolution.catalogMaxTokens === undefined
          ? {}
          : { maxTokens: prepared.modelResolution.catalogMaxTokens }),
        // usageIdentity.runId 用真实 Lume runId(此前回落 sessionId=threadId,无法按 run 聚合)
        runId: this.observer.getRunId(),
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
      }, {
        // Live 事件汇(#285):消费开始时把 tee 投影队列接到 session 桥上
        setSink: (sink) => runtimeSession.setLiveEventSink?.(sink)
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
      try {
        await session.dispose();
      } finally {
        const browserSession = getBrowserToolSessionRegistry().take(runtime.sessionId);
        if (browserSession) {
          await getActiveBrowserBroker()?.dispatch({
            method: "finalize_tabs",
            threadId: runtime.sessionId,
            browserSessionId: browserSession.browserSessionId,
            browserTurnId: browserSession.browserTurnId,
          }).catch(() => undefined);
        }
        options.unregisterAbort(runtime.sessionId);
      }
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
    let runtimeSession: CreateRuntimeCoreSessionResult | undefined;
    try {
      if (runtime.abortSignal?.aborted) return this.abort();
      runtimeSession = await createRuntimeSession({
        lumeSessionId: runtime.sessionId,
        cwd: prepared.agentCwd,
        lumeWorkDir: prepared.lumeWorkDir,
        filesRoot: prepared.filesRoot,
        plansRoot: prepared.plansRoot,
        artifactsRoot: prepared.artifactsRoot,
        projectRoot: prepared.projectRoot,
        // permissions.privateWriteRoots 不走这里：run.ts 经 SDK 的
        // privateWriteRoots 专用通道传它（写放行），additionalDirectories 会把
        // 这些目录带进系统提示词/checkpoint 快照/相对路径解析（#639 复审）
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
          // T7a:advisor.reviewed 已迁事件总线,旧路只落盘 item(recordAdvisorReview 不再投影)
          this.observer.recordAdvisorReview(review);
          // 批次5 第二入口:advisor.reviewed 领域事件经 ThreadEventBus 发布
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
        abortSignal: runtime.abortSignal
      });
    } catch (error) {
      // F3:createRuntimeCoreSession 失败时查询流从未启动,
      // projector 未开 run → 总线无终值;fromActiveRun 又抑制旧路合成 run.failed
      // → web 静默失败。收编进 fail():补发 run.end{error} + observer 落终态。
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/abort|interrupted/i.test(errorMessage)) {
        return this.abort();
      }
      return this.fail(errorMessage);
    }
    // catch 分支恒 return,此处 runtimeSession 必已赋值(TS 不追踪该控制流,断言兜底)
    const session = runtimeSession as CreateRuntimeCoreSessionResult;
    this.latestMemoryContextUsedItems = session.memoryContextUsedItems ?? [];
    this.latestModelVisibleMessage = typeof session.userMessageForModel === "string"
      ? session.userMessageForModel
      : "";

    return this.runRuntimeSession({
      params,
      prepared,
      runtimeSession: session,
      options,
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
    // T7a:run.completed 已迁事件总线(run.end),旧路 emit 删除
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
    // T7a:memory.context.used 已迁事件总线,旧路 emit 删除(item 记录保留供 hydrate replay)。
    // 第二注入路径:同一 items 经 ThreadEventBus 发布(run 级领域事件,T7c 起恒开);
    // sessionDir 与 run-loop tee 一致,保证同一 bus 单例与单调 seq。
    const threadId = this.observer.getThreadId();
    const runId = this.observer.getRunId();
    publishRunDomainEvent({
      sessionDir: getRuntimeCoreSessionDir(this.params.runtime.sessionId, this.prepared.agentDir),
      threadId,
      runId,
      label: "memory.context.used",
      detail: { type: "memory.context.used", items: event.items }
    });
  }

  async abort(): Promise<AgentRuntimeRunResult> {
    // T7a:run.cancelled 已迁事件总线(流中止终值 run.end{stopReason:'aborted'}),旧路 emit 删除
    await this.observer.flush();
    this.emit.onComplete();
    return this.finalizeResult({ status: "aborted" });
  }

  async fail(errorMessage: string): Promise<AgentRuntimeRunResult> {
    // T7a:run.failed 已迁事件总线(run.end{isError}),旧路 emit 删除
    await this.fireRunAfterFailure(errorMessage);
    // F3:查询流未启动(或未交付终值)的失败,投影链不拥有终值——补发 run.end{error};
    // 流已交付终值则跳过,避免同一 run 双终值。
    await this.publishRunEndIfMissing("error", errorMessage);
    await this.observer.flush();
    this.emit.onError(errorMessage);
    return this.finalizeResult({ status: "errored", errorMessage });
  }

  /**
   * F3/#550:run 链内的总线终值补发(仅当投影链未交付 run.end 时)。
   * 与 projector 互斥靠执行序保证:tee 的 finally 先 await pump 排空投影
   * (终值已落盘、互斥标记已置位),异常才向主流传播到 LumeRunner catch。
   * #550 泛化到 completed/turn_limited:泵被单次 publish 同步 throw 终结后
   * 主流照常完成,但 web 端只有收到 run.end 才清 streaming 态。
   */
  private async publishRunEndIfMissing(stopReason: "error" | "error_max_turns" | "end_turn", errorMessage?: string): Promise<void> {
    if (this.busRunEndEmitted) return;
    this.busRunEndEmitted = true;
    const threadId = this.observer.getThreadId();
    const runId = this.observer.getRunId();
    try {
      await getThreadEventBus(getRuntimeCoreSessionDir(this.params.runtime.sessionId, this.prepared.agentDir))
        .publish(threadId, runId, {
          runId,
          turnId: null,
          ts: Date.now(),
          kind: "run",
          phase: "end",
          detail: {
            type: "run.end",
            stopReason,
            isError: stopReason !== "end_turn",
            numTurns: 0,
            ...(errorMessage !== undefined ? { result: errorMessage } : {})
          }
        });
    } catch (error) {
      log.warn("run.end 终值补发失败", {
        threadId,
        runId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
