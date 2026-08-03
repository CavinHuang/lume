import type { LumeGuardrailContext } from "../guardrails/guardrail-types";
import type { LumeGuardrailRunner } from "../guardrails/guardrail-runner";
import { PermissionRuntime } from "../permissions/permission-runtime";
import type {
  PermissionClassification,
  PermissionGrantSuggestion,
  PermissionRuntimeMode,
  PermissionRule
} from "../permissions/permission-types";
import type { LumeToolDescriptor, LumeToolRiskLevel } from "./tool-types";
import { evaluateProtectedRootAccess } from "./protected-root-policy";

export type ToolExecutionAuthorization =
  | {
    status: "allow";
    reasonCode: string;
    risk: "low" | "medium" | "high";
    classification?: PermissionClassification;
    grantSuggestion?: PermissionGrantSuggestion;
    matchedRuleId?: string;
  }
  | {
    status: "deny";
    message: string;
    reasonCode: string;
    risk: "low" | "medium" | "high";
    classification?: PermissionClassification;
    grantSuggestion?: PermissionGrantSuggestion;
    matchedRuleId?: string;
  }
  | {
    status: "approval_required";
    reason: string;
    risk: "low" | "medium" | "high";
    reasonCode: string;
    classification?: PermissionClassification;
    grantSuggestion?: PermissionGrantSuggestion;
    matchedRuleId?: string;
  };

export interface ToolExecutionGatewayInput {
  toolName: string;
  descriptor: LumeToolDescriptor;
  input: unknown;
  permissionMode?: PermissionRuntimeMode;
  classifierEnabled?: boolean;
  permissionRules?: PermissionRule[];
  privateWriteRoots?: string[];
  protectedRoots?: string[];
  context: LumeGuardrailContext;
}

export class ToolExecutionGateway {
  private readonly permissionRuntime: Pick<PermissionRuntime, "authorize">;

  constructor(private readonly deps: {
    guardrails: LumeGuardrailRunner;
    permissionRuntime?: Pick<PermissionRuntime, "authorize">;
  }) {
    this.permissionRuntime = deps.permissionRuntime ?? new PermissionRuntime();
  }

  async authorize(input: ToolExecutionGatewayInput): Promise<ToolExecutionAuthorization> {
    const protectedRootDecision = evaluateProtectedRootAccess({
      descriptor: input.descriptor,
      rawInput: input.input,
      cwd: input.context.cwd ?? process.cwd(),
      protectedRoots: input.protectedRoots ?? [],
    });
    if (protectedRootDecision) {
      return {
        status: "deny",
        message: protectedRootDecision.message,
        reasonCode: protectedRootDecision.reasonCode,
        risk: "high",
      };
    }
    const permissionDecision = await this.permissionRuntime.authorize({
      descriptor: input.descriptor,
      input: input.input,
      mode: input.permissionMode,
      classifierEnabled: input.classifierEnabled,
      context: {
        threadId: input.context.threadId,
        cwd: input.context.cwd,
        workspaceSlug: input.context.workspaceSlug,
        privateWriteRoots: input.privateWriteRoots
      },
      rules: input.permissionRules
    });

    if (permissionDecision.status === "deny") {
      return {
        status: "deny",
        message: permissionDecision.explanation,
        reasonCode: permissionDecision.reasonCode,
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    const inputSafety = await this.deps.guardrails.runToolInputGuardrails({
      toolName: input.toolName,
      input: input.input,
      context: {
        ...input.context,
        permissionMode: input.permissionMode
      }
    });
    if (inputSafety.behavior === "reject") {
      return {
        status: "deny",
        message: `工具参数被拒绝: ${inputSafety.reason}`,
        reasonCode: "guardrail_reject",
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    const bypassesConfirmation = input.permissionMode === "bypassPermissions"
      || permissionDecision.reasonCode === "session_bypass";
    if (inputSafety.behavior === "require_approval" && !bypassesConfirmation) {
      return {
        status: "approval_required",
        reason: inputSafety.reason ?? permissionDecision.explanation,
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        reasonCode: "guardrail_approval",
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    if (inputSafety.behavior === "require_approval" && bypassesConfirmation) {
      return {
        status: "allow",
        reasonCode: "bypass_guardrail_confirmation",
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    if (permissionDecision.status === "allow") {
      return {
        status: "allow",
        reasonCode: permissionDecision.reasonCode,
        risk: toToolPermissionRisk(permissionDecision.riskLevel),
        ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
        ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
        ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
      };
    }

    return {
      status: "approval_required",
      reason: permissionDecision.explanation,
      risk: toToolPermissionRisk(permissionDecision.riskLevel),
      reasonCode: permissionDecision.reasonCode,
      ...(permissionDecision.classification ? { classification: permissionDecision.classification } : {}),
      ...(permissionDecision.grantSuggestion ? { grantSuggestion: permissionDecision.grantSuggestion } : {}),
      ...(permissionDecision.matchedRuleId ? { matchedRuleId: permissionDecision.matchedRuleId } : {})
    };
  }
}

function toToolPermissionRisk(risk: LumeToolRiskLevel | "critical"): "low" | "medium" | "high" {
  return risk === "critical" ? "high" : risk;
}
