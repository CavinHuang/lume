import type {
  AgentSendInput,
  AgentToolPermissionRequest,
  AgentToolPermissionRiskLevel
} from "@lume/shared";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  isToolAlwaysAllowed,
  markToolAlwaysAllowed,
  waitForToolPermissionDecision
} from "./tool-permission-bridge";

interface ToolPermissionGateInput {
  sessionId: string;
  permissionMode?: AgentSendInput["permissionMode"];
  emitToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
}

function classifyToolRisk(toolName: string): AgentToolPermissionRiskLevel {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "bash" || normalized === "exec" || normalized === "process") {
    return "high";
  }
  if (
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "multiedit" ||
    normalized === "memory_save" ||
    normalized === "sessions_send" ||
    normalized === "sessions_spawn"
  ) {
    return "medium";
  }
  return "low";
}

function shouldRequireConfirmation(params: {
  permissionMode?: AgentSendInput["permissionMode"];
  toolName: string;
  risk: AgentToolPermissionRiskLevel;
}): boolean {
  const mode = params.permissionMode ?? "default";
  if (mode === "bypassPermissions") {
    return false;
  }
  if (params.risk === "low") {
    return false;
  }
  if (mode === "acceptEdits") {
    const normalized = params.toolName.trim().toLowerCase();
    if (normalized === "write" || normalized === "edit" || normalized === "multiedit") {
      return false;
    }
  }
  return true;
}

function buildReason(toolName: string, risk: AgentToolPermissionRiskLevel): string {
  if (risk === "high") {
    return `${toolName} 可能执行系统命令或高风险操作，需要你确认。`;
  }
  return `${toolName} 将修改数据或触发执行流程，需要你确认。`;
}

function sanitizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 2000) {
      copied[key] = `${value.slice(0, 2000)}...(truncated)`;
      continue;
    }
    copied[key] = value;
  }
  return copied;
}

export function wrapToolsWithPermissionGate(
  tools: AgentTool[],
  input: ToolPermissionGateInput
): AgentTool[] {
  const runtimeState = {
    inPlanMode: false
  };

  return tools.map((tool) => {
    if (typeof tool.execute !== "function") {
      return tool;
    }
    const originalExecute = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(toolCallId, args, signal) {
        const toolName = tool.name || "unknown_tool";
        const risk = classifyToolRisk(toolName);
        const mode = input.permissionMode ?? "default";
        const effectivePlanMode = runtimeState.inPlanMode || mode === "plan";
        if (effectivePlanMode && risk !== "low") {
          throw new Error(`当前是 plan 模式，只允许规划与只读工具，禁止执行: ${toolName}`);
        }
        if (shouldRequireConfirmation({ permissionMode: effectivePlanMode ? "plan" : mode, toolName, risk })) {
          if (!isToolAlwaysAllowed(input.sessionId, toolName)) {
            const request: AgentToolPermissionRequest = {
              sessionId: input.sessionId,
              requestId: toolCallId,
              toolUseId: toolCallId,
              toolName,
              risk,
              reason: buildReason(toolName, risk),
              input: sanitizeToolInput(args)
            };
            const decision = await waitForToolPermissionDecision(
              request,
              signal ?? new AbortController().signal,
              input.emitToolPermissionRequest
            );
            if (!decision || decision === "deny") {
              throw new Error(`用户拒绝执行工具: ${toolName}`);
            }
            if (decision === "allow_always") {
              markToolAlwaysAllowed(input.sessionId, toolName);
            }
          }
        }
        const result = await originalExecute(toolCallId, args, signal);
        const normalizedToolName = toolName.trim().toLowerCase();
        if (normalizedToolName === "enterplanmode") {
          runtimeState.inPlanMode = true;
        } else if (normalizedToolName === "exitplanmode") {
          runtimeState.inPlanMode = false;
        }
        return result;
      }
    };
  });
}
