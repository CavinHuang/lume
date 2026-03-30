import type { AgentAskUserQuestionRequest, AgentToolPermissionRequest } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MemoryToolPolicy } from "../../memory/memory-policy";
import { createPiControlTools } from "./control/create-control-tools";
import { createPiMemoryTools } from "./memory/create-memory-tools";
import { createSessionTools } from "./session/create-session-tools";
import { createWebTools, WEB_TOOL_NAMES } from "./web/create-web-tools";
import { createCronTools } from "./cron/create-cron-tools";
import { resolveEnabledPiMemoryToolNames } from "./permissions/tool-policy";

const BASE_PI_TOOL_NAMES = ["read", "write", "edit", "bash", "find", "grep", "ls"];
const CONTROL_PI_TOOL_NAMES = ["AskUserQuestion"];
const SESSION_TOOL_NAMES = [
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_delete",
  "sessions_spawn",
  "session_status",
  "subagents_list",
  "subagents_kill",
  "subagents_send",
  "subagents_steer"
];
const AUTOMATION_TOOL_NAMES = [
  "cron_read",
  "cron_set",
  "cron_query"
];

export interface CreateLumePiToolsInput {
  sessionId: string;
  workspaceId?: string;
  channelId?: string;
  sessionType?: AgentSendInput["sessionType"];
  chatType?: AgentSendInput["chatType"];
  workspaceSlug?: string;
  permissionMode?: AgentSendInput["permissionMode"];
  memoryToolPolicy?: MemoryToolPolicy;
  includeCitations: boolean;
  automationExecution?: boolean;
  emitAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
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
    emitAskUserQuestion: input.emitAskUserQuestion,
    includeAskUserQuestion: input.automationExecution !== true
  });
  const sessionTools = createSessionTools({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    sessionType: input.sessionType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    emitAskUserQuestion: input.emitAskUserQuestion,
    emitToolPermissionRequest: input.emitToolPermissionRequest
  });
  const webTools = createWebTools();

  // 不再在这里过滤，由 tool-permission-gate.ts 基于 tool-metadata.ts 处理
  const cronTools = createCronTools({
    workspaceId: input.workspaceId,
    sessionId: input.sessionId
  });
  const customTools = [...memoryTools, ...controlTools, ...sessionTools, ...webTools, ...cronTools];
  const customToolNames = customTools.map((tool) => tool.name);

  return {
    customTools,
    availableToolNames: [
      ...BASE_PI_TOOL_NAMES,
      ...SESSION_TOOL_NAMES,
      ...WEB_TOOL_NAMES,
      ...AUTOMATION_TOOL_NAMES,
      ...(input.automationExecution === true ? [] : CONTROL_PI_TOOL_NAMES),
      ...customToolNames
    ]
  };
}
