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
  LSPApplyTool,
  ProcessOutputTool,
  ProcessStopTool,
  EnterWorktreeTool,
  ExitWorktreeTool,
  registerAgents,
  type SDKMessage,
  type Agent,
  type FileCheckpoint,
  type AgentDefinition,
  type AgentOptions,
  type CompletionGuardResult,
  type ApiType,
  type PromptCachePolicy,
  type ContentBlockParam,
  type ToolContext,
  type ToolResult,
  type RenderClient,
  type TodoState,
  type SandboxSettings,
  SkillTool,
  createTodoTool,
  defineTool,
  finalizeSubagentOutputFromState,
  summarizeSubagentAssistantEvent,
  type ToolDefinition,
  type PersistedToolContinuation,
  warmupLspClients,
  setLspIdleTimeout
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentBrowserAuthRequest,
  AgentDesktopActionRequest,
  AgentSendInput,
  AgentToolPermissionRequest,
  OpenAiApiMode,
  LumeRuntimeEvent,
  RuntimeCodingReport,
  FileReferenceBinding,
  SubagentTaskReport,
  SubagentTask,
  SubagentTaskFeedback,
  AgentTaskRef
} from "@lume/shared";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
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
import { getWorkspaceMcpManager, WorkspaceMcpManager } from "../../mcp/workspace-mcp-manager";
import { resolveMemoryRuntimeConfig, shouldIncludeCitations } from "../../memory-v2/policy";
import type { MemoryV2RecallItem } from "../../memory-v2/types";
import { decryptApiKey, resolveChannelModelBinding } from "../../channel/channel-manager";
import { getEffectiveLumeConfig, getEffectivePluginRuntimeConfig } from "../../system/lume-config-service";
import { createLumeRuntimeTools } from "../tools/create-lume-tools";
import { createSdkWebTools } from "../tools/web/create-web-tools";
import { getSidecarRenderClient } from "../tools/web/render-client-holder";
import { resolveSubagentSpawnPolicy } from "../../agent/subagents/subagent-policy";
import { hasCodingIntent } from "../../agent/capability-routing";
import { getSubagentRunRegistry } from "../../agent/subagents/subagent-run-registry";
import { getSubagentCoordinator } from "../../agent/subagents/subagent-coordinator";
import { buildSubagentWorkContext, resolveSubagentDispatchPolicy } from "../../agent/subagents/subagent-dispatch-policy";
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
import { createMainTaskTools } from "../task/task-tools";
import { FileBackedTaskStore } from "../task/task-store";
import { ToolRuntime, type ToolRuntimeDiagnostic } from "../tools/tool-runtime";
import { SidecarPluginManager } from "../plugins/plugin-manager.js";
import { assemblePluginRuntime, type PluginRuntimeAssembly } from "../plugins/runtime-bridge.js";
import type { RegisteredPlugin } from "../plugins/plugin-registry.js";
import { PluginPermissionRuntime } from "../plugins/permission-runtime.js";
import { DEFAULT_PLUGIN_STATE_PATH, FilePluginStateStore } from "../plugins/plugin-state-store.js";
import { buildPluginAgentHooks } from "../plugins/plugin-hooks-bridge.js";
import { resolveRuntimeLspConfig } from "../lsp/lsp-config.js";
import {
  buildPluginMcpManager,
  buildPluginIdIndex,
  PLUGIN_MCP_WORKSPACE_SLUG,
} from "../plugins/plugin-mcp-bridge.js";
import {
  clearRuntimeToolDescriptors,
} from "../tools/tool-descriptor-session";
import { clearRuntimeFileAccessLedger } from "../tools/file-access-ledger";
import { createCodingRunTracker, type CodingVerificationStatus } from "./coding-run-tracker";
import { runAdvisor } from "../advisor/advisor-service";
import { getNodeReplRuntimeRegistry } from "../tools/node-repl/node-repl-runtime-registry";
import { getComputerUseSessionRegistry } from "../tools/computer-use/computer-use-session";
import {
  filterComputerUseSkills,
  resolveComputerUseSurface,
  type ResolvedComputerUseSurface,
} from "../tools/computer-use/computer-use-surface";
import { withDesktopAutomationFallbackGuard } from "../tools/computer-use/desktop-automation-fallback-guard";
import {
  createPluginAwareMcpResourceTools,
  replaceMcpResourceTools,
} from "./mcp-resource-router.js";
import type { LumeToolDescriptor } from "../tools/tool-types";
import {
  cloneTodoState,
  getTodoCompletionBlocker,
  readLatestTodoState
} from "../runner/todo-state";
import { createFileBackedRunContinuationStore } from "../runner/run-continuation-store";
import {
  collectAppendContextEffects,
  type LumeWorkflowHookExecutionResult
} from "../../workflow-hooks/hook-effects";
import type { LumeWorkflowHookRuntimeLike } from "../../workflow-hooks/hook-runtime";
import type { LumeWorkflowHookEvent } from "../../workflow-hooks/hook-events";

const log = createLogger("runtime-core-prompt");
const DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
const taskExecutorStopHandlers = new Map<string, () => void>();

interface RuntimeCoreResolvedModel {
  id: string;
  provider: string;
  channelProvider?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}

export interface CreateRuntimeCoreSessionInput {
  lumeSessionId: string;
  cwd: string;
  lumeWorkDir?: string;
  filesRoot?: string;
  plansRoot?: string;
  artifactsRoot?: string;
  projectRoot?: string;
  additionalDirectories?: string[];
  fileContextId?: string;
  fileReferenceBinding?: FileReferenceBinding;
  agentDir: string;
  userMessage?: string;
  provider: string;
  channelProvider?: string;
  openaiApiMode?: OpenAiApiMode;
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
  subagentRunId?: string;
  subagentId?: string;
  subagentTaskId?: string;
  subagentAttempt?: number;
  chatType?: AgentSendInput["chatType"];
  permissionMode?: AgentSendInput["permissionMode"];
  messageAttachments?: AgentSendInput["messageAttachments"];
  messageMetadata?: Record<string, unknown>;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  persistCodingReport?: (report: RuntimeCodingReport) => void;
  emitAdvisorReview?: (review: {
    severity: "clear" | "suggestion" | "concern" | "blocker";
    summary: string;
    details?: string;
    modelRef: string;
    durationMs: number;
  }) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  emitTodoUpdated?: Parameters<typeof createTodoTool>[0]["onTodoUpdated"];
  runId?: string;
  workflowHooks?: LumeWorkflowHookRuntimeLike;
  applyWorkflowHookEffects?: (result: LumeWorkflowHookExecutionResult) => Promise<void> | void;
  trace?: ContextAssemblyInput["trace"];
  wikiProposalEnabled?: boolean;
  processSandbox?: SandboxSettings;
  toolConfig?: Record<string, unknown>;
}

interface BoundSubagentIdentity {
  runId: string;
  taskId: string;
}

