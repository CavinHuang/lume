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
  createAgentSession,
  deleteAgentSession,
  getAgentSessionMessages,
  getRecentAgentMessages,
  listAgentSessions,
  migrateChatToAgentSession,
  moveAgentSessionToWorkspace,
  toggleAgentSessionPin,
  truncateAgentMessagesFrom,
  updateAgentSessionMeta
} from "../services/agent-session-manager";
import { getAgentRuntimeStatusManager } from "../services/agent-runtime-status-manager";
import {
  generateAgentTitle,
  sendAgentMessage,
  stopAgent,
  submitAgentToolPermission,
  submitAskUserQuestionAnswers
} from "../services/agent-service";
import {
  copyFolderToSession,
  deleteAgentFile,
  deleteAgentPlan,
  getAgentSessionPath,
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
  resolveWorkspaceSlugBySessionId,
  saveFilesToAgentSession,
  searchAgentWorkspaceFiles,
  showAgentPathInFolder,
  showAttachedPathInFolder
} from "../services/agent-files-service";
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
} from "../services/agent-workspace-manager";
import {
  getGlobalDiscoverySnapshot,
  getGlobalMarketplaceDetail,
  importGlobalMcpToWorkspace,
  importGlobalSkillToWorkspace,
  installGlobalPlugin
} from "../services/global-discovery-service";
import { createLogger, getLogsDir } from "../services/logger";
import type { PlanStateTracker } from "../services/plan-state-tracker";
import { getSessionEventBus } from "../services/pi-agent/session-event-bus";
import { isPiAgentSessionActive } from "../services/pi-agent/runner/run";
import { getSubagentRunRegistry } from "../services/pi-agent/subagents/subagent-run-registry";
import {
  getAgentRuntimeToolPolicyConfig,
  saveAgentRuntimeToolPolicyConfig
} from "../services/pi-agent/tools/tool-policy";
import {
  getAgentProxyStatus,
  saveAgentProxySettings
} from "../services/proxy-settings-manager";
import { readBootstrapFile, writeBootstrapFile } from "../services/workspace-bootstrap-service";
import {
  agentCreateSessionInputSchema,
  agentListSubagentRunsInputSchema,
  agentMigrateChatInputSchema,
  agentMoveSessionInputSchema,
  agentRecentMessagesInputSchema,
  agentSendInputSchema,
  agentSessionIdInputSchema,
  agentTruncateInputSchema,
  agentUpdateTitleInputSchema,
  attachedPathInputSchema,
  copyFolderToSessionInputSchema,
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
  saveFilesToSessionInputSchema,
  saveToolPolicyInputSchema,
  searchWorkspaceFilesInputSchema,
  sessionPathInputSchema,
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
    sessionId: string,
    phase: "idle" | "planning" | "review" | "executing" | "executed",
    extras?: { planPath?: string; steps?: PlanStep[] }
  ) => void;
}

