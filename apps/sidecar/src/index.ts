import { argv, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { AGENT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, CHANNEL_GATEWAY_IPC_CHANNELS, CHANNEL_IPC_CHANNELS, CHAT_IPC_CHANNELS, MEMORY_IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@lume/shared";
import type {
  AttachmentSaveInput,
  AgentGenerateTitleInput,
  AutomationCreateJobInput,
  AutomationDeleteJobInput,
  ChannelGatewayIngressInput,
  ChannelGatewayListDeliveriesInput,
  ChannelProvider,
  ChannelSessionBinding,
  AutomationListRunsInput,
  AutomationRunNowInput,
  AutomationUpdateJobInput,
  AgentProxySettings,
  PlanStep,
  AgentRuntimeToolPolicyConfig,
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
  truncateAgentMessagesFrom,
  updateAgentSessionMeta
} from "./services/agent-session-manager";
import {
  generateAgentTitle,
  sendAgentMessage,
  submitAgentToolPermission,
  submitAskUserQuestionAnswers,
  stopAgent
} from "./services/agent-service";
import {
  copyFolderToSession,
  deleteAgentPlan,
  deleteAgentFile,
  getAgentSessionPath,
  listAgentDirectory,
  listAgentPlans,
  openAgentPath,
  readAgentPlan,
  resolveWorkspaceSlugBySessionId,
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
import { readBootstrapFile } from "./services/workspace-bootstrap-service";
import {
  getGlobalMarketplaceDetail,
  getGlobalDiscoverySnapshot,
  installGlobalPlugin,
  importGlobalMcpToWorkspace,
  importGlobalSkillToWorkspace
} from "./services/global-discovery-service";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "./services/workspace-watcher";
import { startMemorySyncWatcher, stopMemorySyncWatcher } from "./services/memory-sync-watcher";
import { seedDefaultSkills } from "./services/default-skills-seeder";
import { startRelayServer, stopRelayServer } from "./services/browser/extension-relay";
import {
  getWorkspaceMemoryFile,
  getWorkspaceMemoryStatus,
  saveWorkspaceMemory,
  getWorkspaceMemoryStats,
  indexWorkspaceMemory,
  indexWorkspaceMemoryFile,
  searchWorkspaceMemory,
  closeMemoryManagers
} from "./services/memory-service";
import { createLogger, getLogsDir } from "./services/logger";
import { PlanStateTracker } from "./services/plan-state-tracker";
import {
  getAgentRuntimeToolPolicyConfig,
  saveAgentRuntimeToolPolicyConfig
} from "./services/pi-agent/tools/tool-policy";
import {
  getAgentProxyStatus,
  initProxySettings,
  saveAgentProxySettings
} from "./services/proxy-settings-manager";
import {
  getBrowserExtensionInfo,
  getBrowserRelayStatus,
  installBrowserExtension,
  startBrowser
} from "./services/browser/browser-service";
import {
  createAutomationJob,
  deleteAutomationJob,
  listAutomationJobs,
  updateAutomationJob
} from "./services/automation-manager";
import {
  listAutomationRuns,
  refreshAutomationRunnerJobs,
  runAutomationJobNow,
  startAutomationRunner,
  stopAutomationRunner
} from "./services/automation-runner-service";
import {
  listChannelGatewayBindings,
  listChannelGatewayDeliveries,
  simulateChannelGatewayIngress,
  upsertChannelGatewayBinding
} from "./services/channel-gateway/gateway-service";
import {
  getFeishuIngressStatus,
  startFeishuIngressServer,
  stopFeishuIngressServer
} from "./services/channel-gateway/feishu-ingress-service";
import {
  getFeishuGatewayConfigView,
  saveFeishuGatewayConfig
} from "./services/channel-gateway/feishu-config-manager";
import { testFeishuGatewayConnection } from "./services/channel-gateway/feishu-api";
import {
  startFeishuRetryWorker,
  stopFeishuRetryWorker
} from "./services/channel-gateway/feishu-retry-worker";

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

const idSchema = z.string().min(1);
const optionalIdSchema = z.string().min(1).optional();

const fileAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  localPath: z.string(),
  size: z.number()
});

const chatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  createdAt: z.number(),
  model: z.string().optional(),
  reasoning: z.string().optional(),
  stopped: z.boolean().optional(),
  attachments: z.array(fileAttachmentSchema).optional()
});

