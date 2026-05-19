import {
  AskUserQuestionTool,
  AgentTool,
  BashTool,
  createAgent,
  createProvider,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  LSPTool,
  NotebookEditTool,
  registerAgents,
  type SDKMessage,
  type Agent,
  type AgentDefinition,
  type AgentOptions,
  type ApiType,
  type ContentBlockParam,
  type McpServerConfig,
  type ToolContext,
  type ToolResult,
  SkillTool,
  TodoWriteTool,
  defineTool,
  finalizeSubagentOutputFromState,
  summarizeSubagentAssistantEvent,
  type ToolDefinition,
  annotateSubagentStreamingEvent,
  WebFetchTool,
  WebSearchTool
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentSendInput,
  AgentToolPermissionRequest,
  WorkspaceMcpConfig
} from "@lume/shared";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildBuiltinAgents,
  loadCustomAgents
} from "../../agent/agent-prompt-builder";
import { getWorkspaceMcpConfig } from "../../agent/agent-workspace-manager";
import { getDefaultSkillsDir, getWorkspaceSkillsDir } from "../../infra/config-paths";
import { createLogger } from "../../infra/logger";
import { resolveMemoryRuntimeConfig, shouldIncludeCitations } from "../../memory-v2/policy";
import type { MemoryV2RecallItem } from "../../memory-v2/types";
import { decryptApiKey, resolveChannelModelBinding } from "../../channel/channel-manager";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import { createLumeRuntimeTools } from "../tools/create-lume-tools";
import { resolveSubagentSpawnPolicy } from "../../agent/subagents/subagent-policy";
import { getSubagentRunRegistry } from "../../agent/subagents/subagent-run-registry";
import { announceSubagentCompletion } from "../../agent/subagents/subagent-announce-service";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDir,
  hasRuntimeCoreSessionTranscript,
  type RuntimeCoreSessionManager
} from "./session-store";
import { ContextAssembler } from "../context/context-assembler";
import type { ContextAssemblyInput } from "../context/context-assembler";
import { createKernelContextController } from "../context/context-controller";
import { buildRuntimeUserMessageInput } from "./message-attachment-input";
import { createTaskContractWriteTool } from "../plan/task-contract-write-tool";
import { createTaskReportTool } from "../task-run/task-report-tool";
import { ToolRuntime, type ToolRuntimeDiagnostic } from "../tools/tool-runtime";
import {
  clearRuntimeToolDescriptors,
} from "../tools/tool-descriptor-session";
import { clearRuntimeFileAccessLedger } from "../tools/file-access-ledger";
import type { LumeToolDescriptor } from "../tools/tool-types";
import type { TaskContractRecord } from "../plan/task-contract-record-types";

const log = createLogger("runtime-core-prompt");

interface RuntimeCoreResolvedModel {
  id: string;
  provider: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface CreateRuntimeCoreSessionInput {
  lumeSessionId: string;
  cwd: string;
  agentDir: string;
  userMessage?: string;
  provider: string;
  modelRef?: string;
  resolvedModelId: string;
  resolvedModel?: RuntimeCoreResolvedModel;
  apiKey: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  channelId?: string;
  threadType?: AgentSendInput["threadType"];
  subagentType?: string;
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  messageAttachments?: AgentSendInput["messageAttachments"];
  messageMetadata?: Record<string, unknown>;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  emitTaskContractUpdated?: Parameters<typeof createTaskContractWriteTool>[0]["onTaskContractUpdated"];
  runId?: string;
  trace?: ContextAssemblyInput["trace"];
}

export interface RuntimeCoreSessionLike {
  sessionId: string;
  threadId?: string;
  model?: RuntimeCoreResolvedModel;
  messages: Array<{ role: string }>;
  agent: {
    state: {
      systemPrompt: string;
    };
  };
  getActiveToolNames(): string[];
  dispose(): Promise<void>;
}

export interface CreateRuntimeCoreSessionResult {
  agent: Agent;
  session: RuntimeCoreSessionLike;
  sessionManager: RuntimeCoreSessionManager;
  systemPrompt: string;
  userMessageForModel: string | ContentBlockParam[];
  memoryContextUsedItems: MemoryV2RecallItem[];
  tools: ToolDefinition[];
}

interface RuntimeCoreToolset {
  tools: ToolDefinition[];
  availableToolNames: string[];
  descriptorsByCanonicalName: Map<string, LumeToolDescriptor>;
  pluginDiagnostics: ToolRuntimeDiagnostic[];
  mcpDiagnostics: ToolRuntimeDiagnostic[];
}

interface ResolvedSubagentModelOverride {
  source: "input" | "config" | "inherit";
  modelRef?: string;
  channelId?: string;
  resolvedModelId?: string;
  apiType?: ApiType;
  baseUrl?: string;
  apiKey?: string;
}

function normalizeSubagentModelValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "inherit") {
    return undefined;
  }
  return trimmed;
}

