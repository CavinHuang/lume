import {
  createCodingTools,
  createReadOnlyTools,
  type ToolDefinition
} from "@mariozechner/pi-coding-agent";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentToolPermissionRequest
} from "@lume/shared";
import { resolveMemoryRuntimeConfig, shouldIncludeCitations } from "../../memory/memory-policy";
import { createLumePiTools } from "../tools/create-lume-tools";
import { wrapToolsWithPermissionGate } from "../tools/permissions/tool-permission-gate";
import { applyPiToolPolicies } from "../tools/permissions/tool-policy";
import { adaptAgentToolsToToolDefinitions } from "./pi-tool-definition-adapter";

export interface BuildRuntimeCoreToolsInput {
  cwd: string;
  sessionId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  channelId?: string;
  provider?: string;
  chatType?: AgentSendInput["chatType"];
  sessionType?: AgentSendInput["sessionType"];
  permissionMode?: AgentSendInput["permissionMode"];
  messageMetadata?: Record<string, unknown>;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}

export interface RuntimeCoreToolset {
  tools: AgentTool[];
  customTools: ToolDefinition[];
}

export function buildRuntimeCoreTools(
  input: BuildRuntimeCoreToolsInput
): RuntimeCoreToolset {
  const permissionMode = input.permissionMode ?? "default";
  const baseTools = permissionMode === "plan"
    ? createReadOnlyTools(input.cwd)
    : createCodingTools(input.cwd);

  const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
  const includeCitations = shouldIncludeCitations(
    memoryRuntimeConfig.citationsMode,
    input.chatType ?? "direct"
  );
  const automationExecution = isAutomationExecution(input.messageMetadata);
  const lumeTools = createLumePiTools({
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    sessionType: input.sessionType,
    chatType: input.chatType,
    workspaceSlug: input.workspaceSlug,
    permissionMode,
    memoryToolPolicy: memoryRuntimeConfig.toolPolicy,
    includeCitations,
    automationExecution,
    emitAskUserQuestion: input.emitAskUserQuestion ?? (() => {}),
    emitToolPermissionRequest: input.emitToolPermissionRequest ?? (() => {})
  });

  const policyInput = {
    provider: input.provider,
    sessionType: input.sessionType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata
  };
  const gatedInput = {
    sessionId: input.sessionId,
    permissionMode,
    emitToolPermissionRequest: input.emitToolPermissionRequest ?? (() => {})
  };

  const filteredBaseTools = wrapToolsWithPermissionGate(
    applyPiToolPolicies(baseTools, policyInput),
    gatedInput
  );
  const filteredCustomTools = wrapToolsWithPermissionGate(
    applyPiToolPolicies(lumeTools.customTools, policyInput),
    gatedInput
  );

  return {
    tools: filteredBaseTools,
    customTools: adaptAgentToolsToToolDefinitions(filteredCustomTools)
  };
}

function isAutomationExecution(messageMetadata?: Record<string, unknown>): boolean {
  if (!messageMetadata) {
    return false;
  }
  return typeof messageMetadata.automationJobId === "string"
    || typeof messageMetadata.automationTrigger === "string";
}
