import type { LumeToolDescriptor, LumeToolRiskLevel, LumeToolSource } from "../tools/tool-types";

export type PermissionRuntimeMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto"
  | undefined;

export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionRuleScope = "session" | "workspace" | "global";

export interface PermissionRule {
  id?: string;
  scope: PermissionRuleScope;
  tool: string;
  commandPattern?: string;
  pathPattern?: string;
  action: PermissionAction;
}

export interface PermissionRuntimeContext {
  threadId: string;
  runId?: string;
  cwd?: string;
  workspaceSlug?: string;
  privateWriteRoots?: string[];
}

export interface PermissionClassification {
  riskLevel: LumeToolRiskLevel | "critical";
  reasonCode: string;
  explanation: string;
  shouldAsk: boolean;
}

export type PermissionDecisionStatus = "allow" | "deny" | "approval_required";

export interface PermissionDecision {
  status: PermissionDecisionStatus;
  reasonCode: string;
  riskLevel: LumeToolRiskLevel | "critical";
  explanation: string;
  matchedRuleId?: string;
  classification?: PermissionClassification;
  grantSuggestion?: PermissionGrantSuggestion;
}

export interface PermissionGrantSuggestion {
  fingerprint: string;
  label: string;
}

export interface PermissionDecisionInput {
  descriptor: LumeToolDescriptor;
  input: unknown;
  mode?: PermissionRuntimeMode;
  context: PermissionRuntimeContext;
  rules?: PermissionRule[];
}

export interface PermissionClassifierInput {
  toolName: string;
  command?: string;
  path?: string;
  source?: LumeToolSource;
  description?: string;
}

export type PermissionClassifierLlm = (prompt: string) => Promise<string>;