export function resolveSubagentModelOverride(input: {
  toolInput: Record<string, unknown>;
  workspaceSlug?: string;
}): ResolvedSubagentModelOverride {
  const requestedModel = normalizeSubagentModelValue(input.toolInput.model);
  const configuredModel = normalizeSubagentModelValue(
    getEffectiveLumeConfig(input.workspaceSlug).models?.subagent?.defaultModelRef
  );

  const candidate = requestedModel ?? configuredModel;
  const source: ResolvedSubagentModelOverride["source"] = requestedModel
    ? "input"
    : configuredModel
      ? "config"
      : "inherit";

  if (!candidate) {
    return { source: "inherit" };
  }

  const binding = resolveChannelModelBinding(candidate, "chat");
  if (!binding) {
    return { source };
  }

  return {
    source,
    modelRef: candidate,
    channelId: binding.channel.id,
    resolvedModelId: binding.modelId,
    apiType: binding.family === "anthropic" ? "anthropic-messages" : "openai-completions",
    baseUrl: binding.channel.baseUrl,
    apiKey: decryptApiKey(binding.channel.id)
  };
}

export function buildSidecarSubagentRunContext(input: {
  parentThreadId: string;
  parentToolUseId?: string;
  toolInput: Record<string, unknown>;
  policy: {
    depth: number;
    rootThreadId: string;
    parentRunId?: string;
  };
  createRunId?: () => string;
  createChildThreadId?: () => string;
}): {
  runId: string;
  childThreadId: string;
  forwardedToolInput: Record<string, unknown>;
  registryInput: {
    runId: string;
    parentThreadId: string;
    parentRunId?: string;
    rootThreadId: string;
    depth: number;
    childThreadId: string;
    parentToolUseId?: string;
    task: string;
    label?: string;
    cleanup: "keep";
    requestedAgentId?: string;
    resolvedAgentId?: string;
    status: "running";
  };
} {
  const runId = input.createRunId?.() ?? crypto.randomUUID();
  const childThreadId = input.createChildThreadId?.() ?? crypto.randomUUID();
  const task = typeof input.toolInput.prompt === "string" ? input.toolInput.prompt : "";
  const label = typeof input.toolInput.description === "string" ? input.toolInput.description : undefined;
  const agentId = typeof input.toolInput.subagent_type === "string" ? input.toolInput.subagent_type : undefined;

  return {
    runId,
    childThreadId,
    forwardedToolInput: {
      ...input.toolInput,
      subagent_run_id: runId
    },
    registryInput: {
      runId,
      parentThreadId: input.parentThreadId,
      parentRunId: input.policy.parentRunId,
      rootThreadId: input.policy.rootThreadId,
      depth: input.policy.depth,
      childThreadId,
      parentToolUseId: input.parentToolUseId,
      task,
      label,
      cleanup: "keep",
      requestedAgentId: agentId,
      resolvedAgentId: agentId,
      status: "running"
    }
  };
}