function resolveBoundSubagentIdentity(
  input: Pick<CreateRuntimeCoreSessionInput, "threadType" | "subagentRunId" | "subagentTaskId">
): BoundSubagentIdentity | undefined {
  const runId = input.subagentRunId?.trim() ?? "";
  const taskId = input.subagentTaskId?.trim() ?? "";
  if (Boolean(runId) !== Boolean(taskId)) {
    throw new Error("subagentRunId 与 subagentTaskId 必须同时提供");
  }
  if (input.threadType !== "subagent" || !runId || !taskId) {
    return undefined;
  }
  return { runId, taskId };
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
  runtimeContext: string;
  userMessageForModel: string | ContentBlockParam[];
  memoryContextUsedItems: MemoryV2RecallItem[];
  tools: ToolDefinition[];
  getVerificationStatus: () => CodingVerificationStatus;
  beforeToolExecution: NonNullable<AgentOptions["onBeforeToolExecution"]>;
  getBaselineCommit: () => string | undefined;
  getBaselineCommits: () => Record<string, string>;
  getVerificationReport: () => import("./coding-run-tracker").CodingVerificationReport;
  refreshCodingChangeSet: () => Promise<unknown>;
  getLatestFileCheckpoint: () => FileCheckpoint | undefined;
  getWorkspaceRoots: () => string[];
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
    apiType: binding.family === "anthropic"
      ? "anthropic-messages"
      : binding.channel.openaiApiMode === "responses"
        ? "openai-responses"
        : "openai-completions",
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
  subagentId?: string;
  subagentTaskId?: string;
  subagentAttempt?: number;
  modelOverride: ResolvedSubagentModelOverride;
  channelId?: string;
  workspaceId?: string;
  chatType?: AgentSendInput["chatType"];
  messageMetadata?: Record<string, unknown>;
  fileReferenceBinding?: FileReferenceBinding;
  permissionMode?: AgentSendInput["permissionMode"];
  onRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}): Promise<{
  result: ToolResult;
  status: "completed" | "errored" | "aborted" | "timed_out";
  output?: string;
  completionSummary?: string;
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
      traceContext: {
        submissionId: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        origin: "subagent",
        ...(
          typeof (input.messageMetadata?.traceContext as { traceId?: unknown } | undefined)?.traceId === "string"
            ? { parentTraceId: (input.messageMetadata?.traceContext as { traceId: string }).traceId }
            : {}
        )
      },
      messageMetadata: input.messageMetadata
    },
    runtime: {
      sessionId: input.childThreadId,
      deliveryThreadId: input.deliveryThreadId,
      subagentRunId: input.runId,
      subagentId: input.subagentId,
      subagentTaskId: input.subagentTaskId,
      subagentAttempt: input.subagentAttempt,
      ...(subagentType ? { subagentType } : {}),
      ...(input.modelOverride.modelRef ? { modelRef: input.modelOverride.modelRef } : {}),
      channelId: resolvedChannelId,
      resolvedModelId,
      workspaceId: input.workspaceId,
      threadType: "subagent",
      fileReferenceBinding: input.fileReferenceBinding
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

    },
    onComplete: () => undefined,
    onError: (error) => {
      subagentStatus = "errored";
      subagentErrorMessage = error;
    },
    onRuntimeEvent: input.onRuntimeEvent,
    onAskUserQuestion: input.emitAskUserQuestion ?? (() => undefined),
    onBrowserAuthRequest: input.emitBrowserAuthRequest ?? (() => undefined),
    onDesktopActionRequest: input.emitDesktopActionRequest,
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
    ...(finalized.lastAssistantMessage ? { completionSummary: finalized.lastAssistantMessage } : {}),
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

/** A child Run receives IDs from the coordinator; the model cannot redirect a report. */
function createBoundSubagentTaskReportTool(input: { runId: string; taskId: string }): ToolDefinition {
  return defineTool({
    name: "TaskReport",
    description: "Submit the current subagent task result. This is a submission for main-agent review, not acceptance.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["submitted", "failed", "blocked"] },
        summary: { type: "string" },
        completedWork: { type: "array", items: { type: "string" } },
        remainingWork: { type: "array", items: { type: "string" } },
        artifacts: { type: "array", items: { type: "object", properties: { path: { type: "string" }, description: { type: "string" } }, required: ["path"] } },
        verification: { type: "array", items: { type: "object", properties: { command: { type: "string" }, result: { type: "string" }, passed: { type: "boolean" } }, required: ["result", "passed"] } },
        blockers: { type: "array", items: { type: "string" } }
      },
      required: ["status", "summary"]
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(raw) {
      const report = normalizeBoundSubagentReport(raw)
      getSubagentCoordinator().submitReport({ runId: input.runId, report })
      return { data: { ok: true, taskId: input.taskId, runId: input.runId, status: report.status } }
    }
  })
}

function normalizeBoundSubagentReport(raw: unknown): SubagentTaskReport {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
  const status = value.status
  const summary = typeof value.summary === "string" ? value.summary.trim() : ""
  if ((status !== "submitted" && status !== "failed" && status !== "blocked") || !summary) {
    throw new Error("TaskReport 需要 status(submitted|failed|blocked) 和非空 summary")
  }
  const strings = (name: string) => Array.isArray(value[name]) ? value[name].filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : undefined
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts.flatMap((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {}
    return typeof record.path === "string" && record.path.trim() ? [{ path: record.path.trim(), ...(typeof record.description === "string" && record.description.trim() ? { description: record.description.trim() } : {}) }] : []
  }) : undefined
  const verification = Array.isArray(value.verification) ? value.verification.flatMap((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {}
    return typeof record.result === "string" && typeof record.passed === "boolean" ? [{ result: record.result, passed: record.passed, ...(typeof record.command === "string" && record.command.trim() ? { command: record.command.trim() } : {}) }] : []
  }) : undefined
  return { status, summary, ...(strings("completedWork")?.length ? { completedWork: strings("completedWork") } : {}), ...(strings("remainingWork")?.length ? { remainingWork: strings("remainingWork") } : {}), ...(artifacts?.length ? { artifacts } : {}), ...(verification?.length ? { verification } : {}), ...(strings("blockers")?.length ? { blockers: strings("blockers") } : {}) }
}

function buildSubagentTaskInstruction(task: SubagentTask, feedback: SubagentTaskFeedback[]): string {
  const latestFeedback = feedback.at(-1)?.instruction
  return [
    "## Bound task",
    task.objective,
    task.acceptanceCriteria.length ? `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : undefined,
    task.expectedArtifacts?.length ? `Expected artifacts:\n${task.expectedArtifacts.map((item) => `- ${item}`).join("\n")}` : undefined,
    latestFeedback && latestFeedback !== task.objective ? `## Parent feedback for this attempt\n${latestFeedback}` : undefined,
    "Complete only this task, then submit TaskReport."
  ].filter((item): item is string => Boolean(item)).join("\n\n")
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
  options: {
    includeAskUserQuestion: boolean;
    includeWebTools: boolean;
    workspaceSlug?: string;
    renderClient?: RenderClient;
    originalUserInstruction?: string;
  }
): ToolDefinition[] {
  const readOnlyTools: ToolDefinition[] = [
    FileReadTool,
    GlobTool,
    GrepTool,
    ListDirectoryTool,
    ...(options.includeWebTools
      ? createSdkWebTools({ workspaceSlug: options.workspaceSlug, renderClient: options.renderClient })
      : [])
  ];

  if (permissionMode === "plan") {
    return [
      ...readOnlyTools,
      ...(options.includeAskUserQuestion ? [AskUserQuestionTool] : []),
      SkillTool
    ];
  }

  const worktreeTools = shouldExposeWorktreeTools(options.originalUserInstruction)
    ? [EnterWorktreeTool, ExitWorktreeTool]
    : [];

  return [
    ...readOnlyTools,
    ...(options.includeAskUserQuestion ? [AskUserQuestionTool] : []),
    FileWriteTool,
    FileEditTool,
    BashTool,
    ProcessOutputTool,
    ProcessStopTool,
    NotebookEditTool,
    SkillTool,
    LSPTool,
    LSPApplyTool,
    ...worktreeTools
  ];
}

function shouldExposeWorktreeTools(instruction?: string): boolean {
  const normalized = (instruction ?? "").trim().toLowerCase();
  return [
    "worktree",
    "git worktree",
    "isolation",
    "isolated workspace",
    "parallel agent",
    "parallel coding",
    "并行开发",
    "并行修改",
    "隔离工作区",
    "独立工作区",
  ].some((marker) => normalized.includes(marker));
}

