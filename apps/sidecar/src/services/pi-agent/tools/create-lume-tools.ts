import type { AgentAskUserQuestionRequest } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryToolPolicy } from "../../memory-policy";
import { createPiControlTools } from "./create-control-tools";
import { createPiMemoryTools } from "./create-memory-tools";
import { createOpenClawAlignedTools } from "./create-openclaw-aligned-tools";
import { resolveEnabledPiMemoryToolNames } from "./tool-policy";

const BASE_PI_TOOL_NAMES = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep", "LS"];
const CONTROL_PI_TOOL_NAMES = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];
const OPENCLAW_ALIGNED_TOOL_NAMES = [
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "session_status",
  "web_search",
  "web_fetch"
];

export interface CreateLumePiToolsInput {
  agentCwd: string;
  sessionId: string;
  workspaceId?: string;
  channelId?: string;
  workspaceSlug?: string;
  permissionMode?: AgentSendInput["permissionMode"];
  memoryToolPolicy?: MemoryToolPolicy;
  includeCitations: boolean;
  emitAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
}

export interface CreateLumePiToolsOutput {
  customTools: AgentTool[];
  availableToolNames: string[];
}

// Plan 模式工具过滤现在由 tool-permission-gate.ts 基于 tool-metadata.ts 处理
// 不再需要硬编码的白名单

export function createLumePiTools(input: CreateLumePiToolsInput): CreateLumePiToolsOutput {
  const enabledMemoryToolNames = resolveEnabledPiMemoryToolNames(input.memoryToolPolicy);
  const enabledMemoryTools = new Set(enabledMemoryToolNames);
  const memoryTools = input.workspaceSlug
    ? createPiMemoryTools({
      workspaceSlug: input.workspaceSlug,
      enabledTools: enabledMemoryTools,
      includeCitations: input.includeCitations
    })
    : [];
  const controlTools = createPiControlTools({
    sessionId: input.sessionId,
    agentCwd: input.agentCwd,
    emitAskUserQuestion: input.emitAskUserQuestion
  });
  const openClawAlignedTools = createOpenClawAlignedTools({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId
  });

  // 不再在这里过滤，由 tool-permission-gate.ts 基于 tool-metadata.ts 处理
  const customTools = [...memoryTools, ...controlTools, ...openClawAlignedTools];
  const customToolNames = customTools.map((tool) => tool.name);

  return {
    customTools,
    availableToolNames: [
      ...BASE_PI_TOOL_NAMES,
      ...customToolNames
    ]
  };
}
