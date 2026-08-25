import { AGENT_IPC_CHANNELS, type BrowserReferenceGrantInput } from "@lume/shared";
import { setAgentNotificationWriter } from "../services/agent/agent-notification-service";
import { getAgentRuntimeStatusManager } from "../services/agent/agent-runtime-status-manager";
import { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createAgentHandlers } from "./agent-handlers";
import { createAutomationHandlers } from "./automation-handlers";
import { createChannelHandlers } from "./channel-handlers";
import { createImHandlers } from "./im-handlers";
import { createMemoryHandlers } from "./memory-handlers";
import { createModelMetaHandlers } from "./model-meta-handlers";
import { createReadingHandlers } from "./reading-handlers";
import { createRoutineHandlers } from "./routine-handlers";
import { createSuggestionHandlers } from "./suggestion-handlers";
import { createSystemHandlers } from "./system-handlers";
import { createDesktopContextHandlers } from "./desktop-context-handlers";
import { desktopContextRpcService } from "../services/desktop-context/desktop-context-runtime";
import type { NotificationWriter, RpcHandler } from "./types";
import { z } from "./validation";
import type { BrowserBroker } from "../services/browser/browser-broker";
import { getEffectivePluginRuntimeConfig } from "../services/system/lume-config-service";
import { createPersonaHandlers } from "./persona-handlers";
import { createPlanningTodoHandlers } from "./planning-todo-handlers";
import { isBundledBrowserPluginAvailable } from "../services/agent-runtime/plugins/plugin-manager";

export interface CreateRpcHandlersContext {
  writeNotification: NotificationWriter;
  renderClient?: { handleRenderResult: (params: any) => void };
  browserBroker?: BrowserBroker;
}

// #582③：browser 域入参校验归一到 zod schema（与其余 create*Handlers 的 validateInput
// 同一模式），但错误语义保持 `invalid_browser_request` 不变——前端按此 code 容错。
const browserSettingsInputSchema = z
  .object({
    extensionBackendEnabled: z.boolean().optional(),
    browserEnabled: z.boolean().optional(),
    browserUseEnabled: z.boolean().optional(),
  })
  .strict();

const browserReferenceCandidatesInputSchema = z
  .object({ threadId: z.string().min(1) })
  .strict();

const browserCreateReferenceGrantInputSchema = z
  .object({
    backend: z.enum(["iab", "extension"]),
    browserId: z.enum(["lume-iab", "lume-extension"]),
    tabId: z.string().min(1),
    providerTabId: z.string().optional(),
    title: z.string(),
    url: z.string(),
    generation: z.number().optional(),
    lastOpenedAt: z.string().optional(),
    ownerThreadId: z.string().optional(),
    threadId: z.string().min(1),
    access: z.literal("control"),
  })
  .strict();

const browserRevokeReferenceGrantInputSchema = z
  .object({
    backend: z.enum(["iab", "extension"]),
    threadId: z.string().min(1),
    referenceGrantId: z.string().min(1),
  })
  .strict();

function validateBrowserInput<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new Error("invalid_browser_request");
  }
  return parsed.data;
}

