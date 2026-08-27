import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { randomUUID } from "node:crypto";
import type {
  AgentPendingInteractiveState,
  AgentListSubagentRunsInput,
  AgentProxySettings,
  WorkspaceMcpConfig,
} from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import {
  createAgentThreadWithModelRef,
  deleteAgentThread,
  getAgentThreadMeta,
  getAgentThreadMessages,
  getAgentThreadSDKMessages,
  getRecentAgentThreadMessages,
  listAllAgentThreads,
  listAgentThreads,
  toggleAgentThreadPin,
  updateAgentThreadMeta,
  archiveAgentThread,
  restoreAgentThread,
  trashAgentThread,
  restoreAgentThreadFromTrash,
  permanentlyDeleteAgentThread,
  listArchivedThreads,
  listTrashedThreads,
  emptyTrash,
} from "../services/agent/agent-thread-manager";
import { deleteImThreadBindingsForThreadIds } from "../services/im/im-thread-binding-store";
import { getAgentMessageVersions } from "../services/agent/agent-message-versioning-service";
import { getAgentSubmissionStore } from "../services/agent/agent-submission-store";
import { getAgentRuntimeStatusManager } from "../services/agent/agent-runtime-status-manager";
import {
  addPlanningAuthorizedTodo,
  issuePlanningScopeGrant,
  registerPlanningExecutionContext,
} from "../services/planning/planning-execution-context";
import { getPlanningTodoStore } from "../services/planning/planning-todo-store";
import {
  appendAgentMessage,
  sendAgentMessage,
  generateAgentTitle,
  generateWelcomeSuggestions,
  getAgentSubmissionReceipt,
  listAgentMessageQueue,
  pauseAgentQueue,
  promoteQueuedAgentMessageToGuidance,
  prepareAgentDispatchInput,
  removeQueuedAgentMessage,
  reorderAgentMessageQueue,
  resumeAgentQueue,
  retryQueuedAgentMessage,
  updateQueuedAgentMessage,
  stopAgent,
  submitAgentToolPermission,
  submitAskUserQuestionAnswers,
} from "../services/agent/agent-service";
import { resolveAgentDefaultStrategy } from "../services/channel/model-selection";
import {
  getAgentThreadPath,
  getWorkspaceResourcesDirectory,
  resolveWorkspaceSlugByThreadId,
} from "../services/agent/agent-files-service";
import {
  createAgentWorkspace,
  ensureDefaultWorkspace,
  getAgentWorkspace,
  getWorkspaceCapabilities,
  getWorkspaceMcpConfig,
  listAgentWorkspaces,
  saveWorkspaceMcpConfig,
  updateAgentWorkspace,
} from "../services/agent/agent-workspace-manager";
import {
  bindUnboundLegacyProject,
  getProjectAvailability,
  getProjectRemovalImpact,
  relocateUnavailableProject,
  removeProject,
} from "../services/agent/agent-project-lifecycle-service";
import { getWorkspaceMcpManager } from "../services/mcp/workspace-mcp-manager";
import { appendBuiltinMcpStatuses } from "../services/mcp/builtin-mcp-status";
import { getEffectiveLumeConfig } from "../services/system/lume-config-service";
import { getAgentWorkspacePath } from "../services/infra/config-paths";
import { createLogger, writeLogRecord } from "../services/infra/logger";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { isAgentRuntimeSessionActive } from "../services/agent-runtime/runner/attempt";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDir,
} from "../services/agent-runtime/runtime-core/session-store";
import { detectSessionDanglingToolUses } from "../services/agent-runtime/runtime-core/run";
import {
  ensureAgentEventsBridge,
  releaseThreadEventBridge,
  setAgentEventsBridgeWriter,
} from "../services/agent-runtime/events/agent-events-bridge";
import { analyzeThreadWorkspaceSkillImprovements } from "../services/skills/skill-evolution-service";
import {
  buildColdStartContinuationMessage,
  LumeResumeService,
  type ResumeRunResult,
} from "../services/agent-runtime/interruption/resume-service";
import { createFileBackedRunContinuationStore } from "../services/agent-runtime/runtime-core/run-continuation-store";
import { createFileBackedLumeRunStateStore } from "../services/agent-runtime/runtime-core/run-state-store";
import type { LumeRunState } from "../services/agent-runtime/runtime-core/run-state";
import { listThreadRuntimeEvents } from "../services/agent-runtime/replay/runtime-event-history";
import { getSubagentRunRegistry } from "../services/agent-runtime/subagents/subagent-run-registry";
import { listPendingAskUserQuestionRequests } from "../services/agent-runtime/interruption/ask-user-question-session";
import {
  listPendingDesktopActionRequests,
  submitDesktopActionDecision,
} from "../services/agent-runtime/interruption/desktop-action-session";
import { listPendingToolPermissionRequests } from "../services/agent-runtime/interruption/tool-permission-session";
import {
  getAgentProxyStatus,
  saveAgentProxySettings,
} from "../services/system/proxy-settings-manager";
import { resumeAutomationAfterInteraction } from "../services/automation/automation-runner-service";
import {
  agentCreateThreadInputSchema,
  agentGetThreadMessageVersionsInputSchema,
  agentListSubagentRunsInputSchema,
  agentQueuedMessageInputSchema,
  agentRetryQueuedMessageInputSchema,
  agentRecentThreadMessagesInputSchema,
  agentReorderMessageQueueInputSchema,
  agentResumeQueueInputSchema,
  agentSendInputSchema,
  trustedAgentSendInputSchema,
  agentSubmissionReceiptInputSchema,
  agentThreadIdInputSchema,
  agentUpdateQueuedMessageInputSchema,
  agentUpdateThreadTitleInputSchema,
  agentUpdateThreadModelSelectionInputSchema,
  pendingInteractiveInputSchema,
  mcpCallToolDiagnosticInputSchema,
  mcpListResourcesInputSchema,
  mcpReadResourceInputSchema,
  mcpStatusInputSchema,
  mcpTestServerInputSchema,
  proxySettingsInputSchema,
  submitAskUserQuestionInputSchema,
  submitDesktopActionInputSchema,
  submitToolPermissionInputSchema,
  threadRunEventsInputSchema,
  workspaceCreateInputSchema,
  workspaceDeleteInputSchema,
  workspaceDirectoryInputSchema,
  workspaceIdInputSchema,
  workspaceMcpConfigInputSchema,
  workspaceSlugInputSchema,
  workspaceUpdateInputSchema,
  agentGenerateTitleInputSchema,
  agentWelcomeSuggestionInputSchema,
} from "./schemas";
import type { NotificationWriter, RpcHandler } from "./types";
import { asObject, validateInput } from "./validation";
import { trimSdkMessagesForTransport } from "./message-payload-trim";
import { createAgentNotificationEmitter } from "../services/agent/agent-notification-service";
import { createCodingHandlers } from "./coding-handlers";
import { createFileHandlers } from "./file-handlers";
import { createPluginHandlers } from "./plugin-handlers";
import { createResumeHandlers } from "./resume-handlers";
import { createSkillHandlers } from "./skill-handlers";

