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
  | "skill";

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