function buildRuntimeCoreTools(input: {
  cwd: string;
  filesRoot?: string;
  plansRoot?: string;
  artifactsRoot?: string;
  sessionId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  channelId?: string;
  modelRef?: string;
  provider?: string;
  computerUseSurface?: ResolvedComputerUseSurface;
  chatType?: AgentSendInput["chatType"];
  threadType?: AgentSendInput["threadType"];
  permissionMode?: AgentSendInput["permissionMode"];
  subagentDefinition?: AgentDefinition;
  boundSubagentReportTool?: ToolDefinition;
  messageMetadata?: Record<string, unknown>;
  fileReferenceBinding?: FileReferenceBinding;
  originalUserInstruction?: string;
  emitSdkMessage?: (message: SDKMessage) => void;
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
  emitTodoUpdated?: Parameters<typeof createTodoTool>[0]["onTodoUpdated"];
  initialTodoState?: TodoState | null;
  runId?: string;
  renderClient?: RenderClient;
  pluginDiagnostics?: ToolRuntimeDiagnostic[];
  mcpTools?: ToolDefinition[];
  mcpDiagnostics?: ToolRuntimeDiagnostic[];
  /** Plugin command-tool ToolDefinitions built by PluginRuntimeBridge (Phase 3b). */
  pluginCommandTools?: ToolDefinition[];
  /** Plugin MCP tool definitions (Phase MCP Merge-A) from the plugin-scoped MCP manager. */
  pluginMcpTools?: ToolDefinition[];
  wikiProposalEnabled?: boolean;
}): RuntimeCoreToolset {
  const permissionMode = input.permissionMode ?? "default";
  const memoryRuntimeConfig = resolveMemoryRuntimeConfig();
  const includeCitations = shouldIncludeCitations(
    memoryRuntimeConfig.citationsMode,
    input.chatType ?? "direct"
  );
  const automationExecution = isAutomationExecution(input.messageMetadata);
  const directRepositoryRoute = isDirectRepositoryRuntimeRoute(
    input.messageMetadata,
    input.originalUserInstruction
  );
  const baseTools = createBaseSdkAlignedTools(permissionMode, {
    includeAskUserQuestion: automationExecution !== true,
    includeWebTools: !directRepositoryRoute,
    workspaceSlug: input.workspaceSlug,
    renderClient: input.renderClient,
    originalUserInstruction: input.originalUserInstruction
  }).map((tool) => tool.name === "Bash" && input.computerUseSurface === "sky"
    ? withDesktopAutomationFallbackGuard(tool, {
      computerUseActive: () => getComputerUseSessionRegistry().isActive(input.sessionId),
      originalUserInstruction: input.originalUserInstruction,
    })
    : tool);
  const todoTool = createTodoTool({
    threadId: input.sessionId,
    initialTodos: input.initialTodoState?.todos,
    onTodoUpdated: input.emitTodoUpdated,
  });
  const lumeTools = createLumeRuntimeTools({
    threadId: input.sessionId,
    cwd: input.cwd,
    filesRoot: input.filesRoot,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    modelRef: input.modelRef,
    threadType: input.threadType,
    chatType: input.chatType,
    workspaceSlug: input.workspaceSlug,
    permissionMode,
    messageMetadata: input.messageMetadata,
    originalUserInstruction: input.originalUserInstruction,
    computerUseSurface: input.computerUseSurface,
    memoryToolPolicy: memoryRuntimeConfig.toolPolicy,
    includeCitations,
    automationExecution,
    runId: input.runId,
    emitSdkMessage: input.emitSdkMessage,
    emitAskUserQuestion: input.emitAskUserQuestion ?? (() => {}),
    emitBrowserAuthRequest: input.emitBrowserAuthRequest,
    emitDesktopActionRequest: input.emitDesktopActionRequest,
    emitDesktopActionVisualEvent: input.emitRuntimeEvent,
    emitToolPermissionRequest: input.emitToolPermissionRequest ?? (() => {}),
    wikiProposalEnabled: input.wikiProposalEnabled
  });
  const askWikiOnly = getAgentThreadMeta(input.sessionId)?.wikiProfile?.kind === "ask-wiki";

  const policyInput = {
    provider: input.provider,
    workspaceSlug: input.workspaceSlug,
    threadType: input.threadType,
    chatType: input.chatType,
    messageMetadata: input.messageMetadata
  };

  const isMainTaskThread = input.threadType === "main" || input.threadType === undefined;
  const mainTaskRuntime = isMainTaskThread
    ? createMainTaskTools({
      sessionDir: getRuntimeCoreSessionDir(input.sessionId),
      threadId: input.sessionId,
      runId: input.runId,
      emitRuntimeEvent: input.emitRuntimeEvent,
      onCancellationRequested: ({ executorRef }) => {
        if (executorRef) taskExecutorStopHandlers.get(executorRef)?.();
      },
    })
    : undefined;

  const sidecarAgentTool: ToolDefinition = {
    ...AgentTool,
    description: "Launch an independent subagent. For a persistent Task, first claim it with TaskUpdate and then pass task_ref; Task itself never creates or schedules the subagent.",
    isConcurrencySafe: () => false,
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
      try {
        if (toolInput.task_ref !== undefined) {
          if (!mainTaskRuntime) throw new Error("Task-linked Agent calls are main-agent only");
          assertTaskRefDiscriminant(toolInput);
          const taskRef = parseTaskRef(toolInput.task_ref, parentThreadId);
          return await runTaskLinkedSubagent({
            toolInput,
            context,
            taskStore: mainTaskRuntime.store,
            taskRef,
            parentThreadId,
            modelOverride,
            workspaceId: input.workspaceId,
            workspaceSlug: input.workspaceSlug,
            channelId: input.channelId,
            chatType: input.chatType,
            messageMetadata: input.messageMetadata,
            fileReferenceBinding: input.fileReferenceBinding,
            permissionMode,
            emitRuntimeEvent: input.emitRuntimeEvent,
            emitAskUserQuestion: input.emitAskUserQuestion,
            emitBrowserAuthRequest: input.emitBrowserAuthRequest,
            emitDesktopActionRequest: input.emitDesktopActionRequest,
            emitToolPermissionRequest: input.emitToolPermissionRequest,
          });
        }
        const coordinator = getSubagentCoordinator();
        const taskId = typeof toolInput.task_id === "string" ? toolInput.task_id.trim() : undefined;
        const subagentId = typeof toolInput.subagent_id === "string" ? toolInput.subagent_id.trim() : undefined;
        const work = coordinator.list(parentThreadId);
        const dispatch = resolveSubagentDispatchPolicy({
          prompt: typeof toolInput.prompt === "string" ? toolInput.prompt : "",
          taskId,
          subagentId,
          newTask: toolInput.new_task === true,
          unresolvedTasks: work.tasks.filter((task) => task.status === "open" || task.status === "running" || task.status === "awaiting_review")
        });
        if (!dispatch.allowed) {
          return { type: "tool_result" as const, tool_use_id: "", content: dispatch.message, is_error: true };
        }
        const result = await coordinator.runAgentTask({
          parentThreadId,
          parentRunId: input.runId ?? parentThreadId,
          parentToolUseId: context.toolUseId ?? crypto.randomUUID(),
          prompt: typeof toolInput.prompt === "string" ? toolInput.prompt : "",
          description: typeof toolInput.description === "string" ? toolInput.description : "Subagent",
          subagentType: typeof toolInput.subagent_type === "string" ? toolInput.subagent_type : undefined,
          subagentId,
          taskId,
          acceptanceCriteria: Array.isArray(toolInput.acceptance_criteria) ? toolInput.acceptance_criteria.filter((item: unknown): item is string => typeof item === "string") : undefined,
          expectedArtifacts: Array.isArray(toolInput.expected_artifacts) ? toolInput.expected_artifacts.filter((item: unknown): item is string => typeof item === "string") : undefined,
          createSession: ({ subagentId, title, agentType }) => {
            const child = createAgentThreadWithModelRef(title, modelOverride.modelRef, modelOverride.channelId ?? input.channelId, input.workspaceId, parentThreadId, modelOverride.resolvedModelId ?? context.model, { fileContextMode: "inherit" })
            return { threadId: child.id, modelRef: modelOverride.modelRef }
          },
          execute: async ({ run, session, task, feedback, signal }) => {
            const stopChild = () => {
              void import("./attempt").then((module) => module.stopAgentRuntime(session.threadId)).catch(() => undefined)
            }
            signal.addEventListener("abort", stopChild, { once: true })
            try {
              const execution = await runSidecarSubagent({
              toolInput: {
                ...toolInput,
                prompt: buildSubagentTaskInstruction(task, feedback),
                run_in_background: undefined,
                isolation: undefined,
                subagent_run_id: run.runId
              },
              context,
              runId: run.runId,
              childThreadId: session.threadId,
              parentThreadId,
              deliveryThreadId: parentThreadId,
              parentToolUseId: context.toolUseId,
              subagentType: session.agentType,
              subagentId: session.subagentId,
              subagentTaskId: task.taskId,
              subagentAttempt: run.attempt,
              modelOverride,
              channelId: input.channelId,
              workspaceId: input.workspaceId,
              chatType: input.chatType,
              messageMetadata: input.messageMetadata,
              fileReferenceBinding: input.fileReferenceBinding,
              onRuntimeEvent: (event) => {
                coordinator.bindRuntimeRun(run.runId, event.runId);
                input.emitRuntimeEvent?.(event);
              },
              permissionMode,
              emitAskUserQuestion: input.emitAskUserQuestion,
              emitBrowserAuthRequest: input.emitBrowserAuthRequest,
              emitToolPermissionRequest: input.emitToolPermissionRequest
              })
              return {
                status: execution.status === "aborted" ? "cancelled" : execution.status,
                error: execution.error,
                completionSummary: execution.completionSummary,
              }
            } finally {
              signal.removeEventListener("abort", stopChild)
            }
          }
        })
        return { type: "tool_result" as const, tool_use_id: "", content: JSON.stringify(result) }
      } catch (error) {
        return { type: "tool_result" as const, tool_use_id: "", content: `Subagent error: ${error instanceof Error ? error.message : String(error)}`, is_error: true }
      }
    }
  };

  const finishAgentTaskTool = defineTool({
    name: "FinishAgentTask",
    description: "Accept, defer, or cancel a submitted Subagent task. A completed Run is not accepted until this tool is called.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        resolution: { type: "string", enum: ["accepted", "deferred", "cancelled"] },
        reason: { type: "string" }
      },
      required: ["task_id", "resolution", "reason"]
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(raw) {
      const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
      const taskId = typeof value.task_id === "string" ? value.task_id.trim() : ""
      const reason = typeof value.reason === "string" ? value.reason.trim() : ""
      const resolution = value.resolution
      if (!taskId || !reason || (resolution !== "accepted" && resolution !== "deferred" && resolution !== "cancelled")) throw new Error("FinishAgentTask 参数无效")
      const task = getSubagentCoordinator().finishTask({ taskId, resolution, reason })
      return { data: { ok: true, taskId: task.taskId, status: task.status } }
    }
  })

  const retireSubagentTool = defineTool({
    name: "RetireSubagent",
    description: "Retire an idle persistent Subagent Session while keeping its child-thread history available.",
    inputSchema: { type: "object", properties: { subagent_id: { type: "string" }, reason: { type: "string" } }, required: ["subagent_id", "reason"] },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(raw) {
      const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
      const subagentId = typeof value.subagent_id === "string" ? value.subagent_id.trim() : ""
      const reason = typeof value.reason === "string" ? value.reason.trim() : ""
      if (!subagentId || !reason) throw new Error("RetireSubagent 参数无效")
      const session = getSubagentCoordinator().retireSession({ subagentId, reason })
      return { data: { ok: true, subagentId: session.subagentId, status: session.status } }
    }
  })

  const mainTaskTools = mainTaskRuntime?.tools ?? [];
  const taskLoopTools = directRepositoryRoute && isMainTaskThread
    ? []
    : input.threadType === "subagent"
      ? (input.boundSubagentReportTool ? [input.boundSubagentReportTool, todoTool] : [todoTool])
      : [...(isMainTaskThread ? mainTaskTools : []), sidecarAgentTool, finishAgentTaskTool, retireSubagentTool, todoTool]

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
        task_ref: {
          type: "object",
          required: ["taskListId", "taskId", "claimToken"],
          properties: { taskListId: { type: "string" }, taskId: { type: "string" }, claimToken: { type: "string" } },
          description: "Associate this independently-created executor with a claimed main-agent Task.",
        },
        run_in_background: { type: "boolean", description: "If true, start the child session asynchronously and return immediately with a delegationId. Use WaitForDelegations to collect results later." }
      },
      required: ["prompt", "description"]
    },
    isConcurrencySafe: () => false,
    async call(toolInput: any, context: any) {
      const parentThreadId = context.sessionId ?? "";
      const policy = resolveSubagentSpawnPolicy({
        parentThreadId,
        parentPermissionMode: toolInput.mode
      });
      if (!policy.ok) {
        return { type: "tool_result" as const, tool_use_id: "", content: policy.error ?? "spawn policy rejected", is_error: true };
      }
      if (toolInput.task_ref !== undefined) {
        if (!mainTaskRuntime) return { type: "tool_result" as const, tool_use_id: "", content: "Task-linked Delegate calls are main-agent only", is_error: true };
        try {
          assertTaskRefDiscriminant(toolInput);
          if (toolInput.run_in_background === true) throw new Error("Task-linked Delegate calls are serialized and cannot run in background");
          const taskRef = parseTaskRef(toolInput.task_ref, parentThreadId);
          const modelOverride = resolveSubagentModelOverride({ toolInput, workspaceSlug: input.workspaceSlug });
          return await runTaskLinkedSubagent({
            toolInput,
            context,
            taskStore: mainTaskRuntime.store,
            taskRef,
            parentThreadId,
            modelOverride,
            workspaceId: input.workspaceId,
            workspaceSlug: input.workspaceSlug,
            channelId: input.channelId,
            chatType: input.chatType,
            messageMetadata: input.messageMetadata,
            fileReferenceBinding: input.fileReferenceBinding,
            permissionMode,
            emitRuntimeEvent: input.emitRuntimeEvent,
            emitAskUserQuestion: input.emitAskUserQuestion,
            emitBrowserAuthRequest: input.emitBrowserAuthRequest,
            emitDesktopActionRequest: input.emitDesktopActionRequest,
            emitToolPermissionRequest: input.emitToolPermissionRequest,
          });
        } catch (error) {
          return { type: "tool_result" as const, tool_use_id: "", content: error instanceof Error ? error.message : String(error), is_error: true };
        }
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
        modelOverride.resolvedModelId ?? context.model,
        { fileContextMode: "inherit" }
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
        fileReferenceBinding: input.fileReferenceBinding,
        onRuntimeEvent: input.emitRuntimeEvent,
        permissionMode,
        emitAskUserQuestion: input.emitAskUserQuestion,
        emitBrowserAuthRequest: input.emitBrowserAuthRequest,
        emitDesktopActionRequest: input.emitDesktopActionRequest,
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
    groups: askWikiOnly ? [
      { source: "lume", tools: lumeTools.customTools as ToolDefinition[] }
    ] : [
      { source: "sdk", tools: baseTools },
      { source: "task", tools: taskLoopTools },
      { source: "lume", tools: lumeTools.customTools as ToolDefinition[] },
      ...(!directRepositoryRoute && input.mcpTools?.length
        ? [{ source: "mcp" as const, tools: sortDiscoveredTools(input.mcpTools) }]
        : []),
      ...(!directRepositoryRoute && input.pluginCommandTools?.length
        ? [{ source: "plugin" as const, tools: sortDiscoveredTools(input.pluginCommandTools) }]
        : []),
      ...(!directRepositoryRoute && input.pluginMcpTools?.length
        ? [{ source: "plugin" as const, tools: sortDiscoveredTools(input.pluginMcpTools) }]
        : [])
    ]
  });
}

