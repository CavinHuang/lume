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
  registerSkill,
  unregisterSkill,
  getSkill,
  hasSkill,
  type SDKMessage,
  type Agent,
  type AgentDefinition,
  type AgentOptions,
  type ApiType,
  type ContentBlockParam,
  type ToolContext,
  type ToolResult,
  SkillTool,
  createTodoTool,
  defineTool,
  finalizeSubagentOutputFromState,
  summarizeSubagentAssistantEvent,
  type ToolDefinition,
  annotateSubagentStreamingEvent
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentBrowserAuthRequest,
  AgentDesktopActionRequest,
  AgentSendInput,
  AgentToolPermissionRequest,
  LumeRuntimeEvent
} from "@lume/shared";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  buildBuiltinAgents,
  loadCustomAgents,
  type EnabledPluginContextItem
} from "../../agent/agent-prompt-builder";
import {
  getAliceUserSkillsDir,
  getDefaultSkillsDir,
  getUserSkillsDir,
  getWorkspaceSkillsDir
} from "../../infra/config-paths";
import { createLogger } from "../../infra/logger";
import { getWorkspaceMcpManager } from "../../mcp/workspace-mcp-manager";
import { resolveMemoryRuntimeConfig, shouldIncludeCitations } from "../../memory-v2/policy";
import type { MemoryV2RecallItem } from "../../memory-v2/types";
import { decryptApiKey, resolveChannelModelBinding } from "../../channel/channel-manager";
import { getEffectiveLumeConfig, getEffectivePluginRuntimeConfig } from "../../system/lume-config-service";
import { createLumeRuntimeTools } from "../tools/create-lume-tools";
import { createSdkWebTools } from "../tools/web/create-web-tools";
import { resolveSubagentSpawnPolicy } from "../../agent/subagents/subagent-policy";
import { getSubagentRunRegistry } from "../../agent/subagents/subagent-run-registry";
import { announceSubagentCompletion } from "../../agent/subagents/subagent-announce-service";
import { createAgentThreadWithModelRef, getAgentThreadMeta, updateAgentThreadMeta } from "../../agent/agent-thread-manager";
import {
  createOrResumeRuntimeCoreSessionManager,
  getRuntimeCoreSessionDir,
  hasRuntimeCoreSessionTranscript,
  type RuntimeCoreSessionManager
} from "./session-store";
import { ContextAssembler } from "../context/context-assembler";
import type { ContextAssemblyInput } from "../context/context-assembler";
import { resolveDesktopContextProjection } from "../../desktop-context/desktop-context-runtime";
import { createKernelContextController } from "../context/context-controller";
import { buildRuntimeUserMessageInput } from "./message-attachment-input";
import { createTaskContractWriteTool } from "../plan/task-contract-write-tool";
import { createTaskReportTool } from "../task-run/task-report-tool";
import { ToolRuntime, type ToolRuntimeDiagnostic } from "../tools/tool-runtime";
import { SidecarPluginManager } from "../plugins/plugin-manager.js";
import { assemblePluginRuntime, type PluginRuntimeAssembly } from "../plugins/runtime-bridge.js";
import type { RegisteredPlugin } from "../plugins/plugin-registry.js";
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import { DEFAULT_PLUGIN_STATE_PATH, FilePluginStateStore } from "../plugins/plugin-state-store.js";
import { buildPluginAgentHooks } from "../plugins/plugin-hooks-bridge.js";
import {
  buildPluginMcpManager,
  buildPluginIdIndex,
  PLUGIN_MCP_WORKSPACE_SLUG,
} from "../plugins/plugin-mcp-bridge.js";
import {
  clearRuntimeToolDescriptors,
} from "../tools/tool-descriptor-session";
import { clearRuntimeFileAccessLedger } from "../tools/file-access-ledger";
import { getNodeReplRuntimeRegistry } from "../tools/node-repl/node-repl-runtime-registry";
import {
  createPluginAwareMcpResourceTools,
  replaceMcpResourceTools,
} from "./mcp-resource-router.js";
import type { LumeToolDescriptor } from "../tools/tool-types";
import type { TaskContractRecord } from "../plan/task-contract-record-types";
import {
  collectAppendContextEffects,
  type LumeWorkflowHookExecutionResult
} from "../../workflow-hooks/hook-effects";
import type { LumeWorkflowHookRuntimeLike } from "../../workflow-hooks/hook-runtime";
import type { LumeWorkflowHookEvent } from "../../workflow-hooks/hook-events";