const log = createLogger("agent-handlers");

interface AgentHandlersContext {
  writeNotification: NotificationWriter;
  notifyBrowserPluginState?: () => void;
  planModePhaseTracker: PlanModePhaseTracker;
  notifyPlanModePhaseChange: (
    threadId: string,
    phase:
      "idle" | "planning" | "awaiting_approval" | "executing" | "completed",
  ) => void;
  appendAgentMessage?: typeof appendAgentMessage;
  analyzeThreadWorkspaceSkillImprovements?: typeof analyzeThreadWorkspaceSkillImprovements;
}

// Only objects created by the private handler below may carry a trusted
// renderer surface into the public send implementation. JSON-RPC callers can
// reproduce the object shape, but cannot place their deserialized object in
// this process-local identity set.
const trustedPlanningSendEnvelopes = new WeakSet<object>();

export function createAgentHandlers(
  context: AgentHandlersContext,
): Record<string, RpcHandler> {
  const appendAgentMessageForContext =
    context.appendAgentMessage ?? appendAgentMessage;
  const analyzeThreadWorkspaceSkillImprovementsForContext =
    context.analyzeThreadWorkspaceSkillImprovements ??
    analyzeThreadWorkspaceSkillImprovements;

  const resolveRequiredWorkspaceSlug = (
    threadId: string,
    workspaceSlug?: string,
  ) => {
    const resolvedWorkspaceSlug =
      workspaceSlug ?? resolveWorkspaceSlugByThreadId(threadId);
    if (resolvedWorkspaceSlug) return resolvedWorkspaceSlug;
    return getAgentThreadMeta(threadId)?.fileContextId ?? threadId;
  };

  const resolveRuntimeSessionDir = (threadId: string) =>
    getRuntimeCoreSessionDir(threadId);

  // agent:events 推送桥已下沉为进程级单源(#549)：IM 渠道/规划入口等非 RPC
  // 的 run 入口同样建桥，桌面端实时流不再断供。RPC 层只负责注入通知通道。
  setAgentEventsBridgeWriter((channel, payload) => context.writeNotification(channel, payload));

  /**
   * 运行中护栏：短宽限期等待自然收尾后仍活跃则拒绝。
   * 删除/永久删除/移动/回收站共用，防止 run 写入被删目录（#282/#397）。
   */
  const assertThreadNotRunningAfterGrace = async (
    threadId: string,
    action: string,
  ): Promise<void> => {
    if (!isAgentRuntimeSessionActive(threadId)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (isAgentRuntimeSessionActive(threadId)) {
      throw new Error(`线程正在运行中，请停止后再${action}。`);
    }
  };

  const resolveRunIdForThread = async (
    threadId: string,
    runId?: string,
  ): Promise<string | null> => {
    if (runId) return runId;
    const runStore = createFileBackedLumeRunStateStore(
      resolveRuntimeSessionDir(threadId),
    );
    const active = await runStore.findActiveByThread(threadId);
    if (active) return active.runId;
    const runs = await runStore.listStatesByThread(threadId);
    return runs.at(-1)?.runId ?? null;
  };

  const getDanglingToolUsesForThread = (threadId: string) => {
    const messages = createOrResumeRuntimeCoreSessionManager(
      process.cwd(),
      threadId,
    ).buildSessionContext().messages;
    return detectSessionDanglingToolUses(messages);
  };

  const sendResumeContinuationMessage = async (
    state: LumeRunState,
    userMessage: string,
    runtimeContinuation: Record<string, unknown>,
  ): Promise<{ finalOutput: string }> => {
    let finalOutput = "";
    await sendAgentMessage(
      {
        threadId: state.threadId,
        userMessage,
        ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
        ...(state.model.modelRef ? { modelRef: state.model.modelRef } : {}),
        ...(state.model.channelId ? { channelId: state.model.channelId } : {}),
        modelId: state.model.modelId,
        chatType: state.input.chatType as never,
        threadType: state.input.threadType as never,
        permissionMode: state.input.permissionMode,
        traceContext: {
          submissionId: randomUUID(),
          traceId: randomUUID(),
          origin: "resume",
          ...(state.input.traceContext?.traceId
            ? { linkedTraceId: state.input.traceContext.traceId }
            : {}),
        },
        messageMetadata: {
          ...(state.input.messageMetadata ?? {}),
          hiddenFromChat: true,
          runtimeContinuation,
        },
      },
      {
        onRuntimeEvent: (event) => {
          context.writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
            threadId: state.threadId,
            event,
          });
        },
        onMessageAppended: (event) => {
          context.writeNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
          if (event.message.role === "assistant") {
            finalOutput = event.message.content;
          }
        },
        onComplete: () => undefined,
        onError: (error) => {
          throw new Error(error);
        },
        onTitleUpdated: (title) => {
          context.writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            threadId: state.threadId,
            title,
          });
        },
        onAskUserQuestion: (request) => {
          context.writeNotification(
            AGENT_IPC_CHANNELS.ASK_USER_QUESTION,
            request,
          );
        },
        onDesktopActionRequest: (request) => {
          context.writeNotification(
            AGENT_IPC_CHANNELS.DESKTOP_ACTION_REQUEST,
            request,
          );
        },
        onToolPermissionRequest: (request) => {
          context.writeNotification(
            AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST,
            request,
          );
        },
      },
      { appendUserMessage: false },
    );
    return { finalOutput };
  };

  const resumeRunForThread = async (input: {
    threadId: string;
    runId?: string;
    interruptionId?: string;
  }): Promise<ResumeRunResult> => {
    ensureAgentEventsBridge(input.threadId);
    const sessionDir = resolveRuntimeSessionDir(input.threadId);
    const runId = await resolveRunIdForThread(input.threadId, input.runId);
    if (!runId) {
      return {
        status: "not_resumable",
        error: "找不到可恢复 run。",
      };
    }
    const runStateStore = createFileBackedLumeRunStateStore(sessionDir);
    const continuationStore = createFileBackedRunContinuationStore(sessionDir);
    const runState = await runStateStore.get(runId);
    if (!runState) {
      return {
        status: "not_resumable",
        error: "找不到 run state。",
      };
    }
    // 悬空兜底：无 checkpoint 的中断线程也允许一键续跑，由 run.ts 从
    // session history 检测未配对 tool_use 构造 toolContinuations
    //（只读重放 / 副作用注入中断说明占位）。状态门：只允许已中断的非正常
    // 完成态 run（cancelled=人工中止，failed=崩溃）走兜底。进程崩溃会把
    // run 留在 running；只有当前进程无活跃 runtime 且 session 确有悬空
    // tool_use 时，才把它视为 stale running 并允许续跑。
    const continuation = await continuationStore.get(runId);
    const isStaleRunningRun =
      runState.status === "running" &&
      !isAgentRuntimeSessionActive(input.threadId) &&
      getDanglingToolUsesForThread(input.threadId).length > 0;
    if (
      !continuation &&
      (runState.status === "cancelled" ||
        runState.status === "failed" ||
        isStaleRunningRun)
    ) {
      try {
        const result = await sendResumeContinuationMessage(
          runState,
          "继续执行之前被中断的任务；被中断的工具已按只读重放或中断说明处理，请基于实际状态继续。",
          { source: "dangling-fallback", sourceRunId: runState.runId },
        );
        if (isStaleRunningRun) {
          await runStateStore.update(runId, {
            status: "failed",
            completedAt: new Date().toISOString(),
          });
        }
        resumeAutomationAfterInteraction(input.threadId);
        return { status: "resumed", finalOutput: result.finalOutput };
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const service = new LumeResumeService(
      {
        runStateStore,
        continuationStore,
        // 崩溃恢复(#411③):后台任务终态通知由 background-process-recovery 落盘
        // transcript,按 processJobId 取回供 waiting_background checkpoint 转换
        resolveBackgroundNotification: async (processJobId) => {
          const notification = getAgentThreadSDKMessages(input.threadId).find(
            (message) =>
              message.type === "system" &&
              message.subtype === "task_notification" &&
              message.task_id === processJobId,
          );
          return notification;
        },
      },
      async (checkpoint, state) => {
        // interrupted（软中止 checkpoint）：engine 已为被中断工具补 error 占位
        // 并随历史落盘，注入同 id 的 syntheticToolResult 会产生重复
        // tool_result。不带 checkpoint 发送纯续跑消息，让模型读取已有占位。
        if (checkpoint.status === "interrupted") {
          return sendResumeContinuationMessage(
            state,
            "继续执行之前被用户中断的任务；被中断的工具在历史中已带有中断占位结果，请基于占位与工作区实际状态继续原始任务，不要重复已完成的操作。",
            { source: "interrupted-continue", sourceRunId: state.runId },
          );
        }
        return sendResumeContinuationMessage(
          state,
          buildColdStartContinuationMessage(checkpoint),
          {
            sourceRunId: state.runId,
            status: checkpoint.status,
            checkpoint: checkpoint.checkpoint,
            reason: checkpoint.reason,
          },
        );
      },
    );
    const result = await service.resumeRun({
      runId,
      interruptionId: input.interruptionId,
    });
    if (result.status === "resumed") {
      resumeAutomationAfterInteraction(input.threadId);
    }
    return result;
  };

  const discardInterruptedRunForThread = async (input: {
    threadId: string;
    runId?: string;
  }): Promise<{ ok: boolean; runId?: string; error?: string }> => {
    if (isAgentRuntimeSessionActive(input.threadId)) {
      return { ok: false, error: "任务仍在运行，暂时无法放弃恢复。" };
    }
    const runId = await resolveRunIdForThread(input.threadId, input.runId);
    if (!runId) {
      return { ok: false, error: "找不到待放弃的 run。" };
    }
    const sessionDir = resolveRuntimeSessionDir(input.threadId);
    const runStore = createFileBackedLumeRunStateStore(sessionDir);
    const continuationStore = createFileBackedRunContinuationStore(sessionDir);
    const runState = await runStore.get(runId);
    if (!runState || runState.threadId !== input.threadId) {
      return { ok: false, runId, error: "找不到待放弃的 run state。" };
    }

    const continuation = await continuationStore.get(runId);
    const dangling = getDanglingToolUsesForThread(input.threadId);
    if (dangling.length > 0) {
      createOrResumeRuntimeCoreSessionManager(
        process.cwd(),
        input.threadId,
      ).appendMessage({
        role: "user",
        content: dangling.map((use) => ({
          type: "tool_result",
          tool_use_id: use.id,
          content: "Error: run discarded by user",
          is_error: true,
        })),
      });
    }
    if (continuation?.status === "interrupted") {
      await continuationStore.update(runId, {
        status: "not_resumable",
        reason: "用户已放弃恢复。",
      });
    }
    if (runState.status === "running") {
      const completedAt = new Date().toISOString();
      await runStore.update(runId, { status: "cancelled", completedAt });
    }
    return { ok: true, runId };
  };

  const getPendingResume = async (input: {
    threadId: string;
  }): Promise<{
    threadId: string;
    hasPendingResume: boolean;
    runId?: string;
    reason?: string;
  }> => {
    const sessionDir = resolveRuntimeSessionDir(input.threadId);
    const runStore = createFileBackedLumeRunStateStore(sessionDir);
    const continuationStore = createFileBackedRunContinuationStore(sessionDir);
    // 只看线程最近一个 run 的 continuation 状态。
    // tool_running / waiting_background 不进横幅触发集：审批与后台等待已有
    // 专门的交互提示（TOOL_PERMISSION_REQUEST / 后台状态），横幅会造成双重提示。
    const lastRun = (await runStore.listStatesByThread(input.threadId)).at(-1);
    if (lastRun) {
      const continuation = await continuationStore.get(lastRun.runId);
      if (continuation && continuation.status === "interrupted") {
        return {
          threadId: input.threadId,
          hasPendingResume: true,
          runId: lastRun.runId,
          reason: continuation.reason,
        };
      }
      // 崩溃场景：message 级持久化让正在执行工具的 assistant tool_use 落盘，
      // run state 停在 running 且无 continuation checkpoint。session 存在悬空
      // tool_use 且当前进程没有活跃 runtime 时提示恢复。
      if (
        lastRun.status === "running" &&
        !isAgentRuntimeSessionActive(input.threadId)
      ) {
        if (getDanglingToolUsesForThread(input.threadId).length > 0) {
          return {
            threadId: input.threadId,
            hasPendingResume: true,
            runId: lastRun.runId,
            reason: "检测到未完成的崩溃运行",
          };
        }
      }
    }
    return { threadId: input.threadId, hasPendingResume: false };
  };

  const createExecutionStartCallback = (input: AgentSendInput) => () => {
    const phase = context.planModePhaseTracker.getPhase(input.threadId);
    if (
      input.permissionMode === "plan" ||
      (phase !== "planning" && phase !== "awaiting_approval")
    )
      return;
    context.notifyPlanModePhaseChange(input.threadId, "executing");
  };

  const resolveWorkspaceSlugForThread = (
    threadId: string,
    workspaceId?: string,
  ): string | undefined => {
    const explicitWorkspace = workspaceId
      ? getAgentWorkspace(workspaceId)
      : undefined;
    if (explicitWorkspace) return explicitWorkspace.slug;
    const threadWorkspaceId = getAgentThreadMeta(threadId)?.workspaceId;
    return threadWorkspaceId
      ? getAgentWorkspace(threadWorkspaceId)?.slug
      : undefined;
  };

  const scheduleSkillImprovementSuggestionScan = (
    threadId: string,
    workspaceSlug?: string,
  ): void => {
    const resolvedWorkspaceSlug =
      workspaceSlug ?? resolveWorkspaceSlugForThread(threadId);
    if (!resolvedWorkspaceSlug) return;

    setTimeout(() => {
      void analyzeThreadWorkspaceSkillImprovementsForContext({
        workspaceSlug: resolvedWorkspaceSlug,
        cwd: getAgentThreadPath(resolvedWorkspaceSlug, threadId),
        threadId,
        getRecentMessages: (targetThreadId, limit) =>
          getRecentAgentThreadMessages(targetThreadId, limit).messages,
      })
        .then((suggestions) => {
          if (suggestions.length === 0) return;
          context.writeNotification(
            AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED,
            {
              threadId,
              workspaceSlug: resolvedWorkspaceSlug,
              suggestions,
            },
          );
        })
        .catch((error) => {
          log.warn("Skill improvement scan failed", {
            threadId,
            workspaceSlug: resolvedWorkspaceSlug,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, 0);
  };

  const createAgentStreamEmitter = (
    threadId: string,
    options?: { workspaceSlug?: string },
  ) => {
    ensureAgentEventsBridge(threadId);
    return createAgentNotificationEmitter({
      threadId,
      writeNotification: context.writeNotification,
      onComplete: () => {
        scheduleSkillImprovementSuggestionScan(
          threadId,
          options?.workspaceSlug,
        );
        if (context.planModePhaseTracker.getPhase(threadId) === "executing") {
          context.notifyPlanModePhaseChange(threadId, "completed");
        }
      },
      onError: () => {
        if (context.planModePhaseTracker.getPhase(threadId) === "executing") {
          context.notifyPlanModePhaseChange(threadId, "awaiting_approval");
        }
      },
    });
  };

  const handlers: Record<string, RpcHandler> = {
    [AGENT_IPC_CHANNELS.LIST_THREADS]: async () => listAgentThreads(),
    [AGENT_IPC_CHANNELS.CREATE_THREAD]: async (params) => {
      const input = validateInput(
        agentCreateThreadInputSchema,
        params,
        AGENT_IPC_CHANNELS.CREATE_THREAD,
      );
      log.info("[Agent 线程] 创建", {
        title: input.title,
        workspaceId: input.workspaceId,
        modelRef: input.modelRef,
        channelId: input.channelId,
      });
      return createAgentThreadWithModelRef(
        input.title,
        input.modelRef,
        input.channelId,
        input.workspaceId,
        input.parentThreadId,
        input.modelId,
        { fileContextMode: input.fileContextMode ?? "newRoot" },
      );
    },
    [AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES,
      );
      return getAgentThreadMessages(input.threadId).map(
        trimSdkMessagesForTransport,
      );
    },
    [AGENT_IPC_CHANNELS.GET_THREAD_RUNTIME_EVENTS]: async (params) => {
      const input = validateInput(
        threadRunEventsInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_THREAD_RUNTIME_EVENTS,
      );
      return listThreadRuntimeEvents({
        sessionDir: resolveRuntimeSessionDir(input.threadId),
        threadId: input.threadId,
      });
    },
    [AGENT_IPC_CHANNELS.GET_THREAD_MESSAGE_VERSIONS]: async (params) => {
      const input = validateInput(
        agentGetThreadMessageVersionsInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_THREAD_MESSAGE_VERSIONS,
      );
      return {
        threadId: input.threadId,
        versionGroupId: input.versionGroupId,
        messages: getAgentMessageVersions(input.threadId, input.versionGroupId),
      };
    },
    [AGENT_IPC_CHANNELS.GET_RECENT_THREAD_MESSAGES]: async (params) => {
      const input = validateInput(
        agentRecentThreadMessagesInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_RECENT_THREAD_MESSAGES,
      );
      return getRecentAgentThreadMessages(input.threadId, input.limit);
    },
    [AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS]: async (params) => {
      const input = validateInput(
        agentListSubagentRunsInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS,
      ) as AgentListSubagentRunsInput;
      const runRegistry = getSubagentRunRegistry();
      const limit = typeof input.limit === "number" ? input.limit : 50;
      let runs = input.ownerThreadId
        ? runRegistry.listControlledByThread(input.ownerThreadId)
        : runRegistry.listAll(500).sort((a, b) => a.createdAt - b.createdAt);
      if (input.runId) {
        runs = runs.filter((run) => run.runId === input.runId);
      }
      if (input.status) {
        runs = runs.filter((run) => run.status === input.status);
      }
      const sliced = runs.slice(Math.max(0, runs.length - limit));
      return {
        count: sliced.length,
        runs: sliced,
        statusSummary: runRegistry.summarizeStatuses(sliced),
      };
    },
    [AGENT_IPC_CHANNELS.UPDATE_THREAD_TITLE]: async (params) => {
      const input = validateInput(
        agentUpdateThreadTitleInputSchema,
        params,
        AGENT_IPC_CHANNELS.UPDATE_THREAD_TITLE,
      );
      return updateAgentThreadMeta(input.threadId, { title: input.title });
    },
    [AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION]: async (params) => {
      const input = validateInput(
        agentUpdateThreadModelSelectionInputSchema,
        params,
        AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION,
      );
      const raw = asObject(params);
      const isClearRequest =
        input.modelRef === null &&
        input.channelId === null &&
        input.modelId === null;
      if (isClearRequest) {
        const thread = getAgentThreadMeta(input.threadId);
        const workspaceSlug = thread?.workspaceId
          ? getAgentWorkspace(thread.workspaceId)?.slug
          : undefined;
        const inheritedSelection = resolveAgentDefaultStrategy({
          globalDefault: getEffectiveLumeConfig(workspaceSlug).models?.agent,
        });
        return updateAgentThreadMeta(input.threadId, {
          channelId: inheritedSelection.channelId ?? null,
          modelRef: inheritedSelection.modelRef ?? null,
          modelId: null,
          modelSelectionSource: "inherited",
        });
      }
      const hasProvidedSelectionKey =
        "modelRef" in raw || "channelId" in raw || "modelId" in raw;
      const updates: Parameters<typeof updateAgentThreadMeta>[1] = {};
      if ("modelRef" in raw) {
        updates.modelRef = input.modelRef;
      }
      if ("channelId" in raw) {
        updates.channelId = input.channelId;
      }
      if ("modelId" in raw) {
        updates.modelId = input.modelId;
      }
      if (hasProvidedSelectionKey) {
        updates.modelSelectionSource = "thread-override";
      }
      return updateAgentThreadMeta(input.threadId, {
        ...updates,
      });
    },
    [AGENT_IPC_CHANNELS.TOGGLE_PIN_THREAD]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.TOGGLE_PIN_THREAD,
      );
      return toggleAgentThreadPin(input.threadId);
    },
    [AGENT_IPC_CHANNELS.DELETE_THREAD]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_THREAD,
      );
      await assertThreadNotRunningAfterGrace(input.threadId, "删除");
      log.info("[Agent 线程] 删除", { threadId: input.threadId.slice(0, 8) });
      deleteAgentThread(input.threadId);
      // 同步清 IM 绑定（#588）：残留会让 IM 侧在已死线程的壳里从零失忆地对话
      deleteImThreadBindingsForThreadIds(new Set([input.threadId]));
      getAgentRuntimeStatusManager().clearSession(input.threadId);
      context.planModePhaseTracker.clearSession(input.threadId);
      releaseThreadEventBridge(input.threadId);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.ARCHIVE_THREAD]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.ARCHIVE_THREAD,
      );
      // 与删除/回收站/移动同一护栏（#589）：归档运行中的线程会让 run 转入
      // 不可见状态继续烧 token，完成后消息追加进列表里不存在的线程。
      await assertThreadNotRunningAfterGrace(input.threadId, "归档");
      log.info("[Agent 线程] 归档", { threadId: input.threadId.slice(0, 8) });
      return archiveAgentThread(input.threadId);
    },
    [AGENT_IPC_CHANNELS.RESTORE_THREAD]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.RESTORE_THREAD,
      );
      return restoreAgentThread(input.threadId);
    },
    [AGENT_IPC_CHANNELS.TRASH_THREAD]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.TRASH_THREAD,
      );
      // 回收站仅改 meta，但清空回收站会硬删——入口即拦截，堵住 EMPTY_TRASH 绕行（#397）。
      await assertThreadNotRunningAfterGrace(input.threadId, "移入回收站");
      log.info("[Agent 线程] 移入回收站", {
        threadId: input.threadId.slice(0, 8),
      });
      const trashed = trashAgentThread(input.threadId);
      // 入回收站即失活（#588）：IM 消息不再路由进已不可见的线程
      deleteImThreadBindingsForThreadIds(new Set([input.threadId]));
      return trashed;
    },
    [AGENT_IPC_CHANNELS.RESTORE_THREAD_FROM_TRASH]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.RESTORE_THREAD_FROM_TRASH,
      );
      return restoreAgentThreadFromTrash(input.threadId);
    },
    [AGENT_IPC_CHANNELS.PERMANENTLY_DELETE_THREAD]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.PERMANENTLY_DELETE_THREAD,
      );
      await assertThreadNotRunningAfterGrace(input.threadId, "永久删除");
      log.info("[Agent 线程] 永久删除", {
        threadId: input.threadId.slice(0, 8),
      });
      permanentlyDeleteAgentThread(input.threadId);
      deleteImThreadBindingsForThreadIds(new Set([input.threadId]));
      getAgentRuntimeStatusManager().clearSession(input.threadId);
      context.planModePhaseTracker.clearSession(input.threadId);
      releaseThreadEventBridge(input.threadId);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.LIST_ARCHIVED_THREADS]: async () =>
      listArchivedThreads(),
    [AGENT_IPC_CHANNELS.LIST_TRASHED_THREADS]: async () => listTrashedThreads(),
    [AGENT_IPC_CHANNELS.EMPTY_TRASH]: async () => {
      // 清空回收站会对每个 trashed 线程硬删；运行中的先拒绝（#397）。
      const activeTrashedCount = listTrashedThreads().filter(
        (thread) => isAgentRuntimeSessionActive(thread.id),
      ).length;
      if (activeTrashedCount > 0) {
        throw new Error(
          `回收站中 ${activeTrashedCount} 个线程正在运行，请先停止再清空回收站。`,
        );
      }
      const deletedThreadIds = emptyTrash();
      if (deletedThreadIds.length > 0) {
        deleteImThreadBindingsForThreadIds(new Set(deletedThreadIds));
      }
      for (const threadId of deletedThreadIds)
        releaseThreadEventBridge(threadId);
      log.info("[Agent 线程] 清空回收站", { count: deletedThreadIds.length });
      return { cleanedCount: deletedThreadIds.length };
    },
    [AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS,
      );
      return (
        getAgentRuntimeStatusManager().get(input.threadId) ?? {
          threadId: input.threadId,
          phase: "idle",
          updatedAt: Date.now(),
        }
      );
    },
    [AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE]: async (params) => {
      const input = validateInput(
        pendingInteractiveInputSchema,
        params ?? {},
        AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE,
      );
      const askRequests = listPendingAskUserQuestionRequests();
      const desktopActionRequests = listPendingDesktopActionRequests();
      const toolRequests = listPendingToolPermissionRequests();
      const threadIds = new Set<string>();
      for (const request of askRequests) threadIds.add(request.threadId);
      for (const request of desktopActionRequests)
        threadIds.add(request.threadId);
      for (const request of toolRequests) threadIds.add(request.threadId);

      const result: AgentPendingInteractiveState[] = [];
      for (const threadId of threadIds) {
        if (input.threadId && input.threadId !== threadId) continue;
        const askUserQuestions = askRequests.filter(
          (request) => request.threadId === threadId,
        );
        const desktopActionsForThread = desktopActionRequests.filter(
          (request) => request.threadId === threadId,
        );
        const toolPermissions = toolRequests.filter(
          (request) => request.threadId === threadId,
        );
        result.push({
          threadId,
          ...(askUserQuestions.length > 0 ? { askUserQuestions } : {}),
          ...(desktopActionsForThread.length > 0
            ? { desktopActionRequests: desktopActionsForThread }
            : {}),
          ...(toolPermissions.length > 0 ? { toolPermissions } : {}),
        });
      }
      return result;
    },
    ...createResumeHandlers({
      resolveRuntimeSessionDir,
      resumeRunForThread,
      discardInterruptedRunForThread,
      getPendingResume,
    }),
    [AGENT_IPC_CHANNELS.LIST_WORKSPACES]: async () => listAgentWorkspaces(),
    [AGENT_IPC_CHANNELS.CREATE_WORKSPACE]: async (params) => {
      const input = validateInput(
        workspaceCreateInputSchema,
        params,
        AGENT_IPC_CHANNELS.CREATE_WORKSPACE,
      );
      const result = createAgentWorkspace(input.name ?? input.projectPath, {
        projectPath: input.projectPath,
      });
      log.info("[Agent 项目] 创建或复用", {
        name: result.name,
        projectPath: result.projectPath,
      });
      return result;
    },
    [AGENT_IPC_CHANNELS.UPDATE_WORKSPACE]: async (params) => {
      const input = validateInput(
        workspaceUpdateInputSchema,
        params,
        AGENT_IPC_CHANNELS.UPDATE_WORKSPACE,
      );
      const result = updateAgentWorkspace(input.id, { name: input.name });
      log.info("[Agent 项目] 重命名", { id: input.id, name: input.name });
      return result;
    },
    [AGENT_IPC_CHANNELS.GET_WORKSPACE_STATUS]: async (params) => {
      const input = validateInput(
        workspaceIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_WORKSPACE_STATUS,
      );
      return getProjectAvailability(input.id);
    },
    [AGENT_IPC_CHANNELS.BIND_WORKSPACE_DIRECTORY]: async (params) => {
      const input = validateInput(
        workspaceDirectoryInputSchema,
        params,
        AGENT_IPC_CHANNELS.BIND_WORKSPACE_DIRECTORY,
      );
      return bindUnboundLegacyProject(input.id, input.projectPath);
    },
    [AGENT_IPC_CHANNELS.RELOCATE_WORKSPACE_DIRECTORY]: async (params) => {
      const input = validateInput(
        workspaceDirectoryInputSchema,
        params,
        AGENT_IPC_CHANNELS.RELOCATE_WORKSPACE_DIRECTORY,
      );
      return relocateUnavailableProject(input.id, input.projectPath);
    },
    [AGENT_IPC_CHANNELS.GET_WORKSPACE_REMOVAL_IMPACT]: async (params) => {
      const input = validateInput(
        workspaceIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_WORKSPACE_REMOVAL_IMPACT,
      );
      return getProjectRemovalImpact(input.id);
    },
    [AGENT_IPC_CHANNELS.DELETE_WORKSPACE]: async (params) => {
      const input = validateInput(
        workspaceDeleteInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_WORKSPACE,
      );
      log.info("[Agent 项目] 移除", { id: input.id, mode: input.mode });
      return removeProject({ workspaceId: input.id, mode: input.mode });
    },
    [AGENT_IPC_CHANNELS.GET_CAPABILITIES]: async (params) => {
      const input = validateInput(
        workspaceSlugInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_CAPABILITIES,
      );
      return getWorkspaceCapabilities(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.GET_MCP_CONFIG]: async (params) => {
      const input = validateInput(
        workspaceSlugInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_MCP_CONFIG,
      );
      return getWorkspaceMcpConfig(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG]: async (params) => {
      const input = validateInput(
        workspaceMcpConfigInputSchema,
        params,
        AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG,
      );
      saveWorkspaceMcpConfig(
        input.workspaceSlug,
        input.config as WorkspaceMcpConfig,
      );
      void getWorkspaceMcpManager()
        .syncWorkspace(input.workspaceSlug)
        .catch((error) => {
          log.warn("[MCP] 保存配置后同步失败", {
            workspaceSlug: input.workspaceSlug,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_MCP_STATUS]: async (params) => {
      const input = validateInput(
        mcpStatusInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_MCP_STATUS,
      );
      await getWorkspaceMcpManager().syncWorkspace(input.workspaceSlug, {
        waitForConnections: input.waitForConnections !== false,
      });
      return {
        servers: appendBuiltinMcpStatuses(
          getWorkspaceMcpManager().getStatus(input.workspaceSlug),
        ),
      };
    },
    [AGENT_IPC_CHANNELS.TEST_MCP_SERVER]: async (params) => {
      const input = validateInput(
        mcpTestServerInputSchema,
        params,
        AGENT_IPC_CHANNELS.TEST_MCP_SERVER,
      );
      return {
        server: await getWorkspaceMcpManager().testServer(
          input.workspaceSlug,
          input.serverId,
        ),
      };
    },
    [AGENT_IPC_CHANNELS.LIST_MCP_RESOURCES]: async (params) => {
      const input = validateInput(
        mcpListResourcesInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_MCP_RESOURCES,
      );
      return getWorkspaceMcpManager().listResources(input);
    },
    [AGENT_IPC_CHANNELS.READ_MCP_RESOURCE]: async (params) => {
      const input = validateInput(
        mcpReadResourceInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_MCP_RESOURCE,
      );
      return getWorkspaceMcpManager().readResource(input);
    },
    [AGENT_IPC_CHANNELS.CALL_MCP_TOOL]: async (params) => {
      const input = validateInput(
        mcpCallToolDiagnosticInputSchema,
        params,
        AGENT_IPC_CHANNELS.CALL_MCP_TOOL,
      );
      return getWorkspaceMcpManager().callToolDiagnostic(input);
    },
    [AGENT_IPC_CHANNELS.GET_PROXY_SETTINGS]: async () => getAgentProxyStatus(),
    [AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS]: async (params) =>
      saveAgentProxySettings(
        validateInput(
          proxySettingsInputSchema,
          params,
          AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS,
        ) as AgentProxySettings,
      ),
    ...createSkillHandlers(),
    ...createPluginHandlers({
      writeNotification: context.writeNotification,
      notifyBrowserPluginState: context.notifyBrowserPluginState,
    }),
    ...createFileHandlers({
      writeNotification: context.writeNotification,
      resolveRequiredWorkspaceSlug,
    }),
    ...createCodingHandlers(),
    [AGENT_IPC_CHANNELS.GENERATE_TITLE]: async (params) =>
      generateAgentTitle(
        validateInput(agentGenerateTitleInputSchema, params, AGENT_IPC_CHANNELS.GENERATE_TITLE),
      ),
    [AGENT_IPC_CHANNELS.GENERATE_WELCOME_SUGGESTIONS]: async (params) =>
      generateWelcomeSuggestions(
        validateInput(agentWelcomeSuggestionInputSchema, params, AGENT_IPC_CHANNELS.GENERATE_WELCOME_SUGGESTIONS),
      ),
    [AGENT_IPC_CHANNELS.STOP_THREAD]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.STOP_THREAD,
      );
      // 同步设 paused:必须在 await stopAgent 之前,防止 stopAgent 内 cancelActive 触发的
      // abort finally(kernel startNextQueued)自动派发下一条排队消息。
      pauseAgentQueue(input.threadId);
      const stopped = await stopAgent(input.threadId);
      if (
        context.planModePhaseTracker.getPhase(input.threadId) === "executing"
      ) {
        context.notifyPlanModePhaseChange(input.threadId, "awaiting_approval");
      }
      return { ok: true, stopped };
    },
    [AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION]: async (params) => {
      const input = validateInput(
        submitAskUserQuestionInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION,
      );
      const result = await submitAskUserQuestionAnswers({
        threadId: input.threadId,
        toolUseId: input.toolUseId,
        canceled: input.canceled === true,
        answers: input.answers,
      });
      if (result.handledBy === "persisted") {
        const resume = await resumeRunForThread({
          threadId: result.threadId,
          runId: result.runId,
        });
        if (resume.status !== "not_resumable") {
          return { ...result, resume };
        }
      }
      return result;
    },
    [AGENT_IPC_CHANNELS.SUBMIT_DESKTOP_ACTION]: async (params) => {
      const input = validateInput(
        submitDesktopActionInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_DESKTOP_ACTION,
      );
      return { handled: submitDesktopActionDecision(input) };
    },
    [AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION]: async (params) => {
      const input = validateInput(
        submitToolPermissionInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION,
      );
      const result = submitAgentToolPermission({
        threadId: input.threadId,
        requestId: input.requestId,
        decision: input.decision,
        // #558 review P0:schema 补字段后必须在此透传,否则重建仍会剥掉
        ...(input.allowAlwaysScope
          ? { allowAlwaysScope: input.allowAlwaysScope }
          : {}),
        ...(input.threadPermissionMode
          ? { threadPermissionMode: input.threadPermissionMode }
          : {}),
      });
      return result;
    },
    "agent:ensure-default-workspace": async () => ensureDefaultWorkspace(),
    [AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]: async (params) => {
      const trustedSurface =
        params &&
        typeof params === "object" &&
        trustedPlanningSendEnvelopes.has(params) &&
        "trustedSurface" in params
          ? (
              params as {
                trustedSurface?: {
                  surface: "main" | "quick-input";
                  clientSubmissionId: string;
                  threadId: string;
                };
              }
            ).trustedSurface
          : undefined;
      const validated = validateInput(
        agentSendInputSchema,
        params,
        AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE,
      );
      const input: AgentSendInput = {
        ...validated,
        traceContext: {
          submissionId: validated.traceContext?.submissionId ?? randomUUID(),
          ...(validated.traceContext?.clientEventId
            ? { clientEventId: validated.traceContext.clientEventId }
            : {}),
          traceId: validated.traceContext?.traceId ?? randomUUID(),
          origin: (validated.traceContext?.origin ??
            "main_window") as NonNullable<
            AgentSendInput["traceContext"]
          >["origin"],
          ...(validated.traceContext?.parentTraceId
            ? { parentTraceId: validated.traceContext.parentTraceId }
            : {}),
          ...(validated.traceContext?.parentSpanId
            ? { parentSpanId: validated.traceContext.parentSpanId }
            : {}),
          ...(validated.traceContext?.linkedTraceId
            ? { linkedTraceId: validated.traceContext.linkedTraceId }
            : {}),
        },
      };
      const trustedThreadMeta = getAgentThreadMeta(input.threadId);
      const trustedWorkspaceId = trustedThreadMeta?.workspaceId;
      if (trustedThreadMeta) input.workspaceId = trustedWorkspaceId;
      if (
        trustedSurface?.threadId === input.threadId &&
        trustedSurface.clientSubmissionId === input.clientSubmissionId
      ) {
        const planningContext = registerPlanningExecutionContext({
          surface: trustedSurface.surface,
          threadId: input.threadId,
          ...(trustedWorkspaceId ? { workspaceId: trustedWorkspaceId } : {}),
          clientSubmissionId: trustedSurface.clientSubmissionId,
        });
        for (const todo of getPlanningTodoStore().listPrimaryTodosForThread(
          input.threadId,
        ))
          addPlanningAuthorizedTodo(planningContext, todo.id);
        issuePlanningScopeGrant({
          clientSubmissionId: trustedSurface.clientSubmissionId,
          surface: trustedSurface.surface,
          scope: trustedWorkspaceId ? "current" : "unassigned",
          ...(trustedWorkspaceId ? { workspaceId: trustedWorkspaceId } : {}),
          allowedOperations: ["list", "get"],
          mode: "turn",
        });
        const referencedTodoIds = [
          ...new Set(
            (input.messageParts ?? [])
              .filter((part) => part.type === "planning_todo_ref")
              .map((part) => part.todoId),
          ),
        ];
        if (referencedTodoIds.length > 0)
          issuePlanningScopeGrant({
            clientSubmissionId: trustedSurface.clientSubmissionId,
            surface: trustedSurface.surface,
            scope: "todo",
            todoIds: referencedTodoIds,
            allowedOperations: [
              "get",
              "update",
              "complete",
              "reopen",
              "delete",
              "restore",
            ],
            mode: "turn",
          });
        input.trustedPlanningClientSubmissionId =
          trustedSurface.clientSubmissionId;
      }
      writeLogRecord({
        level: "info",
        kind: "trace",
        context: "agent.dispatch",
        event: "message.validated",
        message: "agent message validated by sidecar",
        status: "ok",
        traceId: input.traceContext?.traceId,
        submissionId: input.traceContext?.submissionId,
        threadId: input.threadId,
        origin: input.traceContext?.origin,
        data: { messageLength: input.userMessage.length },
      });
      const sendInput = await prepareAgentDispatchInput(input);
      if (sendInput.permissionMode === "plan") {
        context.notifyPlanModePhaseChange(sendInput.threadId, "planning");
      }
      const result = appendAgentMessageForContext(
        sendInput,
        createAgentStreamEmitter(sendInput.threadId, {
          workspaceSlug: resolveWorkspaceSlugForThread(
            sendInput.threadId,
            sendInput.workspaceId,
          ),
        }),
        {
          onExecutionStarted: createExecutionStartCallback(sendInput),
        },
      );
      writeLogRecord({
        level: "info",
        kind: "trace",
        context: "agent.dispatch",
        event:
          result.mode === "queued"
            ? "agent.queue.accepted"
            : "agent.execution.started",
        message:
          result.mode === "queued"
            ? "agent message queued"
            : "agent execution started",
        status: "ok",
        traceId: sendInput.traceContext?.traceId,
        submissionId: sendInput.traceContext?.submissionId,
        threadId: sendInput.threadId,
        origin: sendInput.traceContext?.origin,
        data: {
          mode: result.mode,
          queuedCount: result.queuedCount,
          queuedMessageId: result.queuedMessage?.id,
        },
      });
      return result;
    },
    "agent:send-thread-message:trusted": async (params) => {
      const envelope = validateInput(
        trustedAgentSendInputSchema,
        params,
        "agent:send-thread-message:trusted",
      );
      const trustedParams = {
        ...envelope.input,
        trustedSurface: envelope.trustedSurface,
      };
      trustedPlanningSendEnvelopes.add(trustedParams);
      return handlers[AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]!(trustedParams);
    },
    [AGENT_IPC_CHANNELS.LIST_MESSAGE_QUEUE]: async (params) => {
      const input = validateInput(
        agentThreadIdInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_MESSAGE_QUEUE,
      );
      return listAgentMessageQueue(input.threadId);
    },
    [AGENT_IPC_CHANNELS.REORDER_MESSAGE_QUEUE]: async (params) => {
      const input = validateInput(
        agentReorderMessageQueueInputSchema,
        params,
        AGENT_IPC_CHANNELS.REORDER_MESSAGE_QUEUE,
      );
      return reorderAgentMessageQueue(input);
    },
    [AGENT_IPC_CHANNELS.REMOVE_QUEUED_MESSAGE]: async (params) => {
      const input = validateInput(
        agentQueuedMessageInputSchema,
        params,
        AGENT_IPC_CHANNELS.REMOVE_QUEUED_MESSAGE,
      );
      return removeQueuedAgentMessage(input);
    },
    [AGENT_IPC_CHANNELS.RETRY_QUEUED_MESSAGE]: async (params) => {
      const input = validateInput(
        agentRetryQueuedMessageInputSchema,
        params,
        AGENT_IPC_CHANNELS.RETRY_QUEUED_MESSAGE,
      );
      return retryQueuedAgentMessage(input);
    },
    [AGENT_IPC_CHANNELS.RESUME_QUEUE]: async (params) => {
      const input = validateInput(
        agentResumeQueueInputSchema,
        params,
        AGENT_IPC_CHANNELS.RESUME_QUEUE,
      );
      return resumeAgentQueue(input);
    },
    [AGENT_IPC_CHANNELS.GET_SUBMISSION_RECEIPT]: async (params) => {
      const input = validateInput(
        agentSubmissionReceiptInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_SUBMISSION_RECEIPT,
      );
      const receipt = getAgentSubmissionReceipt(input.clientSubmissionId);
      return receipt ? { receipt } : {};
    },
    [AGENT_IPC_CHANNELS.ABORT_SUBMISSION]: async (params) => {
      const input = validateInput(
        agentSubmissionReceiptInputSchema,
        params,
        AGENT_IPC_CHANNELS.ABORT_SUBMISSION,
      );
      const store = getAgentSubmissionStore();
      const receipt = store.get(input.clientSubmissionId);
      let aborted = false;
      if (receipt?.status === "preparing") {
        store.transition(
          input.clientSubmissionId,
          "rejected",
          "client_aborted",
        );
        aborted = true;
      } else if (!receipt) {
        store.abortAttachmentLease(input.clientSubmissionId);
        aborted = true;
      }
      return { ok: true, aborted };
    },
    [AGENT_IPC_CHANNELS.UPDATE_QUEUED_MESSAGE]: async (params) => {
      const input = validateInput(
        agentUpdateQueuedMessageInputSchema,
        params,
        AGENT_IPC_CHANNELS.UPDATE_QUEUED_MESSAGE,
      );
      return updateQueuedAgentMessage(input);
    },
    [AGENT_IPC_CHANNELS.PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE]: async (params) => {
      const input = validateInput(
        agentQueuedMessageInputSchema,
        params,
        AGENT_IPC_CHANNELS.PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE,
      );
      return promoteQueuedAgentMessageToGuidance(input);
    },
    [AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH]: async (params) => {
      const input = validateInput(
        workspaceSlugInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH,
      );
      return getAgentWorkspacePath(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.GET_WORKSPACE_RESOURCES_PATH]: async (params) => {
      const input = validateInput(
        workspaceSlugInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_WORKSPACE_RESOURCES_PATH,
      );
      return getWorkspaceResourcesDirectory(input.workspaceSlug);
    },
  };

  return handlers;
}