function isDirectRepositoryRuntimeRoute(
  messageMetadata?: Record<string, unknown>,
  originalUserInstruction?: string
): boolean {
  const preferredRoute = typeof messageMetadata?.preferredCapabilityRoute === "string"
    ? messageMetadata.preferredCapabilityRoute
    : undefined;
  return preferredRoute === "coding"
    || preferredRoute === "raw-tools"
    || hasCodingIntent(originalUserInstruction);
}

function sortDiscoveredTools(tools: ToolDefinition[]): ToolDefinition[] {
  return [...tools].sort((left, right) => left.name.localeCompare(right.name));
}

function resolveSdkApiType(provider: string, openaiApiMode?: OpenAiApiMode): ApiType {
  const normalized = provider.trim().toLowerCase();
  if (normalized === "anthropic" || normalized === "anthropic-compatible") {
    return "anthropic-messages";
  }
  if (normalized === "deepseek") {
    return "deepseek-chat-completions";
  }
  if (openaiApiMode === "responses") {
    return "openai-responses";
  }
  return "openai-completions";
}

export function resolvePromptCachePolicy(input: {
  channelProvider?: string;
  provider: string;
  model: string;
  threadId: string;
  baseUrl?: string;
}): PromptCachePolicy {
  const channelProvider = (input.channelProvider ?? input.provider).trim().toLowerCase();
  const routingKey = `lume:v1:${createHash("sha256")
    .update(`${channelProvider}\0${input.model}\0${input.threadId}`)
    .digest("hex")}`;
  if (channelProvider === "anthropic" && isOfficialEndpoint(input.baseUrl, "api.anthropic.com")) {
    return {
      strategy: "anthropic-ephemeral",
      ttl: "5m",
      cacheStableSystem: true,
      cacheConversation: true,
      runtimeRole: "system"
    };
  }
  if (channelProvider === "openai" && isOfficialEndpoint(input.baseUrl, "api.openai.com")) {
    return { strategy: "implicit", routingKey, runtimeRole: "developer" };
  }
  if (channelProvider === "openrouter") {
    return {
      strategy: "openrouter-sticky",
      routingKey,
      runtimeRole: "system",
      ...(input.model.toLowerCase().startsWith("anthropic/")
        ? { ttl: "5m" as const, cacheStableSystem: true }
        : {})
    };
  }
  if (channelProvider === "deepseek") {
    return { strategy: "implicit", runtimeRole: "user" };
  }
  return { strategy: "implicit", runtimeRole: "user" };
}

