import { AGENT_IPC_CHANNELS } from "@lume/shared";
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
import { desktopContextRpcService } from "../services/desktop-context/desktop-context-runtime";
import type { NotificationWriter, RpcHandler } from "./types";

export interface CreateRpcHandlersContext {
  writeNotification: NotificationWriter;
  renderClient?: { handleRenderResult: (params: any) => void };
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
    createAgentHandlers({
      writeNotification: context.writeNotification,
      planModePhaseTracker,
      notifyPlanModePhaseChange
    })
  );
  if (context.renderClient) {
    handlers["render:result"] = async (params: unknown) => {
      context.renderClient!.handleRenderResult(params as any);
      return { ok: true };
    };
  }
  return handlers;
}
