import type { SDKMessage, ToolDefinition } from "@lume/agent-sdk";
import type { AgentAskUserQuestionRequest, AgentToolPermissionRequest } from "@lume/shared";
import type { AgentSendInput } from "@lume/shared";
import type { MemoryToolPolicy } from "../../memory/memory-policy";
import { createSdkMemoryTools } from "./memory/create-memory-tools";
import { createSdkCronTools } from "./cron/create-cron-tools";
import { resolveEnabledMemoryToolNames } from "./tool-policy-matcher";

const BASE_RUNTIME_TOOL_NAMES = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "ls"];
const AUTOMATION_TOOL_NAMES = [
  "automation_read",
  "automation_set",
  "automation_query"
];

export interface CreateLumeRuntimeToolsInput {
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

export interface CreateLumeRuntimeToolsOutput {
  customTools: ToolDefinition[];
  availableToolNames: string[];
}

export function createLumeRuntimeTools(input: CreateLumeRuntimeToolsInput): CreateLumeRuntimeToolsOutput {
  const enabledMemoryToolNames = resolveEnabledMemoryToolNames(input.memoryToolPolicy);
  const enabledMemoryTools = new Set(enabledMemoryToolNames);
  const memoryTools = input.workspaceSlug
    ? createSdkMemoryTools({
      workspaceSlug: input.workspaceSlug,
      enabledTools: enabledMemoryTools,
      includeCitations: input.includeCitations
    })
    : [];
  const cronTools = createSdkCronTools({
    workspaceId: input.workspaceId,
    sessionId: input.threadId
  });
  const customTools = [...memoryTools, ...cronTools];
  const customToolNames = customTools.map((tool) => tool.name);

  return {
    customTools,
    availableToolNames: [
      ...BASE_RUNTIME_TOOL_NAMES,
      ...AUTOMATION_TOOL_NAMES,
      ...customToolNames
    ]
  };
}
