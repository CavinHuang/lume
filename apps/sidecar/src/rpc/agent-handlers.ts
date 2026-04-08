import { AGENT_IPC_CHANNELS, type BootstrapFileType } from "@lume/shared";
import type {
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
  createAgentThread,
  deleteAgentThread,
  getAgentThreadMessages,
  getRecentAgentThreadMessages,
  listAgentThreads,
  migrateChatToAgentThread,
  moveAgentThreadToWorkspace,
  toggleAgentThreadPin,
  forkAgentThread,
  truncateAgentMessagesFrom,
  updateAgentThreadMeta
} from "../services/agent/agent-session-manager";
import { getAgentMessageVersions } from "../services/agent/agent-message-versioning-service";
import { getAgentRuntimeStatusManager } from "../services/agent/agent-runtime-status-manager";
import {
  generateAgentTitle,
  sendAgentMessage,
  stopAgent,
  submitAgentToolPermission,
  submitAskUserQuestionAnswers
} from "../services/agent/agent-service";
import {
  copyFolderToSession,
  deleteAgentFile,
  deleteAgentPlan,
  getAgentThreadPath,
  listAgentDirectory,
  listAttachedDirectory,
  listAgentPlans,
  moveAgentFile,
  moveAttachedPath,
  openAgentPath,
  openAttachedPath,
  previewAgentPath,
  readAgentPlan,
  renameAgentFile,
  renameAttachedPath,
  resolveWorkspaceSlugByThreadId,
  saveFilesToAgentThread,
  searchAgentWorkspaceFiles,
  showAgentPathInFolder,
  showAttachedPathInFolder
} from "../services/agent/agent-files-service";
import {
  createAgentWorkspace,
  deleteAgentWorkspace,
  deleteWorkspaceSkill,
  ensureDefaultWorkspace,
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
import { getAgentWorkspacePath } from "../services/infra/config-paths";
import { createLogger, getLogsDir } from "../services/infra/logger";
import type { PlanStateTracker } from "../services/agent/plan-state-tracker";
import { isPiAgentSessionActive } from "../services/pi-agent/runtime-core/attempt";
import { getSubagentRunRegistry } from "../services/agent/subagents/subagent-run-registry";
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
  attachedPathInputSchema,
  copyFolderToThreadInputSchema,
  deleteSkillInputSchema,
  listDirectoryInputSchema,
  marketplaceDetailInputSchema,
  moveAttachedFileInputSchema,
  moveFileInputSchema,
  pathFileInputSchema,
  plansListInputSchema,
  plansReadDeleteInputSchema,
  proxySettingsInputSchema,
  readBootstrapFileInputSchema,
  renameAttachedFileInputSchema,
  renameFileInputSchema,
  saveFilesToThreadInputSchema,
  saveToolPolicyInputSchema,
  searchWorkspaceFilesInputSchema,
  threadPathInputSchema,
  submitAskUserQuestionInputSchema,
  submitToolPermissionInputSchema,
  workspaceCreateInputSchema,
  workspaceDeleteInputSchema,
  workspaceMcpConfigInputSchema,
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
  const handlers: Record<string, RpcHandler> = {
    [AGENT_IPC_CHANNELS.LIST_THREADS]: async () => listAgentThreads(),
    [AGENT_IPC_CHANNELS.LIST_SESSIONS]: async () => listAgentThreads(),
    [AGENT_IPC_CHANNELS.CREATE_THREAD]: async (params) => {
      const input = validateInput(agentCreateThreadInputSchema, params, AGENT_IPC_CHANNELS.CREATE_THREAD);
      return createAgentThread(
        input.title,
        input.channelId,
        input.workspaceId,
        input.parentThreadId,
        input.modelId
      );
    },
    [AGENT_IPC_CHANNELS.CREATE_SESSION]: async (params) => {
      const record = (params ?? {}) as Record<string, unknown>;
      const input = validateInput(
        agentCreateThreadInputSchema,
        {
          title: record.title,
          channelId: record.channelId,
          modelId: record.modelId,
          workspaceId: record.workspaceId,
          parentThreadId: record.parentSessionId
        },
        AGENT_IPC_CHANNELS.CREATE_SESSION
      );
      return createAgentThread(
        input.title,
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
    [AGENT_IPC_CHANNELS.GET_MESSAGES]: async (params) => {
      const record = (params ?? {}) as Record<string, unknown>;
      const input = validateInput(
        agentThreadIdInputSchema,
        { threadId: record.sessionId },
        AGENT_IPC_CHANNELS.GET_MESSAGES
      );
      return getAgentThreadMessages(input.threadId);
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
      return updateAgentThreadMeta(input.threadId, {
        channelId: input.channelId,
        modelId: input.modelId
      });
    },
    [AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_AGENT]: async (params) => {
      const input = validateInput(agentMigrateChatInputSchema, params, AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_AGENT);
      const migrated = migrateChatToAgentThread(input.conversationId, input.threadId);
      return { ok: true, migrated };
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
          throw new Error("会话正在运行中，请停止后再移动。");
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
      return getAgentThreadPath(input.workspaceSlug, input.threadId);
    },
    [AGENT_IPC_CHANNELS.LIST_DIRECTORY]: async (params) => {
      const input = validateInput(listDirectoryInputSchema, params, AGENT_IPC_CHANNELS.LIST_DIRECTORY);
      return listAgentDirectory(input.workspaceSlug, input.threadId, input.path);
    },
    [AGENT_IPC_CHANNELS.DELETE_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.DELETE_FILE);
      return deleteAgentFile(input.workspaceSlug, input.threadId, input.path);
    },
    [AGENT_IPC_CHANNELS.OPEN_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.OPEN_FILE);
      return openAgentPath(input.workspaceSlug, input.threadId, input.path);
    },
    [AGENT_IPC_CHANNELS.SHOW_IN_FOLDER]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.SHOW_IN_FOLDER);
      return showAgentPathInFolder(input.workspaceSlug, input.threadId, input.path);
    },
    [AGENT_IPC_CHANNELS.PREVIEW_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.PREVIEW_FILE);
      return previewAgentPath(input.workspaceSlug, input.threadId, input.path);
    },
    [AGENT_IPC_CHANNELS.RENAME_FILE]: async (params) => {
      const input = validateInput(renameFileInputSchema, params, AGENT_IPC_CHANNELS.RENAME_FILE);
      return renameAgentFile(input.workspaceSlug, input.threadId, input.path, input.newName);
    },
    [AGENT_IPC_CHANNELS.MOVE_FILE]: async (params) => {
      const input = validateInput(moveFileInputSchema, params, AGENT_IPC_CHANNELS.MOVE_FILE);
      return moveAgentFile(input.workspaceSlug, input.threadId, input.path, input.targetDir);
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
    [AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES]: async (params) => {
      const input = validateInput(
        searchWorkspaceFilesInputSchema,
        params,
        AGENT_IPC_CHANNELS.SEARCH_WORKSPACE_FILES
      );
      return searchAgentWorkspaceFiles(
        input.workspaceSlug,
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
        throw new Error("未找到会话对应的 workspace");
      }
      return listAgentPlans(resolvedWorkspaceSlug, input.threadId);
    },
    [AGENT_IPC_CHANNELS.READ_PLAN]: async (params) => {
      const input = validateInput(plansReadDeleteInputSchema, params, AGENT_IPC_CHANNELS.READ_PLAN);
      const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugByThreadId(input.threadId);
      if (!resolvedWorkspaceSlug) {
        throw new Error("未找到会话对应的 workspace");
      }
      return readAgentPlan(resolvedWorkspaceSlug, input.threadId, input.planPath);
    },
    [AGENT_IPC_CHANNELS.DELETE_PLAN]: async (params) => {
      const input = validateInput(plansReadDeleteInputSchema, params, AGENT_IPC_CHANNELS.DELETE_PLAN);
      const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugByThreadId(input.threadId);
      if (!resolvedWorkspaceSlug) {
        throw new Error("未找到会话对应的 workspace");
      }
      return deleteAgentPlan(resolvedWorkspaceSlug, input.threadId, input.planPath);
    },
    [AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD]: async (params) =>
      saveFilesToAgentThread(
        validateInput(saveFilesToThreadInputSchema, params, AGENT_IPC_CHANNELS.SAVE_FILES_TO_THREAD)
      ),
    [AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD]: async (params) =>
      copyFolderToSession(
        validateInput(copyFolderToThreadInputSchema, params, AGENT_IPC_CHANNELS.COPY_FOLDER_TO_THREAD)
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
    [AGENT_IPC_CHANNELS.STOP_AGENT]: async (params) => {
      const record = (params ?? {}) as Record<string, unknown>;
      const input = validateInput(
        agentThreadIdInputSchema,
        { threadId: record.sessionId },
        AGENT_IPC_CHANNELS.STOP_AGENT
      );
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
      if (context.planStateTracker.isLikelyExecutionRequest(input)) {
        const steps = context.planStateTracker.syncExecutionFromUserMessage(input.threadId, input.userMessage);
        context.notifyPlanStateChange(input.threadId, "executing", steps ? { steps } : undefined);
      }
      void sendAgentMessage(input, {
        onSdkMessage: (message) => {
          context.writeNotification(AGENT_IPC_CHANNELS.STREAM_EVENT, {
            threadId: input.threadId,
            message
          });
        },
        onComplete: () => {
          if (context.planStateTracker.getPhase(input.threadId) === "executing") {
            const steps = context.planStateTracker.markCurrentStepCompleted(input.threadId);
            context.notifyPlanStateChange(input.threadId, "executed", steps ? { steps } : undefined);
          }
        },
        onError: (error) => {
          context.writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            threadId: input.threadId,
            error
          });
          if (context.planStateTracker.getPhase(input.threadId) === "executing") {
            const steps = context.planStateTracker.markCurrentStepFailed(input.threadId, error);
            context.notifyPlanStateChange(input.threadId, "review", steps ? { steps } : undefined);
          }
        },
        onTitleUpdated: (title) =>
          context.writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            threadId: input.threadId,
            title
          }),
        onAskUserQuestion: (request) =>
          context.writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request),
        onToolPermissionRequest: (request) =>
          context.writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request)
      }).catch((error) => {
        context.writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
          threadId: input.threadId,
          error: error instanceof Error ? error.message : String(error)
        });
        if (context.planStateTracker.getPhase(input.threadId) === "executing") {
          const steps = context.planStateTracker.markCurrentStepFailed(
            input.threadId,
            error instanceof Error ? error.message : String(error)
          );
          context.notifyPlanStateChange(input.threadId, "review", steps ? { steps } : undefined);
        }
      });
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.SEND_MESSAGE]: async (params) => {
      const record = (params ?? {}) as Record<string, unknown>;
      const input = validateInput(
        agentSendInputSchema,
        {
          threadId: record.sessionId,
          userMessage: record.userMessage,
          channelId: record.channelId,
          modelId: record.modelId,
          workspaceId: record.workspaceId,
          chatType: record.chatType,
          threadType: record.sessionType,
          permissionMode: record.permissionMode,
          thinkingLevel: record.thinkingLevel,
          messageMetadata: record.messageMetadata,
          resendFromMessageId: record.resendFromMessageId,
          editFromMessageId: record.editFromMessageId
        },
        AGENT_IPC_CHANNELS.SEND_MESSAGE
      );
      if (context.planStateTracker.isLikelyExecutionRequest(input)) {
        const steps = context.planStateTracker.syncExecutionFromUserMessage(input.threadId, input.userMessage);
        context.notifyPlanStateChange(input.threadId, "executing", steps ? { steps } : undefined);
      }
      void sendAgentMessage(input, {
        onSdkMessage: (message) => {
          context.writeNotification(AGENT_IPC_CHANNELS.STREAM_EVENT, {
            sessionId: input.threadId,
            threadId: input.threadId,
            message
          });
        },
        onComplete: () => {
          context.writeNotification(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
            sessionId: input.threadId,
            threadId: input.threadId
          });
          if (context.planStateTracker.getPhase(input.threadId) === "executing") {
            const steps = context.planStateTracker.markCurrentStepCompleted(input.threadId);
            context.notifyPlanStateChange(input.threadId, "executed", steps ? { steps } : undefined);
          }
        },
        onError: (error) => {
          context.writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: input.threadId,
            threadId: input.threadId,
            error
          });
          if (context.planStateTracker.getPhase(input.threadId) === "executing") {
            const steps = context.planStateTracker.markCurrentStepFailed(input.threadId, error);
            context.notifyPlanStateChange(input.threadId, "review", steps ? { steps } : undefined);
          }
        },
        onTitleUpdated: (title) =>
          context.writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.threadId,
            threadId: input.threadId,
            title
          }),
        onAskUserQuestion: (request) =>
          context.writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, {
            ...request,
            sessionId: request.threadId
          }),
        onToolPermissionRequest: (request) =>
          context.writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, {
            ...request,
            sessionId: request.threadId
          })
      }).catch((error) => {
        context.writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
          sessionId: input.threadId,
          threadId: input.threadId,
          error: error instanceof Error ? error.message : String(error)
        });
        if (context.planStateTracker.getPhase(input.threadId) === "executing") {
          const steps = context.planStateTracker.markCurrentStepFailed(
            input.threadId,
            error instanceof Error ? error.message : String(error)
          );
          context.notifyPlanStateChange(input.threadId, "review", steps ? { steps } : undefined);
        }
      });
      return { ok: true };
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
    }
  };

  return handlers;
}

