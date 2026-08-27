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

// #519：PermissionRule.scope 已删除——matchPermissionRule 只看 tool/commandPattern/pathPattern/action，
// session/workspace/global 作用域语义从未存在于判定逻辑。
export interface PermissionRule {
  id?: string;
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
  classifierEnabled?: boolean;
  context: PermissionRuntimeContext;
  rules?: PermissionRule[];
}

export interface PermissionClassifierInput {
  toolName: string;
  command?: string;
  path?: string;
  source?: LumeToolSource;
  description?: string;
  /** 实际执行 shell 方言：POSIX bash 在场时不套用 PowerShell 词表（iex/ri 等撞名命令防误拦） */
  shellKind?: "bash" | "powershell";
  /** 测试注入口：shellKind 缺省时方言解析的平台与环境依据；缺省按真实进程解析（与 RuntimeToolSafetyContext 同形） */
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}
