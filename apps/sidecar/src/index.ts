import { argv, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { AGENT_IPC_CHANNELS, CHANNEL_IPC_CHANNELS, CHAT_IPC_CHANNELS } from "@lume/shared";
import type {
  AttachmentSaveInput,
  AgentGenerateTitleInput,
  ImportGlobalMcpToWorkspaceInput,
  InstallGlobalPluginInput,
  ImportGlobalSkillToWorkspaceInput,
  AgentSendInput,
  ChannelCreateInput,
  ChannelUpdateInput,
  ChatSendInput,
  FetchModelsInput,
  GenerateTitleInput,
  WorkspaceMcpConfig
} from "@lume/shared";
import {
  createChannel,
  decryptApiKey,
  deleteChannel,
  fetchModels,
  listChannels,
  testChannel,
  testChannelDirect,
  updateChannel
} from "./services/channel-manager";
import {
  createConversation,
  deleteConversation,
  deleteMessage,
  getConversationMessages,
  getRecentMessages,
  listConversations,
  truncateMessagesFrom,
  updateContextDividers,
  updateConversationMeta
} from "./services/conversation-manager";
import { generateTitle, sendMessage, stopGeneration } from "./services/chat-service";
import {
  deleteAttachment,
  readAttachmentAsBase64,
  saveAttachment
} from "./services/attachment-service";
import { extractTextFromAttachment } from "./services/document-parser";
import {
  createAgentSession,
  deleteAgentSession,
  getAgentSessionMessages,
  listAgentSessions,
  updateAgentSessionMeta
} from "./services/agent-session-manager";
import {
  generateAgentTitle,
  sendAgentMessage,
  submitAskUserQuestionAnswers,
  stopAgent
} from "./services/agent-service";
import {
  copyFolderToSession,
  deleteAgentFile,
  getAgentSessionPath,
  listAgentDirectory,
  openAgentPath,
  saveFilesToAgentSession,
  showAgentPathInFolder,
} from "./services/agent-files-service";
import {
  createAgentWorkspace,
  deleteAgentWorkspace,
  ensureDefaultWorkspace,
  getWorkspaceCapabilities,
  getWorkspaceMcpConfig,
  getWorkspaceSkills,
  listAgentWorkspaces,
  saveWorkspaceMcpConfig,
  updateAgentWorkspace,
  deleteWorkspaceSkill
} from "./services/agent-workspace-manager";
import {
  getGlobalMarketplaceDetail,
  getGlobalDiscoverySnapshot,
  installGlobalPlugin,
  importGlobalMcpToWorkspace,
  importGlobalSkillToWorkspace
} from "./services/global-discovery-service";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "./services/workspace-watcher";

// JSON-RPC 使用 stdout 作为协议通道，业务日志统一输出到 stderr，避免污染响应流。
console.log = (...args: unknown[]) => {
  console.error(...args);
};

type JsonRpcRequest = {
  id?: string | number;
  method?: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id?: string | number;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

function writeResponse(response: JsonRpcResponse): void {
  stdout.write(`${JSON.stringify(response)}\n`);
}

function writeNotification(method: string, params: unknown): void {
  stdout.write(`${JSON.stringify({ method, params })}\n`);
}

type RpcHandler = (params: unknown) => Promise<unknown>;

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

const handlers: Record<string, RpcHandler> = {
  healthcheck: async () => ({
    ok: true,
    source: "sidecar",
    pid: process.pid
  }),
  "rpc:list-methods": async () => Object.keys(handlers).sort(),

  [CHANNEL_IPC_CHANNELS.LIST]: async () => listChannels(),
  [CHANNEL_IPC_CHANNELS.CREATE]: async (params) => createChannel(params as ChannelCreateInput),
  [CHANNEL_IPC_CHANNELS.UPDATE]: async (params) => {
    const p = asObject(params);
    const id = asString(p.id);
    if (!id) throw new Error("缺少 channel id");
    return updateChannel(id, (p.input ?? {}) as ChannelUpdateInput);
  },
  [CHANNEL_IPC_CHANNELS.DELETE]: async (params) => {
    const p = asObject(params);
    const id = asString(p.id);
    if (!id) throw new Error("缺少 channel id");
    deleteChannel(id);
    return { ok: true };
  },
  [CHANNEL_IPC_CHANNELS.DECRYPT_KEY]: async (params) => {
    const p = asObject(params);
    const channelId = asString(p.channelId);
    if (!channelId) throw new Error("缺少 channelId");
    return decryptApiKey(channelId);
  },
  [CHANNEL_IPC_CHANNELS.TEST]: async (params) => {
    const p = asObject(params);
    const channelId = asString(p.channelId);
    if (!channelId) throw new Error("缺少 channelId");
    return testChannel(channelId);
  },
  [CHANNEL_IPC_CHANNELS.TEST_DIRECT]: async (params) => testChannelDirect(params as FetchModelsInput),
  [CHANNEL_IPC_CHANNELS.FETCH_MODELS]: async (params) => fetchModels(params as FetchModelsInput),

  [CHAT_IPC_CHANNELS.LIST_CONVERSATIONS]: async () => listConversations(),
  [CHAT_IPC_CHANNELS.CREATE_CONVERSATION]: async (params) => {
    const p = asObject(params);
    return createConversation(
      asString(p.title),
      asString(p.modelId),
      asString(p.channelId)
    );
  },
  [CHAT_IPC_CHANNELS.GET_MESSAGES]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    if (!conversationId) throw new Error("缺少 conversationId");
    return getConversationMessages(conversationId);
  },
  [CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    const limit = asNumber(p.limit);
    if (!conversationId || typeof limit !== "number") {
      throw new Error("缺少 conversationId 或 limit");
    }
    return getRecentMessages(conversationId, limit);
  },
  [CHAT_IPC_CHANNELS.UPDATE_TITLE]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    const title = asString(p.title);
    if (!conversationId || !title) throw new Error("缺少 conversationId 或 title");
    return updateConversationMeta(conversationId, { title });
  },
  [CHAT_IPC_CHANNELS.DELETE_CONVERSATION]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    if (!conversationId) throw new Error("缺少 conversationId");
    deleteConversation(conversationId);
    return { ok: true };
  },
  [CHAT_IPC_CHANNELS.UPDATE_MODEL]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    if (!conversationId) throw new Error("缺少 conversationId");
    return updateConversationMeta(conversationId, {
      modelId: asString(p.modelId),
      channelId: asString(p.channelId)
    });
  },
  [CHAT_IPC_CHANNELS.DELETE_MESSAGE]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    const messageId = asString(p.messageId);
    if (!conversationId || !messageId) throw new Error("缺少 conversationId 或 messageId");
    return deleteMessage(conversationId, messageId);
  },
  [CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    const messageId = asString(p.messageId);
    const preserveFirstMessageAttachments = p.preserveFirstMessageAttachments === true;
    if (!conversationId || !messageId) throw new Error("缺少 conversationId 或 messageId");
    return truncateMessagesFrom(conversationId, messageId, preserveFirstMessageAttachments);
  },
  [CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    const dividers = Array.isArray(p.dividers) ? p.dividers.filter((d): d is string => typeof d === "string") : [];
    if (!conversationId) throw new Error("缺少 conversationId");
    return updateContextDividers(conversationId, dividers);
  },
  [CHAT_IPC_CHANNELS.TOGGLE_PIN]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    if (!conversationId) throw new Error("缺少 conversationId");
    const list = listConversations();
    const target = list.find((item) => item.id === conversationId);
    if (!target) throw new Error("对话不存在");
    return updateConversationMeta(conversationId, { pinned: !target.pinned });
  },
  [CHAT_IPC_CHANNELS.GENERATE_TITLE]: async (params) => generateTitle(params as GenerateTitleInput),
  [CHAT_IPC_CHANNELS.SAVE_ATTACHMENT]: async (params) => saveAttachment(params as AttachmentSaveInput),
  [CHAT_IPC_CHANNELS.READ_ATTACHMENT]: async (params) => {
    const p = asObject(params);
    const localPath = asString(p.localPath);
    if (!localPath) throw new Error("缺少 localPath");
    return readAttachmentAsBase64(localPath);
  },
  [CHAT_IPC_CHANNELS.DELETE_ATTACHMENT]: async (params) => {
    const p = asObject(params);
    const localPath = asString(p.localPath);
    if (!localPath) throw new Error("缺少 localPath");
    deleteAttachment(localPath);
    return { ok: true };
  },
  [CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG]: async () => ({ files: [] }),
  [CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT]: async (params) => {
    const p = asObject(params);
    const localPath = asString(p.localPath);
    if (!localPath) throw new Error("缺少 localPath");
    return extractTextFromAttachment(localPath);
  },
  [CHAT_IPC_CHANNELS.STOP_GENERATION]: async (params) => {
    const p = asObject(params);
    const conversationId = asString(p.conversationId);
    if (!conversationId) throw new Error("缺少 conversationId");
    stopGeneration(conversationId);
    return { ok: true };
  },
  [CHAT_IPC_CHANNELS.SEND_MESSAGE]: async (params) => {
    const input = params as ChatSendInput;
    void sendMessage(input, {
      onChunk: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_CHUNK, event),
      onReasoning: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_REASONING, event),
      onComplete: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_COMPLETE, event),
      onError: (event) => writeNotification(CHAT_IPC_CHANNELS.STREAM_ERROR, event)
    }).catch((error) => {
      writeNotification(CHAT_IPC_CHANNELS.STREAM_ERROR, {
        conversationId: input.conversationId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return { ok: true };
  },

  [AGENT_IPC_CHANNELS.LIST_SESSIONS]: async () => listAgentSessions(),
  [AGENT_IPC_CHANNELS.CREATE_SESSION]: async (params) => {
    const p = asObject(params);
    return createAgentSession(asString(p.title), asString(p.channelId), asString(p.workspaceId));
  },
  [AGENT_IPC_CHANNELS.GET_MESSAGES]: async (params) => {
    const p = asObject(params);
    const sessionId = asString(p.sessionId);
    if (!sessionId) throw new Error("缺少 sessionId");
    return getAgentSessionMessages(sessionId);
  },
  [AGENT_IPC_CHANNELS.UPDATE_TITLE]: async (params) => {
    const p = asObject(params);
    const sessionId = asString(p.sessionId);
    const title = asString(p.title);
    if (!sessionId || !title) throw new Error("缺少 sessionId 或 title");
    return updateAgentSessionMeta(sessionId, { title });
  },
  [AGENT_IPC_CHANNELS.DELETE_SESSION]: async (params) => {
    const p = asObject(params);
    const sessionId = asString(p.sessionId);
    if (!sessionId) throw new Error("缺少 sessionId");
    deleteAgentSession(sessionId);
    return { ok: true };
  },

  [AGENT_IPC_CHANNELS.LIST_WORKSPACES]: async () => listAgentWorkspaces(),
  [AGENT_IPC_CHANNELS.CREATE_WORKSPACE]: async (params) => {
    const p = asObject(params);
    const name = asString(p.name);
    if (!name) throw new Error("缺少 name");
    return createAgentWorkspace(name);
  },
  [AGENT_IPC_CHANNELS.UPDATE_WORKSPACE]: async (params) => {
    const p = asObject(params);
    const id = asString(p.id);
    const name = asString(p.name);
    if (!id || !name) throw new Error("缺少 id 或 name");
    return updateAgentWorkspace(id, { name });
  },
  [AGENT_IPC_CHANNELS.DELETE_WORKSPACE]: async (params) => {
    const p = asObject(params);
    const id = asString(p.id);
    if (!id) throw new Error("缺少 id");
    deleteAgentWorkspace(id);
    return { ok: true };
  },
  [AGENT_IPC_CHANNELS.GET_CAPABILITIES]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    if (!workspaceSlug) throw new Error("缺少 workspaceSlug");
    return getWorkspaceCapabilities(workspaceSlug);
  },
  [AGENT_IPC_CHANNELS.GET_MCP_CONFIG]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    if (!workspaceSlug) throw new Error("缺少 workspaceSlug");
    return getWorkspaceMcpConfig(workspaceSlug);
  },
  [AGENT_IPC_CHANNELS.SAVE_MCP_CONFIG]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    if (!workspaceSlug) throw new Error("缺少 workspaceSlug");
    saveWorkspaceMcpConfig(workspaceSlug, (p.config ?? { servers: {} }) as WorkspaceMcpConfig);
    return { ok: true };
  },
  [AGENT_IPC_CHANNELS.GET_SKILLS]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    if (!workspaceSlug) throw new Error("缺少 workspaceSlug");
    return getWorkspaceSkills(workspaceSlug);
  },
  [AGENT_IPC_CHANNELS.DELETE_SKILL]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    const skillSlug = asString(p.skillSlug);
    if (!workspaceSlug || !skillSlug) throw new Error("缺少 workspaceSlug 或 skillSlug");
    deleteWorkspaceSkill(workspaceSlug, skillSlug);
    return { ok: true };
  },
  [AGENT_IPC_CHANNELS.GET_GLOBAL_DISCOVERY]: async () => getGlobalDiscoverySnapshot(),
  [AGENT_IPC_CHANNELS.RESCAN_GLOBAL_DISCOVERY]: async () => getGlobalDiscoverySnapshot(),
  [AGENT_IPC_CHANNELS.GET_GLOBAL_MARKETPLACE_DETAIL]: async (params) => {
    const p = asObject(params);
    const marketplaceId = asString(p.marketplaceId);
    if (!marketplaceId) throw new Error("缺少 marketplaceId");
    return getGlobalMarketplaceDetail(marketplaceId);
  },
  [AGENT_IPC_CHANNELS.INSTALL_GLOBAL_PLUGIN]: async (params) =>
    installGlobalPlugin(params as InstallGlobalPluginInput),
  [AGENT_IPC_CHANNELS.IMPORT_GLOBAL_MCP_TO_WORKSPACE]: async (params) =>
    importGlobalMcpToWorkspace(params as ImportGlobalMcpToWorkspaceInput),
  [AGENT_IPC_CHANNELS.IMPORT_GLOBAL_SKILL_TO_WORKSPACE]: async (params) =>
    importGlobalSkillToWorkspace(params as ImportGlobalSkillToWorkspaceInput),
  [AGENT_IPC_CHANNELS.GET_SESSION_PATH]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    const sessionId = asString(p.sessionId);
    if (!workspaceSlug || !sessionId) throw new Error("缺少 workspaceSlug 或 sessionId");
    return getAgentSessionPath(workspaceSlug, sessionId);
  },
  [AGENT_IPC_CHANNELS.LIST_DIRECTORY]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    const sessionId = asString(p.sessionId);
    const path = asString(p.path);
    if (!workspaceSlug || !sessionId) throw new Error("缺少 workspaceSlug 或 sessionId");
    return listAgentDirectory(workspaceSlug, sessionId, path);
  },
  [AGENT_IPC_CHANNELS.DELETE_FILE]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    const sessionId = asString(p.sessionId);
    const path = asString(p.path);
    if (!workspaceSlug || !sessionId || !path) throw new Error("缺少 workspaceSlug/sessionId/path");
    return deleteAgentFile(workspaceSlug, sessionId, path);
  },
  [AGENT_IPC_CHANNELS.OPEN_FILE]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    const sessionId = asString(p.sessionId);
    const path = asString(p.path);
    if (!workspaceSlug || !sessionId || !path) throw new Error("缺少 workspaceSlug/sessionId/path");
    return openAgentPath(workspaceSlug, sessionId, path);
  },
  [AGENT_IPC_CHANNELS.SHOW_IN_FOLDER]: async (params) => {
    const p = asObject(params);
    const workspaceSlug = asString(p.workspaceSlug);
    const sessionId = asString(p.sessionId);
    const path = asString(p.path);
    if (!workspaceSlug || !sessionId || !path) throw new Error("缺少 workspaceSlug/sessionId/path");
    return showAgentPathInFolder(workspaceSlug, sessionId, path);
  },
  [AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION]: async (params) =>
    saveFilesToAgentSession(params as import("@lume/shared").AgentSaveFilesInput),
  [AGENT_IPC_CHANNELS.COPY_FOLDER_TO_SESSION]: async (params) =>
    copyFolderToSession(params as import("@lume/shared").AgentCopyFolderInput),
  [AGENT_IPC_CHANNELS.GENERATE_TITLE]: async (params) => generateAgentTitle(params as AgentGenerateTitleInput),
  [AGENT_IPC_CHANNELS.STOP_AGENT]: async (params) => {
    const p = asObject(params);
    const sessionId = asString(p.sessionId);
    if (!sessionId) throw new Error("缺少 sessionId");
    stopAgent(sessionId);
    return { ok: true };
  },
  [AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION]: async (params) => {
    const p = asObject(params);
    const sessionId = asString(p.sessionId);
    const toolUseId = asString(p.toolUseId);
    const canceled = p.canceled === true;
    const answers = p.answers && typeof p.answers === "object"
      ? (p.answers as Record<string, string>)
      : undefined;
    if (!sessionId || !toolUseId) {
      throw new Error("缺少 sessionId 或 toolUseId");
    }
    return submitAskUserQuestionAnswers({
      sessionId,
      toolUseId,
      canceled,
      answers
    });
  },
  "agent:ensure-default-workspace": async () => ensureDefaultWorkspace(),
  [AGENT_IPC_CHANNELS.SEND_MESSAGE]: async (params) => {
    const input = params as AgentSendInput;
    void sendAgentMessage(input, {
      onEvent: (event) =>
        writeNotification(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId: input.sessionId,
          event
        }),
      onComplete: () =>
        writeNotification(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
          sessionId: input.sessionId
        }),
      onError: (error) =>
        writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
          sessionId: input.sessionId,
          error
        }),
      onTitleUpdated: (title) =>
        writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
          sessionId: input.sessionId,
          title
        }),
      onAskUserQuestion: (request) =>
        writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request)
    }).catch((error) => {
      writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return { ok: true };
  }
};

