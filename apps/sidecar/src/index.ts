import { argv, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { z } from "zod";
import { AGENT_IPC_CHANNELS, AUTOMATION_IPC_CHANNELS, CHANNEL_GATEWAY_IPC_CHANNELS, CHANNEL_IPC_CHANNELS, CHAT_IPC_CHANNELS, CHAT_TOOL_IPC_CHANNELS, GITHUB_RELEASE_IPC_CHANNELS, MEMORY_IPC_CHANNELS, SYSTEM_PROMPT_IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@lume/shared";
import type {
  AutomationCreateJobInput,
  AutomationDeleteJobInput,
  ChannelGatewayIngressInput,
  ChannelGatewayListDeliveriesInput,
  ChannelProvider,
  AutomationListRunsInput,
  AutomationRunNowInput,
  AutomationUpdateJobInput,
  PlanStep,
  ChannelCreateInput,
  ChannelUpdateInput,
  FetchModelsInput,
  GitHubReleaseListOptions
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
  createSystemPrompt,
  deleteSystemPrompt,
  getSystemPromptConfig,
  setDefaultPrompt,
  updateAppendSetting,
  updateSystemPrompt
} from "./services/system-prompt-manager";
import {
  createCustomChatTool,
  deleteCustomChatTool,
  getAllChatToolInfos,
  getChatToolCredentials,
  testChatTool,
  updateChatToolCredentials,
  updateChatToolState
} from "./services/chat-tool-manager";
import {
  deleteAttachment,
  readAttachmentAsBase64,
  saveAttachment
} from "./services/attachment-service";
import { extractTextFromAttachment } from "./services/document-parser";
import { startWorkspaceWatcher, stopWorkspaceWatcher } from "./services/workspace-watcher";
import { startMemorySyncWatcher, stopMemorySyncWatcher } from "./services/memory-sync-watcher";
import { startChatToolsWatcher, stopChatToolsWatcher } from "./services/chat-tools-watcher";
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
import { PlanStateTracker } from "./services/plan-state-tracker";
import { initProxySettings } from "./services/proxy-settings-manager";
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
  getFeishuGatewayConfig,
  getFeishuGatewayConfigView,
  saveFeishuGatewayConfig
} from "./services/channel-gateway/feishu-config-manager";
import { testFeishuGatewayConnection } from "./services/channel-gateway/feishu-api";
import {
  getFeishuWsIngressStatus,
  startFeishuWsIngressServer,
  stopFeishuWsIngressServer
} from "./services/channel-gateway/feishu-ws-ingress-service";
import {
  getGitHubReleaseByTag,
  getLatestGitHubRelease,
  listGitHubReleases
} from "./services/github-release-service";
import {
  startFeishuRetryWorker,
  stopFeishuRetryWorker
} from "./services/channel-gateway/feishu-retry-worker";
import { subscribeSubagentAnnounceEvent } from "./services/pi-agent/subagents/subagent-announce-bus";
import { createChatHandlers } from "./rpc/chat-handlers";
import { createAgentHandlers } from "./rpc/agent-handlers";

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

const idSchema = z.string().min(1);

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

const workspaceSlugInputSchema = z.object({
  workspaceSlug: idSchema
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
  connectionMode: z.enum(["websocket", "webhook"]).optional(),
  appId: z.string().default(""),
  appSecret: z.string().optional(),
  verificationToken: z.string().optional(),
  encryptKey: z.string().optional(),
  domain: z.enum(["feishu", "lark"]).optional(),
  defaultWorkspaceId: z.string().optional(),
  webhookPath: z.string().optional()
});

const githubReleaseByTagInputSchema = z.object({
  tag: z.string().min(1)
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
  [GITHUB_RELEASE_IPC_CHANNELS.GET_LATEST_RELEASE]: async () => getLatestGitHubRelease(),
  [GITHUB_RELEASE_IPC_CHANNELS.LIST_RELEASES]: async (params) => listGitHubReleases(
    (params ?? {}) as GitHubReleaseListOptions
  ),
  [GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG]: async (params) => {
    const input = validateInput(
      githubReleaseByTagInputSchema,
      params,
      GITHUB_RELEASE_IPC_CHANNELS.GET_RELEASE_BY_TAG
    );
    return getGitHubReleaseByTag(input.tag);
  },

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

  ...createChatHandlers(writeNotification),

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
  [CHANNEL_GATEWAY_IPC_CHANNELS.GET_INGRESS_STATUS]: async () => {
    const cfg = getFeishuGatewayConfig();
    return cfg.connectionMode === "websocket" ? getFeishuWsIngressStatus() : getFeishuIngressStatus();
  },
  [CHANNEL_GATEWAY_IPC_CHANNELS.START_INGRESS]: async () => {
    const cfg = getFeishuGatewayConfig();
    if (cfg.connectionMode === "websocket") {
      await stopFeishuIngressServer();
      return startFeishuWsIngressServer();
    }
    await stopFeishuWsIngressServer();
    return startFeishuIngressServer();
  },
  [CHANNEL_GATEWAY_IPC_CHANNELS.STOP_INGRESS]: async () => {
    await stopFeishuIngressServer();
    await stopFeishuWsIngressServer();
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

  ...createAgentHandlers({ writeNotification, planStateTracker, notifyPlanStateChange }),
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
    const channelConfig = getFeishuGatewayConfig();
    if (channelConfig.connectionMode === "websocket") {
      void startFeishuWsIngressServer().then((status) => {
        console.error(`[渠道网关] 飞书 WebSocket 已启动: connected=${status.wsConnected}`);
      }).catch((error) => {
        console.error(`[渠道网关] 飞书 WebSocket 启动失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      void startFeishuIngressServer().then((status) => {
        console.error(`[渠道网关] 飞书 webhook 已启动: ${status.webhookUrl ?? "unknown"}`);
      }).catch((error) => {
        console.error(`[渠道网关] 飞书 webhook 启动失败: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
  startFeishuRetryWorker();
  void startAutomationRunner().catch((error) => {
    console.error(`[自动化 Runner] 启动失败: ${error instanceof Error ? error.message : String(error)}`);
  });
  seedDefaultSkills();
  startWorkspaceWatcher((method, params) => writeNotification(method, params));
  startMemorySyncWatcher();
  startChatToolsWatcher((method, params) => writeNotification(method, params));
  const unsubscribeSubagentAnnounce = subscribeSubagentAnnounceEvent((event) => {
    writeNotification(AGENT_IPC_CHANNELS.MESSAGE_APPENDED, event);
  });
  const stopWatcher = (): void => {
    unsubscribeSubagentAnnounce();
    stopWorkspaceWatcher();
    stopMemorySyncWatcher();
    stopChatToolsWatcher();
    closeMemoryManagers();
    void stopAutomationRunner().catch(() => {});
    void stopRelayServer().catch(() => {});
    void stopFeishuIngressServer().catch(() => {});
    void stopFeishuWsIngressServer().catch(() => {});
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
