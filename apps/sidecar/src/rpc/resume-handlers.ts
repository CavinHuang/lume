import { AGENT_IPC_CHANNELS } from "@lume/shared";
import {
  clearAgentThreadMessages,
  forkAgentThread,
  truncateAgentMessagesFrom,
} from "../services/agent/agent-thread-manager";
import { getThreadEventBus } from "../services/agent-runtime/events/thread-event-bus";
import { isAgentRuntimeSessionActive } from "../services/agent-runtime/runner/attempt";
import { createFileBackedRunContinuationStore } from "../services/agent-runtime/runtime-core/run-continuation-store";
import { createFileBackedLumeRunStateStore } from "../services/agent-runtime/runtime-core/run-state-store";
import type { ResumeRunResult } from "../services/agent-runtime/interruption/resume-service";
import {
  redactTraceForLevel,
  type TraceRedactionLevel,
} from "../services/agent-runtime/trace/trace-redaction";
import { createFileBackedLumeTraceStore } from "../services/agent-runtime/trace/trace-store";
import {
  agentThreadIdInputSchema,
  agentTruncateThreadInputSchema,
  discardInterruptedRunInputSchema,
  getEventsInputSchema,
  getPendingResumeInputSchema,
  listRunStatesInputSchema,
  resumeRunInputSchema,
  runTraceInputSchema,
} from "./schemas";
import type { RpcHandler } from "./types";
import { validateInput } from "./validation";

export interface ResumeHandlersDeps {
  resolveRuntimeSessionDir: (threadId: string) => string;
  resumeRunForThread: (input: {
    threadId: string;
    runId?: string;
    interruptionId?: string;
  }) => Promise<ResumeRunResult>;
  discardInterruptedRunForThread: (input: {
    threadId: string;
    runId?: string;
  }) => Promise<{ ok: boolean; runId?: string; error?: string }>;
  getPendingResume: (input: { threadId: string }) => Promise<{
    threadId: string;
    hasPendingResume: boolean;
    runId?: string;
    reason?: string;
  }>;
}

export function createResumeHandlers(
  deps: ResumeHandlersDeps,
): Record<string, RpcHandler> {
  const { resolveRuntimeSessionDir } = deps;
  return {
    [AGENT_IPC_CHANNELS.RESUME_RUN]: async (params) => {
      const input = validateInput(
        resumeRunInputSchema,
        params,
        AGENT_IPC_CHANNELS.RESUME_RUN,
      );
      return deps.resumeRunForThread(input);
    },
    [AGENT_IPC_CHANNELS.GET_EVENTS]: async (params) => {
      const input = validateInput(
        getEventsInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_EVENTS,
      );
      const events = await getThreadEventBus(
        resolveRuntimeSessionDir(input.threadId),
      ).read(input.threadId, input.afterSeq);
      return { threadId: input.threadId, events };
    },
    [AGENT_IPC_CHANNELS.DISCARD_INTERRUPTED_RUN]: async (params) => {
      const input = validateInput(
        discardInterruptedRunInputSchema,
        params,
        AGENT_IPC_CHANNELS.DISCARD_INTERRUPTED_RUN,
      );
      return deps.discardInterruptedRunForThread(input);
    },
    [AGENT_IPC_CHANNELS.GET_PENDING_RESUME]: async (params) => {
      const input = validateInput(
        getPendingResumeInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_PENDING_RESUME,
      );
      return deps.getPendingResume(input);
    },
    [AGENT_IPC_CHANNELS.LIST_RUN_STATES]: async (params) => {
      const input = validateInput(
        listRunStatesInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_RUN_STATES,
      );
      const sessionDir = resolveRuntimeSessionDir(input.threadId);
      const runStore = createFileBackedLumeRunStateStore(sessionDir);
      const continuationStore =
        createFileBackedRunContinuationStore(sessionDir);
      const runs = await runStore.listStatesByThread(input.threadId);
      return {
        runs: await Promise.all(
          runs.map(async (run) => {
            const continuation = await continuationStore.get(run.runId);
            return {
              runId: run.runId,
              threadId: run.threadId,
              workspaceId: run.workspaceId,
              workspaceSlug: run.workspaceSlug,
              status: run.status,
              currentStep: run.currentStep,
              traceId: run.traceId,
              contractId: run.contractId,
              model: run.model,
              usage: run.usage,
              pendingInterruptionCount: run.pendingInterruptions.length,
              generatedItemCount: await runStore.countItems(run.runId),
              continuation: continuation
                ? {
                    status: continuation.status,
                    checkpoint: {
                      step: continuation.checkpoint.step,
                      interruptionId: continuation.checkpoint.interruptionId,
                      toolCallId: continuation.checkpoint.toolCallId,
                      toolName: continuation.checkpoint.toolName,
                      toolKind: continuation.checkpoint.toolKind,
                    },
                    reason: continuation.reason,
                    updatedAt: continuation.updatedAt,
                  }
                : undefined,
              error: run.error
                ? {
                    code: run.error.code,
                    message: run.error.message,
                    retryable: run.error.retryable,
                  }
                : undefined,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              completedAt: run.completedAt,
            };
          }),
        ),
      };
    },
    [AGENT_IPC_CHANNELS.GET_RUN_TRACE]: async (params) => {
      const input = validateInput(
        runTraceInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_RUN_TRACE,
      );
      const sessionDir = resolveRuntimeSessionDir(input.threadId);
      const traceStore = createFileBackedLumeTraceStore(sessionDir);
      let traceId = input.traceId;
      if (!traceId && input.runId) {
        const run = await createFileBackedLumeRunStateStore(sessionDir).get(
          input.runId,
        );
        traceId = run?.traceId;
      }
      const trace = traceId
        ? await traceStore.get(traceId)
        : ((await traceStore.listByThread(input.threadId)).at(-1) ?? null);
      return {
        trace: trace
          ? redactTraceForLevel(
              trace,
              (input.redactionLevel ?? "safe_summary") as TraceRedactionLevel,
            )
          : null,
      };
    },
    [AGENT_IPC_CHANNELS.TRUNCATE_THREAD_MESSAGES_FROM]: async (params) => {
      const input = validateInput(
        agentTruncateThreadInputSchema,
        params,
        AGENT_IPC_CHANNELS.TRUNCATE_THREAD_MESSAGES_FROM,
      );
      // 截断直接替换 transcript，运行中执行会与 run 写入互踩（#397）。
      if (isAgentRuntimeSessionActive(input.threadId)) {
        throw new Error("线程正在运行中，请停止后再截断消息。");
      }
      return truncateAgentMessagesFrom(input.threadId, input.messageId);
    },
    [AGENT_IPC_CHANNELS.CLEAR_THREAD]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.CLEAR_THREAD,
      );
      return clearAgentThreadMessages(input.threadId);
    },
    [AGENT_IPC_CHANNELS.FORK_THREAD]: async (params) => {
      const input = params as { threadId: string; upToMessageId: string };
      if (!input.threadId || !input.upToMessageId) {
        throw new Error("FORK_THREAD requires threadId and upToMessageId");
      }
      return forkAgentThread(input.threadId, input.upToMessageId);
    },
  };
}
