import {
  getToolMetadata,
  inferToolMetadata,
  isToolAllowedInPlanMode
} from "../../pi-agent/tools/permissions/tool-metadata";
import type { LumeGuardrailContext } from "../guardrails/guardrail-types";
import type { LumeGuardrailRunner } from "../guardrails/guardrail-runner";
import {
  evaluateToolApprovalPolicy,
  type RuntimePermissionMode
} from "./tool-policy";

export type ToolExecutionAuthorization =
  | { status: "allow" }
  | { status: "deny"; message: string }
  | { status: "approval_required"; reason: string; risk: "low" | "medium" | "high" };

export interface ToolExecutionGatewayInput {
  toolName: string;
  input: unknown;
  permissionMode?: RuntimePermissionMode;
  context: LumeGuardrailContext;
}

export class ToolExecutionGateway {
  constructor(private readonly deps: { guardrails: LumeGuardrailRunner }) {}

  async authorize(input: ToolExecutionGatewayInput): Promise<ToolExecutionAuthorization> {
    const mode = input.permissionMode ?? "default";
    if (mode === "plan" && !isToolAllowedInPlanMode(input.toolName)) {
      return {
        status: "deny",
        message: `当前是 plan 模式，只允许规划与只读工具，禁止执行: ${input.toolName}`
      };
    }

    const inputSafety = await this.deps.guardrails.runToolInputGuardrails({
      toolName: input.toolName,
      input: input.input,
      context: input.context
    });
    if (inputSafety.behavior === "reject") {
      return {
        status: "deny",
        message: `工具参数被拒绝: ${inputSafety.reason}`
      };
    }

    const approvalPolicy = evaluateToolApprovalPolicy({
      permissionMode: input.permissionMode,
      toolName: input.toolName,
      guardrailResult: inputSafety
    });
    if (!approvalPolicy.requiresApproval) {
      return { status: "allow" };
    }

    return {
      status: "approval_required",
      reason: approvalPolicy.reason,
      risk: (getToolMetadata(input.toolName) ?? inferToolMetadata(input.toolName)).riskLevel
    };
  }
}