export function buildSidecarSubagentExecutionInput(input: {
  forwardedToolInput: Record<string, unknown>;
  modelOverride: ResolvedSubagentModelOverride;
  runInBackground: boolean;
}): Record<string, unknown> {
  return {
    ...input.forwardedToolInput,
    run_in_background: input.runInBackground,
    isolation: undefined,
    ...(input.modelOverride.resolvedModelId ? { model: input.modelOverride.resolvedModelId } : {})
  };
}

async function runSidecarSubagent(input: {
  toolInput: Record<string, unknown>;
  context: ToolContext;
  runId: string;
  childThreadId: string;
  parentThreadId: string;
  deliveryThreadId: string;
  parentToolUseId?: string;
  subagentType?: string;
  modelOverride: ResolvedSubagentModelOverride;
  channelId?: string;
  workspaceId?: string;
  chatType?: AgentSendInput["chatType"];
  messageMetadata?: Record<string, unknown>;
  permissionMode?: AgentSendInput["permissionMode"];
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}): Promise<{
  result: ToolResult;
  status: "completed" | "errored" | "aborted";
  output?: string;
  error?: string;
}> {
  const prompt = typeof input.toolInput.prompt === "string" ? input.toolInput.prompt : "";
  const subagentType = typeof input.toolInput.subagent_type === "string"
    ? input.toolInput.subagent_type
    : input.subagentType;
  const resolvedChannelId = input.modelOverride.channelId ?? input.channelId;
  const resolvedModelId = input.modelOverride.resolvedModelId ?? input.context.model;
  if (!resolvedChannelId || !resolvedModelId) {
    return {
      status: "errored",
      error: "subagent 缺少 channelId/modelId",
      result: {
        type: "tool_result",
        tool_use_id: "",
        content: "Subagent error: subagent 缺少 channelId/modelId",
        is_error: true
      }
    };
  }

  const { runAgentRuntime } = await import("./attempt");
  const forwardEvent = input.context.emitEvent ?? (() => undefined);
  const childPermissionMode = (
    typeof input.toolInput.mode === "string"
      ? input.toolInput.mode
      : input.permissionMode
  ) as AgentSendInput["permissionMode"] | undefined;
  let textOutput = "";
  let lastAssistantMessage = "";
  const toolCalls: string[] = [];
  let subagentStatus: "completed" | "errored" | "aborted" = "completed";
  let subagentErrorMessage = "";

  const runtimeResult = await runAgentRuntime({
    input: {
      threadId: input.childThreadId,
      userMessage: prompt,
      ...(input.modelOverride.modelRef ? { modelRef: input.modelOverride.modelRef } : {}),
      channelId: resolvedChannelId,
      modelId: resolvedModelId,
      workspaceId: input.workspaceId,
      chatType: input.chatType,
      threadType: "subagent",
      permissionMode: childPermissionMode,
      messageMetadata: input.messageMetadata
    },
    runtime: {
      sessionId: input.childThreadId,
      deliveryThreadId: input.deliveryThreadId,
      subagentRunId: input.runId,
      ...(subagentType ? { subagentType } : {}),
      ...(input.modelOverride.modelRef ? { modelRef: input.modelOverride.modelRef } : {}),
      channelId: resolvedChannelId,
      resolvedModelId,
      workspaceId: input.workspaceId,
      threadType: "subagent"
    }
  }, {
    onSdkMessage: (message) => {
      if (message.type === "assistant") {
        const summary = summarizeSubagentAssistantEvent(
          message.message.content as Array<Record<string, unknown>>,
          textOutput,
          toolCalls
        );
        textOutput = summary.textOutput;
        lastAssistantMessage = summary.lastAssistantMessage || lastAssistantMessage;
        toolCalls.length = 0;
        toolCalls.push(...summary.toolCalls);
      }
      if (message.type === "result") {
        if (typeof message.result === "string" && message.result.trim()) {
          textOutput = textOutput
            ? `${textOutput}\n\n${message.result.trim()}`
            : message.result.trim();
          lastAssistantMessage = message.result.trim();
        }
        const errorText = [
          ...(Array.isArray(message.errors) ? message.errors : []),
          typeof message.result === "string" ? message.result : "",
        ].find((value) => typeof value === "string" && value.trim().length > 0);
        if (message.is_error || (typeof message.subtype === "string" && message.subtype !== "success")) {
          subagentStatus = "errored";
          if (errorText) {
            subagentErrorMessage = errorText.trim();
          }
        }
      }

      const taggedEvent = annotateSubagentStreamingEvent(message as SDKMessage, {
        subagentRunId: input.runId,
        parentSessionId: input.deliveryThreadId,
        parentToolUseId: input.parentToolUseId
      });
      if (taggedEvent) {
        forwardEvent(taggedEvent);
      }
    },
    onComplete: () => undefined,
    onError: (error) => {
      subagentStatus = "errored";
      subagentErrorMessage = error;
    },
    onAskUserQuestion: input.emitAskUserQuestion ?? (() => undefined),
    onToolPermissionRequest: input.emitToolPermissionRequest ?? (() => undefined)
  });

  if (runtimeResult.status === "errored") {
    subagentStatus = "errored";
    if (runtimeResult.errorMessage) {
      subagentErrorMessage = runtimeResult.errorMessage;
    }
  }
  if (runtimeResult.status === "aborted") {
    subagentStatus = "aborted";
  }

  const finalized = finalizeSubagentOutputFromState({
    textOutput,
    toolCalls,
    lastAssistantMessage,
    errorMessage: subagentErrorMessage,
    status: subagentStatus
  });

  return {
    status: subagentStatus,
    output: finalized.output,
    ...(subagentErrorMessage ? { error: subagentErrorMessage } : {}),
    result: {
      type: "tool_result",
      tool_use_id: "",
      content: finalized.output,
      ...(subagentStatus !== "completed" ? { is_error: true } : {})
    }
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

function createBaseSdkAlignedTools(
  permissionMode: AgentSendInput["permissionMode"],
  options: { includeAskUserQuestion: boolean }
): ToolDefinition[] {
  const readOnlyTools: ToolDefinition[] = [
    FileReadTool,
    GlobTool,
    GrepTool,
    ListDirectoryTool,
    WebSearchTool,
    WebFetchTool
  ];

  if (permissionMode === "plan") {
    return [
      ...readOnlyTools,
      ...(options.includeAskUserQuestion ? [AskUserQuestionTool] : []),
      SkillTool
    ];
  }

  return [
    ...readOnlyTools,
    ...(options.includeAskUserQuestion ? [AskUserQuestionTool] : []),
    FileWriteTool,
    FileEditTool,
    BashTool,
    NotebookEditTool,
    SkillTool,
    TodoWriteTool,
    LSPTool
  ];
}

function buildRuntimeCoreTools(input: {
  cwd: string;
  sessionId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  channelId?: string;
  provider?: string;
  chatType?: AgentSendInput["chatType"];
  threadType?: AgentSendInput["threadType"];
  permissionMode?: AgentSendInput["permissionMode"];
  subagentDefinition?: AgentDefinition;
  messageMetadata?: Record<string, unknown>;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  emitTaskContractUpdated?: (contract: TaskContractRecord) => void;
  runId?: string;
  pluginDiagnostics?: ToolRuntimeDiagnostic[];
}): RuntimeCoreToolset {
  const permissionMode = input.permissionMode ?? "default";
  const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
  const includeCitations = shouldIncludeCitations(
    memoryRuntimeConfig.citationsMode,
    input.chatType ?? "direct"
  );
  const automationExecution = isAutomationExecution(input.messageMetadata);
  const baseTools = createBaseSdkAlignedTools(permissionMode, {
    includeAskUserQuestion: automationExecution !== true
  });
  const planWriteTool = createTaskContractWriteTool({
    sessionDir: getRuntimeCoreSessionDir(input.sessionId),
    threadId: input.sessionId,
    runId: input.runId ?? input.sessionId,
    ...(input.workspaceSlug ? { threadWorkspaceDir: input.cwd } : {}),
    onTaskContractUpdated: input.emitTaskContractUpdated
  });
  const taskReportTool = createTaskReportTool({
    sessionDir: getRuntimeCoreSessionDir(input.sessionId),
    threadId: input.sessionId
  });
  const lumeTools = createLumeRuntimeTools({
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
    workspaceSlug: input.workspaceSlug,
    threadType: input.threadType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata
  };

  const sidecarAgentTool: ToolDefinition = {
    ...AgentTool,
    isConcurrencySafe: () => true,
    async call(toolInput: any, context: any) {
      const parentThreadId = context.sessionId ?? "";
      const policy = resolveSubagentSpawnPolicy({
        parentThreadId,
        parentPermissionMode: toolInput.mode
      });
      if (!policy.ok) {
        return { type: "tool_result" as const, tool_use_id: "", content: policy.error ?? "spawn policy rejected", is_error: true };
      }
      const subagentRun = buildSidecarSubagentRunContext({
        parentThreadId,
        parentToolUseId: context.toolUseId,
        toolInput,
        policy
      });
      const modelOverride = resolveSubagentModelOverride({
        toolInput,
        workspaceSlug: input.workspaceSlug
      });
      const enrichedContext = {
        ...context,
        emitEvent: input.emitSdkMessage
          ? (event: SDKMessage) => { input.emitSdkMessage!(event); }
          : context.emitEvent,
        onSubagentEnd: async ({ status, output, error }: { status: "completed" | "errored" | "aborted"; output?: string; error?: string }) => {
          getSubagentRunRegistry().update(subagentRun.runId, { status, outcome: { output, error } });
          const run = getSubagentRunRegistry().get(subagentRun.runId);
          if (run) await announceSubagentCompletion({ run });
        }
      };
      const runInBackground = toolInput.run_in_background === true;
      const executionInput = buildSidecarSubagentExecutionInput({
        forwardedToolInput: subagentRun.forwardedToolInput,
        modelOverride,
        runInBackground
      });
      getSubagentRunRegistry().create({
        ...subagentRun.registryInput,
        deliveryThreadId: parentThreadId,
        parentToolUseId: context.toolUseId,
        ...(modelOverride.modelRef ? { modelRef: modelOverride.modelRef } : {}),
        ...(modelOverride.channelId ? { channelId: modelOverride.channelId } : input.channelId ? { channelId: input.channelId } : {}),
        ...(modelOverride.resolvedModelId ? { modelId: modelOverride.resolvedModelId } : context.model ? { modelId: context.model } : {})
      });
      const executeSubagent = () => runSidecarSubagent({
        toolInput: executionInput,
        context: enrichedContext,
        runId: subagentRun.runId,
        childThreadId: subagentRun.childThreadId,
        parentThreadId,
        deliveryThreadId: parentThreadId,
        parentToolUseId: context.toolUseId,
        subagentType: subagentRun.registryInput.resolvedAgentId,
        modelOverride,
        channelId: input.channelId,
        workspaceId: input.workspaceId,
        chatType: input.chatType,
        messageMetadata: input.messageMetadata,
        permissionMode,
        emitAskUserQuestion: input.emitAskUserQuestion,
        emitToolPermissionRequest: input.emitToolPermissionRequest
      });
      if (runInBackground) {
        void executeSubagent()
          .then(async (execution) => {
            await enrichedContext.onSubagentEnd?.({
              runId: subagentRun.runId,
              status: execution.status,
              output: execution.output,
              error: execution.error
            });
          })
          .catch(async (err: any) => {
            getSubagentRunRegistry().update(subagentRun.runId, {
              status: "errored",
              outcome: { error: err?.message ?? String(err) }
            });
            const run = getSubagentRunRegistry().get(subagentRun.runId);
            if (run) await announceSubagentCompletion({ run });
          });
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: `Background subagent started: ${subagentRun.runId}`
        };
      }
      try {
        const execution = await executeSubagent();
        await enrichedContext.onSubagentEnd?.({
          runId: subagentRun.runId,
          status: execution.status,
          output: execution.output,
          error: execution.error
        });
        return execution.result;
      } catch (err: any) {
        getSubagentRunRegistry().update(subagentRun.runId, { status: "errored", outcome: { error: err.message } });
        throw err;
      }
    }
  };

  return ToolRuntime.build({
    cwd: input.cwd,
    sessionId: input.sessionId,
    permissionMode,
    threadType: input.threadType,
    subagentDefinition: input.subagentDefinition,
    messageMetadata: input.messageMetadata,
    policyInput,
    pluginDiagnostics: input.pluginDiagnostics,
    groups: [
      { source: "sdk", tools: baseTools },
      ...(permissionMode === "plan" ? [{ source: "plan" as const, tools: [planWriteTool] }] : []),
      { source: "task", tools: [taskReportTool, sidecarAgentTool] },
      { source: "lume", tools: lumeTools.customTools as ToolDefinition[] }
    ]
  });
}

function resolveSdkApiType(provider: string): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (normalized === "deepseek") {
    return "deepseek-chat-completions";
  }
  return "openai-completions";
}

function buildMcpServers(workspaceSlug?: string): Record<string, McpServerConfig> | undefined {
  if (!workspaceSlug) {
    return undefined;
  }
  const config = getWorkspaceMcpConfig(workspaceSlug);
  return mapWorkspaceMcpConfig(config);
}

function mapWorkspaceMcpConfig(config: WorkspaceMcpConfig): Record<string, McpServerConfig> | undefined {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(config.servers ?? {})) {
    if (!entry.enabled) continue;
    if (entry.type === "stdio" && entry.command) {
      servers[name] = {
        type: "stdio",
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.env ? { env: entry.env } : {})
      };
      continue;
    }
    if ((entry.type === "http" || entry.type === "sse") && entry.url) {
      servers[name] = {
        type: entry.type,
        url: entry.url,
        ...(entry.headers ? { headers: entry.headers } : {})
      };
    }
  }
  return Object.keys(servers).length > 0 ? servers : undefined;
}

