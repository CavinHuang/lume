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
import { createSystemHandlers } from "./system-handlers";
import { createDesktopContextHandlers } from "./desktop-context-handlers";
import { createWikiHandlers } from "./wiki-handlers";
import { desktopContextRpcService } from "../services/desktop-context/desktop-context-runtime";
import type { NotificationWriter, RpcHandler } from "./types";
import type { BrowserBroker } from "../services/browser/browser-broker";
import { getEffectivePluginRuntimeConfig } from "../services/system/lume-config-service";
import { createPlanningTodoHandlers } from "./planning-todo-handlers";

export interface CreateRpcHandlersContext {
  writeNotification: NotificationWriter;
  renderClient?: { handleRenderResult: (params: any) => void };
  browserBroker?: BrowserBroker;
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
  const notifyBrowserPluginState = (): void => {
    const enabled = getEffectivePluginRuntimeConfig().enabled;
    const browserEnabled = enabled.includes("browser");
    const chromeEnabled = enabled.includes("lume-chrome");
    context.browserBroker?.setPluginState({ browserEnabled, chromeEnabled, extensionBackendEnabled });
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
    createDesktopContextHandlers(desktopContextRpcService),
    createWikiHandlers(),
    createAgentHandlers({
      writeNotification: context.writeNotification,
      notifyBrowserPluginState,
      planModePhaseTracker,
      notifyPlanModePhaseChange
    }),
    createPlanningTodoHandlers({ writeNotification: context.writeNotification })
  );
  if (context.renderClient) {
    handlers["render:result"] = async (params: unknown) => {
      context.renderClient!.handleRenderResult(params as any);
      return { ok: true };
    };
  }
  if (context.browserBroker) {
    handlers["browser:settings"] = async (params) => {
      if (!params || typeof params !== "object") throw new Error("invalid browser settings");
      extensionBackendEnabled = (params as { extensionBackendEnabled?: unknown }).extensionBackendEnabled === true;
      notifyBrowserPluginState();
      return { ok: true };
    };
    handlers["browser:broker"] = async () => { throw new Error("browser broker requires the authenticated Node REPL ingress"); };
    handlers["browser:backends"] = async () => context.browserBroker!.listBackends();
    handlers["browser:reference-candidates"] = async (params) => {
      const threadId = params && typeof params === "object" && typeof (params as { threadId?: unknown }).threadId === "string"
        ? (params as { threadId: string }).threadId.trim()
        : "";
      if (!threadId) throw new Error("invalid_browser_request");
      return context.browserBroker!.listReferenceCandidates(threadId);
    };
    handlers["browser:create-reference-grant"] = async (params) => {
      if (!params || typeof params !== "object") throw new Error("invalid_browser_request");
      return context.browserBroker!.createReferenceGrant(params as BrowserReferenceGrantInput);
    };
    handlers["browser:revoke-reference-grant"] = async (params) => {
      if (!params || typeof params !== "object") throw new Error("invalid_browser_request");
      const input = params as { backend?: unknown; threadId?: unknown; referenceGrantId?: unknown };
      if ((input.backend !== "iab" && input.backend !== "extension") || typeof input.threadId !== "string" || typeof input.referenceGrantId !== "string") throw new Error("invalid_browser_request");
      return context.browserBroker!.revokeReferenceGrant({ backend: input.backend, threadId: input.threadId, referenceGrantId: input.referenceGrantId });
    };
  }
  return handlers;
}