function isOfficialEndpoint(baseUrl: string | undefined, officialHost: string): boolean {
  if (!baseUrl?.trim()) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === officialHost;
  } catch {
    return false;
  }
}

function fingerprintToolSchema(tools: ToolDefinition[]): string {
  return createHash("sha256").update(JSON.stringify(tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  })))).digest("hex");
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
  const boundSubagentIdentity = resolveBoundSubagentIdentity(input);
  const sessionDir = getRuntimeCoreSessionDir(input.lumeSessionId, input.agentDir);
  const runId = input.runId ?? input.lumeSessionId;
  const codingRunTracker = createCodingRunTracker({
    workspaceRoot: input.cwd,
    additionalRoots: input.additionalDirectories,
    statePath: join(sessionDir, `coding-state-${(input.runId ?? "session").replace(/[^a-zA-Z0-9_-]/g, "_")}.v1.json`),
    turnId: typeof input.messageMetadata?.turnId === "string" ? input.messageMetadata.turnId : undefined,
    userMessageId: typeof input.messageMetadata?.messageId === "string" ? input.messageMetadata.messageId : undefined,
    routeReason: typeof input.messageMetadata?.routeReason === "string" ? input.messageMetadata.routeReason : undefined,
    toolSelectionReason: typeof input.messageMetadata?.toolSelectionReason === "string" ? input.messageMetadata.toolSelectionReason : undefined
  });
  await codingRunTracker.initialize();
  let approvalRequestCount = 0;
  const publishCodingReport = (): void => {
    const codingReport: RuntimeCodingReport = {
      ...codingRunTracker.getVerificationReport(),
      runId,
      approvalRequestCount,
    };
    if (!codingReport.workspaceChanged && !codingReport.pendingBackground && (codingReport.gitActions?.length ?? 0) === 0) return;
    input.persistCodingReport?.(codingReport);
    try {
      input.emitRuntimeEvent?.({
        id: `${runId}:coding-report:${Date.now()}`,
        type: "coding.report.updated",
        threadId: input.lumeSessionId,
        runId,
        createdAt: new Date().toISOString(),
        codingReport,
      });
    } catch (error) {
      log.warn("Failed to emit Coding report update", {
        sessionId: input.lumeSessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const handleToolExecution = (toolInput: Parameters<typeof codingRunTracker.observe>[0]): void => {
    codingRunTracker.observe(toolInput);
    const task = toolInput.result._meta?.task as { id?: string; status?: string } | undefined;
    if (input.runId && task?.id && task.status === "running") {
      const toolName = toolInput.toolName;
      const toolKind = toolName.toLowerCase() === "processoutput" ? "read" : "execute";
      const toolUseId = toolInput.result.tool_use_id || task.id;
      const now = new Date().toISOString();
      void createFileBackedRunContinuationStore(sessionDir).upsert({
        version: 2,
        runId: input.runId,
        threadId: input.lumeSessionId,
        status: "waiting_background",
        checkpoint: {
          step: "waiting_for_tool_result",
          toolCallId: toolUseId,
          toolName,
          toolKind,
          processJobId: task.id,
          toolCall: {
            id: toolUseId,
            name: toolName,
            input: toolInput.input,
            inputHash: createHash("sha256").update(JSON.stringify(toolInput.input ?? null)).digest("hex"),
            kind: toolKind
          }
        },
        reason: "后台命令已持久化，恢复时重新附着而不重复执行。",
        createdAt: now,
        updatedAt: now
      });
    }
    publishCodingReport();
  };
  const handleAsyncEvent = (event: SDKMessage): void => {
    const updatesCodingReport = codingRunTracker.observeAsyncEvent(event);
    if (input.runId && event.type === "system" && event.subtype === "task_notification" && event.status !== "attention") {
      const continuationStore = createFileBackedRunContinuationStore(sessionDir);
      void continuationStore.get(input.runId).then((continuation) => {
        if (!continuation || continuation.version !== 2 || continuation.checkpoint.processJobId !== event.task_id) return;
        return continuationStore.update(input.runId!, {
          status: "ready_to_resume",
          checkpoint: {
            ...continuation.checkpoint,
            step: "after_tool_result",
            syntheticToolResult: {
              type: "tool_result",
              tool_use_id: event.tool_use_id ?? continuation.checkpoint.toolCallId ?? "",
              content: event.message ?? event.summary ?? "",
              ...(event.status === "failed" || event.status === "stopped" || event.status === "interrupted"
                ? { is_error: true }
                : {}),
              ...(event.execution ? { _meta: { execution: event.execution } } : {})
            }
          },
          reason: `后台命令已进入终态：${event.status}。`
        });
      }).catch((error) => {
        log.warn("Failed to persist background continuation result", {
          sessionId: input.lumeSessionId,
          runId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    try {
      input.emitSdkMessage?.(event);
    } catch (error) {
      log.warn("Failed to emit asynchronous SDK event", {
        sessionId: input.lumeSessionId,
        runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!updatesCodingReport) return;
    void codingRunTracker.refreshChangeSet()
      .catch((error) => {
        log.warn("Failed to refresh Coding changes after background task completion", {
          sessionId: input.lumeSessionId,
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        publishCodingReport();
      });
  };
  const emitToolPermissionRequest = input.emitToolPermissionRequest
    ? (request: AgentToolPermissionRequest) => {
      approvalRequestCount += 1;
      input.emitToolPermissionRequest?.(request);
    }
    : undefined;
  const boundSubagentReportTool = boundSubagentIdentity
    ? createBoundSubagentTaskReportTool(boundSubagentIdentity)
    : undefined;
  const initialTodoState = await readLatestTodoState({
    sessionDir,
    threadId: input.lumeSessionId
  });
  let currentTodoState = cloneTodoState(initialTodoState);
  const handleTodoUpdated: Parameters<typeof createTodoTool>[0]["onTodoUpdated"] = async (state) => {
    currentTodoState = cloneTodoState(state);
    await input.emitTodoUpdated?.(state);
  };
  const sessionManager = createOrResumeRuntimeCoreSessionManager(input.cwd, input.lumeSessionId, input.agentDir);
  const agents = { ...buildBuiltinAgents(), ...loadCustomAgents(input.workspaceSlug) };
  const subagentDefinition = input.subagentType ? agents[input.subagentType] : undefined;
  // Phase 3b: registry → resolver → bridge. Command tools + skills come from the
  // PluginRuntimeBridge now; the SDK's loadPlugins path is no longer used (no
  // agentOptions.plugins). Plugin hooks are wired below (Phase 3d, buildPluginAgentHooks).
  const pluginConfig = getEffectivePluginRuntimeConfig(input.workspaceSlug);
  const computerUseConfig = getEffectiveLumeConfig(input.workspaceSlug).models?.computerUse;
  const channelProvider = input.modelRef
    ? resolveChannelModelBinding(input.modelRef, "chat")?.channel.provider ?? input.provider
    : input.provider;
  const computerUseSurface = resolveComputerUseSurface({
    agentSurface: computerUseConfig?.agentSurface,
    modelRef: input.modelRef,
    skyModelRefs: computerUseConfig?.skyModelRefs,
    channelProvider,
  });
  const pluginManager = new SidecarPluginManager();
  const registeredPlugins = await pluginManager.listRegistered({
    enabled: pluginConfig.enabled,
    // Do not auto-load project-local .lume/plugins just because the Agent cwd is a real project.
    directories: pluginConfig.directories,
  });
  const discoveredLspConfig = await resolveRuntimeLspConfig({
    cwd: input.cwd,
    user: getEffectiveLumeConfig(input.workspaceSlug).lsp,
    plugins: registeredPlugins,
  });
  const runLspConfig = input.toolConfig?.lsp && typeof input.toolConfig.lsp === "object" && !Array.isArray(input.toolConfig.lsp)
    ? input.toolConfig.lsp as Record<string, unknown>
    : undefined;
  const lspConfig = {
    ...discoveredLspConfig,
    ...(runLspConfig ?? {}),
    ...(discoveredLspConfig.servers || (runLspConfig?.servers && typeof runLspConfig.servers === "object")
      ? {
        servers: {
          ...(discoveredLspConfig.servers ?? {}),
          ...(runLspConfig?.servers && typeof runLspConfig.servers === "object"
            ? runLspConfig.servers as Record<string, unknown>
            : {}),
        },
      }
      : {}),
  };
  setLspIdleTimeout(lspConfig.idleTimeoutMs);
  const computerUsePlugin = registeredPlugins.find((plugin) => plugin.pluginId === "computer-use");
  log.info("Computer Use capability selected", {
    sessionId: input.lumeSessionId,
    runId: input.runId,
    computerUseSurface,
    pluginVersion: computerUsePlugin?.version,
    modelRef: input.modelRef,
  });
  const pluginAssembly = await assemblePluginRuntime(registeredPlugins);
  const runtimePluginAssembly: PluginRuntimeAssembly = {
    ...pluginAssembly,
    skills: filterComputerUseSkills(pluginAssembly.skills, computerUseSurface),
  };

  // Phase 3d: build agentOptions.hooks from resolved plugin hooks. Shell-command hooks
  // are gate-aware (§8.1): checkSensitiveCapability(hook:event:matcher) before spawn.
  const hookPermissionRuntime = new PluginPermissionRuntime({
    stateStore: new FilePluginStateStore(DEFAULT_PLUGIN_STATE_PATH),
  });
  const pluginAgentHooks = buildPluginAgentHooks({
    capabilities: pluginAssembly.hooks,
    runtime: hookPermissionRuntime,
    workspaceSlug: input.workspaceSlug,
    sandbox: input.processSandbox,
  });
  const agentHooks = { ...pluginAgentHooks };
  const advisorConfig = getEffectiveLumeConfig(input.workspaceSlug).models?.advisor;
  if (input.threadType !== "subagent" && advisorConfig?.defaultModelRef && advisorConfig.enabled !== false) {
    agentHooks.Stop = [
      ...(agentHooks.Stop ?? []),
      {
        hooks: [async (hookInput: Record<string, unknown>) => {
          try {
            const review = await runAdvisor({
              workspaceSlug: input.workspaceSlug,
              cwd: input.cwd,
              userMessage: input.userMessage,
              messages: hookInput.messages,
            });
            if (!review) return undefined;
            input.emitAdvisorReview?.(review);
          } catch (error) {
            log.warn("Advisor review failed", {
              sessionId: input.lumeSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return undefined;
        }],
      },
    ];
  }

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
    stdioSandbox: input.processSandbox,
    stdioCwd: input.cwd,
  });
  const askWikiOnly = getAgentThreadMeta(input.lumeSessionId)?.wikiProfile?.kind === "ask-wiki";
  const workspaceMcpManager = input.processSandbox?.processIsolation?.enabled
    ? new WorkspaceMcpManager({ stdioSandbox: input.processSandbox, stdioCwd: input.cwd })
    : getWorkspaceMcpManager();
  const pluginMcpRuntime = askWikiOnly ? { tools: [], diagnostics: [] } : await pluginMcpManager
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
  const enabledPlugins = buildEnabledPluginContext(registeredPlugins, runtimePluginAssembly);
  const workspaceMcpRuntime = input.workspaceSlug && !askWikiOnly
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
    filesRoot: input.filesRoot,
    plansRoot: input.plansRoot,
    artifactsRoot: input.artifactsRoot,
    sessionId: input.lumeSessionId,
    workspaceId: input.workspaceId,
    workspaceSlug: input.workspaceSlug,
    channelId: input.channelId,
    modelRef: input.modelRef,
    provider: input.provider,
    computerUseSurface,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    subagentDefinition,
    boundSubagentReportTool,
    fileReferenceBinding: input.fileReferenceBinding,
    messageMetadata: input.messageMetadata,
    originalUserInstruction: input.userMessage,
    emitSdkMessage: input.emitSdkMessage,
    emitRuntimeEvent: input.emitRuntimeEvent,
    emitAskUserQuestion: input.emitAskUserQuestion,
    emitBrowserAuthRequest: input.emitBrowserAuthRequest,
    emitDesktopActionRequest: input.emitDesktopActionRequest,
    emitToolPermissionRequest,
    emitTodoUpdated: handleTodoUpdated,
    initialTodoState,
    runId: input.runId,
    renderClient: getSidecarRenderClient(),
    pluginDiagnostics: pluginAssembly.diagnostics.map((d) => ({
      pluginName: d.pluginId,
      severity: d.severity,
      reason: d.message,
      ...(d.path ? { path: d.path } : {}),
      ...(d.code ? { code: d.code } : {}),
    })),
    pluginCommandTools: pluginAssembly.commandToolDefinitions,
    pluginMcpTools: pluginMcpRuntime.tools,
    wikiProposalEnabled: input.wikiProposalEnabled,
    mcpTools: replaceMcpResourceTools(workspaceMcpRuntime.tools, pluginAwareMcpResourceTools),
    mcpDiagnostics: [
      ...(workspaceMcpRuntime.diagnostics ?? []),
      ...(pluginMcpRuntime.diagnostics ?? []),
    ]
  });
  const contextTokenBudget = input.resolvedModel?.contextWindow ?? 32_000;
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
  const modelId = input.resolvedModel?.id ?? input.resolvedModelId;
  const promptCache = resolvePromptCachePolicy({
    channelProvider: input.channelProvider,
    provider: input.provider,
    model: modelId,
    threadId: input.lumeSessionId,
    baseUrl: input.resolvedModel?.baseUrl
  });
  const toolSchemaFingerprint = fingerprintToolSchema(toolset.tools);
  const toolSchemaTokens = estimateToolSchemaTokens(toolset.tools);

  const contextAssembly = await new ContextAssembler().assemble({
    threadId: input.lumeSessionId,
    runId,
    cwd: input.cwd,
    lumeWorkDir: input.lumeWorkDir,
    projectRoot: input.projectRoot,
    modelRef: input.modelRef,
    resolvedModelId: input.resolvedModel?.id ?? input.resolvedModelId,
    workspaceName: input.workspaceName,
    workspaceSlug: input.workspaceSlug,
    threadType: input.threadType,
    chatType: input.chatType,
    permissionMode: input.permissionMode,
    automationExecution: isAutomationExecution(input.messageMetadata),
    agentSystemPrompt: boundSubagentIdentity
      ? [
          subagentDefinition?.prompt,
          "You are executing one bound Subagent Task. Do not create nested subagents or change the task acceptance criteria. Before ending this run, call TaskReport with submitted, failed, or blocked status and a concise summary. TaskReport is a submission to the parent agent, never final acceptance.",
          `Bound task: ${boundSubagentIdentity.taskId}; attempt: ${input.subagentAttempt ?? 1}.`
        ].filter(Boolean).join("\n\n")
      : subagentDefinition?.prompt,
    userMessage: input.userMessage ?? "",
    messageAttachments: input.messageAttachments,
    availableTools: toolset.availableToolNames,
    enabledPlugins,
    tokenBudget: contextTokenBudget,
    toolSchemaFingerprint,
    toolSchemaTokens,
    cacheStrategy: promptCache.strategy,
    workflowContext,
    desktopContext,
    todoState: initialTodoState,
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
  const unresolvedSubagentTasks = input.threadType === "subagent"
    ? []
    : getSubagentCoordinator().list(input.lumeSessionId).tasks.filter((task) => task.status === "open" || task.status === "running" || task.status === "awaiting_review");
  const systemPrompt = contextAssembly.systemPrompt;
  const runtimeContext = [
    contextAssembly.runtimeContext,
    buildSubagentWorkContext(unresolvedSubagentTasks)
  ].filter(Boolean).join("\n\n");
  const context = sessionManager.buildSessionContext();
  const existingCompletionGuard = boundSubagentIdentity
    ? () => getSubagentCoordinator().getRunCompletionBlocker(boundSubagentIdentity.runId)
    : input.runId
      ? () => getSubagentCoordinator().getCompletionBlocker(input.lumeSessionId, input.runId!)
      : undefined;
  const completionGuard = async (): Promise<CompletionGuardResult> => {
    const existing = await existingCompletionGuard?.();
    if (existing) return existing;
    const coding = await codingRunTracker.completionGuard();
    return coding ?? getTodoCompletionBlocker(currentTodoState);
  };
  const codingCompletionEnabled = !(
    input.subagentRunId
    && input.subagentTaskId
    && !input.runId
    && !boundSubagentIdentity
  );
  const preferredCapabilityRoute = typeof input.messageMetadata?.preferredCapabilityRoute === "string"
    ? input.messageMetadata.preferredCapabilityRoute
    : undefined;
  const enableFileCheckpointing = preferredCapabilityRoute === "coding"
    || preferredCapabilityRoute === "raw-tools";
  const additionalDirectories = [...new Set([
    ...(input.additionalDirectories ?? []),
    input.lumeWorkDir,
    input.artifactsRoot,
  ].filter((directory): directory is string => Boolean(directory))
    .map((directory) => resolve(directory))
    .filter((directory) => directory !== resolve(input.cwd)))];
  const toolContinuation = resolvePersistedToolContinuation(input.messageMetadata);
  const runtimeToolConfig = {
    ...(input.toolConfig ?? {}),
    ...(Object.keys(lspConfig).length > 0 ? { lsp: lspConfig } : {}),
  };

  const agentOptions: AgentOptions = {
    apiType: resolveSdkApiType(input.provider, input.openaiApiMode),
    apiKey: input.apiKey,
    ...(input.resolvedModel?.baseUrl ? { baseURL: input.resolvedModel.baseUrl } : {}),
    model: input.resolvedModel?.id ?? input.resolvedModelId,
    cwd: input.cwd,
    threadType: input.threadType,
    artifactsRoot: input.artifactsRoot,
    ...(Object.keys(runtimeToolConfig).length > 0 ? { toolConfig: runtimeToolConfig } : {}),
    onAsyncEvent: handleAsyncEvent,
    onToolExecution: handleToolExecution,
    onBeforeToolExecution: codingRunTracker.beforeToolExecution,
    systemPrompt,
    runtimeContext,
    promptCache,
    tools: toolset.tools,
    sessionId: input.lumeSessionId,
    ...(toolContinuation ? { toolContinuation } : {}),
    ...(hasRuntimeCoreSessionTranscript(input.lumeSessionId, input.agentDir)
      ? { resume: input.lumeSessionId }
      : {}),
    ...(Object.keys(agentHooks).length > 0 ? { hooks: agentHooks } : {}),
    agents,
    permissionMode: input.permissionMode === "bypassPermissions" ? "bypassPermissions" : "default",
    includePartialMessages: true,
    skillsDirectories: resolveSkillDirectories(input.cwd, input.workspaceSlug),
    shouldLoadFilesystemSkill: createRuntimeSkillFilter(input.workspaceSlug),
    skills: runtimePluginAssembly.skills,
    resolveRuntimeTools: (tools, runtimeContext) => ToolRuntime.resolveDynamicTools({
      tools,
      requiredTools: boundSubagentReportTool ? [boundSubagentReportTool] : undefined,
      cwd: input.cwd,
      sessionId: input.lumeSessionId,
      threadType: runtimeContext.threadType ?? input.threadType,
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
    ...(codingCompletionEnabled && (input.userMessage?.trim() || existingCompletionGuard)
      ? { completionGuard }
      : {}),
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
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
    persistSession: true,
    enableFileCheckpointing
  };

  const agent = createAgent(agentOptions);
  if (
    (preferredCapabilityRoute === "coding" || preferredCapabilityRoute === "raw-tools")
    && lspConfig?.enabled !== false
    && lspConfig?.lazy !== true
  ) {
    void warmupLspClients(input.cwd, agentOptions.toolConfig, 5_000).catch(() => undefined);
  }
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
      getComputerUseSessionRegistry().clear(input.lumeSessionId);
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
      if (input.workspaceSlug && input.processSandbox?.processIsolation?.enabled) {
        await workspaceMcpManager.disposeWorkspace(input.workspaceSlug).catch((error) => {
          log.warn("Sandboxed workspace MCP dispose failed", {
            sessionId: input.lumeSessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
      clearRuntimeToolDescriptors(input.lumeSessionId);
      clearRuntimeFileAccessLedger(input.lumeSessionId);
    }
  };

  const userMessageForModel = buildRuntimeUserMessageInput({
    userMessage: contextAssembly.userMessageForModel,
    contentBlocks: contextAssembly.userMessageContentBlocks,
    attachments: input.messageAttachments,
    visionSupported: input.resolvedModel?.input?.includes("image") === true,
    workspaceSlug: input.workspaceSlug,
    threadId: input.lumeSessionId
  });

  return {
    agent,
    session,
    sessionManager,
    systemPrompt,
    runtimeContext,
    userMessageForModel,
    memoryContextUsedItems: contextAssembly.memoryContextUsedItems,
    tools: resolvedTools,
    getVerificationStatus: codingRunTracker.getVerificationStatus,
    beforeToolExecution: codingRunTracker.beforeToolExecution,
    getBaselineCommit: codingRunTracker.getBaselineCommit,
    getBaselineCommits: codingRunTracker.getBaselineCommits,
    getWorkspaceRoots: () => [resolve(input.cwd), ...additionalDirectories],
    refreshCodingChangeSet: codingRunTracker.refreshChangeSet,
    getLatestFileCheckpoint: () => agent.getLatestFileCheckpoint(),
    getVerificationReport: () => ({
      ...codingRunTracker.getVerificationReport(),
      approvalRequestCount
    })
  };
}

function resolvePersistedToolContinuation(
  metadata: Record<string, unknown> | undefined,
): PersistedToolContinuation | undefined {
  const runtimeContinuation = metadata?.runtimeContinuation;
  if (!runtimeContinuation || typeof runtimeContinuation !== "object") return undefined;
  const record = runtimeContinuation as Record<string, unknown>;
  const checkpoint = record.checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return undefined;
  const checkpointRecord = checkpoint as Record<string, unknown>;
  const toolCall = checkpointRecord.toolCall;
  if (!toolCall || typeof toolCall !== "object") return undefined;
  const call = toolCall as Record<string, unknown>;
  if (typeof call.id !== "string" || typeof call.name !== "string") return undefined;
  const inputHash = createHash("sha256").update(JSON.stringify(call.input ?? null)).digest("hex");
  if (typeof call.inputHash === "string" && call.inputHash !== inputHash) {
    throw new Error("cold-start continuation 的工具输入指纹不匹配");
  }
  const synthetic = checkpointRecord.syntheticToolResult;
  const toolResult = synthetic && typeof synthetic === "object"
    ? synthetic as ToolResult
    : synthetic === undefined ? undefined : {
      type: "tool_result" as const,
      tool_use_id: call.id,
      content: typeof synthetic === "string" ? synthetic : JSON.stringify(synthetic),
    };
  return {
    toolCall: {
      id: call.id,
      name: call.name,
      input: call.input,
    },
    ...(toolResult ? {
      toolResult: {
        ...toolResult,
        type: "tool_result",
        tool_use_id: call.id,
      },
    } : {}),
  };
}

function parseTaskRef(value: unknown, parentThreadId: string): AgentTaskRef {
  if (!value || typeof value !== "object") throw new Error("task_ref must be { taskListId, taskId, claimToken }");
  const ref = value as Record<string, unknown>;
  if (typeof ref.taskListId !== "string" || typeof ref.taskId !== "string" || typeof ref.claimToken !== "string") {
    throw new Error("task_ref must contain taskListId, taskId, and claimToken");
  }
  if (ref.taskListId !== parentThreadId) throw new Error("task_ref.taskListId must match the parent main thread");
  return { taskListId: ref.taskListId, taskId: ref.taskId, claimToken: ref.claimToken };
}

function assertTaskRefDiscriminant(toolInput: Record<string, unknown>): void {
  const forbidden = ["task_id", "new_task", "acceptance_criteria", "expected_artifacts", "subagent_id", "team_name", "isolation"];
  const present = forbidden.filter((name) => toolInput[name] !== undefined);
  if (present.length > 0) throw new Error(`task_ref cannot be combined with legacy coordinator fields: ${present.join(", ")}`);
}

async function runTaskLinkedSubagent(input: {
  toolInput: Record<string, unknown>;
  context: ToolContext;
  taskStore: FileBackedTaskStore;
  taskRef: AgentTaskRef;
  parentThreadId: string;
  modelOverride: ResolvedSubagentModelOverride;
  workspaceId?: string;
  workspaceSlug?: string;
  channelId?: string;
  chatType?: AgentSendInput["chatType"];
  messageMetadata?: Record<string, unknown>;
  fileReferenceBinding?: FileReferenceBinding;
  permissionMode?: AgentSendInput["permissionMode"];
  emitRuntimeEvent?: (event: LumeRuntimeEvent) => void;
  emitAskUserQuestion?: (request: AgentAskUserQuestionRequest) => void;
  emitBrowserAuthRequest?: (request: AgentBrowserAuthRequest) => void;
  emitDesktopActionRequest?: (request: AgentDesktopActionRequest) => void;
  emitToolPermissionRequest?: (request: AgentToolPermissionRequest) => void;
}): Promise<ToolResult> {
  const actor = { threadId: input.parentThreadId, threadType: "main" as const, actorId: `main:${input.parentThreadId}` };
  const current = await input.taskStore.get(input.taskRef.taskId, actor);
  if (!current || current.claimToken !== input.taskRef.claimToken) throw new Error("task_ref claim is missing or expired");
  const executorRef = crypto.randomUUID();
  await input.taskStore.bindExecutor({
    taskId: input.taskRef.taskId,
    claimToken: input.taskRef.claimToken,
    expectedRevision: current.revision,
    executorRef,
  }, actor);
  let childThreadId: string | undefined;
  let execution: Awaited<ReturnType<typeof runSidecarSubagent>>;
  try {
    const childMeta = createAgentThreadWithModelRef(
      typeof input.toolInput.description === "string" ? input.toolInput.description : "Task executor",
      input.modelOverride.modelRef,
      input.modelOverride.channelId ?? input.channelId,
      input.workspaceId,
      input.parentThreadId,
      input.modelOverride.resolvedModelId ?? input.context.model,
      { fileContextMode: "inherit" }
    );
    childThreadId = childMeta.id;
    taskExecutorStopHandlers.set(executorRef, () => {
      void import("./attempt").then((module) => module.stopAgentRuntime(childMeta.id)).catch(() => undefined);
    });
    const forwardedInput = { ...input.toolInput };
    delete forwardedInput.task_ref;
    execution = await runSidecarSubagent({
      toolInput: forwardedInput,
      context: input.context,
      runId: executorRef,
      childThreadId: childMeta.id,
      parentThreadId: input.parentThreadId,
      deliveryThreadId: input.parentThreadId,
      parentToolUseId: input.context.toolUseId,
      subagentType: typeof input.toolInput.subagent_type === "string" ? input.toolInput.subagent_type : undefined,
      modelOverride: input.modelOverride,
      channelId: input.channelId,
      workspaceId: input.workspaceId,
      chatType: input.chatType,
      messageMetadata: input.messageMetadata,
      fileReferenceBinding: input.fileReferenceBinding,
      onRuntimeEvent: input.emitRuntimeEvent,
      permissionMode: input.permissionMode,
      emitAskUserQuestion: input.emitAskUserQuestion,
      emitBrowserAuthRequest: input.emitBrowserAuthRequest,
      emitDesktopActionRequest: input.emitDesktopActionRequest,
      emitToolPermissionRequest: input.emitToolPermissionRequest,
    });
  } catch (error) {
    execution = {
      status: "errored",
      error: error instanceof Error ? error.message : String(error),
      result: { type: "tool_result", tool_use_id: "", content: error instanceof Error ? error.message : String(error), is_error: true },
    };
  } finally {
    taskExecutorStopHandlers.delete(executorRef);
  }
  const ack = await input.taskStore.acknowledgeExecutor({
    taskId: input.taskRef.taskId,
    claimToken: input.taskRef.claimToken,
    executorRef,
    terminal: true,
    error: execution.error,
    resultSummary: execution.completionSummary ?? execution.output,
    resultStatus: execution.status,
  }, actor);
  if (execution.status !== "completed") {
    const latest = await input.taskStore.get(input.taskRef.taskId, actor);
    if (latest?.task.status === "in_progress") {
      await input.taskStore.update({
        taskId: input.taskRef.taskId,
        status: "pending",
        expectedRevision: latest.revision,
        claimToken: input.taskRef.claimToken,
      }, actor);
    }
  }
  return {
    ...execution.result,
    content: JSON.stringify({
      taskRef: input.taskRef,
      executorRef,
      ...(childThreadId ? { childThreadId } : {}),
      status: execution.status,
      output: execution.output,
      ...(execution.error ? { error: execution.error } : {}),
      taskRevision: ack.revision,
    }),
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