export function createRpcHandlers(context: CreateRpcHandlersContext): Record<string, RpcHandler> {
  setAgentNotificationWriter(context.writeNotification);
  const planModePhaseTracker = new PlanModePhaseTracker();
  const runtimeStatusManager = getAgentRuntimeStatusManager();
  const notifyPlanModePhaseChange = (
    sessionId: string,
    phase: "idle" | "planning" | "awaiting_approval" | "executing" | "completed"
  ): void => {
    const event = planModePhaseTracker.updatePhase(sessionId, phase);
    if (!event) {
      return;
    }
    context.writeNotification(AGENT_IPC_CHANNELS.PLAN_MODE_PHASE_CHANGED, event);
  };
  runtimeStatusManager.subscribe((status) => {
    context.writeNotification(AGENT_IPC_CHANNELS.RUNTIME_STATUS_CHANGED, {
      status: {
        ...status
      }
    });
  });

  const handlers: Record<string, RpcHandler> = {};
  let extensionBackendEnabled = false;
  // desktop「启用 Lume 浏览器 / 允许 Browser Use」设置经 browser:settings RPC
  // 到达此处(缺省视为启用),驱动 broker 门控与工具 isEnabled(#608)
  let browserEnabledFromSettings = true;
  let agentBrowserUseEnabledFromSettings = true;
  const notifyBrowserPluginState = (): void => {
    const enabled = getEffectivePluginRuntimeConfig().enabled;
    const browserEnabled = (enabled.includes("browser") || isBundledBrowserPluginAvailable()) && browserEnabledFromSettings;
    const chromeEnabled = enabled.includes("lume-chrome");
    context.browserBroker?.setPluginState({ browserEnabled, chromeEnabled, extensionBackendEnabled, agentBrowserUseEnabled: agentBrowserUseEnabledFromSettings });
    context.writeNotification("browser:plugin-state", { browserEnabled, chromeEnabled, extensionBackendEnabled, enabled });
  };
  notifyBrowserPluginState();
  Object.assign(
    handlers,
    createSystemHandlers({
      getMethodNames: () => Object.keys(handlers).sort()
    }),
    createChannelHandlers(),
    createModelMetaHandlers(),
    createImHandlers(),
    createMemoryHandlers(),
    createReadingHandlers({
      writeNotification: context.writeNotification
    }),
    createAutomationHandlers(),
    createRoutineHandlers(),
    createSuggestionHandlers({ writeNotification: context.writeNotification }),
    createDesktopContextHandlers(desktopContextRpcService),
    createAgentHandlers({
      writeNotification: context.writeNotification,
      notifyBrowserPluginState,
      planModePhaseTracker,
      notifyPlanModePhaseChange
    }),
    createPlanningTodoHandlers({ writeNotification: context.writeNotification }),
    createPersonaHandlers()
  );
  if (context.renderClient) {
    handlers["render:result"] = async (params: unknown) => {
      context.renderClient!.handleRenderResult(params as any);
      return { ok: true };
    };
  }
  if (context.browserBroker) {
    handlers["browser:settings"] = async (params) => {
      const settingsParams = validateBrowserInput(browserSettingsInputSchema, params ?? {});
      extensionBackendEnabled = settingsParams.extensionBackendEnabled === true;
      browserEnabledFromSettings = settingsParams.browserEnabled !== false;
      agentBrowserUseEnabledFromSettings = settingsParams.browserUseEnabled !== false;
      notifyBrowserPluginState();
      return { ok: true };
    };
    // 安全守卫，勿删：恒 throw 防止 renderer 经通用 RPC 打开未认证的 Node REPL broker
    // 入口（broker 仅允许经桌面专属认证 ingress 调用）。删除此守卫会把 broker 暴露给
    // renderer sidecar_call 面（#528 三审安全警示⑤）。
    handlers["browser:broker"] = async () => { throw new Error("browser broker requires the authenticated Node REPL ingress"); };
    handlers["browser:backends"] = async () => context.browserBroker!.listBackends();
    handlers["browser:chrome-import-status"] = async () => context.browserBroker!.connectedChromeImportStatus();
    handlers["browser:export-chrome-cookies"] = async () => context.browserBroker!.exportConnectedChromeCookies();
    handlers["browser:reference-candidates"] = async (params) => {
      const input = validateBrowserInput(browserReferenceCandidatesInputSchema, params);
      return context.browserBroker!.listReferenceCandidates(input.threadId.trim());
    };
    handlers["browser:create-reference-grant"] = async (params) => {
      const input = validateBrowserInput(browserCreateReferenceGrantInputSchema, params);
      return context.browserBroker!.createReferenceGrant(input as BrowserReferenceGrantInput);
    };
    handlers["browser:revoke-reference-grant"] = async (params) => {
      const input = validateBrowserInput(browserRevokeReferenceGrantInputSchema, params);
      return context.browserBroker!.revokeReferenceGrant({ backend: input.backend, threadId: input.threadId, referenceGrantId: input.referenceGrantId });
    };
  }
  return handlers;
}
