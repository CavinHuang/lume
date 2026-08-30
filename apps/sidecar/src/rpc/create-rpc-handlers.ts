import { AGENT_IPC_CHANNELS } from "@lume/shared";
import { getAgentRuntimeStatusManager } from "../services/agent/agent-runtime-status-manager";
import { PlanModePhaseTracker } from "../services/agent/plan-mode-phase-tracker";
import { createAgentHandlers } from "./agent-handlers";
import { createAutomationHandlers } from "./automation-handlers";
import { createChannelHandlers } from "./channel-handlers";
import { createConnectorHandlers } from "./connector-handlers";
import { createImHandlers } from "./im-handlers";
import { createMemoryHandlers } from "./memory-handlers";
import { createModelMetaHandlers } from "./model-meta-handlers";
import { createObsidianVaultHandlers } from "./obsidian-handlers";
import { createReadingHandlers } from "./reading-handlers";
import { createRoutineHandlers } from "./routine-handlers";
import { createSuggestionHandlers } from "./suggestion-handlers";
import { createSystemHandlers } from "./system-handlers";
import { createDesktopContextHandlers } from "./desktop-context-handlers";
import { desktopContextRpcService } from "../services/desktop-context/desktop-context-runtime";
import type { NotificationWriter, RpcHandler } from "./types";
import { createPersonaHandlers } from "./persona-handlers";
import { createPlanningTodoHandlers } from "./planning-todo-handlers";
import { getTerminalBridgeHandlers } from "../services/terminal/terminal-bridge";

export interface CreateRpcHandlersContext {
  writeNotification: NotificationWriter;
  renderClient?: { handleRenderResult: (params: any) => void };
}

export function createRpcHandlers(context: CreateRpcHandlersContext): Record<string, RpcHandler> {
  // #580:agent 域通知写入器改由组合根经 outbound-notification 注入,
  // handler 工厂不再偷偷装配全局 setter。
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
    createConnectorHandlers(),
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
      planModePhaseTracker,
      notifyPlanModePhaseChange
    }),
    createPlanningTodoHandlers({ writeNotification: context.writeNotification }),
    createPersonaHandlers(),
    createObsidianVaultHandlers(),
    // 右侧面板终端 tab（sidecar 侧 PTY 执行体 + terminal:data 输出通知）
    getTerminalBridgeHandlers({ writeNotification: context.writeNotification })
  );
  if (context.renderClient) {
    handlers["render:result"] = async (params: unknown) => {
      context.renderClient!.handleRenderResult(params as any);
      return { ok: true };
    };
  }
  return handlers;
}
