import type {
  AgentSendInput,
  AgentToolPermissionRequest
} from "@lume/shared";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  isToolAlwaysAllowed,
  markToolAlwaysAllowed,
  waitForToolPermissionDecision
} from "./tool-permission-bridge";
import {
  getToolMetadata,
  inferToolMetadata,
  isToolAllowedInPlanMode
} from "./tool-metadata";

interface ToolPermissionGateInput {
  sessionId: string;
  permissionMode?: AgentSendInput["permissionMode"];
  emitToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
}

function shouldRequireConfirmation(params: {
  permissionMode?: AgentSendInput["permissionMode"];
  toolName: string;
}): boolean {
  const mode = params.permissionMode ?? "default";
  if (mode === "bypassPermissions") {
    return false;
  }

  // 使用元数据获取风险等级
  const metadata = getToolMetadata(params.toolName) ?? inferToolMetadata(params.toolName);
  const risk = metadata.riskLevel;

  if (risk === "low") {
    return false;
  }
  if (mode === "acceptEdits") {
    const category = metadata.category;
    if (category === "write") {
      return false;
    }
  }
  return true;
}

function buildReason(toolName: string): string {
  const metadata = getToolMetadata(toolName) ?? inferToolMetadata(toolName);
  const risk = metadata.riskLevel;
  const category = metadata.category;

  if (risk === "high") {
    return `${toolName} 可能执行系统命令或高风险操作，需要你确认。`;
  }
  if (category === "write") {
    return `${toolName} 将修改文件或数据，需要你确认。`;
  }
  if (category === "execute") {
    return `${toolName} 将执行操作，需要你确认。`;
  }
  return `${toolName} 将触发操作，需要你确认。`;
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
        const metadata = getToolMetadata(toolName) ?? inferToolMetadata(toolName);
        const mode = input.permissionMode ?? "default";
        const effectivePlanMode = runtimeState.inPlanMode || mode === "plan";

        // 使用元数据检查 Plan 模式权限
        if (effectivePlanMode && !isToolAllowedInPlanMode(toolName)) {
          throw new Error(`当前是 plan 模式，只允许规划与只读工具，禁止执行: ${toolName}`);
        }

        if (shouldRequireConfirmation({ permissionMode: effectivePlanMode ? "plan" : mode, toolName })) {
          if (!isToolAlwaysAllowed(input.sessionId, toolName)) {
            const request: AgentToolPermissionRequest = {
              sessionId: input.sessionId,
              requestId: toolCallId,
              toolUseId: toolCallId,
              toolName,
              risk: metadata.riskLevel,
              reason: buildReason(toolName),
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
