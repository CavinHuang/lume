import { clearQuestionHandler, setQuestionHandler, type CanUseToolFn } from "@lume/agent-sdk";
import type { SDKMessage } from "@lume/shared";
import type { AgentAskUserQuestionQuestion } from "@lume/shared";
import type { PiAgentRunParams, PiAgentRunResult, PiAgentRuntimeEmitter } from "../../pi-agent/runner/types";
import { resolveAgentThinkingLevel } from "../../pi-agent/runner/model-capabilities";
import type { resolveRuntimeCoreChannelModel } from "../../pi-agent/runtime-core/model";
import { getRuntimeCoreSessionDir } from "../../pi-agent/runtime-core/session-store";
import {
  createRuntimeCoreSession,
  type CreateRuntimeCoreSessionInput,
  type CreateRuntimeCoreSessionResult
} from "../../pi-agent/runtime-core/run";
import { updateRuntimeThreadMetaIfPresent } from "../../pi-agent/runtime-core/thread-meta-target";
import {
  consumeRuntimeCoreQueryStream,
  createObservedRuntimeEmitter,
  normalizeRuntimeCoreQueryPermissionMode
} from "./run-loop";
import { LumeRunObserver } from "./run-observer";
import { fromPiAgentRunResult } from "./run-result";
import { applyResolvedThinkingLevel } from "./thinking-level";

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
  params: PiAgentRunParams;
  prepared: PreparedRuntimeCoreAttempt;
  runtimeSession: Pick<CreateRuntimeCoreSessionResult, "agent" | "session" | "tools">;
  options: RunRuntimeCoreAttemptOptions;
  createCanUseTool: (askUserSignal: AbortSignal) => CanUseToolFn;
}

interface PreparedRuntimeCoreRunInput {
  params: PiAgentRunParams;
  prepared: PreparedRuntimeCoreAttempt;
  options: RunRuntimeCoreAttemptOptions;
  createCanUseTool: (askUserSignal: AbortSignal) => CanUseToolFn;
  createRuntimeSession?: (input: CreateRuntimeCoreSessionInput) => Promise<CreateRuntimeCoreSessionResult>;
}

export class LumeRunner {
  readonly emit: PiAgentRuntimeEmitter;

  private constructor(
    private readonly observer: LumeRunObserver,
    emit: PiAgentRuntimeEmitter
  ) {
    this.emit = createObservedRuntimeEmitter(emit, observer);
  }

  static async create(input: {
    params: PiAgentRunParams;
    prepared: PreparedRuntimeCoreAttempt;
    emit: PiAgentRuntimeEmitter;
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
        channelId: params.runtime.channelId
      }
    });
    return new LumeRunner(observer, input.emit);
  }

  async finalizeResult(result: PiAgentRunResult): Promise<PiAgentRunResult> {
    const lumeResult = fromPiAgentRunResult(result);
    await this.observer.finalize(lumeResult.status, lumeResult.error);
    return result;
  }

  async finalizeError(error: unknown): Promise<void> {
    await this.observer.finalize("failed", error instanceof Error ? error : String(error));
  }

  async runQueryStream(query: AsyncIterable<SDKMessage>): Promise<PiAgentRunResult> {
    const result = await consumeRuntimeCoreQueryStream({
      query,
      emit: this.emit
    });
    if (result.status !== "completed") {
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
  }: RuntimeSessionRunInput): Promise<PiAgentRunResult> {
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

      const query = agent.query(input.userMessage, {
        canUseTool: createCanUseTool(askUserAbortController.signal),
        permissionMode: normalizeRuntimeCoreQueryPermissionMode(input.permissionMode),
        includePartialMessages: true
      });

      const streamResult = await this.runQueryStream(query);
      if (streamResult.status !== "completed") {
        return streamResult;
      }

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
  }: PreparedRuntimeCoreRunInput): Promise<PiAgentRunResult> {
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
      chatType: input.chatType,
      permissionMode: input.permissionMode,
      messageMetadata: input.messageMetadata,
      emitSdkMessage: this.emit.onSdkMessage,
      emitAskUserQuestion: this.emit.onAskUserQuestion,
      emitToolPermissionRequest: this.emit.onToolPermissionRequest,
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

  async complete(): Promise<PiAgentRunResult> {
    this.emit.onComplete();
    return this.finalizeResult({ status: "completed" });
  }

  async abort(): Promise<PiAgentRunResult> {
    this.emit.onComplete();
    return this.finalizeResult({ status: "aborted" });
  }

  async fail(errorMessage: string): Promise<PiAgentRunResult> {
    this.emit.onError(errorMessage);
    return this.finalizeResult({ status: "errored", errorMessage });
  }
}