const log = createLogger("runtime-core-prompt");
const DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;

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
  attachedDirectories?: string[];
  messageMetadata?: Record<string, unknown>;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  emitTaskContractUpdated?: Parameters<typeof createTaskContractWriteTool>[0]["onTaskContractUpdated"];
  emitTodoUpdated?: Parameters<typeof createTodoTool>[0]["onTodoUpdated"];
  runId?: string;
  workflowHooks?: LumeWorkflowHookRuntimeLike;
  applyWorkflowHookEffects?: (result: LumeWorkflowHookExecutionResult) => Promise<void> | void;
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
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}): Promise<{
  result: ToolResult;
  status: "completed" | "errored" | "aborted" | "timed_out";
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
    onBrowserAuthRequest: input.emitBrowserAuthRequest ?? (() => undefined),
    onDesktopActionRequest: input.emitDesktopActionRequest,
    onRuntimeEvent: input.emitRuntimeEvent,
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

export async function runForegroundSubagentWithTimeout(input: {
  execution: Promise<{
    result: ToolResult;
    status: "completed" | "errored" | "aborted" | "timed_out";
    output?: string;
    error?: string;
  }>;
  childThreadId: string;
  timeoutMs: number;
  stopSubagent: (threadId: string) => Promise<boolean>;
}): Promise<{
  result: ToolResult;
  status: "completed" | "errored" | "aborted" | "timed_out";
  output?: string;
  error?: string;
}> {
  if (input.timeoutMs <= 0) {
    return input.execution;
  }

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{
    result: ToolResult;
    status: "timed_out";
    output: string;
    error: string;
  }>((resolve) => {
    timeoutId = setTimeout(async () => {
      timedOut = true;
      await input.stopSubagent(input.childThreadId).catch(() => false);
      const error = `Subagent timed out after ${input.timeoutMs}ms and was cancelled.`;
      resolve({
        status: "timed_out",
        output: error,
        error,
        result: {
          type: "tool_result",
          tool_use_id: "",
          content: error,
          is_error: true
        }
      });
    }, input.timeoutMs);
    if (typeof timeoutId === "object" && "unref" in timeoutId && typeof timeoutId.unref === "function") {
      timeoutId.unref();
    }
  });

  const result = await Promise.race([input.execution, timeout]);
  if (!timedOut && timeoutId) {
    clearTimeout(timeoutId);
  }
  if (timedOut) {
    input.execution.catch(() => undefined);
  }
  return result;
}

function resolveForegroundSubagentTimeoutMs(): number {
  const raw = process.env.LUME_SUBAGENT_FOREGROUND_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS;
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
    ...createSdkWebTools()
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
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  emitTaskContractUpdated?: (contract: TaskContractRecord) => void;
  emitTodoUpdated?: Parameters<typeof createTodoTool>[0]["onTodoUpdated"];
  runId?: string;
  pluginDiagnostics?: ToolRuntimeDiagnostic[];
  mcpTools?: ToolDefinition[];
  mcpDiagnostics?: ToolRuntimeDiagnostic[];
  /** Plugin command-tool ToolDefinitions built by PluginRuntimeBridge (Phase 3b). */
  pluginCommandTools?: ToolDefinition[];
  /** Plugin MCP tool definitions (Phase MCP Merge-A) from the plugin-scoped MCP manager. */
  pluginMcpTools?: ToolDefinition[];
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
  const todoTool = createTodoTool({
    threadId: input.sessionId,
    onTodoUpdated: input.emitTodoUpdated,
  });
  const lumeTools = createLumeRuntimeTools({
    threadId: input.sessionId,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    threadType: input.threadType,
    chatType: input.chatType,
    workspaceSlug: input.workspaceSlug,
    permissionMode,
    memoryToolPolicy: memoryRuntimeConfig.toolPolicy,
    includeCitations,
    automationExecution,
    runId: input.runId,
    emitSdkMessage: input.emitSdkMessage,
    emitAskUserQuestion: input.emitAskUserQuestion ?? (() => {}),
    emitBrowserAuthRequest: input.emitBrowserAuthRequest,
    emitDesktopActionRequest: input.emitDesktopActionRequest,
    emitDesktopActionVisualEvent: input.emitRuntimeEvent,
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
      const modelOverride = resolveSubagentModelOverride({
        toolInput,
        workspaceSlug: input.workspaceSlug
      });
      // ★ 与 Delegate 对齐：创建会话栏可见的子会话 thread（带 parentThreadId），
      // 使 Task 派生的 subagent 在左侧栏母会话下显示为子会话节点。
      const childMeta = createAgentThreadWithModelRef(
        resolveTaskThreadInitialTitle(toolInput),
        modelOverride.modelRef,
        modelOverride.channelId ?? input.channelId,
        input.workspaceId,
        parentThreadId,
        modelOverride.resolvedModelId ?? context.model
      );
      const subagentRun = buildSidecarSubagentRunContext({
        parentThreadId,
        parentToolUseId: context.toolUseId,
        toolInput,
        policy,
        createChildThreadId: () => childMeta.id
      });
      const enrichedContext = {
        ...context,
        emitEvent: input.emitSdkMessage
          ? (event: SDKMessage) => { input.emitSdkMessage!(event); }
          : context.emitEvent,
        onSubagentEnd: async ({ status, output, error }: { status: "completed" | "errored" | "aborted" | "timed_out"; output?: string; error?: string }) => {
          getSubagentRunRegistry().update(subagentRun.runId, { status, outcome: { output, error } });
          const run = getSubagentRunRegistry().get(subagentRun.runId);
          if (run) await announceSubagentCompletion({ run });
          // 子会话完成时用输出摘要派生标题（与 Delegate 对齐）
          const newTitle = deriveDelegateTitle(childMeta.title, output);
          if (newTitle && newTitle !== childMeta.title) {
            updateAgentThreadMeta(childMeta.id, { title: newTitle });
          }
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
        emitBrowserAuthRequest: input.emitBrowserAuthRequest,
        emitDesktopActionRequest: input.emitDesktopActionRequest,
        emitRuntimeEvent: input.emitRuntimeEvent,
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
        const execution = await runForegroundSubagentWithTimeout({
          execution: executeSubagent(),
          childThreadId: subagentRun.childThreadId,
          timeoutMs: resolveForegroundSubagentTimeoutMs(),
          stopSubagent: async (threadId) => {
            const { stopAgentRuntime } = await import("./attempt");
            return stopAgentRuntime(threadId);
          }
        });
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

  const delegateTool: ToolDefinition = {
    ...AgentTool,
    name: "Delegate",
    description:
      "Delegate a task to an INDEPENDENT, sidebar-visible child session. Use for long-running or important tasks that should be tracked as their own conversation. The child session appears under the parent in the sidebar. Returns the child's final result. Only one level of delegation is allowed. Set run_in_background=true to start the child asynchronously and return immediately with a delegationId; later collect results with WaitForDelegations.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task for the delegated child session" },
        description: { type: "string", description: "A short (3-5 word) description of the task" },
        thread_title: { type: "string", description: "Optional title for the child session (defaults to description)" },
        subagent_type: { type: "string" },
        model: { type: "string" },
        mode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"] },
        run_in_background: { type: "boolean", description: "If true, start the child session asynchronously and return immediately with a delegationId. Use WaitForDelegations to collect results later." }
      },
      required: ["prompt", "description"]
    },
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
      // D7: 仅允许一级 delegate —— 当前父 thread 若已是某 subagent run 的 child，拒绝
      const depthGuard = canDelegateFromThread(parentThreadId);
      if (!depthGuard.ok) {
        return { type: "tool_result" as const, tool_use_id: "", content: depthGuard.error ?? "depth rejected", is_error: true };
      }
      const modelOverride = resolveSubagentModelOverride({
        toolInput,
        workspaceSlug: input.workspaceSlug
      });
      // ★ 关键差异：创建会话栏可见的子会话 thread（带 parentThreadId）
      const childMeta = createAgentThreadWithModelRef(
        typeof toolInput.thread_title === "string" ? toolInput.thread_title
          : typeof toolInput.description === "string" ? toolInput.description : undefined,
        modelOverride.modelRef,
        modelOverride.channelId ?? input.channelId,
        input.workspaceId,
        parentThreadId,
        modelOverride.resolvedModelId ?? context.model
      );
      const subagentRun = buildSidecarSubagentRunContext({
        parentThreadId,
        parentToolUseId: context.toolUseId,
        toolInput,
        policy,
        createChildThreadId: () => childMeta.id
      });
      const enrichedContext = {
        ...context,
        emitEvent: input.emitSdkMessage
          ? (event: SDKMessage) => { input.emitSdkMessage!(event); }
          : context.emitEvent,
        onSubagentEnd: async ({ status, output, error }: { status: "completed" | "errored" | "aborted" | "timed_out"; output?: string; error?: string }) => {
          getSubagentRunRegistry().update(subagentRun.runId, { status, outcome: { output, error } });
          const run = getSubagentRunRegistry().get(subagentRun.runId);
          if (run) await announceSubagentCompletion({ run });
          const newTitle = deriveDelegateTitle(childMeta.title, output);
          if (newTitle && newTitle !== childMeta.title) {
            updateAgentThreadMeta(childMeta.id, { title: newTitle });
          }
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
        threadBound: true,
        ...(modelOverride.modelRef ? { modelRef: modelOverride.modelRef } : {}),
        ...(modelOverride.channelId ? { channelId: modelOverride.channelId } : input.channelId ? { channelId: input.channelId } : {}),
        ...(modelOverride.resolvedModelId ? { modelId: modelOverride.resolvedModelId } : context.model ? { modelId: context.model } : {})
      });
      const executeSubagent = () => runSidecarSubagent({
        toolInput: executionInput,
        context: enrichedContext,
        runId: subagentRun.runId,
        childThreadId: childMeta.id,
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
        emitBrowserAuthRequest: input.emitBrowserAuthRequest,
        emitDesktopActionRequest: input.emitDesktopActionRequest,
        emitRuntimeEvent: input.emitRuntimeEvent,
        emitToolPermissionRequest: input.emitToolPermissionRequest
      });
      if (runInBackground) {
        // ★ 注册 completion 信号量，供 WaitForDelegations 感知完成（须在 resolve 之前注册）
        getSubagentRunRegistry().createDelegationCompletion(subagentRun.runId);
        void executeSubagent()
          .then(async (execution) => {
            await enrichedContext.onSubagentEnd?.({
              runId: subagentRun.runId,
              status: execution.status,
              output: execution.output,
              error: execution.error
            });
            // ★ resolve 信号量，唤醒等待方
            getSubagentRunRegistry().resolveDelegationCompletion(subagentRun.runId);
          })
          .catch(async (err: any) => {
            getSubagentRunRegistry().update(subagentRun.runId, {
              status: "errored",
              outcome: { error: err?.message ?? String(err) }
            });
            const run = getSubagentRunRegistry().get(subagentRun.runId);
            if (run) await announceSubagentCompletion({ run });
            // ★ 出错时也要 resolve，避免等待方永久挂起
            getSubagentRunRegistry().resolveDelegationCompletion(subagentRun.runId);
          });
        return {
          type: "tool_result" as const,
          tool_use_id: "",
          content: JSON.stringify({ delegationId: subagentRun.runId, childThreadId: childMeta.id, status: "started" })
        };
      }
      try {
        const execution = await runForegroundSubagentWithTimeout({
          execution: executeSubagent(),
          childThreadId: childMeta.id,
          timeoutMs: resolveForegroundSubagentTimeoutMs(),
          stopSubagent: async (threadId: string) => {
            const { stopAgentRuntime } = await import("./attempt");
            return stopAgentRuntime(threadId);
          }
        });
        await enrichedContext.onSubagentEnd?.({
          runId: subagentRun.runId,
          status: execution.status,
          output: execution.output,
          error: execution.error
        });
        return execution.result;
      } catch (err: any) {
        getSubagentRunRegistry().update(subagentRun.runId, { status: "errored", outcome: { error: err?.message ?? String(err) } });
        throw err;
      }
    }
  };

  const waitForDelegationsTool: ToolDefinition = {
    name: "WaitForDelegations",
    description:
      "Wait for previously delegated background child sessions to finish and return their results. Use after Delegate(run_in_background=true). Input: mode 'all'(default)|'any', min_completed (for any, default 1), timeout_seconds (default 1800, max 7200). Returns status (completed|timeout), completedCount, runningCount, and a delegations array with each child's result.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["all", "any"], description: "'all' waits for every delegation; 'any' returns once min_completed have finished" },
        min_completed: { type: "number", description: "For mode 'any': number of completions to wait for (default 1)" },
        timeout_seconds: { type: "number", description: "Max wait in seconds (default 1800, max 7200)" }
      }
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    isEnabled: () => true,
    async prompt() {
      return "Wait for delegated background sessions.";
    },
    async call(toolInput: any, context: any) {
      const parentThreadId = context.sessionId ?? "";
      return buildWaitForDelegationsResult(toolInput ?? {}, parentThreadId, getSubagentRunRegistry());
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
    mcpDiagnostics: input.mcpDiagnostics,
    groups: [
      { source: "sdk", tools: baseTools },
      ...(permissionMode === "plan" ? [{ source: "plan" as const, tools: [planWriteTool] }] : []),
      { source: "task", tools: [taskReportTool, sidecarAgentTool, delegateTool, waitForDelegationsTool, todoTool] },
      { source: "lume", tools: lumeTools.customTools as ToolDefinition[] },
      ...(input.mcpTools?.length ? [{ source: "mcp" as const, tools: input.mcpTools }] : []),
      ...(input.pluginCommandTools?.length
        ? [{ source: "plugin" as const, tools: input.pluginCommandTools }]
        : []),
      ...(input.pluginMcpTools?.length
        ? [{ source: "plugin" as const, tools: input.pluginMcpTools }]
        : [])
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

function isAutomationExecution(messageMetadata?: Record<string, unknown>): boolean {
  if (!messageMetadata) {
    return false;
  }
  return typeof messageMetadata.automationJobId === "string"
    || typeof messageMetadata.automationTrigger === "string";
}

function resolveSkillDirectories(cwd: string, workspaceSlug?: string): string[] {
  const roots = [
    getDefaultSkillsDir(),
    getUserSkillsDir(),
    getAliceUserSkillsDir(),
    join(cwd, ".alice", "skills"),
    join(cwd, ".lume", "skills")
  ];
  if (workspaceSlug) {
    roots.push(getWorkspaceSkillsDir(workspaceSlug));
  }
  return roots;
}

function normalizeSkillList(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function createRuntimeSkillFilter(workspaceSlug?: string): AgentOptions["shouldLoadFilesystemSkill"] {
  if (!workspaceSlug) return undefined;

  const effectiveConfig = getEffectiveLumeConfig(workspaceSlug);
  const enabled = normalizeSkillList(effectiveConfig.skills?.enabled);
  const disabled = normalizeSkillList(effectiveConfig.skills?.disabled);
  if (enabled.size === 0 && disabled.size === 0) return undefined;

  const controlledRoots = new Set([
    resolve(getDefaultSkillsDir()),
    resolve(getWorkspaceSkillsDir(workspaceSlug))
  ]);

  return ({ root, skillName }) => {
    if (!controlledRoots.has(resolve(root))) return true;
    if (disabled.has(skillName)) return false;
    if (enabled.size > 0 && !enabled.has(skillName)) return false;
    return true;
  };
}

function buildEnabledPluginContext(
  plugins: RegisteredPlugin[],
  assembly: PluginRuntimeAssembly
): EnabledPluginContextItem[] {
  if (plugins.length === 0) return [];

  const skillsByPlugin = new Map<string, EnabledPluginContextItem["skills"]>();
  for (const skill of assembly.skills) {
    const pluginId = skill.name.split(":")[0];
    if (!pluginId) continue;
    const skills = skillsByPlugin.get(pluginId) ?? [];
    skills.push({
      name: skill.name,
      ...(skill.description ? { description: skill.description } : {}),
    });
    skillsByPlugin.set(pluginId, skills);
  }

  const commandToolsByPlugin = new Map<string, string[]>();
  for (const tool of assembly.commandToolDefinitions) {
    const runtimeMetadata = tool.runtimeMetadata as { pluginId?: string } | undefined;
    const pluginId = runtimeMetadata?.pluginId;
    if (!pluginId) continue;
    const tools = commandToolsByPlugin.get(pluginId) ?? [];
    tools.push(tool.name);
    commandToolsByPlugin.set(pluginId, tools);
  }

  const mcpServersByPlugin = new Map<string, string[]>();
  for (const server of assembly.mcpServers) {
    const servers = mcpServersByPlugin.get(server.pluginId) ?? [];
    servers.push(`${server.pluginId}:${server.serverId}`);
    mcpServersByPlugin.set(server.pluginId, servers);
  }

  const diagnosticsByPlugin = new Map<string, string[]>();
  for (const diagnostic of assembly.diagnostics) {
    if (!diagnostic.pluginId) continue;
    const diagnostics = diagnosticsByPlugin.get(diagnostic.pluginId) ?? [];
    diagnostics.push(diagnostic.message);
    diagnosticsByPlugin.set(diagnostic.pluginId, diagnostics);
  }

  return plugins.map((plugin) => {
    const diagnostics = [
      ...plugin.diagnostics.map((diagnostic) => diagnostic.message),
      ...(diagnosticsByPlugin.get(plugin.pluginId) ?? []),
    ];
    if (plugin.permissionState && plugin.permissionState.state !== "loaded") {
      diagnostics.push(`${plugin.permissionState.state}: ${plugin.permissionState.reason}`);
    }
    return {
      pluginId: plugin.pluginId,
      ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
      ...(plugin.description ? { description: plugin.description } : {}),
      skills: skillsByPlugin.get(plugin.pluginId) ?? [],
      commandTools: commandToolsByPlugin.get(plugin.pluginId) ?? [],
      mcpServers: mcpServersByPlugin.get(plugin.pluginId) ?? [],
      diagnostics: Array.from(new Set(diagnostics)),
    };
  });
}

function estimateToolSchemaTokens(tools: ToolDefinition[]): number {
  return tools.reduce((sum, tool) =>
    sum + Math.ceil((tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema ?? {}).length) / 4),
  0);
}

async function executeWorkflowHookSafely(
  workflowHooks: LumeWorkflowHookRuntimeLike | undefined,
  event: LumeWorkflowHookEvent
): Promise<LumeWorkflowHookExecutionResult | null> {
  if (!workflowHooks) return null;
  try {
    return await workflowHooks.execute(event);
  } catch {
    return null;
  }
}

async function applyWorkflowHookEffectsSafely(
  applyWorkflowHookEffects: CreateRuntimeCoreSessionInput["applyWorkflowHookEffects"],
  result: LumeWorkflowHookExecutionResult | null
): Promise<void> {
  if (!applyWorkflowHookEffects || !result) return;
  try {
    await applyWorkflowHookEffects(result);
  } catch {
    // Hook observe effects must not block runtime session creation.
  }
}

/**
 * WaitForDelegations 工具的纯逻辑：根据 registry 收敛结果构造返回 JSON。
 * 提取为模块级导出函数以便单测（工具闭包本身不可从外部调用）。
 */
export async function buildWaitForDelegationsResult(
  toolInput: { mode?: string; min_completed?: number; timeout_seconds?: number },
  parentThreadId: string,
  registry: {
    waitForDelegations(input: { parentThreadId: string; mode: "all" | "any"; minCompleted?: number; timeoutMs: number }): Promise<{ status: "completed" | "timeout"; completedCount: number; runningCount: number }>;
    listByParentSession(parentThreadId: string): Array<{ runId: string; childThreadId: string; label?: string; status: string; outcome?: { output?: string; error?: string } }>;
  }
): Promise<{ type: "tool_result"; tool_use_id: string; content: string }> {
  const mode = toolInput.mode === "any" ? "any" : "all";
  const timeoutMs = Math.min(Math.max((toolInput.timeout_seconds ?? 1800) * 1000, 1000), 2 * 3600 * 1000);
  const result = await registry.waitForDelegations({
    parentThreadId,
    mode,
    minCompleted: toolInput.min_completed,
    timeoutMs
  });
  const runs = registry.listByParentSession(parentThreadId);
  const delegations = runs.map((r) => ({
    delegationId: r.runId,
    childThreadId: r.childThreadId,
    ...(r.label ? { label: r.label } : {}),
    status: r.status,
    ...(r.outcome?.output ? { outputSummary: r.outcome.output.slice(0, 2000) } : {}),
    ...(r.outcome?.error ? { error: r.outcome.error } : {})
  }));
  return {
    type: "tool_result" as const,
    tool_use_id: "",
    content: JSON.stringify({
      status: result.status,
      mode,
      completedCount: result.completedCount,
      runningCount: result.runningCount,
      delegations
    })
  };
}

export async function createRuntimeCoreSession(
  input: CreateRuntimeCoreSessionInput
): Promise<CreateRuntimeCoreSessionResult> {
  const sessionManager = createOrResumeRuntimeCoreSessionManager(input.cwd, input.lumeSessionId, input.agentDir);
  const agents = { ...buildBuiltinAgents(), ...loadCustomAgents(input.workspaceSlug) };
  const subagentDefinition = input.subagentType ? agents[input.subagentType] : undefined;
  // Phase 3b: registry → resolver → bridge. Command tools + skills come from the
  // PluginRuntimeBridge now; the SDK's loadPlugins path is no longer used (no
  // agentOptions.plugins). Plugin hooks are wired below (Phase 3d, buildPluginAgentHooks).
  const pluginConfig = getEffectivePluginRuntimeConfig(input.workspaceSlug);
  const pluginManager = new SidecarPluginManager();
  const registeredPlugins = await pluginManager.listRegistered({
    enabled: pluginConfig.enabled,
    // cwd-local root + configured extras as directories; the global ~/.lume/plugins
    // root is covered by SidecarPluginManager's default pluginRoot.
    directories: [join(input.cwd, ".lume", "plugins"), ...pluginConfig.directories],
  });
  const pluginAssembly = await assemblePluginRuntime(registeredPlugins);

  // Phase 3d: build agentOptions.hooks from resolved plugin hooks. Shell-command hooks
  // are gate-aware (§8.1): checkSensitiveCapability(hook:event:matcher) before spawn.
  const hookPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(DEFAULT_PLUGIN_STATE_PATH),
  });
  const pluginAgentHooks = buildPluginAgentHooks({
    capabilities: pluginAssembly.hooks,
    runtime: hookPermissionRuntime,
    workspaceSlug: input.workspaceSlug,
  });

  // Register plugin skills (resolver already namespaced skill.name as `${pluginId}:${original}`).
  const registeredPluginSkillNames = new Set<string>();
  for (const skill of pluginAssembly.skills) {
    if (hasSkill(skill.name)) {
      log.warn(`[plugin] skill "${skill.name}" already registered, skipping duplicate`);
      continue;
    }
    registerSkill(skill);
    registeredPluginSkillNames.add(skill.name);
  }
  log.info("Plugin skill registration complete", {
    sessionId: input.lumeSessionId,
    totalRegistered: registeredPluginSkillNames.size,
    skills: Array.from(registeredPluginSkillNames),
  });
  // Phase MCP Merge-A/B: plugin-declared MCP servers via a TRANSIENT WorkspaceMcpManager
  // (independent of the workspace singleton — zero pollution, §16.7 lifecycle via dispose).
  // Merge-B: §8.1 start gate (authorizeConnect → checkSensitiveCapability, mcpServer key) +
  // drop fixed-name management tools (includeManagementTools:false, avoids workspace collision) +
  // stamp pluginId/capability/mcpServerId so the call gate (sensitive-gate.ts) source-binds.
  // Stateless runtime, same state path as attempt.ts → shares approval records.
  const pluginMcpPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(DEFAULT_PLUGIN_STATE_PATH),
  });
  const pluginMcpServerIndex = buildPluginIdIndex(pluginAssembly.mcpServers);
  const pluginMcpManager = buildPluginMcpManager(pluginAssembly.mcpServers, {
    permissionRuntime: pluginMcpPermissionRuntime,
    workspaceSlug: input.workspaceSlug,
  });
  const workspaceMcpManager = getWorkspaceMcpManager();
  const pluginMcpRuntime = await pluginMcpManager
    .createRuntimeTools(PLUGIN_MCP_WORKSPACE_SLUG, {
      includeManagementTools: false,
      toolMetadataProvider: (serverId) => {
        const pluginId = pluginMcpServerIndex.get(serverId);
        if (!pluginId) return undefined;
        return { source: "plugin", pluginId, capability: "mcp" };
      },
    })
    .catch((error) => ({
      tools: [],
      diagnostics: [{
        pluginName: "PluginMCP",
        severity: "warning" as const,
        reason: error instanceof Error ? error.message : String(error),
      }],
    }));
  const enabledPlugins = buildEnabledPluginContext(registeredPlugins, pluginAssembly);
  const workspaceMcpRuntime = input.workspaceSlug
    ? await workspaceMcpManager.createRuntimeTools(input.workspaceSlug).catch((error) => ({
      tools: [],
      diagnostics: [{
        pluginName: "MCP",
        severity: "warning" as const,
        reason: error instanceof Error ? error.message : String(error)
      }]
    }))
    : { tools: [], diagnostics: [] };
  const pluginAwareMcpResourceTools = input.workspaceSlug && pluginAssembly.mcpServers.length > 0
    ? createPluginAwareMcpResourceTools({
      workspaceSlug: input.workspaceSlug,
      pluginServers: pluginAssembly.mcpServers,
      workspaceMcpManager,
      pluginMcpManager,
    })
    : [];
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
    emitBrowserAuthRequest: input.emitBrowserAuthRequest,
    emitDesktopActionRequest: input.emitDesktopActionRequest,
    emitRuntimeEvent: input.emitRuntimeEvent,
    emitToolPermissionRequest: input.emitToolPermissionRequest,
    emitTaskContractUpdated: input.emitTaskContractUpdated,
    emitTodoUpdated: input.emitTodoUpdated,
    runId: input.runId,
    pluginDiagnostics: pluginAssembly.diagnostics.map((d) => ({
      pluginName: d.pluginId,
      severity: d.severity,
      reason: d.message,
      ...(d.path ? { path: d.path } : {}),
      ...(d.code ? { code: d.code } : {}),
    })),
    pluginCommandTools: pluginAssembly.commandToolDefinitions,
    pluginMcpTools: pluginMcpRuntime.tools,
    mcpTools: replaceMcpResourceTools(workspaceMcpRuntime.tools, pluginAwareMcpResourceTools),
    mcpDiagnostics: [
      ...(workspaceMcpRuntime.diagnostics ?? []),
      ...(pluginMcpRuntime.diagnostics ?? []),
    ]
  });
  const contextTokenBudget = input.resolvedModel?.contextWindow ?? 32_000;
  const runId = input.runId ?? input.lumeSessionId;
  const beforeContextResult = await executeWorkflowHookSafely(input.workflowHooks, {
    event: "context.beforeAssemble",
    runId,
    threadId: input.lumeSessionId,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    cwd: input.cwd,
    permissionMode: input.permissionMode,
    threadType: input.threadType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata,
    userMessage: input.userMessage ?? "",
    availableTools: toolset.availableToolNames,
    tokenBudget: contextTokenBudget
  });
  const workflowContext = beforeContextResult
    ? { appendContext: collectAppendContextEffects(beforeContextResult.effects) }
    : undefined;
  const desktopContext = await resolveDesktopContextProjection(input.messageMetadata);

  const contextAssembly = await new ContextAssembler().assemble({
    threadId: input.lumeSessionId,
    runId,
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
    attachedDirectories: input.attachedDirectories,
    availableTools: toolset.availableToolNames,
    enabledPlugins,
    tokenBudget: contextTokenBudget,
    workflowContext,
    desktopContext,
    trace: input.trace
  });
  const afterContextResult = await executeWorkflowHookSafely(input.workflowHooks, {
    event: "context.afterAssemble",
    runId,
    threadId: input.lumeSessionId,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    cwd: input.cwd,
    permissionMode: input.permissionMode,
    threadType: input.threadType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata,
    availableTools: toolset.availableToolNames,
    tokenBudget: contextTokenBudget,
    memoryContextUsedItems: contextAssembly.memoryContextUsedItems,
    userMessageForModelLength: contextAssembly.userMessageForModel.length
  });
  await applyWorkflowHookEffectsSafely(input.applyWorkflowHookEffects, afterContextResult);
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
    ...(Object.keys(pluginAgentHooks).length > 0 ? { hooks: pluginAgentHooks } : {}),
    agents,
    permissionMode: input.permissionMode === "bypassPermissions" ? "bypassPermissions" : "default",
    includePartialMessages: true,
    skillsDirectories: resolveSkillDirectories(input.cwd, input.workspaceSlug),
    shouldLoadFilesystemSkill: createRuntimeSkillFilter(input.workspaceSlug),
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
    additionalDirectories: input.workspaceSlug ? [input.cwd, ...(input.attachedDirectories ?? [])] : input.attachedDirectories,
    contextController: createKernelContextController({
      threadId: input.lumeSessionId,
      model: input.resolvedModel?.id ?? input.resolvedModelId,
      contextWindow: input.resolvedModel?.contextWindow ?? 32_000,
      maxOutputTokens: input.resolvedModel?.maxTokens,
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
      await getNodeReplRuntimeRegistry().shutdown(input.lumeSessionId);
      try {
        await pluginMcpManager.disposeWorkspace(PLUGIN_MCP_WORKSPACE_SLUG);
      } catch (error) {
        // M-2: a dispose failure (e.g. child-process kill error) must not skip the
        // descriptor/ledger/skill cleanup below — those are required to avoid leaking
        // state into the next session. Log and continue.
        log.warn("Plugin MCP disposeWorkspace failed during session dispose", {
          sessionId: input.lumeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      clearRuntimeToolDescriptors(input.lumeSessionId);
      clearRuntimeFileAccessLedger(input.lumeSessionId);
      for (const name of registeredPluginSkillNames) {
        unregisterSkill(name);
      }
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

/**
 * D7 一级深度拦截：当前父 thread 若本身是某个 subagent run 的 child，
 * 则禁止再 delegate（仅允许一级委托）。
 * 比 resolveSubagentSpawnPolicy 的 maxDepth 更严格。
 */
export function canDelegateFromThread(parentThreadId: string): { ok: boolean; error?: string } {
  const parentRun = getSubagentRunRegistry().getLatestByChildThread(parentThreadId);
  const parentMeta = getAgentThreadMeta(parentThreadId);
  if (parentRun || parentMeta?.parentThreadId) {
    return { ok: false, error: "委托子会话不能再创建新的委托子会话（仅允许一级）" };
  }
  return { ok: true };
}

/**
 * 子会话完成时用输出摘要派生标题。
 * output 非空→取前 20 字（折叠空白）；否则保留原标题。
 */
export function deriveDelegateTitle(
  originalTitle: string | undefined,
  output: string | undefined
): string | undefined {
  if (output && output.trim().length > 0) {
    const trimmed = output.trim().replace(/\s+/g, " ");
    return Array.from(trimmed).slice(0, 20).join("");
  }
  return originalTitle;
}

/**
 * Task 工具派生子会话时的初始侧栏标题解析。
 *
 * 策略：description 非空→用 description（LLM 写的短摘要，侧栏最易识别）；
 * 否则取 prompt 前 20 字（码点安全，与 deriveDelegateTitle 同策略，不切断 emoji 代理对）；
 * 两者皆空→返回 undefined（由 createAgentThreadWithModelRef 兜底为 "新 Agent 线程"）。
 *
 * 初始标题是临时态：完成时还会经 deriveDelegateTitle 用输出摘要覆盖
 * （见 sidecarAgentTool.onSubagentEnd），故优先保证"进行中可识别"而非完美。
 */
export function resolveTaskThreadInitialTitle(toolInput: Record<string, unknown>): string | undefined {
  const description = typeof toolInput.description === "string" ? toolInput.description.trim() : "";
  if (description) return description;

  const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt.trim() : "";
  if (!prompt) return undefined;

  const folded = prompt.replace(/\s+/g, " ");
  return Array.from(folded).slice(0, 20).join("");
}