const chatSendInputSchema = z.object({
  conversationId: z.string().min(1),
  userMessage: z.string(),
  messageHistory: z.array(chatMessageSchema),
  channelId: z.string().min(1),
  modelId: z.string().min(1),
  systemMessage: z.string().optional(),
  contextLength: z.union([z.number(), z.literal("infinite")]).optional(),
  contextDividers: z.array(z.string()).optional(),
  attachments: z.array(fileAttachmentSchema).optional(),
  thinkingEnabled: z.boolean().optional()
});

const chatConversationIdInputSchema = z.object({
  conversationId: idSchema
});

const chatUpdateTitleInputSchema = z.object({
  conversationId: idSchema,
  title: z.string().min(1)
});

const chatUpdateModelInputSchema = z.object({
  conversationId: idSchema,
  modelId: z.string().optional(),
  channelId: z.string().optional()
});

const chatMessageIdInputSchema = z.object({
  conversationId: idSchema,
  messageId: idSchema
});

const chatTruncateInputSchema = z.object({
  conversationId: idSchema,
  messageId: idSchema,
  preserveFirstMessageAttachments: z.boolean().optional()
});

const chatContextDividersInputSchema = z.object({
  conversationId: idSchema,
  dividers: z.array(z.string()).default([])
});

const chatLocalPathInputSchema = z.object({
  localPath: idSchema
});

const chatRecentMessagesInputSchema = z.object({
  conversationId: idSchema,
  limit: z.number().int().min(1)
});

const agentSendInputSchema = z.object({
  sessionId: z.string().min(1),
  userMessage: z.string(),
  channelId: z.string().optional(),
  modelId: z.string().optional(),
  workspaceId: z.string().optional(),
  chatType: z.enum(["direct", "group", "channel"]).optional(),
  sessionType: z.enum(["main", "subagent", "group", "channel"]).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(),
  messageMetadata: z.record(z.string(), z.unknown()).optional()
});

const memoryIndexWorkspaceInputSchema = z.object({
  workspaceSlug: idSchema,
  force: z.boolean().optional()
});

const memoryIndexFileInputSchema = z.object({
  workspaceSlug: idSchema,
  filePath: idSchema,
  force: z.boolean().optional()
});

const memorySearchInputSchema = z.object({
  workspaceSlug: idSchema,
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(50).optional(),
  minScore: z.number().min(0).max(1).optional()
});

const memoryGetInputSchema = z.object({
  workspaceSlug: idSchema,
  path: idSchema,
  from: z.number().int().min(1).optional(),
  lines: z.number().int().min(1).optional()
});

const memorySaveInputSchema = z.object({
  workspaceSlug: idSchema,
  content: z.string().min(1),
  path: z.string().optional(),
  date: z.string().optional()
});

const agentCreateSessionInputSchema = z.object({
  title: z.string().optional(),
  channelId: z.string().optional(),
  workspaceId: z.string().optional()
});

const agentSessionIdInputSchema = z.object({
  sessionId: idSchema
});

const agentUpdateTitleInputSchema = z.object({
  sessionId: idSchema,
  title: z.string().min(1)
});

const agentTruncateInputSchema = z.object({
  sessionId: idSchema,
  messageId: idSchema
});

const workspaceSlugInputSchema = z.object({
  workspaceSlug: idSchema
});

const workspaceCreateInputSchema = z.object({
  name: z.string().min(1)
});

const workspaceUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1)
});

const workspaceDeleteInputSchema = z.object({
  id: idSchema
});

const mcpServerEntrySchema = z.object({
  type: z.enum(["stdio", "http", "sse"]),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean()
});

const workspaceMcpConfigInputSchema = z.object({
  workspaceSlug: idSchema,
  config: z.object({
    servers: z.record(z.string(), mcpServerEntrySchema)
  }).default({ servers: {} })
});

const deleteSkillInputSchema = z.object({
  workspaceSlug: idSchema,
  skillSlug: idSchema
});

const marketplaceDetailInputSchema = z.object({
  marketplaceId: idSchema
});

const sessionPathInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema
});

const listDirectoryInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
  path: z.string().optional()
});

const pathFileInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
  path: idSchema
});

const plansReadDeleteInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  sessionId: idSchema,
  planPath: idSchema
});

