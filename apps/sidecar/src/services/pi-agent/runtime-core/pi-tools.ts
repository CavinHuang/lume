import {
  BashTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  LSPTool,
  NotebookEditTool,
  SkillTool,
  TodoWriteTool,
  type SDKMessage,
  defineTool,
  type ToolDefinition
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentToolPermissionRequest
} from "@lume/shared";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveMemoryRuntimeConfig, shouldIncludeCitations } from "../../memory/memory-policy";
import { createLumePiTools } from "../tools/create-lume-tools";
import { applyPiToolPolicies } from "../tools/permissions/tool-policy";

export interface BuildRuntimeCoreToolsInput {
  cwd: string;
  sessionId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  channelId?: string;
  provider?: string;
  chatType?: AgentSendInput["chatType"];
  threadType?: AgentSendInput["threadType"];
  permissionMode?: AgentSendInput["permissionMode"];
  messageMetadata?: Record<string, unknown>;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}

export interface RuntimeCoreToolset {
  tools: ToolDefinition[];
  availableToolNames: string[];
}

function cloneToolWithName(tool: ToolDefinition, name: string, description?: string): ToolDefinition {
  return {
    ...tool,
    name,
    ...(description ? { description } : {})
  };
}

const ListDirectoryTool = defineTool({
  name: "ls",
  description: "List files and directories in a path.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute or relative directory path. Defaults to current directory."
      }
    }
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    try {
      const targetPath = resolve(context.cwd, typeof input.path === "string" ? input.path : ".");
      const entries = await readdir(targetPath, { withFileTypes: true });
      return {
        data: {
          path: targetPath,
          entries: entries.map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? "dir" : "file"
          }))
        }
      };
    } catch (error) {
      return {
        data: `Error listing directory: ${error instanceof Error ? error.message : String(error)}`,
        is_error: true
      };
    }
  }
});

function createBaseSdkAlignedTools(permissionMode: AgentSendInput["permissionMode"]): ToolDefinition[] {
  const readOnlyTools: ToolDefinition[] = [
    cloneToolWithName(FileReadTool, "read"),
    cloneToolWithName(GlobTool, "find", "Find files by glob pattern."),
    cloneToolWithName(GrepTool, "grep"),
    ListDirectoryTool
  ];

  if (permissionMode === "plan") {
    return [...readOnlyTools, EnterPlanModeTool, ExitPlanModeTool, SkillTool];
  }

  return [
    ...readOnlyTools,
    cloneToolWithName(FileWriteTool, "write"),
    cloneToolWithName(FileEditTool, "edit"),
    cloneToolWithName(BashTool, "bash"),
    NotebookEditTool,
    SkillTool,
    TodoWriteTool,
    LSPTool,
    EnterPlanModeTool,
    ExitPlanModeTool
  ];
}

export function buildRuntimeCoreTools(
  input: BuildRuntimeCoreToolsInput
): RuntimeCoreToolset {
  const permissionMode = input.permissionMode ?? "default";
  const baseTools = createBaseSdkAlignedTools(permissionMode);

  const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
  const includeCitations = shouldIncludeCitations(
    memoryRuntimeConfig.citationsMode,
    input.chatType ?? "direct"
  );
  const automationExecution = isAutomationExecution(input.messageMetadata);
  const lumeTools = createLumePiTools({
    threadId: input.sessionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadType: input.threadType,
    chatType: input.chatType,
    workspaceSlug: input.workspaceSlug,
    permissionMode,
    memoryToolPolicy: memoryRuntimeConfig.toolPolicy,
    includeCitations,
    automationExecution,
    emitSdkMessage: input.emitSdkMessage,
    emitAskUserQuestion: input.emitAskUserQuestion ?? (() => {}),
    emitToolPermissionRequest: input.emitToolPermissionRequest ?? (() => {})
  });

  const policyInput = {
    provider: input.provider,
    threadType: input.threadType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata
  };

  const customTools = applyPiToolPolicies(lumeTools.customTools as unknown as any[], policyInput) as unknown as ToolDefinition[];
  const filteredBaseTools = applyPiToolPolicies(baseTools as unknown as any[], policyInput) as unknown as ToolDefinition[];
  const tools = [...filteredBaseTools, ...customTools];

  return {
    tools,
    availableToolNames: Array.from(new Set(tools.map((tool) => tool.name)))
  };
}

function isAutomationExecution(messageMetadata?: Record<string, unknown>): boolean {
  if (!messageMetadata) {
    return false;
  }
  return typeof messageMetadata.automationJobId === "string"
    || typeof messageMetadata.automationTrigger === "string";
}

