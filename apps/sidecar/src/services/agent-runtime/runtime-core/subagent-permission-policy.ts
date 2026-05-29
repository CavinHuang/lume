import type {
  AgentToolPermissionRiskLevel,
  LumeConfigSubagentApprovalPolicy
} from "@lume/shared";

export interface SubagentPermissionPolicyInput {
  isSubagent: boolean;
  mode?: LumeConfigSubagentApprovalPolicy["mode"];
  authorizationStatus: "allow" | "deny" | "approval_required";
  risk: AgentToolPermissionRiskLevel;
  toolName: string;
}

export interface SubagentPermissionPolicyDenyDecision {
  behavior: "deny";
  message: string;
  reasonCode: "subagent_high_risk_denied";
}

export interface SubagentCanAllowAlwaysInput {
  isSubagent: boolean;
  allowAlways?: LumeConfigSubagentApprovalPolicy["allowAlways"];
  hasGrantSuggestion: boolean;
}

export function resolveSubagentPermissionPolicyDecision(
  input: SubagentPermissionPolicyInput
): SubagentPermissionPolicyDenyDecision | null {
  if (!input.isSubagent) return null;
  if (input.authorizationStatus !== "approval_required") return null;
  if (input.mode !== "deny-high-risk") return null;
  if (input.risk !== "high") return null;
  return {
    behavior: "deny",
    message: `Subagent 高风险工具已按策略拒绝: ${input.toolName}`,
    reasonCode: "subagent_high_risk_denied"
  };
}

export function resolveSubagentCanAllowAlways(input: SubagentCanAllowAlwaysInput): boolean {
  if (!input.hasGrantSuggestion) return false;
  if (!input.isSubagent) return true;
  return input.allowAlways !== "disabled";
}