export function createAgentHandlers(context: AgentHandlersContext): Record<string, RpcHandler> {
  return {
    [AGENT_IPC_CHANNELS.LIST_SESSIONS]: async () => listAgentSessions(),
    [AGENT_IPC_CHANNELS.CREATE_SESSION]: async (params) => {
      const input = validateInput(agentCreateSessionInputSchema, params, AGENT_IPC_CHANNELS.CREATE_SESSION);
      return createAgentSession(
        input.title,
        input.channelId,
        input.modelId,
        input.workspaceId,
        input.parentSessionId
      );
    },
    [AGENT_IPC_CHANNELS.GET_MESSAGES]: async (params) => {
      const input = validateInput(agentSessionIdInputSchema, params, AGENT_IPC_CHANNELS.GET_MESSAGES);
      return getAgentSessionMessages(input.sessionId);
    },
    [AGENT_IPC_CHANNELS.GET_RECENT_MESSAGES]: async (params) => {
      const input = validateInput(agentRecentMessagesInputSchema, params, AGENT_IPC_CHANNELS.GET_RECENT_MESSAGES);
      return getRecentAgentMessages(input.sessionId, input.limit);
    },
    [AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS]: async (params) => {
      const input = validateInput(
        agentListSubagentRunsInputSchema,
        params,
        AGENT_IPC_CHANNELS.LIST_SUBAGENT_RUNS
      ) as AgentListSubagentRunsInput;
      const runRegistry = getSubagentRunRegistry();
      const limit = typeof input.limit === "number" ? input.limit : 50;
      let runs = input.ownerSessionId
        ? runRegistry.listControlledBySession(input.ownerSessionId)
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
    [AGENT_IPC_CHANNELS.UPDATE_TITLE]: async (params) => {
      const input = validateInput(agentUpdateTitleInputSchema, params, AGENT_IPC_CHANNELS.UPDATE_TITLE);
      return updateAgentSessionMeta(input.sessionId, { title: input.title });
    },
    [AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_AGENT]: async (params) => {
      const input = validateInput(agentMigrateChatInputSchema, params, AGENT_IPC_CHANNELS.MIGRATE_CHAT_TO_AGENT);
      const migrated = migrateChatToAgentSession(input.conversationId, input.sessionId);
      return { ok: true, migrated };
    },
    [AGENT_IPC_CHANNELS.TOGGLE_PIN_SESSION]: async (params) => {
      const input = validateInput(agentSessionIdInputSchema, params, AGENT_IPC_CHANNELS.TOGGLE_PIN_SESSION);
      return toggleAgentSessionPin(input.sessionId);
    },
    [AGENT_IPC_CHANNELS.MOVE_SESSION]: async (params) => {
      const input = validateInput(agentMoveSessionInputSchema, params, AGENT_IPC_CHANNELS.MOVE_SESSION);
      if (isPiAgentSessionActive(input.sessionId)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (isPiAgentSessionActive(input.sessionId)) {
          throw new Error("会话正在运行中，请停止后再移动。");
        }
      }
      return moveAgentSessionToWorkspace(input.sessionId, input.workspaceId);
    },
    [AGENT_IPC_CHANNELS.DELETE_SESSION]: async (params) => {
      const input = validateInput(agentSessionIdInputSchema, params, AGENT_IPC_CHANNELS.DELETE_SESSION);
      deleteAgentSession(input.sessionId);
      getAgentRuntimeStatusManager().clearSession(input.sessionId);
      context.planStateTracker.clearSession(input.sessionId);
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS]: async (params) => {
      const input = validateInput(agentSessionIdInputSchema, params, AGENT_IPC_CHANNELS.GET_RUNTIME_STATUS);
      return getAgentRuntimeStatusManager().get(input.sessionId) ?? {
        sessionId: input.sessionId,
        phase: "idle",
        updatedAt: Date.now()
      };
    },
    [AGENT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM]: async (params) => {
      const input = validateInput(agentTruncateInputSchema, params, AGENT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM);
      return truncateAgentMessagesFrom(input.sessionId, input.messageId);
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
    [AGENT_IPC_CHANNELS.GET_SESSION_PATH]: async (params) => {
      const input = validateInput(sessionPathInputSchema, params, AGENT_IPC_CHANNELS.GET_SESSION_PATH);
      return getAgentSessionPath(input.workspaceSlug, input.sessionId);
    },
    [AGENT_IPC_CHANNELS.LIST_DIRECTORY]: async (params) => {
      const input = validateInput(listDirectoryInputSchema, params, AGENT_IPC_CHANNELS.LIST_DIRECTORY);
      return listAgentDirectory(input.workspaceSlug, input.sessionId, input.path);
    },
    [AGENT_IPC_CHANNELS.DELETE_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.DELETE_FILE);
      return deleteAgentFile(input.workspaceSlug, input.sessionId, input.path);
    },
    [AGENT_IPC_CHANNELS.OPEN_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.OPEN_FILE);
      return openAgentPath(input.workspaceSlug, input.sessionId, input.path);
    },
    [AGENT_IPC_CHANNELS.SHOW_IN_FOLDER]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.SHOW_IN_FOLDER);
      return showAgentPathInFolder(input.workspaceSlug, input.sessionId, input.path);
    },
    [AGENT_IPC_CHANNELS.PREVIEW_FILE]: async (params) => {
      const input = validateInput(pathFileInputSchema, params, AGENT_IPC_CHANNELS.PREVIEW_FILE);
      return previewAgentPath(input.workspaceSlug, input.sessionId, input.path);
    },
    [AGENT_IPC_CHANNELS.RENAME_FILE]: async (params) => {
      const input = validateInput(renameFileInputSchema, params, AGENT_IPC_CHANNELS.RENAME_FILE);
      return renameAgentFile(input.workspaceSlug, input.sessionId, input.path, input.newName);
    },
    [AGENT_IPC_CHANNELS.MOVE_FILE]: async (params) => {
      const input = validateInput(moveFileInputSchema, params, AGENT_IPC_CHANNELS.MOVE_FILE);
      return moveAgentFile(input.workspaceSlug, input.sessionId, input.path, input.targetDir);
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
        input.sessionId,
        input.query,
        input.limit ?? 20,
        input.rootPath
      );
    },
    [AGENT_IPC_CHANNELS.LIST_PLANS]: async (params) => {
      const input = validateInput(plansListInputSchema, params, AGENT_IPC_CHANNELS.LIST_PLANS);
      const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugBySessionId(input.sessionId);
      if (!resolvedWorkspaceSlug) {
        throw new Error("未找到会话对应的 workspace");
      }
      return listAgentPlans(resolvedWorkspaceSlug, input.sessionId);
    },
    [AGENT_IPC_CHANNELS.READ_PLAN]: async (params) => {
      const input = validateInput(plansReadDeleteInputSchema, params, AGENT_IPC_CHANNELS.READ_PLAN);
      const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugBySessionId(input.sessionId);
      if (!resolvedWorkspaceSlug) {
        throw new Error("未找到会话对应的 workspace");
      }
      return readAgentPlan(resolvedWorkspaceSlug, input.sessionId, input.planPath);
    },
    [AGENT_IPC_CHANNELS.DELETE_PLAN]: async (params) => {
      const input = validateInput(plansReadDeleteInputSchema, params, AGENT_IPC_CHANNELS.DELETE_PLAN);
      const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugBySessionId(input.sessionId);
      if (!resolvedWorkspaceSlug) {
        throw new Error("未找到会话对应的 workspace");
      }
      return deleteAgentPlan(resolvedWorkspaceSlug, input.sessionId, input.planPath);
    },
    [AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION]: async (params) =>
      saveFilesToAgentSession(
        validateInput(saveFilesToSessionInputSchema, params, AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION)
      ),
    [AGENT_IPC_CHANNELS.COPY_FOLDER_TO_SESSION]: async (params) =>
      copyFolderToSession(
        validateInput(copyFolderToSessionInputSchema, params, AGENT_IPC_CHANNELS.COPY_FOLDER_TO_SESSION)
      ),
    [AGENT_IPC_CHANNELS.GENERATE_TITLE]: async (params) => generateAgentTitle(params as AgentGenerateTitleInput),
    [AGENT_IPC_CHANNELS.STOP_AGENT]: async (params) => {
      const input = validateInput(agentSessionIdInputSchema, params, AGENT_IPC_CHANNELS.STOP_AGENT);
      stopAgent(input.sessionId);
      if (context.planStateTracker.getPhase(input.sessionId) === "executing") {
        const steps = context.planStateTracker.markCurrentStepFailed(input.sessionId, "用户已停止当前执行");
        context.notifyPlanStateChange(input.sessionId, "review", steps ? { steps } : undefined);
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
        sessionId: input.sessionId,
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
        sessionId: input.sessionId,
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
    [AGENT_IPC_CHANNELS.SEND_MESSAGE]: async (params) => {
      const input = validateInput(agentSendInputSchema, params, AGENT_IPC_CHANNELS.SEND_MESSAGE);
      if (context.planStateTracker.isLikelyExecutionRequest(input)) {
        const steps = context.planStateTracker.syncExecutionFromUserMessage(input.sessionId, input.userMessage);
        context.notifyPlanStateChange(input.sessionId, "executing", steps ? { steps } : undefined);
      }
      const bus = getSessionEventBus();
      const unsubscribe = bus.subscribe(input.sessionId, (event) => {
        context.writeNotification(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId: input.sessionId,
          event
        });
      });
      void sendAgentMessage(input, {
        onEvent: (event) => {
          context.writeNotification(AGENT_IPC_CHANNELS.STREAM_EVENT, {
            sessionId: input.sessionId,
            event
          });
          if (event.type !== "tool_result") {
            return;
          }
          if (event.toolName === "EnterPlanMode") {
            context.notifyPlanStateChange(input.sessionId, "planning");
            return;
          }
          if (event.toolName === "ExitPlanMode" && !event.isError) {
            const planPath = context.planStateTracker.parsePlanPathFromToolResult(event.result);
            context.notifyPlanStateChange(input.sessionId, "review", planPath ? { planPath } : undefined);
          }
        },
        onComplete: () => {
          unsubscribe();
          context.writeNotification(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
            sessionId: input.sessionId
          });
          if (context.planStateTracker.getPhase(input.sessionId) === "executing") {
            const steps = context.planStateTracker.markCurrentStepCompleted(input.sessionId);
            context.notifyPlanStateChange(input.sessionId, "executed", steps ? { steps } : undefined);
          }
        },
        onError: (error) => {
          unsubscribe();
          context.writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
            sessionId: input.sessionId,
            error
          });
          if (context.planStateTracker.getPhase(input.sessionId) === "executing") {
            const steps = context.planStateTracker.markCurrentStepFailed(input.sessionId, error);
            context.notifyPlanStateChange(input.sessionId, "review", steps ? { steps } : undefined);
          }
        },
        onTitleUpdated: (title) =>
          context.writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
            sessionId: input.sessionId,
            title
          }),
        onAskUserQuestion: (request) =>
          context.writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request),
        onToolPermissionRequest: (request) =>
          context.writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request)
      }).catch((error) => {
        context.writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
          sessionId: input.sessionId,
          error: error instanceof Error ? error.message : String(error)
        });
        if (context.planStateTracker.getPhase(input.sessionId) === "executing") {
          const steps = context.planStateTracker.markCurrentStepFailed(
            input.sessionId,
            error instanceof Error ? error.message : String(error)
          );
          context.notifyPlanStateChange(input.sessionId, "review", steps ? { steps } : undefined);
        }
      });
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.WRITE_LOG]: async (params) => {
      const payload = asObject(params);
      const level = asString(payload.level) || "info";
      const contextName = asString(payload.context) || "web";
      const message = asString(payload.message);
      const sessionId = asString(payload.sessionId);
      const data = payload.data as Record<string, unknown> | undefined;

      if (!message) {
        return { ok: false };
      }

      const log = createLogger(contextName, sessionId);
      const logMethod = level as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
      if (typeof log[logMethod] === "function") {
        log[logMethod](message, data);
      } else {
        log.info(message, data);
      }
      return { ok: true };
    },
    [AGENT_IPC_CHANNELS.GET_LOGS_DIR]: async () => ({ path: getLogsDir() })
  };
}
