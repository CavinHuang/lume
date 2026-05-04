import { AGENT_IPC_CHANNELS, type BootstrapFileType } from "@lume/shared";
import type {
  AgentPendingInteractiveState,
  AgentGenerateTitleInput,
  AgentListSubagentRunsInput,
  AgentProxySettings,
  AgentRuntimeToolPolicyConfig,
  ImportGlobalMcpToWorkspaceInput,
  ImportGlobalSkillToWorkspaceInput,
  ImportLocalSkillDirectoryToWorkspaceInput,
  InstallSkillMarketItemToWorkspaceInput,
  InstallGlobalPluginInput,
  PlanStep,
  WorkspaceMcpConfig
} from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import {
  createAgentThreadWithModelRef,
  deleteAgentThread,
  getAgentThreadMeta,
  getAgentThreadMessages,
  getRecentAgentThreadMessages,
  listAgentThreads,
  migrateChatToAgentThread,
  moveAgentThreadToWorkspace,
  toggleAgentThreadPin,
  forkAgentThread,
  truncateAgentMessagesFrom,
  updateAgentThreadMeta
} from "../services/agent/agent-thread-manager";
import { getAgentMessageVersions } from "../services/agent/agent-message-versioning-service";
import { getAgentRuntimeStatusManager } from "../services/agent/agent-runtime-status-manager";
import {
  appendAgentMessage,
  sendAgentMessage,
  generateAgentTitle,
  stopAgent,
  submitAgentToolPermission,
  submitAskUserQuestionAnswers
} from "../services/agent/agent-service";
import { resolveAgentDefaultStrategy } from "../services/channel/model-selection";
import {
  attachWorkspaceResourceToThread,
  copyFolderToSession,
  deleteAgentFile,
  deleteWorkspaceFile,
  deleteAgentPlan,
  getAgentThreadPath,
  getWorkspaceResourcesDirectory,
  listAgentDirectory,
  listAttachedDirectory,
  listAgentPlans,
  listWorkspaceDirectory,
  moveAgentFile,
  moveWorkspaceFile,
  moveAttachedPath,
  openAgentPath,
  openAttachedPath,
  openWorkspacePath,
  previewAgentPath,
  previewWorkspacePath,
  readAgentPlan,
  renameAgentFile,
  renameWorkspaceFile,
  renameAttachedPath,
  resolveWorkspaceSlugByThreadId,
  saveFilesToAgentThread,
  saveFilesToWorkspace,
  searchAgentWorkspaceFiles,
  showAgentPathInFolder,
  showWorkspacePathInFolder,
  showAttachedPathInFolder
} from "../services/agent/agent-files-service";
import { promoteFileToWorkspace } from "../services/agent/agent-file-promotion-service";
import {
  createAgentWorkspace,
  deleteAgentWorkspace,
  deleteWorkspaceSkill,
  ensureDefaultWorkspace,
  getAgentWorkspace,
  getWorkspaceCapabilities,
  getWorkspaceMcpConfig,
  getWorkspaceSkills,
  listAgentWorkspaces,
  saveWorkspaceMcpConfig,
  updateAgentWorkspace
} from "../services/agent/agent-workspace-manager";
import {
  getGlobalDiscoverySnapshot,
  getGlobalMarketplaceDetail,
  importGlobalMcpToWorkspace,
  importGlobalSkillToWorkspace,
  installGlobalPlugin
} from "../services/system/global-discovery-service";
import {
  getGitHubSkillReview,
  installGitHubSkillToWorkspace
} from "../services/system/github-skill-install-service";
import {
  getSkillMarketDetail,
  getSkillMarketCatalog,
  installSkillMarketItemToWorkspace,
  importLocalSkillDirectoryToWorkspace
} from "../services/system/skills-market-service";
import { getEffectiveLumeConfig } from "../services/system/lume-config-service";
import { getAgentWorkspacePath } from "../services/infra/config-paths";
import { createLogger, getLogsDir } from "../services/infra/logger";
import type { PlanStateTracker } from "../services/agent/plan-state-tracker";
import { isPiAgentSessionActive } from "../services/pi-agent/runtime-core/attempt";
import { getRuntimeCoreSessionDir } from "../services/pi-agent/runtime-core/session-store";
import {
  buildColdStartContinuationMessage,
  LumeResumeService
} from "../services/agent-runtime/interruption/resume-service";
import {
  listPendingPlanApprovalRequests,
  resolvePlanApproval
} from "../services/agent-runtime/plan/plan-approval-service";
import { persistFallbackPlanFromText } from "../services/agent-runtime/plan/plan-fallback-service";
import {
  markStructuredPlanExecutionFailed,
  markStructuredPlanExecutionWaiting,
  markStructuredPlanInteractionResolved
} from "../services/agent-runtime/plan/plan-execution-service";
import {
  buildCurrentPlanStepSendInput,
  markCurrentPlanStepUnreported,
  skipCurrentPlanStep,
  startNextPlanStep,
  type PlanExecutionIntent
} from "../services/agent-runtime/plan/plan-execution-controller";
import { projectPlanEventToProgressEvent, projectPlanToProgressEvents } from "../services/agent-runtime/plan/plan-progress-events";
import { createFileBackedLumePlanStore } from "../services/agent-runtime/plan/plan-store";
import type { LumePlan } from "../services/agent-runtime/plan/plan-types";
import { createFileBackedRunContinuationStore } from "../services/agent-runtime/runner/run-continuation-store";
import { projectRunStateToRunEvents } from "../services/agent-runtime/runner/run-item-events";
import { createFileBackedLumeRunStateStore } from "../services/agent-runtime/runner/run-state-store";
import { redactTraceForLevel, type TraceRedactionLevel } from "../services/agent-runtime/trace/trace-redaction";
import { createFileBackedLumeTraceStore } from "../services/agent-runtime/trace/trace-store";
import { getSubagentRunRegistry } from "../services/agent/subagents/subagent-run-registry";
import { listPendingPiAskUserQuestionRequests } from "../services/pi-agent/tools/bridges/ask-user-question-bridge";
import { listPendingToolPermissionRequests } from "../services/pi-agent/tools/bridges/tool-permission-bridge";
import {
  getAgentRuntimeToolPolicyConfig,
  saveAgentRuntimeToolPolicyConfig
} from "../services/pi-agent/tools/permissions/tool-policy";
import {
  getAgentProxyStatus,
  saveAgentProxySettings
} from "../services/system/proxy-settings-manager";
import { readBootstrapFile, writeBootstrapFile } from "../services/system/workspace-bootstrap-service";
import {
  agentAppendInputSchema,
  agentCreateThreadInputSchema,
  agentGetThreadMessageVersionsInputSchema,
  agentListSubagentRunsInputSchema,
  agentMigrateChatInputSchema,
  agentMoveThreadInputSchema,
  agentRecentThreadMessagesInputSchema,
  agentSendInputSchema,
  agentThreadIdInputSchema,
  agentTruncateThreadInputSchema,
  agentUpdateThreadTitleInputSchema,
  agentUpdateThreadModelSelectionInputSchema,
  executePlanInputSchema,
  attachWorkspaceResourceToThreadInputSchema,
  attachedPathInputSchema,
  copyFolderToThreadInputSchema,
  deleteSkillInputSchema,
  githubSkillReviewInputSchema,
  importLocalSkillDirectoryInputSchema,
  installGitHubSkillInputSchema,
  installSkillMarketItemInputSchema,
  listDirectoryInputSchema,
  marketplaceDetailInputSchema,
  moveAttachedFileInputSchema,
  moveFileInputSchema,
  pendingInteractiveInputSchema,
  pathFileInputSchema,
  plansListInputSchema,
  plansReadDeleteInputSchema,
  promoteFileToWorkspaceInputSchema,
  proxySettingsInputSchema,
  readBootstrapFileInputSchema,
  listRunStatesInputSchema,
  renameAttachedFileInputSchema,
  renameFileInputSchema,
  resumeRunInputSchema,
  runTraceInputSchema,
  saveFilesToWorkspaceInputSchema,
  saveFilesToThreadInputSchema,
  saveToolPolicyInputSchema,
  searchWorkspaceFilesInputSchema,
  skillMarketCatalogInputSchema,
  skillMarketDetailInputSchema,
  structuredPlansInputSchema,
  threadRunEventsInputSchema,
  threadPathInputSchema,
  submitAskUserQuestionInputSchema,
  submitPlanApprovalInputSchema,
  submitToolPermissionInputSchema,
  workspaceCreateInputSchema,
  workspaceDeleteInputSchema,
  workspaceMoveFileInputSchema,
  workspaceMcpConfigInputSchema,
  workspacePathInputSchema,
  workspaceRenameFileInputSchema,
  workspaceRequiredPathInputSchema,
  workspaceSlugInputSchema,
  workspaceUpdateInputSchema,
  writeBootstrapFileInputSchema
} from "./schemas";
import type { NotificationWriter, RpcHandler } from "./types";
import { asObject, asString, validateInput } from "./validation";

