import type { SDKMessage, ToolDefinition } from "@lume/agent-sdk";
import type { AgentAskUserQuestionRequest, AgentToolPermissionRequest } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import type { MemoryToolPolicy } from "../../memory/memory-policy";
import { createSdkMemoryTools } from "./memory/create-memory-tools";
import { createSdkSessionTools } from "./session/create-session-tools";
import { createSdkCronTools } from "./cron/create-cron-tools";
import { resolveEnabledPiMemoryToolNames } from "./permissions/tool-policy";

const BASE_PI_TOOL_NAMES = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "ls"];
const THREAD_TOOL_NAMES = [
  "agents_list",
  "threads_list",
  "threads_history",
  "threads_send",
  "threads_delete",
  "threads_spawn",
  "thread_status",
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
  threadId: string;
  workspaceId?: string;
  channelId?: string;
  threadType?: AgentSendInput["threadType"];
  chatType?: AgentSendInput["chatType"];
  workspaceSlug?: string;
  permissionMode?: AgentSendInput["permissionMode"];
  memoryToolPolicy?: MemoryToolPolicy;
  includeCitations: boolean;
  automationExecution?: boolean;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest: (request: AgentToolPermissionRequest) => void;
}

export interface CreateLumePiToolsOutput {
  customTools: ToolDefinition[];
  availableToolNames: string[];
}

// Plan 模式工具过滤现在由 tool-permission-gate.ts 基于 tool-metadata.ts 处理
// 不再需要硬编码的白名单

export function createLumePiTools(input: CreateLumePiToolsInput): CreateLumePiToolsOutput {
  const enabledMemoryToolNames = resolveEnabledPiMemoryToolNames(input.memoryToolPolicy);
  const enabledMemoryTools = new Set(enabledMemoryToolNames);
  const memoryTools = input.workspaceSlug
    ? createSdkMemoryTools({
      workspaceSlug: input.workspaceSlug,
      enabledTools: enabledMemoryTools,
      includeCitations: input.includeCitations
    })
    : [];
  const sessionTools = createSdkSessionTools({
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    emitSdkMessage: input.emitSdkMessage,
    emitAskUserQuestion: input.emitAskUserQuestion,
    emitToolPermissionRequest: input.emitToolPermissionRequest,
    includeWebTools: false
  });
  // 不再在这里过滤，由 tool-permission-gate.ts 基于 tool-metadata.ts 处理
  const cronTools = createSdkCronTools({
    workspaceId: input.workspaceId,
    sessionId: input.threadId
  });
  const customTools = [...memoryTools, ...sessionTools, ...cronTools];
  const customToolNames = customTools.map((tool) => tool.name);

  return {
    customTools,
    availableToolNames: [
      ...BASE_PI_TOOL_NAMES,
      ...THREAD_TOOL_NAMES,
      ...AUTOMATION_TOOL_NAMES,
      ...customToolNames
    ]
  };
}


