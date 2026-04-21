import { AGENT_IPC_CHANNELS, type BootstrapFileType } from "@lume/shared";
import type {
  AgentPendingInteractiveState,
  AgentGenerateTitleInput,
  AgentListSubagentRunsInput,
  AgentProxySettings,
  AgentRuntimeToolPolicyConfig,
  ImportGlobalMcpToWorkspaceInput,
  ImportGlobalSkillToWorkspaceInput,
  InstallGlobalPluginInput,
  PlanStep,
  WorkspaceMcpConfig
} from "@lume/shared";
import {
  createAgentThreadWithModelRef,
  deleteAgentThread,
  getAgentThreadMeta,
  getAgentThreadMessages,
  getAgentThreadSDKMessages,
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
import { getEffectiveLumeConfig } from "../services/system/lume-config-service";
import { getAgentWorkspacePath } from "../services/infra/config-paths";
import { createLogger, getLogsDir } from "../services/infra/logger";
import type { PlanStateTracker } from "../services/agent/plan-state-tracker";
import { isPiAgentSessionActive } from "../services/pi-agent/runtime-core/attempt";
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
  attachWorkspaceResourceToThreadInputSchema,
  attachedPathInputSchema,
  copyFolderToThreadInputSchema,
  deleteSkillInputSchema,
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
  renameAttachedFileInputSchema,
  renameFileInputSchema,
  saveFilesToWorkspaceInputSchema,
  saveFilesToThreadInputSchema,
  saveToolPolicyInputSchema,
  searchWorkspaceFilesInputSchema,
  threadPathInputSchema,
  submitAskUserQuestionInputSchema,
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

export function createAgentHandlers(context: AgentHandlersContext): Record<string, RpcHandler> {
  const resolveRequiredWorkspaceSlug = (threadId: string, workspaceSlug?: string) => {
    const resolvedWorkspaceSlug = workspaceSlug ?? resolveWorkspaceSlugByThreadId(threadId);
    if (!resolvedWorkspaceSlug) {
      throw new Error("未找到线程对应的 workspace");
    }
    return resolvedWorkspaceSlug;
  };

  const createExecutionStartCallback = (input: { threadId: string; userMessage: string }) => () => {
    if (!context.planStateTracker.isLikelyExecutionRequest(input)) {
      return;
    }
    const steps = context.planStateTracker.syncExecutionFromUserMessage(input.threadId, input.userMessage);
    context.notifyPlanStateChange(input.threadId, "executing", steps ? { steps } : undefined);
  };

  const createAgentStreamEmitter = (threadId: string) => ({
    onSdkMessage: (message: unknown) => {
      context.writeNotification(AGENT_IPC_CHANNELS.STREAM_EVENT, {
        threadId,
        message
      });
    },
    onMessageAppended: (event: unknown) => {
      context.writeNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
    },
    onComplete: () => {
      context.writeNotification(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
        threadId
      });
      if (context.planStateTracker.getPhase(threadId) === "executing") {
        const steps = context.planStateTracker.markCurrentStepCompleted(threadId);
        context.notifyPlanStateChange(threadId, "executed", steps ? { steps } : undefined);
      }
    },
    onError: (error: string) => {
      context.writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        threadId,
        error
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
      context.writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request),
    onToolPermissionRequest: (request: unknown) =>
      context.writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request)
  });

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
    [AGENT_IPC_CHANNELS.GET_THREAD_SDK_MESSAGES]: async (params) => {
      const input = validateInput(agentThreadIdInputSchema, params, AGENT_IPC_CHANNELS.GET_THREAD_SDK_MESSAGES);
      return {
        threadId: input.threadId,
        messages: getAgentThreadSDKMessages(input.threadId)
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
      const threadIds = new Set<string>();
      for (const request of askRequests) threadIds.add(request.threadId);
      for (const request of toolRequests) threadIds.add(request.threadId);

      const result: AgentPendingInteractiveState[] = [];
      for (const threadId of threadIds) {
        if (input.threadId && input.threadId !== threadId) continue;
        const askUserQuestions = askRequests.filter((request) => request.threadId === threadId);
        const toolPermissions = toolRequests.filter((request) => request.threadId === threadId);
        result.push({
          threadId,
          ...(askUserQuestions.length > 0 ? { askUserQuestions } : {}),
          ...(toolPermissions.length > 0 ? { toolPermissions } : {})
        });
      }
      return result;
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
      return submitAskUserQuestionAnswers({
        threadId: input.threadId,
        toolUseId: input.toolUseId,
        canceled: input.canceled === true,
        answers: input.answers
      });
    },
    [AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION]: async (params) => {
      const input = validateInput(
        submitToolPermissionInputSchema,
        params,
        AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION
      );
      return submitAgentToolPermission({
        threadId: input.threadId,
        requestId: input.requestId,
        decision: input.decision
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
      return appendAgentMessage(input, createAgentStreamEmitter(input.threadId), {
        onExecutionStarted: createExecutionStartCallback(input)
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