interface AgentHandlersContext {
  writeNotification: NotificationWriter;
  planStateTracker: PlanStateTracker;
  notifyPlanStateChange: (
    threadId: string,
    phase: "idle" | "planning" | "review" | "executing" | "executed",
    extras?: { planPath?: string; steps?: PlanStep[] }
  ) => void;
}

function isPlanContinuationUserMessage(userMessage: string): boolean {
  const text = userMessage.trim();
  if (!text) return false;
  return text === "继续"
    || text === "继续执行"
    || text === "继续计划"
    || text === "继续执行计划"
    || text === "请继续"
    || text === "继续吧"
    || /^继续(执行)?(当前|这个|该)?计划/.test(text);
}

export function createAgentHandlers(context: AgentHandlersContext): Record<string, RpcHandler> {
  const resolveRequiredWorkspaceSlug = (threadId: string, workspaceSlug?: string) => {
    const resolvedWorkspaceSlug = workspaceSlug ?? resolveWorkspaceSlugByThreadId(threadId);
    if (!resolvedWorkspaceSlug) {
      throw new Error("未找到线程对应的 workspace");
    }
    return resolvedWorkspaceSlug;
  };

  const resolveRuntimeSessionDir = (threadId: string) => getRuntimeCoreSessionDir(threadId);

  const resolveRunIdForThread = async (threadId: string, runId?: string): Promise<string | null> => {
    if (runId) return runId;
    const runStore = createFileBackedLumeRunStateStore(resolveRuntimeSessionDir(threadId));
    const active = await runStore.findActiveByThread(threadId);
    if (active) return active.runId;
    const runs = await runStore.listByThread(threadId);
    return runs.at(-1)?.runId ?? null;
  };

  const resolveExecutablePlan = async (input: { threadId: string; planId?: string }) => {
    const plans = await createFileBackedLumePlanStore(resolveRuntimeSessionDir(input.threadId)).listByThread(input.threadId);
    const candidates = input.planId
      ? plans.filter((plan) => plan.id === input.planId)
      : plans
        .filter((plan) => plan.status === "approved" || plan.status === "executing" || plan.status === "failed")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return candidates[0] ?? null;
  };

  const resolvePlanContinuationInput = async (input: AgentSendInput): Promise<AgentSendInput> => {
    return input;
  };

  const dispatchPlanExecution = (input: {
    threadId: string;
    planId?: string;
    permissionMode?: AgentSendInput["permissionMode"];
    intent?: PlanExecutionIntent;
  }) => async () => {
    const sessionDir = resolveRuntimeSessionDir(input.threadId);
    const plan = await resolveExecutablePlan({ threadId: input.threadId, planId: input.planId });
    if (!plan) {
      return {
        ok: false,
        status: "not_found" as const,
        error: "找不到可执行计划。"
      };
    }
    if (plan.status !== "approved" && plan.status !== "executing" && plan.status !== "failed") {
      return {
        ok: false,
        status: "not_executable" as const,
        planId: plan.id,
        error: "计划尚未批准或不可继续执行。"
      };
    }
    if (input.intent === "skip") {
      const skipped = await skipCurrentPlanStep({
        sessionDir,
        threadId: input.threadId,
        planId: plan.id
      });
      if (skipped) {
        emitLatestPlanProgress(input.threadId, skipped);
        context.notifyPlanStateChange(input.threadId, skipped.status === "completed" ? "executed" : "executing");
      }
      return {
        ok: Boolean(skipped),
        status: skipped ? "sent" as const : "not_executable" as const,
        planId: plan.id,
        ...(skipped ? {} : { error: "当前计划步骤不可跳过。" })
      };
    }
    const started = await startNextPlanStep({
      sessionDir,
      threadId: input.threadId,
      planId: plan.id,
      intent: input.intent ?? "execute"
    });
    if (!started) {
      return {
        ok: false,
        status: "not_executable" as const,
        planId: plan.id,
        error: "计划没有剩余可执行步骤。"
      };
    }
    const sendInput = buildCurrentPlanStepSendInput({
      threadId: input.threadId,
      plan: started.plan,
      step: started.step,
      permissionMode: input.permissionMode,
      controlEvent: input.intent === "retry" ? "retry_plan_step" : input.intent === "continue" ? "continue_plan_step" : "execute_plan_step"
    });
    emitLatestPlanProgress(input.threadId, started.plan);
    const dispatch = appendAgentMessage(sendInput, createAgentStreamEmitter(sendInput.threadId, { planId: started.plan.id }), {
      onExecutionStarted: () => {
        context.notifyPlanStateChange(input.threadId, "executing");
      }
    });
    return {
      ok: true,
      status: dispatch.mode,
      queuedCount: dispatch.queuedCount,
      planId: plan.id
    };
  };

  const emitLatestPlanProgress = (threadId: string, plan: LumePlan | null) => {
    if (!plan) return;
    const latestEvent = plan.events?.at(-1);
    if (!latestEvent) return;
    context.writeNotification(AGENT_IPC_CHANNELS.RUN_EVENT, {
      threadId,
      event: projectPlanEventToProgressEvent(plan, latestEvent)
    });
  };

  const createExecutionStartCallback = (input: AgentSendInput) => () => {
    if (!context.planStateTracker.isLikelyExecutionRequest(input)) {
      return;
    }
    const steps = context.planStateTracker.syncExecutionFromSendInput(input);
    context.notifyPlanStateChange(input.threadId, "executing", steps ? { steps } : undefined);
    if (steps?.length) {
      emitPlanExecutionStatusMessage(input.threadId, buildPlanExecutionStartedText(steps), "running");
    }
  };

  const emitPlanExecutionStatusMessage = (
    threadId: string,
    text: string,
    status: "running" | "waiting" | "completed" | "failed"
  ) => {
    context.writeNotification(AGENT_IPC_CHANNELS.RUN_EVENT, {
      threadId,
      event: {
        type: "plan_execution_status",
        text,
        status,
        createdAt: new Date().toISOString()
      }
    });
  };

  const buildPlanExecutionStartedText = (steps: PlanStep[]): string => {
    const currentIndex = steps.findIndex((step) => step.status === "in_progress");
    const currentStep = currentIndex >= 0 ? steps[currentIndex] : steps[0];
    const totalCount = steps.length;
    const completedCount = steps.filter((step) => step.status === "completed").length;
    const remainingCount = steps.filter((step) => step.status === "pending" || step.status === "in_progress" || step.status === "failed").length;
    const previewSteps = steps.slice(0, 6).map((step, index) => {
      const marker = step.status === "completed"
        ? "✓"
        : step.status === "in_progress"
          ? "→"
          : step.status === "failed"
            ? "!"
            : "○";
      return `- ${marker} ${index + 1}. ${step.text}`;
    });
    return [
      `**开始执行计划**`,
      `第 **${currentIndex >= 0 ? currentIndex + 1 : 1} / ${totalCount}** 步`,
      `已完成 ${completedCount} 步，剩余 ${remainingCount} 步。`,
      currentStep ? `当前执行：**${currentStep.text}**` : "",
      previewSteps.length > 0 ? `步骤概览：\n\n${previewSteps.join("\n")}` : "",
      steps.length > previewSteps.length ? `...另有 ${steps.length - previewSteps.length} 步` : "",
      "执行过程中会继续在这里输出进展；需要你确认时会暂停并提示。"
    ].filter(Boolean).join("\n\n");
  };

  const createAgentStreamEmitter = (threadId: string, options?: { planId?: string }) => {
    let finalOutput: string | undefined;
    let structuredPlanWritten = false;
    return {
      onRunEvent: (event: unknown) => {
        const runEvent = event as { type?: string; result?: { finalOutput?: unknown } };
        if (runEvent.type === "run_completed" && typeof runEvent.result?.finalOutput === "string") {
          finalOutput = runEvent.result.finalOutput;
        }
        context.writeNotification(AGENT_IPC_CHANNELS.RUN_EVENT, {
          threadId,
          event
        });
      },
      onMessageAppended: (event: unknown) => {
        context.writeNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
        const appended = event as {
          threadId?: string;
          message?: {
            id?: string;
            role?: string;
            content?: string;
            createdAt?: number;
            versionGroupId?: string;
            versionIndex?: number;
            versionCount?: number;
          };
        };
        if (appended.message?.role === "user" && typeof appended.message.content === "string") {
          context.writeNotification(AGENT_IPC_CHANNELS.RUN_EVENT, {
            threadId,
            event: {
              type: "user_message_submitted",
              text: appended.message.content,
              createdAt: new Date(appended.message.createdAt ?? Date.now()).toISOString(),
              messageId: appended.message.id,
              versionGroupId: appended.message.versionGroupId,
              versionIndex: appended.message.versionIndex,
              versionCount: appended.message.versionCount
            }
          });
        }
      },
      onComplete: () => {
        const sessionDir = resolveRuntimeSessionDir(threadId);
        if (
          !structuredPlanWritten
          && context.planStateTracker.getPhase(threadId) === "planning"
          && finalOutput?.trim()
        ) {
          void persistFallbackPlanFromText({
            sessionDir,
            threadId,
            runId: threadId,
            text: finalOutput,
            onPlanUpdated: () => {
              context.notifyPlanStateChange(threadId, "review");
            }
          });
        }
        if (options?.planId) {
          void (async () => {
            const store = createFileBackedLumePlanStore(sessionDir);
            let plan = await store.get(options.planId!);
            if (plan?.status === "executing" && plan.currentStepId) {
              const current = plan.steps.find((step) => step.id === plan?.currentStepId);
              if (current?.status === "running") {
                plan = await markCurrentPlanStepUnreported({
                  sessionDir,
                  threadId,
                  planId: options.planId
                });
              }
            }
            emitLatestPlanProgress(threadId, plan);
            if (plan?.status === "approved") {
              void dispatchPlanExecution({
                threadId,
                planId: plan.id,
                intent: "continue"
              })();
              return;
            }
            if (plan?.status === "completed") {
              context.notifyPlanStateChange(threadId, "executed");
            }
          })();
          return;
        }
        if (context.planStateTracker.getPhase(threadId) === "executing") {
          const steps = context.planStateTracker.markCurrentStepCompleted(threadId);
          context.notifyPlanStateChange(threadId, "executed", steps ? { steps } : undefined);
        }
      },
      onError: (error: string) => {
        void markStructuredPlanExecutionFailed({
          sessionDir: resolveRuntimeSessionDir(threadId),
          threadId,
          error
        });
        context.writeNotification(AGENT_IPC_CHANNELS.RUN_EVENT, {
          threadId,
          event: {
            type: "run_failed",
            error: {
              code: "runtime_error",
              message: error
            }
          }
        });
        if (context.planStateTracker.getPhase(threadId) === "executing") {
          const steps = context.planStateTracker.markCurrentStepFailed(threadId, error);
          context.notifyPlanStateChange(threadId, "review", steps ? { steps } : undefined);
        }
      },
      onTitleUpdated: (title: string) =>
        context.writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
          threadId,
          title
        }),
      onAskUserQuestion: (request: unknown) =>
        {
          const message = (request as { questions?: Array<{ question?: string }> })?.questions
            ?.map((item) => item.question)
            .filter(Boolean)
            .join("\n");
          void markStructuredPlanExecutionWaiting({
            sessionDir: resolveRuntimeSessionDir(threadId),
            threadId,
            status: "needs_user_input",
            reason: message || "等待用户回答"
          }).then((plan) => emitLatestPlanProgress(threadId, plan));
          context.writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request);
        },
      onToolPermissionRequest: (request: unknown) =>
        {
          const toolRequest = request as { toolName?: string; reason?: string };
          void markStructuredPlanExecutionWaiting({
            sessionDir: resolveRuntimeSessionDir(threadId),
            threadId,
            status: "needs_approval",
            reason: toolRequest.reason || (toolRequest.toolName ? `等待 ${toolRequest.toolName} 权限审批` : "等待工具权限审批")
          }).then((plan) => emitLatestPlanProgress(threadId, plan));
          context.writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request);
        },
      onPlanUpdated: () => {
        structuredPlanWritten = true;
        context.notifyPlanStateChange(threadId, "review");
      }
    };
  };

  const handlers: Record<string, RpcHandler> = {
    [AGENT_IPC_CHANNELS.LIST_THREADS]: async () => listAgentThreads(),
    [AGENT_IPC_CHANNELS.CREATE_THREAD]: async (params) => {
      const input = validateInput(agentCreateThreadInputSchema, params, AGENT_IPC_CHANNELS.CREATE_THREAD);
      return createAgentThreadWithModelRef(
        input.title,
        input.modelRef,
        input.channelId,
        input.workspaceId,
        input.parentThreadId,
        input.modelId
      );
    },
    [AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.GET_THREAD_MESSAGES);
      return getAgentThreadMessages(input.threadId);
    },
    [AGENT_IPC_CHANNELS.GET_THREAD_RUN_EVENTS]: async (params) => {
      const input = validateInput(threadRunEventsInputSchema, params, AGENT_IPC_CHANNELS.GET_THREAD_RUN_EVENTS);
      const sessionDir = resolveRuntimeSessionDir(input.threadId);
      const runs = await createFileBackedLumeRunStateStore(sessionDir)
        .listByThread(input.threadId);
      const plans = await createFileBackedLumePlanStore(sessionDir).listByThread(input.threadId);
      return {
        threadId: input.threadId,
        events: [
          ...runs.flatMap((run) => projectRunStateToRunEvents(run)),
          ...plans.flatMap((plan) => projectPlanToProgressEvents(plan))
        ]
      };
    },
    [AGENT_IPC_CHANNELS.GET_THREAD_MESSAGE_VERSIONS]: async (params) => {
      const input = validateInput(
        agentGetThreadMessageVersionsInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_THREAD_MESSAGE_VERSIONS
      );
      return {
        threadId: input.threadId,
        versionGroupId: input.versionGroupId,
        messages: getAgentMessageVersions(input.threadId, input.versionGroupId)
      };
    },
    [AGENT_IPC_CHANNELS.GET_RECENT_THREAD_MESSAGES]: async (params) => {
      const input = validateInput(agentRecentThreadMessagesInputSchema, params, AGENT_IPC_CHANNELS.GET_RECENT_THREAD_MESSAGES);
      return getRecentAgentThreadMessages(input.threadId, input.limit);
    },
    [AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS]: async (params) => {
      const input = validateInput(
        agentListSubagentRunsInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS
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
        statusSummary: runRegistry.summarizeStatuses(sliced)
      };
    },
    [AGENT_IPC_CHANNELS.UPDATE_THREAD_TITLE]: async (params) => {
      const input = validateInput(agentUpdateThreadTitleInputSchema, params, AGENT_IPC_CHANNELS.UPDATE_THREAD_TITLE);
      return updateAgentThreadMeta(input.threadId, { title: input.title });
    },
    [AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION]: async (params) => {
      const input = validateInput(
        agentUpdateThreadModelSelectionInputSchema,
        params,
        AGENT_IPC_CHANNELS.UPDATE_THREAD_MODEL_SELECTION
      );
      const raw = asObject(params);
      const isClearRequest = input.modelRef === null && input.channelId === null && input.modelId === null;
      if (isClearRequest) {
        const thread = getAgentThreadMeta(input.threadId);
        const workspaceSlug = thread?.workspaceId
          ? getAgentWorkspace(thread.workspaceId)?.slug
          : undefined;
        const inheritedSelection = resolveAgentDefaultStrategy({
          globalDefault: getEffectiveLumeConfig(workspaceSlug).models?.agent
        });
        return updateAgentThreadMeta(input.threadId, {
          channelId: inheritedSelection.channelId ?? null,
          modelRef: inheritedSelection.modelRef ?? null,
          modelId: null,
          modelSelectionSource: "inherited"
        });
      }
      const hasProvidedSelectionKey = "modelRef" in raw || "channelId" in raw || "modelId" in raw;
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
        ...updates
      });
    },
    [AGENT_IPC_CHANNELS.TOGGLE_PIN_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.TOGGLE_PIN_THREAD);
      return toggleAgentThreadPin(input.threadId);
    },
    [AGENT_IPC_CHANNELS.MOVE_THREAD]: async (params) => {
      const input = validateInput(agentMoveThreadInputSchema, params, AGENT_IPC_CHANNELS.MOVE_THREAD);
      if (isPiAgentSessionActive(input.threadId)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (isPiAgentSessionActive(input.threadId)) {
          throw new Error("线程正在运行中，请停止后再移动。");
        }
      }
      return moveAgentThreadToWorkspace(input.threadId, input.workspaceId);
    },
    [AGENT_IPC_CHANNELS.DELETE_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.DELETE_THREAD);
      deleteAgentThread(input.threadId);
      getAgentRuntimeStatusManager().clearSession(input.threadId);
      context.planStateTracker.clearSession(input.threadId);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS);
      return getAgentRuntimeStatusManager().get(input.threadId) ?? {
        threadId: input.threadId,
        phase: "idle",
        updatedAt: Date.now()
      };
    },
    [AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE]: async (params) => {
      const input = validateInput(
        pendingInteractiveInputSchema,
        params ?? {},
        AGENT_IPC_CHANNELS.GET_PENDING_INTERACTIVE
      );
      const askRequests = listPendingPiAskUserQuestionRequests();
      const toolRequests = listPendingToolPermissionRequests();
      const planRequests = await listPendingPlanApprovalRequests();
      const threadIds = new Set<string>();
      for (const request of askRequests) threadIds.add(request.threadId);
      for (const request of toolRequests) threadIds.add(request.threadId);
      for (const request of planRequests) threadIds.add(request.threadId);

      const result: AgentPendingInteractiveState[] = [];
      for (const threadId of threadIds) {
        if (input.threadId && input.threadId !== threadId) continue;
        const askUserQuestions = askRequests.filter((request) => request.threadId === threadId);
        const toolPermissions = toolRequests.filter((request) => request.threadId === threadId);
        const planApprovals = planRequests.filter((request) => request.threadId === threadId);
        result.push({
          threadId,
          ...(askUserQuestions.length > 0 ? { askUserQuestions } : {}),
          ...(toolPermissions.length > 0 ? { toolPermissions } : {}),
          ...(planApprovals.length > 0 ? { planApprovals } : {})
        });
      }
      return result;
    },
    [AGENT_IPC_CHANNELS.RESUME_RUN]: async (params) => {
      const input = validateInput(resumeRunInputSchema, params, AGENT_IPC_CHANNELS.RESUME_RUN);
      const sessionDir = resolveRuntimeSessionDir(input.threadId);
      const runId = await resolveRunIdForThread(input.threadId, input.runId);
      if (!runId) {
        return {
          status: "not_resumable",
          error: "找不到可恢复 run。"
        };
      }
      const service = new LumeResumeService({
        runStateStore: createFileBackedLumeRunStateStore(sessionDir),
        continuationStore: createFileBackedRunContinuationStore(sessionDir)
      }, async (checkpoint, state) => {
        let finalOutput = "";
        await sendAgentMessage({
          threadId: state.threadId,
          userMessage: buildColdStartContinuationMessage(checkpoint),
          ...(state.workspaceId ? { workspaceId: state.workspaceId } : {}),
          ...(state.model.modelRef ? { modelRef: state.model.modelRef } : {}),
          ...(state.model.channelId ? { channelId: state.model.channelId } : {}),
          modelId: state.model.modelId,
          chatType: state.input.chatType as never,
          threadType: state.input.threadType as never,
          permissionMode: state.input.permissionMode,
          messageMetadata: {
            ...(state.input.messageMetadata ?? {}),
            runtimeContinuation: {
              sourceRunId: state.runId,
              checkpoint: checkpoint.checkpoint,
              reason: checkpoint.reason
            }
          }
        }, {
          onRunEvent: (event) => {
            context.writeNotification(AGENT_IPC_CHANNELS.RUN_EVENT, {
              threadId: state.threadId,
              event
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
              title
            });
          },
          onAskUserQuestion: (request) => {
            context.writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request);
          },
          onToolPermissionRequest: (request) => {
            context.writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request);
          }
        }, { appendUserMessage: false });
        return { finalOutput };
      });
      return service.resumeRun({
        runId,
        interruptionId: input.interruptionId
      });
    },
    [AGENT_IPC_CHANNELS.LIST_RUN_STATES]: async (params) => {
      const input = validateInput(listRunStatesInputSchema, params, AGENT_IPC_CHANNELS.LIST_RUN_STATES);
      const sessionDir = resolveRuntimeSessionDir(input.threadId);
      const runStore = createFileBackedLumeRunStateStore(sessionDir);
      const continuationStore = createFileBackedRunContinuationStore(sessionDir);
      const runs = await runStore.listByThread(input.threadId);
      return {
        runs: await Promise.all(runs.map(async (run) => {
          const continuation = await continuationStore.get(run.runId);
          return {
            runId: run.runId,
            threadId: run.threadId,
            workspaceId: run.workspaceId,
            workspaceSlug: run.workspaceSlug,
            status: run.status,
            currentStep: run.currentStep,
            traceId: run.traceId,
            planId: run.planId,
            model: run.model,
            usage: run.usage,
            pendingInterruptionCount: run.pendingInterruptions.length,
            generatedItemCount: run.generatedItems.length,
            continuation: continuation
              ? {
                  status: continuation.status,
                  checkpoint: {
                    step: continuation.checkpoint.step,
                    interruptionId: continuation.checkpoint.interruptionId,
                    toolCallId: continuation.checkpoint.toolCallId,
                    toolName: continuation.checkpoint.toolName,
                    toolKind: continuation.checkpoint.toolKind
                  },
                  reason: continuation.reason,
                  updatedAt: continuation.updatedAt
                }
              : undefined,
            error: run.error
              ? {
                  code: run.error.code,
                  message: run.error.message,
                  retryable: run.error.retryable
                }
              : undefined,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            completedAt: run.completedAt
          };
        }))
      };
    },
    [AGENT_IPC_CHANNELS.GET_RUN_TRACE]: async (params) => {
      const input = validateInput(runTraceInputSchema, params, AGENT_IPC_CHANNELS.GET_RUN_TRACE);
      const sessionDir = resolveRuntimeSessionDir(input.threadId);
      const traceStore = createFileBackedLumeTraceStore(sessionDir);
      let traceId = input.traceId;
      if (!traceId && input.runId) {
        const run = await createFileBackedLumeRunStateStore(sessionDir).get(input.runId);
        traceId = run?.traceId;
      }
      const trace = traceId
        ? await traceStore.get(traceId)
        : (await traceStore.listByThread(input.threadId)).at(-1) ?? null;
      return {
        trace: trace
          ? redactTraceForLevel(trace, (input.redactionLevel ?? "safe_summary") as TraceRedactionLevel)
          : null
      };
    },
    [AGENT_IPC_CHANNELS.LIST_STRUCTURED_PLANS]: async (params) => {
      const input = validateInput(structuredPlansInputSchema, params, AGENT_IPC_CHANNELS.LIST_STRUCTURED_PLANS);
      const plans = await createFileBackedLumePlanStore(resolveRuntimeSessionDir(input.threadId))
        .listByThread(input.threadId);
      return { plans };
    },
    [AGENT_IPC_CHANNELS.TRUNCATE_THREAD_MESSAGES_FROM]: async (params) => {
      const input = validateInput(agentTruncateThreadInputSchema, params, AGENT_IPC_CHANNELS.TRUNCATE_THREAD_MESSAGES_FROM);
      return truncateAgentMessagesFrom(input.threadId, input.messageId);
    },
    [AGENT_IPC_CHANNELS.FORK_THREAD]: async (params) => {
      const input = params as { threadId: string; upToMessageId: string };
      if (!input.threadId || !input.upToMessageId) {
        throw new Error("FORK_THREAD requires threadId and upToMessageId");
      }
      return forkAgentThread(input.threadId, input.upToMessageId);
    },
    [AGENT_IPC_CHANNELS.LIST_WORKSPACES]: async () => listAgentWorkspaces(),
    [AGENT_IPC_CHANNELS.CREATE_WORKSPACE]: async (params) => {
      const input = validateInput(workspaceCreateInputSchema, params, AGENT_IPC_CHANNELS.CREATE_WORKSPACE);
      return createAgentWorkspace(input.name);
    },
    [AGENT_IPC_CHANNELS.UPDATE_WORKSPACE]: async (params) => {
      const input = validateInput(workspaceUpdateInputSchema, params, AGENT_IPC_CHANNELS.UPDATE_WORKSPACE);
      return updateAgentWorkspace(input.id, { name: input.name });
    },
    [AGENT_IPC_CHANNELS.DELETE_WORKSPACE]: async (params) => {
      const input = validateInput(workspaceDeleteInputSchema, params, AGENT_IPC_CHANNELS.DELETE_WORKSPACE);
      deleteAgentWorkspace(input.id);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_CAPABILITIES]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, AGENT_IPC_CHANNELS.GET_CAPABILITIES);
      return getWorkspaceCapabilities(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.GET_MCP_CONFIG]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, AGENT_IPC_CHANNELS.GET_MCP_CONFIG);
      return getWorkspaceMcpConfig(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG]: async (params) => {
      const input = validateInput(workspaceMcpConfigInputSchema, params, AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG);
      saveWorkspaceMcpConfig(input.workspaceSlug, input.config as WorkspaceMcpConfig);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_TOOL_POLICY]: async () => getAgentRuntimeToolPolicyConfig(),
    [AGENT_IPC_CHANNELS.SAVE_TOOL_POLICY]: async (params) =>
      saveAgentRuntimeToolPolicyConfig(
        validateInput(saveToolPolicyInputSchema, params, AGENT_IPC_CHANNELS.SAVE_TOOL_POLICY) as AgentRuntimeToolPolicyConfig
      ),
    [AGENT_IPC_CHANNELS.GET_PROXY_SETTINGS]: async () => getAgentProxyStatus(),
    [AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS]: async (params) =>
      saveAgentProxySettings(
        validateInput(proxySettingsInputSchema, params, AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS) as AgentProxySettings
      ),
    [AGENT_IPC_CHANNELS.GET_SKILLS]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, AGENT_IPC_CHANNELS.GET_SKILLS);
      return getWorkspaceSkills(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.DELETE_SKILL]: async (params) => {
      const input = validateInput(deleteSkillInputSchema, params, AGENT_IPC_CHANNELS.DELETE_SKILL);
      deleteWorkspaceSkill(input.workspaceSlug, input.skillSlug);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_GLOBAL_DISCOVERY]: async () => getGlobalDiscoverySnapshot(),
    [AGENT_IPC_CHANNELS.RESCAN_GLOBAL_DISCOVERY]: async () => getGlobalDiscoverySnapshot(),
    [AGENT_IPC_CHANNELS.GET_SKILL_MARKET_CATALOG]: async (params) => {
      const input = validateInput(
        skillMarketCatalogInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_SKILL_MARKET_CATALOG
      );
      return getSkillMarketCatalog(input);
    },
    [AGENT_IPC_CHANNELS.GET_SKILL_MARKET_DETAIL]: async (params) => {
      const input = validateInput(
        skillMarketDetailInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_SKILL_MARKET_DETAIL
      );
      return getSkillMarketDetail(input);
    },
    [AGENT_IPC_CHANNELS.GET_GITHUB_SKILL_REVIEW]: async (params) => {
      const input = validateInput(
        githubSkillReviewInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_GITHUB_SKILL_REVIEW
      );
      return getGitHubSkillReview(input);
    },
    [AGENT_IPC_CHANNELS.INSTALL_GITHUB_SKILL_TO_WORKSPACE]: async (params) => {
      const input = validateInput(
        installGitHubSkillInputSchema,
        params,
        AGENT_IPC_CHANNELS.INSTALL_GITHUB_SKILL_TO_WORKSPACE
      );
      return installGitHubSkillToWorkspace(input);
    },
    [AGENT_IPC_CHANNELS.GET_GLOBAL_MARKETPLACE_DETAIL]: async (params) => {
      const input = validateInput(marketplaceDetailInputSchema, params, AGENT_IPC_CHANNELS.GET_GLOBAL_MARKETPLACE_DETAIL);
      return getGlobalMarketplaceDetail(input.marketplaceId);
    },
    [AGENT_IPC_CHANNELS.INSTALL_GLOBAL_PLUGIN]: async (params) =>
      installGlobalPlugin(params as InstallGlobalPluginInput),
    [AGENT_IPC_CHANNELS.IMPORT_GLOBAL_MCP_TO_WORKSPACE]: async (params) =>
      importGlobalMcpToWorkspace(params as ImportGlobalMcpToWorkspaceInput),
    [AGENT_IPC_CHANNELS.IMPORT_GLOBAL_SKILL_TO_WORKSPACE]: async (params) =>
      importGlobalSkillToWorkspace(params as ImportGlobalSkillToWorkspaceInput),
    [AGENT_IPC_CHANNELS.IMPORT_LOCAL_SKILL_DIRECTORY_TO_WORKSPACE]: async (params) => {
      const input = validateInput(
        importLocalSkillDirectoryInputSchema,
        params,
        AGENT_IPC_CHANNELS.IMPORT_LOCAL_SKILL_DIRECTORY_TO_WORKSPACE
      );
      return importLocalSkillDirectoryToWorkspace(input as ImportLocalSkillDirectoryToWorkspaceInput);
    },
    [AGENT_IPC_CHANNELS.INSTALL_SKILL_MARKET_ITEM_TO_WORKSPACE]: async (params) => {
      const input = validateInput(
        installSkillMarketItemInputSchema,
        params,
        AGENT_IPC_CHANNELS.INSTALL_SKILL_MARKET_ITEM_TO_WORKSPACE
      );
      return installSkillMarketItemToWorkspace(input as InstallSkillMarketItemToWorkspaceInput);
    },
    [AGENT_IPC_CHANNELS.GET_THREAD_PATH]: async (params) => {
      const input = validateInput(threadPathInputSchema, params, AGENT_IPC_CHANNELS.GET_THREAD_PATH);
      return getAgentThreadPath(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId
      );
    },
    [AGENT_IPC_CHANNELS.LIST_DIRECTORY]: async (params) => {
      const input = validateInput(listDirectoryInputSchema, params, AGENT_IPC_CHANNELS.LIST_DIRECTORY);
      return {
        entries: listAgentDirectory(
          resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
          input.threadId,
          input.path
        )
      };
    },
    [AGENT_IPC_CHANNELS.LIST_WORKSPACE_DIRECTORY]: async (params) => {
      const input = validateInput(
        workspacePathInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_WORKSPACE_DIRECTORY
      );
      return listWorkspaceDirectory(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.DELETE_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.DELETE_FILE);
      return deleteAgentFile(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path
      );
    },
    [AGENT_IPC_CHANNELS.DELETE_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_WORKSPACE_FILE
      );
      return deleteWorkspaceFile(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.OPEN_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.OPEN_FILE);
      return openAgentPath(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path
      );
    },
    [AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE
      );
      return openWorkspacePath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.SHOW_IN_FOLDER]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.SHOW_IN_FOLDER);
      return showAgentPathInFolder(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path
      );
    },
    [AGENT_IPC_CHANNELS.SHOW_WORKSPACE_IN_FOLDER]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.SHOW_WORKSPACE_IN_FOLDER
      );
      return showWorkspacePathInFolder(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.PREVIEW_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.PREVIEW_FILE);
      return previewAgentPath(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path
      );
    },
    [AGENT_IPC_CHANNELS.PREVIEW_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.PREVIEW_WORKSPACE_FILE
      );
      return previewWorkspacePath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.RENAME_FILE]: async (params) => {
      const input = validateInput(renameFileInputSchema, params, AGENT_IPC_CHANNELS.RENAME_FILE);
      return renameAgentFile(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
        input.newName
      );
    },
    [AGENT_IPC_CHANNELS.RENAME_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRenameFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.RENAME_WORKSPACE_FILE
      );
      return renameWorkspaceFile(input.workspaceSlug, input.path, input.newName);
    },
    [AGENT_IPC_CHANNELS.MOVE_FILE]: async (params) => {
      const input = validateInput(moveFileInputSchema, params, AGENT_IPC_CHANNELS.MOVE_FILE);
      return moveAgentFile(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path,
        input.targetDir
      );
    },
    [AGENT_IPC_CHANNELS.MOVE_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceMoveFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.MOVE_WORKSPACE_FILE
      );
      return moveWorkspaceFile(input.workspaceSlug, input.path, input.targetDir);
    },
    [AGENT_IPC_CHANNELS.LIST_ATTACHED_DIRECTORY]: async (params) => {
      const input = validateInput(attachedPathInputSchema, params, AGENT_IPC_CHANNELS.LIST_ATTACHED_DIRECTORY);
      return listAttachedDirectory(input.path);
    },
    [AGENT_IPC_CHANNELS.OPEN_ATTACHED_FILE]: async (params) => {
      const input = validateInput(attachedPathInputSchema, params, AGENT_IPC_CHANNELS.OPEN_ATTACHED_FILE);
      return openAttachedPath(input.path);
    },
    [AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER]: async (params) => {
      const input = validateInput(attachedPathInputSchema, params, AGENT_IPC_CHANNELS.SHOW_ATTACHED_IN_FOLDER);
      return showAttachedPathInFolder(input.path);
    },
    [AGENT_IPC_CHANNELS.RENAME_ATTACHED_FILE]: async (params) => {
      const input = validateInput(
        renameAttachedFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.RENAME_ATTACHED_FILE
      );
      return renameAttachedPath(input.path, input.newName);
    },
    [AGENT_IPC_CHANNELS.MOVE_ATTACHED_FILE]: async (params) => {
      const input = validateInput(moveAttachedFileInputSchema, params, AGENT_IPC_CHANNELS.MOVE_ATTACHED_FILE);
      return moveAttachedPath(input.path, input.targetDir);
    },
    [AGENT_IPC_CHANNELS.PROMOTE_FILE_TO_WORKSPACE]: async (params) =>
      promoteFileToWorkspace(
        validateInput(promoteFileToWorkspaceInputSchema, params, AGENT_IPC_CHANNELS.PROMOTE_FILE_TO_WORKSPACE)
      ),
    [AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES]: async (params) => {
      const input = validateInput(
        searchWorkspaceFilesInputSchema,
        params,
        AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES
      );
      const workspaceSlug = resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug);
      return searchAgentWorkspaceFiles(
        workspaceSlug,
        input.threadId,
        input.query,
        input.limit ?? 20,
        input.rootPath
      );
    },
    [AGENT_IPC_CHANNELS.LIST_PLANS]: async (params) => {
      const input = validateInput(plansListInputSchema, params, AGENT_IPC_CHANNELS.LIST_PLANS);
      const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugByThreadId(input.threadId);
      if (!resolvedWorkspaceSlug) {
        throw new Error("未找到线程对应的 workspace");
      }
      return listAgentPlans(resolvedWorkspaceSlug, input.threadId);
    },
    [AGENT_IPC_CHANNELS.READ_PLAN]: async (params) => {
      const input = validateInput(plansReadDeleteInputSchema, params, AGENT_IPC_CHANNELS.READ_PLAN);
      const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugByThreadId(input.threadId);
      if (!resolvedWorkspaceSlug) {
        throw new Error("未找到线程对应的 workspace");
      }
      return readAgentPlan(resolvedWorkspaceSlug, input.threadId, input.planPath);
    },
    [AGENT_IPC_CHANNELS.DELETE_PLAN]: async (params) => {
      const input = validateInput(plansReadDeleteInputSchema, params, AGENT_IPC_CHANNELS.DELETE_PLAN);
      const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugByThreadId(input.threadId);
      if (!resolvedWorkspaceSlug) {
        throw new Error("未找到线程对应的 workspace");
      }
      return deleteAgentPlan(resolvedWorkspaceSlug, input.threadId, input.planPath);
    },
    [AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD]: async (params) =>
      saveFilesToAgentThread(
        (() => {
          const input = validateInput(saveFilesToThreadInputSchema, params, AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD);
          return {
            ...input,
            workspaceSlug: resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug)
          };
        })()
      ),
    [AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD]: async (params) =>
      copyFolderToSession(
        (() => {
          const input = validateInput(copyFolderToThreadInputSchema, params, AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD);
          return {
            ...input,
            workspaceSlug: resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug)
          };
        })()
      ),
    [AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_RESOURCE_TO_THREAD]: async (params) =>
      attachWorkspaceResourceToThread(
        validateInput(
          attachWorkspaceResourceToThreadInputSchema,
          params,
          AGENT_IPC_CHANNELS.ATTACH_WORKSPACE_RESOURCE_TO_THREAD
        )
      ),
    [AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE]: async (params) =>
      saveFilesToWorkspace(
        validateInput(saveFilesToWorkspaceInputSchema, params, AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE)
      ),
    [AGENT_IPC_CHANNELS.GENERATE_TITLE]: async (params) => generateAgentTitle(params as AgentGenerateTitleInput),
    [AGENT_IPC_CHANNELS.STOP_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.STOP_THREAD);
      stopAgent(input.threadId);
      void markStructuredPlanExecutionFailed({
        sessionDir: resolveRuntimeSessionDir(input.threadId),
        threadId: input.threadId,
        error: "用户已停止当前执行"
      });
      if (context.planStateTracker.getPhase(input.threadId) === "executing") {
        const steps = context.planStateTracker.markCurrentStepFailed(input.threadId, "用户已停止当前执行");
        context.notifyPlanStateChange(input.threadId, "review", steps ? { steps } : undefined);
      }
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION]: async (params) => {
      const input = validateInput(
        submitAskUserQuestionInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION
      );
      const result = submitAskUserQuestionAnswers({
        threadId: input.threadId,
        toolUseId: input.toolUseId,
        canceled: input.canceled === true,
        answers: input.answers
      });
      void markStructuredPlanInteractionResolved({
        sessionDir: resolveRuntimeSessionDir(input.threadId),
        threadId: input.threadId
      });
      return result;
    },
    [AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION]: async (params) => {
      const input = validateInput(
        submitToolPermissionInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION
      );
      const result = submitAgentToolPermission({
        threadId: input.threadId,
        requestId: input.requestId,
        decision: input.decision
      });
      void markStructuredPlanInteractionResolved({
        sessionDir: resolveRuntimeSessionDir(input.threadId),
        threadId: input.threadId
      });
      return result;
    },
    [AGENT_IPC_CHANNELS.SUBMIT_PLAN_APPROVAL]: async (params) => {
      const input = validateInput(
        submitPlanApprovalInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_PLAN_APPROVAL
      );
      const ok = await resolvePlanApproval({
        sessionDir: resolveRuntimeSessionDir(input.threadId),
        threadId: input.threadId,
        planId: input.planId,
        decision: input.decision
      });
      if (!ok || input.decision !== "approve" || input.execute !== true) {
        return { ok };
      }
      const execution = await dispatchPlanExecution({
        threadId: input.threadId,
        planId: input.planId,
        intent: "execute"
      })();
      return { ok, execution };
    },
    [AGENT_IPC_CHANNELS.EXECUTE_PLAN]: async (params) => {
      const input = validateInput(executePlanInputSchema, params, AGENT_IPC_CHANNELS.EXECUTE_PLAN);
      return dispatchPlanExecution({
        threadId: input.threadId,
        planId: input.planId,
        permissionMode: input.permissionMode,
        intent: input.intent
      })();
    },
    "agent:ensure-default-workspace": async () => ensureDefaultWorkspace(),
    "agent:read-bootstrap-file": async (params) => {
      const input = validateInput(readBootstrapFileInputSchema, params, "agent:read-bootstrap-file");
      return { content: readBootstrapFile(input.workspaceSlug, input.fileType as BootstrapFileType) };
    },
    "agent:write-bootstrap-file": async (params) => {
      const input = validateInput(writeBootstrapFileInputSchema, params, "agent:write-bootstrap-file");
      writeBootstrapFile(input.workspaceSlug, input.fileType as BootstrapFileType, input.content);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE]: async (params) => {
      const input = validateInput(agentSendInputSchema, params, AGENT_IPC_CHANNELS.SEND_THREAD_MESSAGE);
      if (isPlanContinuationUserMessage(input.userMessage) && typeof input.messageMetadata?.planExecutionKey !== "string") {
        const latestContinuablePlan = await resolveExecutablePlan({ threadId: input.threadId });
        if (latestContinuablePlan) {
          return dispatchPlanExecution({
            threadId: input.threadId,
            planId: latestContinuablePlan.id,
            permissionMode: input.permissionMode,
            intent: "continue"
          })();
        }
      }
      const sendInput = await resolvePlanContinuationInput(input);
      if (sendInput.permissionMode === "plan") {
        context.notifyPlanStateChange(sendInput.threadId, "planning");
      }
      return appendAgentMessage(sendInput, createAgentStreamEmitter(sendInput.threadId), {
        onExecutionStarted: createExecutionStartCallback(sendInput)
      });
    },
    [AGENT_IPC_CHANNELS.APPEND_THREAD_MESSAGE]: async (params) => {
      const input = validateInput(agentAppendInputSchema, params, AGENT_IPC_CHANNELS.APPEND_THREAD_MESSAGE);
      return appendAgentMessage(input, createAgentStreamEmitter(input.threadId), {
        onExecutionStarted: createExecutionStartCallback(input)
      });
    },
    [AGENT_IPC_CHANNELS.WRITE_LOG]: async (params) => {
      const payload = asObject(params);
      const level = asString(payload.level) || "info";
      const contextName = asString(payload.context) || "web";
      const message = asString(payload.message);
      const threadId = asString(payload.threadId);
      const data = payload.data as Record<string, unknown> | undefined;

      if (!message) {
        return { ok: false };
      }

      const log = createLogger(contextName, threadId);
      const logMethod = level as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
      if (typeof log[logMethod] === "function") {
        log[logMethod](message, data);
      } else {
        log.info(message, data);
      }
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_LOGS_DIR]: async () => ({ path: getLogsDir() }),
    [AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, AGENT_IPC_CHANNELS.GET_WORKSPACE_ROOT_PATH);
      return getAgentWorkspacePath(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.GET_WORKSPACE_RESOURCES_PATH]: async (params) => {
      const input = validateInput(
        workspaceSlugInputSchema,
        params,
        AGENT_IPC_CHANNELS.GET_WORKSPACE_RESOURCES_PATH
      );
      return getWorkspaceResourcesDirectory(input.workspaceSlug);
    }
  };

  return handlers;
}
