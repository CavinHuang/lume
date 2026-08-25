import type { ToolDefinition } from "@lume/agent-sdk";

export type LumeToolSource =
  | "sdk"
  | "lume"
  | "memory"
  | "automation"
  | "plan"
  | "task"
  | "mcp"
  | "skill"
  | "plugin";

export type LumeToolCategory = "read" | "write" | "execute" | "control" | "network";

export type LumeToolCapability =
  | "filesystem"
  | "shell"
  | "web"
  | "memory"
  | "automation"
  | "planning"
  | "subagent"
  | "mcp"
  | "skill"
  | "plugin"
  | "external";

export type LumeToolRiskLevel = "low" | "medium" | "high";

export type LumeToolSideEffects =
  | "none"
  | "local_read"
  | "local_write"
  | "network"
  | "process"
  | "external";

export interface LumeToolMetadata {
  title?: string;
  description?: string;
  category: LumeToolCategory;
  capability: LumeToolCapability;
  riskLevel: LumeToolRiskLevel;
  sideEffects: LumeToolSideEffects;
  allowedInPlanMode: boolean;
  isReadOnly: boolean;
  isConcurrencySafe: boolean;
  requiresWorkspace?: boolean;
  requiresNetwork?: boolean;
  requiresApprovalByDefault?: boolean;
  payloadPolicy?: {
    maxInputChars?: number;
  };
  resultPolicy?: {
    maxChars?: number;
  };
  executionPolicy?: {
    maxCallsPerTurn?: number;
    allowBackground?: boolean;
    /** 单次调用看门狗（#538）：超时后向引擎返回 is_error 结果而非无限等待；
     * 底层调用仍会在后台自然结束。缺省不启用。
     * 勿用于写类工具：超时返回会提前释放 workspace writer lease，而底层
     * mutation 可能仍在写文件；只配给只读/外部查询类工具。 */
    toolTimeoutMs?: number;
  };
}

export interface LumeToolDescriptor {
  name: string;
  canonicalName: string;
  source: LumeToolSource;
  definition: ToolDefinition;
  metadata: LumeToolMetadata;
}

export type LumeToolDescriptorInput = Omit<LumeToolDescriptor, "canonicalName" | "metadata"> & {
  canonicalName?: string;
  metadata?: Partial<LumeToolMetadata>;
};