const plansListInputSchema = z.object({
  workspaceSlug: optionalIdSchema,
  sessionId: idSchema
});

const saveFilesToSessionInputSchema = z.object({
  workspaceSlug: idSchema,
  sessionId: idSchema,
  files: z.array(z.object({
    filename: z.string().min(1),
    data: z.string()
  }))
});

const copyFolderToSessionInputSchema = z.object({
  sourcePath: idSchema,
  workspaceSlug: idSchema,
  sessionId: idSchema
});

const submitAskUserQuestionInputSchema = z.object({
  sessionId: idSchema,
  toolUseId: idSchema,
  canceled: z.boolean().optional(),
  answers: z.record(z.string(), z.string()).optional()
});

const submitToolPermissionInputSchema = z.object({
  sessionId: idSchema,
  requestId: idSchema,
  decision: z.enum(["allow_once", "allow_always", "deny"])
});

const bootstrapFileTypeSchema = z.enum([
  "SOUL",
  "USER",
  "IDENTITY",
  "AGENTS",
  "TOOLS",
  "HEARTBEAT",
  "MEMORY",
  "BOOTSTRAP"
]);

const readBootstrapFileInputSchema = z.object({
  workspaceSlug: idSchema,
  fileType: bootstrapFileTypeSchema
});

const toolPolicyRuleSchema = z.object({
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional()
});

const saveToolPolicyInputSchema = z.object({
  version: z.number().optional(),
  tools: z.object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
    byProvider: z.record(z.string(), toolPolicyRuleSchema).optional(),
    bySessionType: z.record(z.string(), toolPolicyRuleSchema).optional(),
    byChatType: z.record(z.string(), toolPolicyRuleSchema).optional(),
    subagent: toolPolicyRuleSchema.optional()
  }).optional()
});

const proxySettingsInputSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  mode: z.enum(["off", "system", "custom"]),
  httpProxy: z.string().optional(),
  httpsProxy: z.string().optional(),
  noProxy: z.string().optional()
});

const automationScheduleSchema = z.object({
  type: z.enum(["cron", "once", "interval"]),
  cronExpr: z.string().optional(),
  runAt: z.number().optional(),
  intervalMs: z.number().optional(),
  timezone: z.string().optional()
});

const automationCreateInputSchema = z.object({
  name: z.string().min(1),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  schedule: automationScheduleSchema,
  prompt: z.string().min(1)
});

const automationUpdateInputSchema = z.object({
  id: idSchema,
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  schedule: automationScheduleSchema.optional(),
  prompt: z.string().min(1).optional()
});

const automationDeleteInputSchema = z.object({
  id: idSchema
});

const automationListRunsInputSchema = z.object({
  jobId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional()
});

const automationRunNowInputSchema = z.object({
  id: idSchema
});

const channelProviderSchema = z.enum(["telegram", "discord", "whatsapp", "slack", "feishu"]);

