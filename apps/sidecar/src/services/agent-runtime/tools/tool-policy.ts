import {
  getToolMetadata,
  inferToolMetadata
} from "../../pi-agent/tools/permissions/tool-metadata";
import type { LumeGuardrailResult } from "../guardrails/guardrail-types";

export type RuntimePermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | undefined;

export interface ToolApprovalPolicyInput {
  permissionMode: RuntimePermissionMode;
  toolName: string;
  guardrailResult: LumeGuardrailResult;
}

export type ToolApprovalPolicyResult =
  | { requiresApproval: false }
  | { requiresApproval: true; reason: string };

export function evaluateToolApprovalPolicy(input: ToolApprovalPolicyInput): ToolApprovalPolicyResult {
  if (input.guardrailResult.behavior === "require_approval") {
    return {
      requiresApproval: true,
      reason: input.guardrailResult.reason ?? buildToolApprovalReason(input.toolName)
    };
  }

  const mode = input.permissionMode ?? "default";
  if (mode === "bypassPermissions") {
    return { requiresApproval: false };
  }

  const metadata = getToolMetadata(input.toolName) ?? inferToolMetadata(input.toolName);
  if (metadata.riskLevel === "low") {
    return { requiresApproval: false };
  }
  if (mode === "acceptEdits" && metadata.category === "write") {
    return { requiresApproval: false };
  }

  return {
    requiresApproval: true,
    reason: buildToolApprovalReason(input.toolName)
  };
}

export function buildToolApprovalReason(toolName: string): string {
  const metadata = getToolMetadata(toolName) ?? inferToolMetadata(toolName);
  if (metadata.riskLevel === "high") {
    return `${toolName} 可能执行系统命令或高风险操作，需要你确认。`;
  }
  if (metadata.category === "write") {
    return `${toolName} 将修改文件或数据，需要你确认。`;
  }
  if (metadata.category === "execute") {
    return `${toolName} 将执行操作，需要你确认。`;
  }
  return `${toolName} 将触发操作，需要你确认。`;
}
