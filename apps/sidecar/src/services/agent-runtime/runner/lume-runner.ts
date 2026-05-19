import { clearQuestionHandler, setQuestionHandler, type CanUseToolFn } from "@lume/agent-sdk";
import type { SDKMessage } from "@lume/shared";
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
import { appendRunArchive } from "../../memory-v2/markdown-store";
import { resolveMemoryRuntimeConfig } from "../../memory/memory-policy";

interface PreparedRuntimeCoreAttempt {
  agentCwd: string;
  agentDir: string;
  workspaceName?: string;
  workspaceSlug?: string;
  modelResolution: NonNullable<ReturnType<typeof resolveRuntimeCoreChannelModel>>;
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
  createCanUseTool: (askUserSignal: AbortSignal) => CanUseToolFn;
}

interface PreparedRuntimeCoreRunInput {
  params: AgentRuntimeRunParams;
  prepared: PreparedRuntimeCoreAttempt;
  options: RunRuntimeCoreAttemptOptions;
  createCanUseTool: (askUserSignal: AbortSignal) => CanUseToolFn;
  createRuntimeSession?: (input: CreateRuntimeCoreSessionInput) => Promise<CreateRuntimeCoreSessionResult>;
}

export function resolveRuntimeCoreMaxTurns(input: AgentRuntimeRunParams["input"]): number | undefined {
  const metadata = input.messageMetadata ?? {};
  const taskControlEvent = metadata.taskControlEvent;
  if (
    typeof metadata.taskRunId === "string"
    || taskControlEvent === "execute_task"
    || taskControlEvent === "continue_task"
    || taskControlEvent === "retry_task"
  ) {
    return 20;
  }
  if (input.permissionMode === "plan") {
    return 12;
  }
  return undefined;
}

export class LumeRunner {
  readonly emit: AgentRuntimeEmitter;

  private constructor(
    private readonly observer: LumeRunObserver,
    emit: AgentRuntimeEmitter
  ) {
    this.emit = createObservedRuntimeEmitter(emit, observer);
  }

  static async create(input: {
    params: AgentRuntimeRunParams;
    prepared: PreparedRuntimeCoreAttempt;
    emit: AgentRuntimeEmitter;
  }): Promise<LumeRunner> {
    const { params, prepared } = input;
    const observer = await LumeRunObserver.create({
      sessionDir: getRuntimeCoreSessionDir(params.runtime.sessionId, prepared.agentDir),
      threadId: params.runtime.sessionId,
      workspaceId: params.runtime.workspaceId,
      workspaceSlug: prepared.workspaceSlug,
      userMessage: params.input.userMessage,
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
    return new LumeRunner(observer, input.emit);
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
    await this.observer.finalize("failed", error instanceof Error ? error : String(error));
  }

  async runQueryStream(query: AsyncIterable<SDKMessage>): Promise<AgentRuntimeRunResult> {
    const result = await consumeRuntimeCoreQueryStream({
      query,
      emit: this.emit
    });
    if (result.status === "turn_limited") {
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
        canUseTool: createCanUseTool(askUserAbortController.signal),
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
      subagentType: runtime.subagentType,
      chatType: input.chatType,
      permissionMode: input.permissionMode,
      messageMetadata: input.messageMetadata,
      emitSdkMessage: this.emit.onSdkMessage,
      emitAskUserQuestion: this.emit.onAskUserQuestion,
      emitToolPermissionRequest: this.emit.onToolPermissionRequest,
      emitTaskContractUpdated: this.emit.onTaskContractUpdated,
      runId: this.observer.getRunId(),
      trace: this.observer.getContextAssemblyTrace()
    });

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
    if (workspaceSlug) {
      try {
        appendRunArchive({
          workspaceSlug,
          runId: this.observer.getRunId(),
          record: {
            type: "run.completed",
            threadId: this.observer.getThreadId(),
            userMessage: this.observer.getUserMessage()
          }
        });
      } catch {
        // Run archive must not block completion.
      }
    }
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

  private emitMemoryContextUsed(items: CreateRuntimeCoreSessionResult["memoryContextUsedItems"]): void {
    if (items.length === 0) return;
    if (resolveMemoryRuntimeConfig().citationsMode === "off") return;
    this.emit.onRuntimeEvent?.({
      id: `${this.observer.getRunId()}:memory.context.used`,
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
        reason: item.reason
      })),
      hidden: true
    });
  }

  async abort(): Promise<AgentRuntimeRunResult> {
    await this.observer.flush();
    this.emit.onComplete();
    return this.finalizeResult({ status: "aborted" });
  }

  async fail(errorMessage: string): Promise<AgentRuntimeRunResult> {
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
}