const channelInboundEventSchema = z.object({
  id: idSchema,
  provider: channelProviderSchema,
  externalChatId: idSchema,
  externalUserId: z.string().optional(),
  externalMessageId: idSchema,
  text: z.string().min(1),
  receivedAt: z.number(),
  workspaceId: z.string().optional(),
  sessionId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

const channelGatewayIngressInputSchema = z.object({
  event: channelInboundEventSchema
});

const channelGatewayUpsertBindingInputSchema = z.object({
  provider: channelProviderSchema,
  externalChatId: idSchema,
  externalUserId: z.string().optional(),
  workspaceId: z.string().optional(),
  sessionId: idSchema
});

const channelGatewayListDeliveriesInputSchema = z.object({
  provider: channelProviderSchema.optional(),
  limit: z.number().int().min(1).max(500).optional()
});

const feishuGatewaySaveInputSchema = z.object({
  enabled: z.boolean(),
  appId: z.string().default(""),
  appSecret: z.string().optional(),
  verificationToken: z.string().optional(),
  encryptKey: z.string().optional(),
  domain: z.enum(["feishu", "lark"]).optional(),
  defaultWorkspaceId: z.string().optional(),
  webhookPath: z.string().optional()
});

function validateInput<T>(schema: z.ZodType<T>, payload: unknown, method: string): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  const firstIssue = parsed.error.issues[0];
  const path = firstIssue?.path.join(".") || "root";
  const message = firstIssue?.message || "参数校验失败";
  throw new Error(`${method} 参数非法: ${path} - ${message}`);
}

const planStateTracker = new PlanStateTracker();

function notifyPlanStateChange(
  sessionId: string,
  phase: "idle" | "planning" | "review" | "executing" | "executed",
  extras?: { planPath?: string; steps?: PlanStep[] }
): void {
  const event = planStateTracker.updatePhase(sessionId, phase, extras);
  if (!event) return;
  writeNotification(AGENT_IPC_CHANNELS.PLAN_STATE_CHANGED, event);
}

const handlers: Record<string, RpcHandler> = {
  healthcheck: async () => ({
    ok: true,
    source: "sidecar",
    version: IPC_PROTOCOL_VERSION,
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
    const input = validateInput(chatConversationIdInputSchema, params, CHAT_IPC_CHANNELS.GET_MESSAGES);
    return getConversationMessages(input.conversationId);
  },
  [CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES]: async (params) => {
    const input = validateInput(chatRecentMessagesInputSchema, params, CHAT_IPC_CHANNELS.GET_RECENT_MESSAGES);
    return getRecentMessages(input.conversationId, input.limit);
  },
  [CHAT_IPC_CHANNELS.UPDATE_TITLE]: async (params) => {
    const input = validateInput(chatUpdateTitleInputSchema, params, CHAT_IPC_CHANNELS.UPDATE_TITLE);
    return updateConversationMeta(input.conversationId, { title: input.title });
  },
  [CHAT_IPC_CHANNELS.DELETE_CONVERSATION]: async (params) => {
    const input = validateInput(chatConversationIdInputSchema, params, CHAT_IPC_CHANNELS.DELETE_CONVERSATION);
    deleteConversation(input.conversationId);
    return { ok: true };
  },
  [CHAT_IPC_CHANNELS.UPDATE_MODEL]: async (params) => {
    const input = validateInput(chatUpdateModelInputSchema, params, CHAT_IPC_CHANNELS.UPDATE_MODEL);
    return updateConversationMeta(input.conversationId, {
      modelId: input.modelId,
      channelId: input.channelId
    });
  },
  [CHAT_IPC_CHANNELS.DELETE_MESSAGE]: async (params) => {
    const input = validateInput(chatMessageIdInputSchema, params, CHAT_IPC_CHANNELS.DELETE_MESSAGE);
    return deleteMessage(input.conversationId, input.messageId);
  },
  [CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM]: async (params) => {
    const input = validateInput(chatTruncateInputSchema, params, CHAT_IPC_CHANNELS.TRUNCATE_MESSAGES_FROM);
    return truncateMessagesFrom(
      input.conversationId,
      input.messageId,
      input.preserveFirstMessageAttachments === true
    );
  },
  [CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS]: async (params) => {
    const input = validateInput(chatContextDividersInputSchema, params, CHAT_IPC_CHANNELS.UPDATE_CONTEXT_DIVIDERS);
    return updateContextDividers(input.conversationId, input.dividers);
  },
  [CHAT_IPC_CHANNELS.TOGGLE_PIN]: async (params) => {
    const input = validateInput(chatConversationIdInputSchema, params, CHAT_IPC_CHANNELS.TOGGLE_PIN);
    const list = listConversations();
    const target = list.find((item) => item.id === input.conversationId);
    if (!target) throw new Error("对话不存在");
    return updateConversationMeta(input.conversationId, { pinned: !target.pinned });
  },
  [CHAT_IPC_CHANNELS.GENERATE_TITLE]: async (params) => generateTitle(params as GenerateTitleInput),
  [CHAT_IPC_CHANNELS.SAVE_ATTACHMENT]: async (params) => saveAttachment(params as AttachmentSaveInput),
  [CHAT_IPC_CHANNELS.READ_ATTACHMENT]: async (params) => {
    const input = validateInput(chatLocalPathInputSchema, params, CHAT_IPC_CHANNELS.READ_ATTACHMENT);
    return readAttachmentAsBase64(input.localPath);
  },
  [CHAT_IPC_CHANNELS.DELETE_ATTACHMENT]: async (params) => {
    const input = validateInput(chatLocalPathInputSchema, params, CHAT_IPC_CHANNELS.DELETE_ATTACHMENT);
    deleteAttachment(input.localPath);
    return { ok: true };
  },
  [CHAT_IPC_CHANNELS.OPEN_FILE_DIALOG]: async () => ({ files: [] }),
  [CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT]: async (params) => {
    const input = validateInput(chatLocalPathInputSchema, params, CHAT_IPC_CHANNELS.EXTRACT_ATTACHMENT_TEXT);
    return extractTextFromAttachment(input.localPath);
  },
  [CHAT_IPC_CHANNELS.STOP_GENERATION]: async (params) => {
    const input = validateInput(chatConversationIdInputSchema, params, CHAT_IPC_CHANNELS.STOP_GENERATION);
    stopGeneration(input.conversationId);
    return { ok: true };
  },
  [CHAT_IPC_CHANNELS.SEND_MESSAGE]: async (params) => {
    const input = validateInput(chatSendInputSchema, params, CHAT_IPC_CHANNELS.SEND_MESSAGE);
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
  [MEMORY_IPC_CHANNELS.INDEX_WORKSPACE]: async (params) =>
    indexWorkspaceMemory(validateInput(memoryIndexWorkspaceInputSchema, params, MEMORY_IPC_CHANNELS.INDEX_WORKSPACE)),
  [MEMORY_IPC_CHANNELS.INDEX_FILE]: async (params) =>
    indexWorkspaceMemoryFile(validateInput(memoryIndexFileInputSchema, params, MEMORY_IPC_CHANNELS.INDEX_FILE)),
  [MEMORY_IPC_CHANNELS.SEARCH]: async (params) =>
    searchWorkspaceMemory(validateInput(memorySearchInputSchema, params, MEMORY_IPC_CHANNELS.SEARCH)),
  [MEMORY_IPC_CHANNELS.STATS]: async (params) => {
    const input = validateInput(workspaceSlugInputSchema, params, MEMORY_IPC_CHANNELS.STATS);
    return getWorkspaceMemoryStats(input.workspaceSlug);
  },
  [MEMORY_IPC_CHANNELS.GET]: async (params) =>
    getWorkspaceMemoryFile(validateInput(memoryGetInputSchema, params, MEMORY_IPC_CHANNELS.GET)),
  [MEMORY_IPC_CHANNELS.SAVE]: async (params) =>
    saveWorkspaceMemory(validateInput(memorySaveInputSchema, params, MEMORY_IPC_CHANNELS.SAVE)),
  [MEMORY_IPC_CHANNELS.STATUS]: async (params) => {
    const input = validateInput(workspaceSlugInputSchema, params, MEMORY_IPC_CHANNELS.STATUS);
    return getWorkspaceMemoryStatus(input.workspaceSlug);
  },

  [AUTOMATION_IPC_CHANNELS.LIST_JOBS]: async () => listAutomationJobs(),
  [AUTOMATION_IPC_CHANNELS.CREATE_JOB]: async (params) => {
    const created = createAutomationJob(
      validateInput(automationCreateInputSchema, params, AUTOMATION_IPC_CHANNELS.CREATE_JOB) as AutomationCreateJobInput
    );
    await refreshAutomationRunnerJobs();
    return created;
  },
  [AUTOMATION_IPC_CHANNELS.UPDATE_JOB]: async (params) => {
    const updated = updateAutomationJob(
      validateInput(automationUpdateInputSchema, params, AUTOMATION_IPC_CHANNELS.UPDATE_JOB) as AutomationUpdateJobInput
    );
    await refreshAutomationRunnerJobs();
    return updated;
  },
  [AUTOMATION_IPC_CHANNELS.DELETE_JOB]: async (params) => {
    const result = deleteAutomationJob(
      validateInput(automationDeleteInputSchema, params, AUTOMATION_IPC_CHANNELS.DELETE_JOB) as AutomationDeleteJobInput
    );
    await refreshAutomationRunnerJobs();
    return result;
  },
  [AUTOMATION_IPC_CHANNELS.LIST_RUNS]: async (params) =>
    listAutomationRuns(
      validateInput(automationListRunsInputSchema, params ?? {}, AUTOMATION_IPC_CHANNELS.LIST_RUNS) as AutomationListRunsInput
    ),
  [AUTOMATION_IPC_CHANNELS.RUN_NOW]: async (params) =>
    runAutomationJobNow(
      validateInput(automationRunNowInputSchema, params, AUTOMATION_IPC_CHANNELS.RUN_NOW) as AutomationRunNowInput
    ),

  [CHANNEL_GATEWAY_IPC_CHANNELS.SIMULATE_INGRESS]: async (params) =>
    simulateChannelGatewayIngress(
      validateInput(
        channelGatewayIngressInputSchema,
        params,
        CHANNEL_GATEWAY_IPC_CHANNELS.SIMULATE_INGRESS
      ) as ChannelGatewayIngressInput
    ),
  [CHANNEL_GATEWAY_IPC_CHANNELS.LIST_BINDINGS]: async () => listChannelGatewayBindings(),
  [CHANNEL_GATEWAY_IPC_CHANNELS.UPSERT_BINDING]: async (params) =>
    upsertChannelGatewayBinding(
      validateInput(
        channelGatewayUpsertBindingInputSchema,
        params,
        CHANNEL_GATEWAY_IPC_CHANNELS.UPSERT_BINDING
      ) as {
        provider: ChannelProvider;
        externalChatId: string;
        externalUserId?: string;
        workspaceId?: string;
        sessionId: string;
      }
    ),
  [CHANNEL_GATEWAY_IPC_CHANNELS.LIST_DELIVERIES]: async (params) =>
    listChannelGatewayDeliveries(
      validateInput(
        channelGatewayListDeliveriesInputSchema,
        params ?? {},
        CHANNEL_GATEWAY_IPC_CHANNELS.LIST_DELIVERIES
      ) as ChannelGatewayListDeliveriesInput
    ),
  [CHANNEL_GATEWAY_IPC_CHANNELS.GET_INGRESS_STATUS]: async () => getFeishuIngressStatus(),
  [CHANNEL_GATEWAY_IPC_CHANNELS.START_INGRESS]: async () => startFeishuIngressServer(),
  [CHANNEL_GATEWAY_IPC_CHANNELS.STOP_INGRESS]: async () => {
    await stopFeishuIngressServer();
    return { ok: true };
  },
  [CHANNEL_GATEWAY_IPC_CHANNELS.GET_FEISHU_CONFIG]: async () => getFeishuGatewayConfigView(),
  [CHANNEL_GATEWAY_IPC_CHANNELS.SAVE_FEISHU_CONFIG]: async (params) =>
    saveFeishuGatewayConfig(
      validateInput(
        feishuGatewaySaveInputSchema,
        params,
        CHANNEL_GATEWAY_IPC_CHANNELS.SAVE_FEISHU_CONFIG
      )
    ),
  [CHANNEL_GATEWAY_IPC_CHANNELS.TEST_FEISHU_CONFIG]: async () => testFeishuGatewayConnection(),

  [AGENT_IPC_CHANNELS.LIST_SESSIONS]: async () => listAgentSessions(),
  [AGENT_IPC_CHANNELS.CREATE_SESSION]: async (params) => {
    const p = validateInput(agentCreateSessionInputSchema, params, AGENT_IPC_CHANNELS.CREATE_SESSION);
    return createAgentSession(
      p.title,
      p.channelId,
      p.workspaceId
    );
  },
  [AGENT_IPC_CHANNELS.GET_MESSAGES]: async (params) => {
    const input = validateInput(agentSessionIdInputSchema, params, AGENT_IPC_CHANNELS.GET_MESSAGES);
    return getAgentSessionMessages(input.sessionId);
  },
  [AGENT_IPC_CHANNELS.UPDATE_TITLE]: async (params) => {
    const input = validateInput(agentUpdateTitleInputSchema, params, AGENT_IPC_CHANNELS.UPDATE_TITLE);
    return updateAgentSessionMeta(input.sessionId, { title: input.title });
  },
  [AGENT_IPC_CHANNELS.DELETE_SESSION]: async (params) => {
    const input = validateInput(agentSessionIdInputSchema, params, AGENT_IPC_CHANNELS.DELETE_SESSION);
    deleteAgentSession(input.sessionId);
    planStateTracker.clearSession(input.sessionId);
    return { ok: true };
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
  [AGENT_IPC_CHANNELS.LIST_PLANS]: async (params) => {
    const input = validateInput(plansListInputSchema, params, AGENT_IPC_CHANNELS.LIST_PLANS);
    const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugBySessionId(input.sessionId);
    if (!resolvedWorkspaceSlug) throw new Error("未找到会话对应的 workspace");
    return listAgentPlans(resolvedWorkspaceSlug, input.sessionId);
  },
  [AGENT_IPC_CHANNELS.READ_PLAN]: async (params) => {
    const input = validateInput(plansReadDeleteInputSchema, params, AGENT_IPC_CHANNELS.READ_PLAN);
    const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugBySessionId(input.sessionId);
    if (!resolvedWorkspaceSlug) throw new Error("未找到会话对应的 workspace");
    return readAgentPlan(resolvedWorkspaceSlug, input.sessionId, input.planPath);
  },
  [AGENT_IPC_CHANNELS.DELETE_PLAN]: async (params) => {
    const input = validateInput(plansReadDeleteInputSchema, params, AGENT_IPC_CHANNELS.DELETE_PLAN);
    const resolvedWorkspaceSlug = input.workspaceSlug ?? resolveWorkspaceSlugBySessionId(input.sessionId);
    if (!resolvedWorkspaceSlug) throw new Error("未找到会话对应的 workspace");
    return deleteAgentPlan(resolvedWorkspaceSlug, input.sessionId, input.planPath);
  },
  [AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION]: async (params) =>
    saveFilesToAgentSession(validateInput(saveFilesToSessionInputSchema, params, AGENT_IPC_CHANNELS.SAVE_FILES_TO_SESSION)),
  [AGENT_IPC_CHANNELS.COPY_FOLDER_TO_SESSION]: async (params) =>
    copyFolderToSession(validateInput(copyFolderToSessionInputSchema, params, AGENT_IPC_CHANNELS.COPY_FOLDER_TO_SESSION)),
  [AGENT_IPC_CHANNELS.GENERATE_TITLE]: async (params) => generateAgentTitle(params as AgentGenerateTitleInput),
  [AGENT_IPC_CHANNELS.STOP_AGENT]: async (params) => {
    const input = validateInput(agentSessionIdInputSchema, params, AGENT_IPC_CHANNELS.STOP_AGENT);
    stopAgent(input.sessionId);
    if (planStateTracker.getPhase(input.sessionId) === "executing") {
      const steps = planStateTracker.markCurrentStepFailed(input.sessionId, "用户已停止当前执行");
      notifyPlanStateChange(input.sessionId, "review", steps ? { steps } : undefined);
    }
    return { ok: true };
  },
  [AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION]: async (params) => {
    const input = validateInput(submitAskUserQuestionInputSchema, params, AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION);
    return submitAskUserQuestionAnswers({
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
      canceled: input.canceled === true,
      answers: input.answers
    });
  },
  [AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION]: async (params) => {
    const input = validateInput(submitToolPermissionInputSchema, params, AGENT_IPC_CHANNELS.SUBMIT_TOOL_PERMISSION);
    return submitAgentToolPermission({
      sessionId: input.sessionId,
      requestId: input.requestId,
      decision: input.decision
    });
  },
  "agent:ensure-default-workspace": async () => ensureDefaultWorkspace(),
  "agent:read-bootstrap-file": async (params) => {
    const input = validateInput(readBootstrapFileInputSchema, params, "agent:read-bootstrap-file");
    return { content: readBootstrapFile(input.workspaceSlug, input.fileType as import("@lume/shared").BootstrapFileType) };
  },
  [AGENT_IPC_CHANNELS.SEND_MESSAGE]: async (params) => {
    const input = validateInput(agentSendInputSchema, params, AGENT_IPC_CHANNELS.SEND_MESSAGE);
    if (planStateTracker.isLikelyExecutionRequest(input)) {
      const steps = planStateTracker.syncExecutionFromUserMessage(input.sessionId, input.userMessage);
      notifyPlanStateChange(input.sessionId, "executing", steps ? { steps } : undefined);
    }
    void sendAgentMessage(input, {
      onEvent: (event) => {
        writeNotification(AGENT_IPC_CHANNELS.STREAM_EVENT, {
          sessionId: input.sessionId,
          event
        });
        if (event.type !== "tool_result") return;
        if (event.toolName === "EnterPlanMode") {
          notifyPlanStateChange(input.sessionId, "planning");
          return;
        }
        if (event.toolName === "ExitPlanMode") {
          const planPath = planStateTracker.parsePlanPathFromToolResult(event.result);
          notifyPlanStateChange(input.sessionId, "review", planPath ? { planPath } : undefined);
        }
      },
      onComplete: () => {
        writeNotification(AGENT_IPC_CHANNELS.STREAM_COMPLETE, {
          sessionId: input.sessionId
        });
        if (planStateTracker.getPhase(input.sessionId) === "executing") {
          const steps = planStateTracker.markCurrentStepCompleted(input.sessionId);
          notifyPlanStateChange(input.sessionId, "executed", steps ? { steps } : undefined);
        }
      },
      onError: (error) =>
      {
        writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
          sessionId: input.sessionId,
          error
        });
        if (planStateTracker.getPhase(input.sessionId) === "executing") {
          const steps = planStateTracker.markCurrentStepFailed(input.sessionId, error);
          notifyPlanStateChange(input.sessionId, "review", steps ? { steps } : undefined);
        }
      },
      onTitleUpdated: (title) =>
        writeNotification(AGENT_IPC_CHANNELS.TITLE_UPDATED, {
          sessionId: input.sessionId,
          title
        }),
      onAskUserQuestion: (request) =>
        writeNotification(AGENT_IPC_CHANNELS.ASK_USER_QUESTION, request),
      onToolPermissionRequest: (request) =>
        writeNotification(AGENT_IPC_CHANNELS.TOOL_PERMISSION_REQUEST, request)
    }).catch((error) => {
      writeNotification(AGENT_IPC_CHANNELS.STREAM_ERROR, {
        sessionId: input.sessionId,
        error: error instanceof Error ? error.message : String(error)
      });
      if (planStateTracker.getPhase(input.sessionId) === "executing") {
        const steps = planStateTracker.markCurrentStepFailed(
          input.sessionId,
          error instanceof Error ? error.message : String(error)
        );
        notifyPlanStateChange(input.sessionId, "review", steps ? { steps } : undefined);
      }
    });
    return { ok: true };
  },

  // 日志相关
  [AGENT_IPC_CHANNELS.WRITE_LOG]: async (params) => {
    const p = asObject(params);
    const level = asString(p.level) || "info";
    const context = asString(p.context) || "web";
    const message = asString(p.message);
    const sessionId = asString(p.sessionId);
    const data = p.data as Record<string, unknown> | undefined;

    if (!message) return { ok: false };

    const log = createLogger(context, sessionId);
    const logMethod = level as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    if (typeof log[logMethod] === "function") {
      log[logMethod](message, data);
    } else {
      log.info(message, data);
    }
    return { ok: true };
  },
  [AGENT_IPC_CHANNELS.GET_LOGS_DIR]: async () => ({ path: getLogsDir() }),
  "browser:get-extension-info": async () => getBrowserExtensionInfo(),
  "browser:install-extension": async () => installBrowserExtension(),
  "browser:get-relay-status": async () => getBrowserRelayStatus(),
  "browser:start-relay": async () => startBrowser("relay")
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
  const relayAutostart = process.env.LUME_BROWSER_RELAY_AUTOSTART?.toLowerCase() !== "0";
  void initProxySettings().catch((error) => {
    console.error(`[代理配置] 启动初始化失败: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (relayAutostart) {
    void startRelayServer().then(({ port }) => {
      console.error(`[浏览器 Relay] 已启动: http://127.0.0.1:${port}/`);
    }).catch((error) => {
      console.error(`[浏览器 Relay] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  const channelIngressAutostart = process.env.LUME_CHANNEL_GATEWAY_AUTOSTART?.toLowerCase() !== "0";
  if (channelIngressAutostart) {
    void startFeishuIngressServer().then((status) => {
      console.error(`[渠道网关] 飞书 webhook 已启动: ${status.webhookUrl ?? "unknown"}`);
    }).catch((error) => {
      console.error(`[渠道网关] 飞书 webhook 启动失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  startFeishuRetryWorker();
  void startAutomationRunner().catch((error) => {
    console.error(`[自动化 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  });
  seedDefaultSkills();
  startWorkspaceWatcher((method, params) => writeNotification(method, params));
  startMemorySyncWatcher();
  const stopWatcher = (): void => {
    stopWorkspaceWatcher();
    stopMemorySyncWatcher();
    closeMemoryManagers();
    void stopAutomationRunner().catch(() => {});
    void stopRelayServer().catch(() => {});
    void stopFeishuIngressServer().catch(() => {});
    stopFeishuRetryWorker();
  };
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