async function handleRpcLine(line: string): Promise<void> {
  let payload: JsonRpcRequest;
  try {
    payload = JSON.parse(line) as JsonRpcRequest;
  } catch {
    writeResponse({
      error: { code: "E_BAD_JSON", message: "Invalid JSON payload." }
    });
    return;
  }

  const method = payload.method;
  if (!method) {
    writeResponse({
      id: payload.id,
      error: {
        code: "E_BAD_REQUEST",
        message: "Missing method."
      }
    });
    return;
  }

  const handler = handlers[method];
  if (!handler) {
    writeResponse({
      id: payload.id,
      error: {
        code: "E_NOT_IMPLEMENTED",
        message: `Method not implemented: ${method}`
      }
    });
    return;
  }

  try {
    console.error(`[sidecar] rpc_in method=${method} id=${String(payload.id)}`);
    const result = await handler(payload.params);
    console.error(`[sidecar] rpc_out ok method=${method} id=${String(payload.id)}`);
    writeResponse({ id: payload.id, result });
  } catch (error) {
    console.error(`[sidecar] rpc_out err method=${method} id=${String(payload.id)} error=${error instanceof Error ? error.message : String(error)}`);
    writeResponse({
      id: payload.id,
      error: {
        code: "E_RPC",
        message: error instanceof Error ? error.message : "Unknown sidecar error"
      }
    });
  }
}

function boot(): void {
  console.error(`[sidecar] booted (pid=${process.pid}) args=${argv.slice(2).join(" ")}`);
  startWorkspaceWatcher((method, params) => writeNotification(method, params));
  const stopWatcher = (): void => stopWorkspaceWatcher();
  process.once("exit", stopWatcher);
  process.once("SIGINT", () => {
    stopWatcher();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    stopWatcher();
    process.exit(0);
  });

  stdin.setEncoding("utf8");
  const rl = createInterface({
    input: stdin,
    crlfDelay: Infinity
  });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void handleRpcLine(trimmed);
  });
}

boot();
