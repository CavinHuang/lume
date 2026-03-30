import { AGENT_IPC_CHANNELS } from "@lume/shared";
import type { PlanStep } from "@lume/shared";
import { getAgentRuntimeStatusManager } from "../services/agent/agent-runtime-status-manager";
import { PlanStateTracker } from "../services/agent/plan-state-tracker";
import { createAgentHandlers } from "./agent-handlers";
import { createAutomationHandlers } from "./automation-handlers";
import { createChannelHandlers } from "./channel-handlers";
import { createChatHandlers } from "./chat-handlers";
import { createMemoryHandlers } from "./memory-handlers";
import { createSystemHandlers } from "./system-handlers";
import type { NotificationWriter, RpcHandler } from "./types";

export interface CreateRpcHandlersContext {
  writeNotification: NotificationWriter;
}

export function createRpcHandlers(context: CreateRpcHandlersContext): Record<string, RpcHandler> {
  const planStateTracker = new PlanStateTracker();
  const runtimeStatusManager = getAgentRuntimeStatusManager();
  const notifyPlanStateChange = (
    sessionId: string,
    phase: "idle" | "planning" | "review" | "executing" | "executed",
    extras?: { planPath?: string; steps?: PlanStep[] }
  ): void => {
    const event = planStateTracker.updatePhase(sessionId, phase, extras);
    if (!event) {
      return;
    }
    context.writeNotification(AGENT_IPC_CHANNELS.PLAN_STATE_CHANGED, event);
  };
  runtimeStatusManager.subscribe((status) => {
    context.writeNotification(AGENT_IPC_CHANNELS.RUNTIME_STATUS_CHANGED, { status });
  });

  const handlers: Record<string, RpcHandler> = {};
  Object.assign(
    handlers,
    createSystemHandlers({
      getMethodNames: () => Object.keys(handlers).sort()
    }),
    createChannelHandlers(),
    createChatHandlers(context.writeNotification),
    createMemoryHandlers(),
    createAutomationHandlers(),
    createAgentHandlers({
      writeNotification: context.writeNotification,
      planStateTracker,
      notifyPlanStateChange
    })
  );
  return handlers;
}
