import { AGENT_IPC_CHANNELS, type BootstrapFileType } from "@lume/shared";
import type {
  AgentPendingInteractiveState,
  AgentGenerateTitleInput,
  AgentListSubagentRunsInput,
  AgentPluginDiagnostic,
  AgentPluginListItem,
  AgentProxySettings,
  ImportLocalSkillDirectoryToWorkspaceInput,
  InstallSkillMarketItemToWorkspaceInput,
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
  moveAgentThreadToWorkspace,
  toggleAgentThreadPin,
  forkAgentThread,
  truncateAgentMessagesFrom,
  updateAgentThreadMeta,
  archiveAgentThread,
  restoreAgentThread,
  trashAgentThread,
  restoreAgentThreadFromTrash,
  permanentlyDeleteAgentThread,
  listArchivedThreads,
  listTrashedThreads,
  cleanupExpiredTrash,
} from "../services/agent/agent-thread-manager";
import { getAgentMessageVersions } from "../services/agent/agent-message-versioning-service";
import { getAgentRuntimeStatusManager } from "../services/agent/agent-runtime-status-manager";
import {
  appendAgentMessage,
  sendAgentMessage,
  generateAgentTitle,
  listAgentMessageQueue,
  promoteQueuedAgentMessageToGuidance,
  removeQueuedAgentMessage,
  reorderAgentMessageQueue,
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
  deleteWorkspaceRootFile,
  getAgentThreadPath,
  getWorkspaceResourcesDirectory,
  listAgentDirectory,
  listAttachedDirectory,
  listWorkspaceDirectory,
  listWorkspaceRootDirectory,
  moveAgentFile,
  moveWorkspaceFile,
  moveWorkspaceRootFile,
  moveAttachedPath,
  openAgentPath,
  openAttachedPath,
  openWorkspacePath,
  openWorkspaceRootPath,
  previewAgentPath,
  readAgentFileData,
  readAgentPath,
  previewWorkspacePath,
  readWorkspacePath,
  readWorkspaceRootPath,
  renameAgentFile,
  renameWorkspaceFile,
  renameWorkspaceRootFile,
  renameAttachedPath,
  resolveWorkspaceSlugByThreadId,
  saveFilesToAgentThread,
  saveFilesToWorkspace,
  saveFilesToWorkspaceRoot,
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
import { getWorkspaceMcpManager } from "../services/mcp/workspace-mcp-manager";
import {
  getGitHubSkillReview,
  installGitHubSkillToWorkspace
} from "../services/skills/github-skill-install-service";
import {
  getSkillMarketDetail,
  getSkillMarketCatalog,
  installSkillMarketItemToWorkspace,
  importLocalSkillDirectoryToWorkspace
} from "../services/skills/skills-market-service";
import {
  analyzeThreadWorkspaceSkillImprovements,
  analyzeWorkspaceSkillImprovement,
  applyWorkspaceSkillImprovement,
  listWorkspaceSkillVersions,
  restoreWorkspaceSkillVersion
} from "../services/skills/skill-evolution-service";
import {
  deleteEditableSkill,
  getEditableSkill,
  listEditableSkills,
  saveWorkspaceSkill
} from "../services/skills/workspace-skill-editor-service";
import { SidecarPluginManager } from "../services/agent-runtime/plugins/plugin-manager.js";
import { getEffectiveLumeConfig } from "../services/system/lume-config-service";
import { getAgentWorkspacePath } from "../services/infra/config-paths";
import { createLogger, getLogsDir } from "../services/infra/logger";
import type { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { isAgentRuntimeSessionActive } from "../services/agent-runtime/runtime-core/attempt";
import { getRuntimeCoreSessionDir } from "../services/agent-runtime/runtime-core/session-store";
import {
  buildColdStartContinuationMessage,
  LumeResumeService,
  type ResumeRunResult
} from "../services/agent-runtime/interruption/resume-service";
import {
  listPendingTaskApprovalRequests
} from "../services/agent-runtime/plan/task-approval-service";
import { createFileBackedRunContinuationStore } from "../services/agent-runtime/runner/run-continuation-store";
import { createFileBackedLumeRunStateStore } from "../services/agent-runtime/runner/run-state-store";
import { listThreadRuntimeEvents } from "../services/agent-runtime/replay/runtime-event-history";
import {
  createRuntimeOrchestrator,
  type RuntimeOrchestrator
} from "../services/agent-runtime/runtime-orchestrator";
import { redactTraceForLevel, type TraceRedactionLevel } from "../services/agent-runtime/trace/trace-redaction";
import { createFileBackedLumeTraceStore } from "../services/agent-runtime/trace/trace-store";
import { getSubagentRunRegistry } from "../services/agent/subagents/subagent-run-registry";
import { listPendingAskUserQuestionRequests } from "../services/agent-runtime/interruption/ask-user-question-session";
import { listPendingToolPermissionRequests } from "../services/agent-runtime/interruption/tool-permission-session";
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
  agentMoveThreadInputSchema,
  agentQueuedMessageInputSchema,
  agentRecentThreadMessagesInputSchema,
  agentReorderMessageQueueInputSchema,
  agentSendInputSchema,
  agentThreadIdInputSchema,
  agentTruncateThreadInputSchema,
  agentUpdateThreadTitleInputSchema,
  agentUpdateThreadModelSelectionInputSchema,
  applySkillImprovementInputSchema,
  executeTaskContractInputSchema,
  attachWorkspaceResourceToThreadInputSchema,
  attachedPathInputSchema,
  copyFolderToThreadInputSchema,
  deleteSkillInputSchema,
  editableSkillInputSchema,
  githubSkillReviewInputSchema,
  importLocalSkillDirectoryInputSchema,
  installGitHubSkillInputSchema,
  installSkillMarketItemInputSchema,
  listEditableSkillsInputSchema,
  listDirectoryInputSchema,
  moveAttachedFileInputSchema,
  moveFileInputSchema,
  pendingInteractiveInputSchema,
  pathFileInputSchema,
  promoteFileToWorkspaceInputSchema,
  proxySettingsInputSchema,
  readBootstrapFileInputSchema,
  listRunStatesInputSchema,
  mcpCallToolDiagnosticInputSchema,
  mcpListResourcesInputSchema,
  mcpReadResourceInputSchema,
  mcpStatusInputSchema,
  mcpTestServerInputSchema,
  renameAttachedFileInputSchema,
  renameFileInputSchema,
  resumeRunInputSchema,
  runTraceInputSchema,
  saveSkillInputSchema,
  saveFilesToWorkspaceInputSchema,
  saveFilesToThreadInputSchema,
  searchWorkspaceFilesInputSchema,
  skillMarketCatalogInputSchema,
  skillMarketDetailInputSchema,
  skillImprovementAnalysisInputSchema,
  skillVersionInputSchema,
  threadRunEventsInputSchema,
  threadPathInputSchema,
  submitAskUserQuestionInputSchema,
  submitTaskApprovalInputSchema,
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

const log = createLogger("agent-handlers");

/** Re-scan plugin directories and normalize into the LIST_PLUGINS/RELOAD_PLUGINS result shape. */
async function buildAgentPluginList(): Promise<{
  plugins: AgentPluginListItem[];
  diagnostics: AgentPluginDiagnostic[];
}> {
  const manager = new SidecarPluginManager();
  const plugins = await manager.resolveEnabled({ enabled: [], directories: [] });
  const items: AgentPluginListItem[] = plugins.map((p) => ({
    pluginId: p.name,
    name: p.name,
    version: p.version,
    root: p.root,
    manifestFormat: p.manifestFormat,
    description: p.manifest.description,
    displayName: p.manifest.displayName,
    hooks: p.manifest.hooks,
    mcpServers: p.manifest.mcpServers,
    skills: p.manifest.skills?.length ?? 0,
    commandTools: p.manifest.commandTools?.length ?? 0,
    diagnostics: (p.diagnostics ?? []) as AgentPluginDiagnostic[],
  }));
  return {
    plugins: items,
    diagnostics: items.flatMap((item) => item.diagnostics),
  };
}

interface AgentHandlersContext {
  writeNotification: NotificationWriter;
  planModePhaseTracker: PlanModePhaseTracker;
  notifyPlanModePhaseChange: (
    threadId: string,
    phase: "idle" | "planning" | "awaiting_approval" | "executing" | "completed"
  ) => void;
  appendAgentMessage?: typeof appendAgentMessage;
  analyzeThreadWorkspaceSkillImprovements?: typeof analyzeThreadWorkspaceSkillImprovements;
}

export function createAgentHandlers(context: AgentHandlersContext): Record<string, RpcHandler> {
  const appendAgentMessageForContext = context.appendAgentMessage ?? appendAgentMessage;
  const analyzeThreadWorkspaceSkillImprovementsForContext =
    context.analyzeThreadWorkspaceSkillImprovements ?? analyzeThreadWorkspaceSkillImprovements;

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

  const resumeRunForThread = async (input: {
    threadId: string;
    runId?: string;
    interruptionId?: string;
  }): Promise<ResumeRunResult> => {
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
        onRuntimeEvent: (event) => {
          context.writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
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
  };

  let runtimeOrchestrator: RuntimeOrchestrator;

  const createExecutionStartCallback = (input: AgentSendInput) => () => {
    if (!context.planModePhaseTracker.isLikelyExecutionRequest(input)) {
      return;
    }
    context.notifyPlanModePhaseChange(input.threadId, "executing");
  };

  const resolveWorkspaceSlugForThread = (threadId: string, workspaceId?: string): string | undefined => {
    const explicitWorkspace = workspaceId ? getAgentWorkspace(workspaceId) : undefined;
    if (explicitWorkspace) return explicitWorkspace.slug;
    const threadWorkspaceId = getAgentThreadMeta(threadId)?.workspaceId;
    return threadWorkspaceId ? getAgentWorkspace(threadWorkspaceId)?.slug : undefined;
  };

  const scheduleSkillImprovementSuggestionScan = (threadId: string, workspaceSlug?: string): void => {
    const resolvedWorkspaceSlug = workspaceSlug ?? resolveWorkspaceSlugForThread(threadId);
    if (!resolvedWorkspaceSlug) return;

    setTimeout(() => {
      void analyzeThreadWorkspaceSkillImprovementsForContext({
        workspaceSlug: resolvedWorkspaceSlug,
        cwd: getAgentThreadPath(resolvedWorkspaceSlug, threadId),
        threadId,
        getRecentMessages: (targetThreadId, limit) => getRecentAgentThreadMessages(targetThreadId, limit).messages
      })
        .then((suggestions) => {
          if (suggestions.length === 0) return;
          context.writeNotification(AGENT_IPC_CHANNELS.SKILL_IMPROVEMENT_SUGGESTED, {
            threadId,
            workspaceSlug: resolvedWorkspaceSlug,
            suggestions
          });
        })
        .catch((error) => {
          log.warn("Skill improvement scan failed", {
            threadId,
            workspaceSlug: resolvedWorkspaceSlug,
            error: error instanceof Error ? error.message : String(error)
          });
        });
    }, 0);
  };

  const createAgentStreamEmitter = (
    threadId: string,
    options?: { contractId?: string; taskRunId?: string; workspaceSlug?: string }
  ) => {
    return {
      onRuntimeEvent: (event: unknown) => {
        context.writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
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
          const createdAt = new Date(appended.message.createdAt ?? Date.now()).toISOString();
          context.writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
            threadId,
            event: {
              id: `${threadId}:${appended.message.id ?? createdAt}:message.user.submitted`,
              type: "message.user.submitted",
              runId: `message:${appended.message.id ?? createdAt}`,
              threadId,
              text: appended.message.content,
              createdAt,
              messageId: appended.message.id,
              versionGroupId: appended.message.versionGroupId,
              versionIndex: appended.message.versionIndex,
              versionCount: appended.message.versionCount
            }
          });
        }
      },
      onComplete: (payload?: { reason?: "max_turns" }) => {
        const turnLimited = payload?.reason === "max_turns";
        if (options?.taskRunId) {
          void runtimeOrchestrator.handleTaskRunCompletion({
            threadId,
            taskRunId: options.taskRunId,
            contractId: options.contractId,
            turnLimited
          });
          return;
        }
        scheduleSkillImprovementSuggestionScan(threadId, options?.workspaceSlug);
        if (context.planModePhaseTracker.getPhase(threadId) === "executing") {
          context.notifyPlanModePhaseChange(threadId, "completed");
        }
      },
      onError: (error: string) => {
        context.writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
          threadId,
          event: {
            id: `${threadId}:${Date.now()}:run.failed`,
            type: "run.failed",
            threadId,
            runId: `runtime-error:${threadId}`,
            createdAt: new Date().toISOString(),
            error: {
              code: "runtime_error",
              message: error
            }
          }
        });
        if (context.planModePhaseTracker.getPhase(threadId) === "executing") {
          context.notifyPlanModePhaseChange(threadId, "awaiting_approval");
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
          if (options?.taskRunId) {
            void runtimeOrchestrator.setTaskRunAwaitingInteraction({
              threadId,
              taskRunId: options.taskRunId,
              waitingFor: "user",
              reason: message || "等待用户回答"
            });
          }
          context.writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request);
        },
      onToolPermissionRequest: (request: unknown) =>
        {
          const toolRequest = request as { toolName?: string; reason?: string };
          if (options?.taskRunId) {
            void runtimeOrchestrator.setTaskRunAwaitingInteraction({
              threadId,
              taskRunId: options.taskRunId,
              waitingFor: "permission",
              reason: toolRequest.reason || (toolRequest.toolName ? `等待 ${toolRequest.toolName} 权限审批` : "等待工具权限审批")
            });
          }
          context.writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request);
        },
      onTaskContractUpdated: (contract?: { status?: string }) => {
        if (contract?.status === "needs_approval") {
          context.notifyPlanModePhaseChange(threadId, "awaiting_approval");
        }
      }
    };
  };

  runtimeOrchestrator = createRuntimeOrchestrator({
    appendAgentMessage,
    createAgentStreamEmitter,
    notifyPlanModePhaseChange: context.notifyPlanModePhaseChange,
    resolveRuntimeSessionDir,
    writeRuntimeEvent: (threadId, event) => {
      context.writeNotification(AGENT_IPC_CHANNELS.RUNTIME_EVENT, {
        threadId,
        event
      });
    }
  });

  const handlers: Record<string, RpcHandler> = {
    [AGENT_IPC_CHANNELS.LIST_THREADS]: async () => listAgentThreads(),
    [AGENT_IPC_CHANNELS.CREATE_THREAD]: async (params) => {
      const input = validateInput(agentCreateThreadInputSchema, params, AGENT_IPC_CHANNELS.CREATE_THREAD);
      log.info("[Agent 线程] 创建", {
        title: input.title,
        workspaceId: input.workspaceId,
        modelRef: input.modelRef,
        channelId: input.channelId
      });
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
    [AGENT_IPC_CHANNELS.GET_THREAD_RUNTIME_EVENTS]: async (params) => {
      const input = validateInput(threadRunEventsInputSchema, params, AGENT_IPC_CHANNELS.GET_THREAD_RUNTIME_EVENTS);
      return listThreadRuntimeEvents({
        sessionDir: resolveRuntimeSessionDir(input.threadId),
        threadId: input.threadId
      });
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
      if (isAgentRuntimeSessionActive(input.threadId)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (isAgentRuntimeSessionActive(input.threadId)) {
          throw new Error("线程正在运行中，请停止后再移动。");
        }
      }
      return moveAgentThreadToWorkspace(input.threadId, input.workspaceId);
    },
    [AGENT_IPC_CHANNELS.DELETE_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.DELETE_THREAD);
      log.info("[Agent 线程] 删除", { threadId: input.threadId.slice(0, 8) });
      deleteAgentThread(input.threadId);
      getAgentRuntimeStatusManager().clearSession(input.threadId);
      context.planModePhaseTracker.clearSession(input.threadId);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.ARCHIVE_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.ARCHIVE_THREAD);
      log.info("[Agent 线程] 归档", { threadId: input.threadId.slice(0, 8) });
      return archiveAgentThread(input.threadId);
    },
    [AGENT_IPC_CHANNELS.RESTORE_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.RESTORE_THREAD);
      return restoreAgentThread(input.threadId);
    },
    [AGENT_IPC_CHANNELS.TRASH_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.TRASH_THREAD);
      log.info("[Agent 线程] 移入回收站", { threadId: input.threadId.slice(0, 8) });
      return trashAgentThread(input.threadId);
    },
    [AGENT_IPC_CHANNELS.RESTORE_THREAD_FROM_TRASH]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.RESTORE_THREAD_FROM_TRASH);
      return restoreAgentThreadFromTrash(input.threadId);
    },
    [AGENT_IPC_CHANNELS.PERMANENTLY_DELETE_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.PERMANENTLY_DELETE_THREAD);
      log.info("[Agent 线程] 永久删除", { threadId: input.threadId.slice(0, 8) });
      permanentlyDeleteAgentThread(input.threadId);
      getAgentRuntimeStatusManager().clearSession(input.threadId);
      context.planModePhaseTracker.clearSession(input.threadId);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.LIST_ARCHIVED_THREADS]: async () => listArchivedThreads(),
    [AGENT_IPC_CHANNELS.LIST_TRASHED_THREADS]: async () => listTrashedThreads(),
    [AGENT_IPC_CHANNELS.CLEANUP_EXPIRED_TRASH]: async () => {
      const count = cleanupExpiredTrash();
      return { cleanedCount: count };
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
      const askRequests = listPendingAskUserQuestionRequests();
      const toolRequests = listPendingToolPermissionRequests();
      const taskApprovalRequests = await listPendingTaskApprovalRequests();
      const threadIds = new Set<string>();
      for (const request of askRequests) threadIds.add(request.threadId);
      for (const request of toolRequests) threadIds.add(request.threadId);
      for (const request of taskApprovalRequests) threadIds.add(request.threadId);

      const result: AgentPendingInteractiveState[] = [];
      for (const threadId of threadIds) {
        if (input.threadId && input.threadId !== threadId) continue;
        const askUserQuestions = askRequests.filter((request) => request.threadId === threadId);
        const toolPermissions = toolRequests.filter((request) => request.threadId === threadId);
        const taskApprovals = taskApprovalRequests.filter((request) => request.threadId === threadId);
        result.push({
          threadId,
          ...(askUserQuestions.length > 0 ? { askUserQuestions } : {}),
          ...(toolPermissions.length > 0 ? { toolPermissions } : {}),
          ...(taskApprovals.length > 0 ? { taskApprovals } : {})
        });
      }
      return result;
    },
    [AGENT_IPC_CHANNELS.RESUME_RUN]: async (params) => {
      const input = validateInput(resumeRunInputSchema, params, AGENT_IPC_CHANNELS.RESUME_RUN);
      return resumeRunForThread(input);
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
            contractId: run.contractId,
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
      const result = createAgentWorkspace(input.name);
      log.info("[Agent 工作区] 创建", { name: input.name });
      return result;
    },
    [AGENT_IPC_CHANNELS.UPDATE_WORKSPACE]: async (params) => {
      const input = validateInput(workspaceUpdateInputSchema, params, AGENT_IPC_CHANNELS.UPDATE_WORKSPACE);
      const result = updateAgentWorkspace(input.id, { name: input.name });
      log.info("[Agent 工作区] 更新", { id: input.id, name: input.name });
      return result;
    },
    [AGENT_IPC_CHANNELS.DELETE_WORKSPACE]: async (params) => {
      const input = validateInput(workspaceDeleteInputSchema, params, AGENT_IPC_CHANNELS.DELETE_WORKSPACE);
      const workspace = getAgentWorkspace(input.id);
      log.info("[Agent 工作区] 删除", { id: input.id });
      deleteAgentWorkspace(input.id);
      if (workspace) {
        await getWorkspaceMcpManager().disposeWorkspace(workspace.slug);
      }
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
      void getWorkspaceMcpManager().syncWorkspace(input.workspaceSlug).catch((error) => {
        log.warn("[MCP] 保存配置后同步失败", {
          workspaceSlug: input.workspaceSlug,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_MCP_STATUS]: async (params) => {
      const input = validateInput(mcpStatusInputSchema, params, AGENT_IPC_CHANNELS.GET_MCP_STATUS);
      await getWorkspaceMcpManager().syncWorkspace(input.workspaceSlug, {
        waitForConnections: input.waitForConnections !== false
      });
      return { servers: getWorkspaceMcpManager().getStatus(input.workspaceSlug) };
    },
    [AGENT_IPC_CHANNELS.TEST_MCP_SERVER]: async (params) => {
      const input = validateInput(mcpTestServerInputSchema, params, AGENT_IPC_CHANNELS.TEST_MCP_SERVER);
      return { server: await getWorkspaceMcpManager().testServer(input.workspaceSlug, input.serverId) };
    },
    [AGENT_IPC_CHANNELS.LIST_MCP_RESOURCES]: async (params) => {
      const input = validateInput(mcpListResourcesInputSchema, params, AGENT_IPC_CHANNELS.LIST_MCP_RESOURCES);
      return getWorkspaceMcpManager().listResources(input);
    },
    [AGENT_IPC_CHANNELS.READ_MCP_RESOURCE]: async (params) => {
      const input = validateInput(mcpReadResourceInputSchema, params, AGENT_IPC_CHANNELS.READ_MCP_RESOURCE);
      return getWorkspaceMcpManager().readResource(input);
    },
    [AGENT_IPC_CHANNELS.CALL_MCP_TOOL]: async (params) => {
      const input = validateInput(mcpCallToolDiagnosticInputSchema, params, AGENT_IPC_CHANNELS.CALL_MCP_TOOL);
      return getWorkspaceMcpManager().callToolDiagnostic(input);
    },
    [AGENT_IPC_CHANNELS.GET_PROXY_SETTINGS]: async () => getAgentProxyStatus(),
    [AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS]: async (params) =>
      saveAgentProxySettings(
        validateInput(proxySettingsInputSchema, params, AGENT_IPC_CHANNELS.SAVE_PROXY_SETTINGS) as AgentProxySettings
      ),
    [AGENT_IPC_CHANNELS.GET_SKILLS]: async (params) => {
      const input = validateInput(workspaceSlugInputSchema, params, AGENT_IPC_CHANNELS.GET_SKILLS);
      return getWorkspaceSkills(input.workspaceSlug);
    },
    [AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS]: async (params) => {
      const input = validateInput(listEditableSkillsInputSchema, params, AGENT_IPC_CHANNELS.LIST_EDITABLE_SKILLS);
      return listEditableSkills(input);
    },
    [AGENT_IPC_CHANNELS.GET_EDITABLE_SKILL]: async (params) => {
      const input = validateInput(editableSkillInputSchema, params, AGENT_IPC_CHANNELS.GET_EDITABLE_SKILL);
      return getEditableSkill(input);
    },
    [AGENT_IPC_CHANNELS.SAVE_SKILL]: async (params) => {
      const input = validateInput(saveSkillInputSchema, params, AGENT_IPC_CHANNELS.SAVE_SKILL);
      return saveWorkspaceSkill(input);
    },
    [AGENT_IPC_CHANNELS.DELETE_SKILL]: async (params) => {
      const input = validateInput(deleteSkillInputSchema, params, AGENT_IPC_CHANNELS.DELETE_SKILL);
      if (input.storageScope) {
        deleteEditableSkill({
          storageScope: input.storageScope,
          workspaceSlug: input.workspaceSlug,
          skillSlug: input.skillSlug,
          cwd: input.cwd
        });
        return { ok: true };
      }
      deleteWorkspaceSkill(input.workspaceSlug, input.skillSlug);
      return { ok: true };
    },
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
    [AGENT_IPC_CHANNELS.LIST_SKILL_VERSIONS]: async (params) => {
      const input = validateInput(
        skillVersionInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_SKILL_VERSIONS
      );
      return listWorkspaceSkillVersions(input);
    },
    [AGENT_IPC_CHANNELS.RESTORE_SKILL_VERSION]: async (params) => {
      const input = validateInput(
        skillVersionInputSchema.required({ filename: true }),
        params,
        AGENT_IPC_CHANNELS.RESTORE_SKILL_VERSION
      );
      return restoreWorkspaceSkillVersion(input);
    },
    [AGENT_IPC_CHANNELS.ANALYZE_SKILL_IMPROVEMENT]: async (params) => {
      const input = validateInput(
        skillImprovementAnalysisInputSchema,
        params,
        AGENT_IPC_CHANNELS.ANALYZE_SKILL_IMPROVEMENT
      );
      return analyzeWorkspaceSkillImprovement({
        ...input,
        getRecentMessages: (threadId, limit) => getRecentAgentThreadMessages(threadId, limit).messages
      });
    },
    [AGENT_IPC_CHANNELS.APPLY_SKILL_IMPROVEMENT]: async (params) => {
      const input = validateInput(
        applySkillImprovementInputSchema,
        params,
        AGENT_IPC_CHANNELS.APPLY_SKILL_IMPROVEMENT
      );
      return applyWorkspaceSkillImprovement(input);
    },
    [AGENT_IPC_CHANNELS.LIST_PLUGINS]: async () => {
      const result = await buildAgentPluginList();
      log.info("LIST_PLUGINS request", { count: result.plugins.length, names: result.plugins.map((p) => p.name) });
      return result;
    },
    [AGENT_IPC_CHANNELS.RELOAD_PLUGINS]: async () => {
      const result = await buildAgentPluginList();
      log.info("RELOAD_PLUGINS request", { count: result.plugins.length, names: result.plugins.map((p) => p.name) });
      // 通知 client 刷新能力 UI。下一次 agent attempt 自动读到新磁盘状态（无状态、按尝试加载）。
      context.writeNotification(AGENT_IPC_CHANNELS.CAPABILITIES_CHANGED, {});
      return result;
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
    [AGENT_IPC_CHANNELS.LIST_WORKSPACE_ROOT_DIRECTORY]: async (params) => {
      const input = validateInput(
        workspacePathInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_WORKSPACE_ROOT_DIRECTORY
      );
      return listWorkspaceRootDirectory(input.workspaceSlug, input.path);
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
    [AGENT_IPC_CHANNELS.DELETE_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.DELETE_WORKSPACE_ROOT_FILE
      );
      return deleteWorkspaceRootFile(input.workspaceSlug, input.path);
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
    [AGENT_IPC_CHANNELS.OPEN_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.OPEN_WORKSPACE_ROOT_FILE
      );
      return openWorkspaceRootPath(input.workspaceSlug, input.path);
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
    [AGENT_IPC_CHANNELS.READ_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.READ_FILE);
      return readAgentPath(
        resolveRequiredWorkspaceSlug(input.threadId, input.workspaceSlug),
        input.threadId,
        input.path
      );
    },
    [AGENT_IPC_CHANNELS.READ_THREAD_FILE_DATA]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.READ_THREAD_FILE_DATA);
      return readAgentFileData(
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
    [AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_WORKSPACE_FILE
      );
      return readWorkspacePath(input.workspaceSlug, input.path);
    },
    [AGENT_IPC_CHANNELS.READ_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRequiredPathInputSchema,
        params,
        AGENT_IPC_CHANNELS.READ_WORKSPACE_ROOT_FILE
      );
      return readWorkspaceRootPath(input.workspaceSlug, input.path);
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
    [AGENT_IPC_CHANNELS.RENAME_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceRenameFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.RENAME_WORKSPACE_ROOT_FILE
      );
      return renameWorkspaceRootFile(input.workspaceSlug, input.path, input.newName);
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
    [AGENT_IPC_CHANNELS.MOVE_WORKSPACE_ROOT_FILE]: async (params) => {
      const input = validateInput(
        workspaceMoveFileInputSchema,
        params,
        AGENT_IPC_CHANNELS.MOVE_WORKSPACE_ROOT_FILE
      );
      return moveWorkspaceRootFile(input.workspaceSlug, input.path, input.targetDir);
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
    [AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE_ROOT]: async (params) =>
      saveFilesToWorkspaceRoot(
        validateInput(saveFilesToWorkspaceInputSchema, params, AGENT_IPC_CHANNELS.SAVE_FILES_TO_WORKSPACE_ROOT)
      ),
    [AGENT_IPC_CHANNELS.GENERATE_TITLE]: async (params) => generateAgentTitle(params as AgentGenerateTitleInput),
    [AGENT_IPC_CHANNELS.STOP_THREAD]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.STOP_THREAD);
      stopAgent(input.threadId);
      if (context.planModePhaseTracker.getPhase(input.threadId) === "executing") {
        context.notifyPlanModePhaseChange(input.threadId, "awaiting_approval");
      }
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION]: async (params) => {
      const input = validateInput(
        submitAskUserQuestionInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION
      );
      const result = await submitAskUserQuestionAnswers({
        threadId: input.threadId,
        toolUseId: input.toolUseId,
        canceled: input.canceled === true,
        answers: input.answers
      });
      if (result.handledBy === "persisted") {
        const resume = await resumeRunForThread({
          threadId: result.threadId,
          runId: result.runId
        });
        if (resume.status !== "not_resumable") {
          return { ...result, resume };
        }
      }
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
        decision: input.decision,
        ...(input.threadPermissionMode ? { threadPermissionMode: input.threadPermissionMode } : {})
      });
      return result;
    },
    [AGENT_IPC_CHANNELS.SUBMIT_TASK_APPROVAL]: async (params) => {
      const input = validateInput(
        submitTaskApprovalInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_TASK_APPROVAL
      );
      return runtimeOrchestrator.submitTaskApproval(input);
    },
    [AGENT_IPC_CHANNELS.EXECUTE_TASK_CONTRACT]: async (params) => {
      const input = validateInput(executeTaskContractInputSchema, params, AGENT_IPC_CHANNELS.EXECUTE_TASK_CONTRACT);
      return runtimeOrchestrator.dispatchTaskExecution({
        threadId: input.threadId,
        contractId: input.contractId,
        permissionMode: input.permissionMode,
        intent: input.intent
      });
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
      const approvalDispatch = await runtimeOrchestrator.dispatchPlanExecutionApproval(input);
      if (approvalDispatch) {
        return approvalDispatch;
      }
      const sendInput = await runtimeOrchestrator.resolvePlanContinuationInput(input);
      if (sendInput.permissionMode === "plan") {
        context.notifyPlanModePhaseChange(sendInput.threadId, "planning");
      }
      return appendAgentMessageForContext(sendInput, createAgentStreamEmitter(sendInput.threadId, {
        workspaceSlug: resolveWorkspaceSlugForThread(sendInput.threadId, sendInput.workspaceId)
      }), {
        onExecutionStarted: createExecutionStartCallback(sendInput)
      });
    },
    [AGENT_IPC_CHANNELS.APPEND_THREAD_MESSAGE]: async (params) => {
      const input = validateInput(agentAppendInputSchema, params, AGENT_IPC_CHANNELS.APPEND_THREAD_MESSAGE);
      return appendAgentMessageForContext(input, createAgentStreamEmitter(input.threadId, {
        workspaceSlug: resolveWorkspaceSlugForThread(input.threadId, input.workspaceId)
      }), {
        onExecutionStarted: createExecutionStartCallback(input)
      });
    },
    [AGENT_IPC_CHANNELS.LIST_MESSAGE_QUEUE]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.LIST_MESSAGE_QUEUE);
      return listAgentMessageQueue(input.threadId);
    },
    [AGENT_IPC_CHANNELS.REORDER_MESSAGE_QUEUE]: async (params) => {
      const input = validateInput(
        agentReorderMessageQueueInputSchema,
        params,
        AGENT_IPC_CHANNELS.REORDER_MESSAGE_QUEUE
      );
      return reorderAgentMessageQueue(input);
    },
    [AGENT_IPC_CHANNELS.REMOVE_QUEUED_MESSAGE]: async (params) => {
      const input = validateInput(
        agentQueuedMessageInputSchema,
        params,
        AGENT_IPC_CHANNELS.REMOVE_QUEUED_MESSAGE
      );
      return removeQueuedAgentMessage(input);
    },
    [AGENT_IPC_CHANNELS.PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE]: async (params) => {
      const input = validateInput(
        agentQueuedMessageInputSchema,
        params,
        AGENT_IPC_CHANNELS.PROMOTE_QUEUED_MESSAGE_TO_GUIDANCE
      );
      return promoteQueuedAgentMessageToGuidance(input);
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