function isAutomationExecution(messageMetadata?: Record<string, unknown>): boolean {
  if (!messageMetadata) {
    return false;
  }
  return typeof messageMetadata.automationJobId === "string"
    || typeof messageMetadata.automationTrigger === "string";
}

function resolveSkillDirectories(workspaceSlug?: string): string[] {
  const roots = [getDefaultSkillsDir()];
  if (workspaceSlug) {
    roots.push(getWorkspaceSkillsDir(workspaceSlug));
  }
  return roots;
}

function estimateToolSchemaTokens(tools: ToolDefinition[]): number {
  return tools.reduce((sum, tool) =>
    sum + Math.ceil((tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema ?? {}).length) / 4),
  0);
}

export async function createRuntimeCoreSession(
  input: CreateRuntimeCoreSessionInput
): Promise<CreateRuntimeCoreSessionResult> {
  const sessionManager = createOrResumeRuntimeCoreSessionManager(input.cwd, input.lumeSessionId, input.agentDir);
  const agents = { ...buildBuiltinAgents(), ...loadCustomAgents(input.workspaceSlug) };
  const subagentDefinition = input.subagentType ? agents[input.subagentType] : undefined;
  const pluginResolution = ToolRuntime.resolveCommandPluginSpecs({
    cwd: input.cwd,
    workspaceSlug: input.workspaceSlug
  });
  const toolset = buildRuntimeCoreTools({
    cwd: input.cwd,
    sessionId: input.lumeSessionId,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    channelId: input.channelId,
    provider: input.provider,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    subagentDefinition,
    messageMetadata: input.messageMetadata,
    emitSdkMessage: input.emitSdkMessage,
    emitAskUserQuestion: input.emitAskUserQuestion,
    emitToolPermissionRequest: input.emitToolPermissionRequest,
    emitTaskContractUpdated: input.emitTaskContractUpdated,
    runId: input.runId,
    pluginDiagnostics: pluginResolution.diagnostics
  });

  const contextAssembly = await new ContextAssembler().assemble({
    threadId: input.lumeSessionId,
    runId: input.lumeSessionId,
    cwd: input.cwd,
    modelRef: input.modelRef,
    resolvedModelId: input.resolvedModel?.id ?? input.resolvedModelId,
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    agentSystemPrompt: subagentDefinition?.prompt,
    userMessage: input.userMessage ?? "",
    messageAttachments: input.messageAttachments,
    availableTools: toolset.availableToolNames,
    tokenBudget: input.resolvedModel?.contextWindow ?? 32_000,
    trace: input.trace
  });
  const systemPrompt = contextAssembly.systemPrompt;
  const context = sessionManager.buildSessionContext();

  const agentOptions: AgentOptions = {
    apiType: resolveSdkApiType(input.provider),
    apiKey: input.apiKey,
    ...(input.resolvedModel?.baseUrl ? { baseURL: input.resolvedModel.baseUrl } : {}),
    model: input.resolvedModel?.id ?? input.resolvedModelId,
    cwd: input.cwd,
    systemPrompt,
    tools: toolset.tools,
    sessionId: input.lumeSessionId,
    ...(hasRuntimeCoreSessionTranscript(input.lumeSessionId, input.agentDir)
      ? { resume: input.lumeSessionId }
      : {}),
    ...(buildMcpServers(input.workspaceSlug) ? { mcpServers: buildMcpServers(input.workspaceSlug) } : {}),
    plugins: pluginResolution.specs,
    agents,
    permissionMode: input.permissionMode === "bypassPermissions" ? "bypassPermissions" : "default",
    includePartialMessages: true,
    skillsDirectories: resolveSkillDirectories(input.workspaceSlug),
    resolveRuntimeTools: (tools) => ToolRuntime.resolveDynamicTools({
      tools,
      cwd: input.cwd,
      sessionId: input.lumeSessionId,
      permissionMode: input.permissionMode,
      messageMetadata: input.messageMetadata,
      policyInput: {
        provider: input.provider,
        workspaceSlug: input.workspaceSlug,
        threadType: input.threadType,
        chatType: input.chatType,
        messageMetadata: input.messageMetadata
      }
    }),
    additionalDirectories: input.workspaceSlug ? [input.cwd] : undefined,
    contextController: createKernelContextController({
      threadId: input.lumeSessionId,
      model: input.resolvedModel?.id ?? input.resolvedModelId,
      contextWindow: input.resolvedModel?.contextWindow ?? 32_000,
      systemPrompt,
      memoryContext: contextAssembly.memoryContext,
      sessionMessages: context.messages,
      toolSchemaTokens: estimateToolSchemaTokens(toolset.tools)
    }),
    persistSession: true
  };

  const agent = createAgent(agentOptions);
  await agent.getInitializationResult();
  const resolvedTools = getResolvedAgentTools(agent, toolset.tools);

  const session: RuntimeCoreSessionLike = {
    sessionId: input.lumeSessionId,
    threadId: input.lumeSessionId,
    model: input.resolvedModel ?? {
      id: input.resolvedModelId,
      provider: input.provider
    },
    messages: context.messages.map((message) => ({ role: message.role })),
    agent: {
      state: {
        systemPrompt
      }
    },
    getActiveToolNames() {
      return resolvedTools.map((tool) => tool.name);
    },
    async dispose() {
      await agent.close();
      clearRuntimeToolDescriptors(input.lumeSessionId);
      clearRuntimeFileAccessLedger(input.lumeSessionId);
    }
  };

  const userMessageForModel = buildRuntimeUserMessageInput({
    userMessage: contextAssembly.userMessageForModel,
    attachments: input.messageAttachments,
    provider: input.provider,
    workspaceSlug: input.workspaceSlug,
    threadId: input.lumeSessionId
  });

  return {
    agent,
    session,
    sessionManager,
    systemPrompt,
    userMessageForModel,
    memoryContextUsedItems: contextAssembly.memoryContextUsedItems,
    tools: resolvedTools
  };
}

function getResolvedAgentTools(agent: Agent, fallback: ToolDefinition[]): ToolDefinition[] {
  const tools = (agent as unknown as { toolPool?: ToolDefinition[] }).toolPool;
  return Array.isArray(tools) ? tools : fallback;
}
