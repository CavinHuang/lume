import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { getAgentRuntimeStatusManager } from "../services/agent/agent-runtime-status-manager";
import { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createAgentHandlers } from "./agent-handlers";
import { createAutomationHandlers } from "./automation-handlers";
import { createChannelHandlers } from "./channel-handlers";
import { createImHandlers } from "./im-handlers";
import { createMemoryHandlers } from "./memory-handlers";
import { createSystemHandlers } from "./system-handlers";
import type { NotificationWriter, RpcHandler } from "./types";

export interface CreateRpcHandlersContext {
  writeNotification: NotificationWriter;
}

export function createRpcHandlers(context: CreateRpcHandlersContext): Record<string, RpcHandler> {
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
    createImHandlers(),
    createMemoryHandlers(),
    createAutomationHandlers(),
    createAgentHandlers({
      writeNotification: context.writeNotification,
      planModePhaseTracker,
      notifyPlanModePhaseChange
    })
  );
  return handlers;
}
