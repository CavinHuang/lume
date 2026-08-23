/**
 * runtime-core 子代理执行器(#177 自 run.ts 拆出,纯移动):
 * bound/task-linked/Delegate 子代理的模型覆盖解析、运行上下文构造、
 * 前台超时执行、task_ref 校验与委托守卫。
 */
import type { CreateRuntimeCoreSessionInput } from "./run";
import { getRuntimeCoreEntry } from "./runtime-entry";
import {
  type Agent,
  type ApiType,
  type ToolContext,
  type ToolResult,
  defineTool,
  finalizeSubagentOutputFromState,
  summarizeSubagentAssistantEvent,
  type ToolDefinition,
} from "@lume/agent-sdk";
import type {
  AgentAskUserQuestionRequest,
  AgentBrowserAuthRequest,
  AgentDesktopActionRequest,
  AgentSendInput,
  AgentToolPermissionRequest,
  LumeRuntimeEvent,
  FileReferenceBinding,
  SubagentTaskReport,
  SubagentTask,
  SubagentTaskFeedback,
  AgentTaskRef,
} from "@lume/shared";
import { join, resolve } from "node:path";
import { resolveConfiguredConnectionApiType } from "../../model-runtime/connection-provider";
import { getEffectiveLumeConfig } from "../../system/lume-config-service";
import {
  clampSubagentPermissionMode,
  resolveSubagentSpawnPolicy,
} from "../subagents/subagent-policy";
import { getSubagentRunRegistry } from "../subagents/subagent-run-registry";
import { getSubagentCoordinator } from "../subagents/subagent-coordinator";
import { getRuntimeHostPorts } from "../host-ports";
import { FileBackedTaskStore } from "../task/task-store";

const DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const taskExecutorStopHandlers = new Map<string, () => void>();
interface BoundSubagentIdentity {
  runId: string;
  taskId: string;
}

export function resolveBoundSubagentIdentity(
  input: Pick<
    CreateRuntimeCoreSessionInput,
    "threadType" | "subagentRunId" | "subagentTaskId"
  >,
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
interface ResolvedSubagentModelOverride {
  source: "input" | "config" | "inherit";
  modelRef?: string;
  channelId?: string;
  resolvedModelId?: string;
  apiType?: ApiType;
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
    getEffectiveLumeConfig(input.workspaceSlug).models?.subagent
      ?.defaultModelRef,
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

  const binding = getRuntimeHostPorts().resolveChannelModelBinding(candidate, "chat");
  if (!binding) {
    return { source };
  }

  return {
    source,
    modelRef: candidate,
    channelId: binding.channel.id,
    resolvedModelId: binding.modelId,
    apiType: resolveConfiguredConnectionApiType(
      binding.channel,
      binding.modelId,
    ),
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
  const task =
    typeof input.toolInput.prompt === "string" ? input.toolInput.prompt : "";
  const label =
    typeof input.toolInput.description === "string"
      ? input.toolInput.description
      : undefined;
  const agentId =
    typeof input.toolInput.subagent_type === "string"
      ? input.toolInput.subagent_type
      : undefined;

  return {
    runId,
    childThreadId,
    forwardedToolInput: {
      ...input.toolInput,
      subagent_run_id: runId,
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
      status: "running",
    },
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
    ...(input.modelOverride.resolvedModelId
      ? { model: input.modelOverride.resolvedModelId }
      : {}),
  };
}

export async function runSidecarSubagent(input: {
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
  planningClientSubmissionId?: string;
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
  const prompt =
    typeof input.toolInput.prompt === "string" ? input.toolInput.prompt : "";
  const subagentType =
    typeof input.toolInput.subagent_type === "string"
      ? input.toolInput.subagent_type
      : input.subagentType;
  const resolvedChannelId = input.modelOverride.channelId ?? input.channelId;
  const resolvedModelId =
    input.modelOverride.resolvedModelId ?? input.context.model;
  if (!resolvedChannelId || !resolvedModelId) {
    return {
      status: "errored",
      error: "subagent 缺少 channelId/modelId",
      result: {
        type: "tool_result",
        tool_use_id: "",
        content: "Subagent error: subagent 缺少 channelId/modelId",
        is_error: true,
      },
    };
  }

  const { runAgentRuntime } = getRuntimeCoreEntry();
  // 收口契约：模型可控的子代理权限模式一律经此钳制，子级特权不得高于父线程
  // （sendAgentMessage 直派子代理的路径当前均非模型可控，不在此范围）
  const requestedPermissionMode =
    typeof input.toolInput.mode === "string" ? input.toolInput.mode : undefined;
  const childPermissionMode = clampSubagentPermissionMode(
    requestedPermissionMode,
    input.permissionMode,
  );
  const permissionModeAdjusted =
    requestedPermissionMode !== undefined &&
    requestedPermissionMode !== childPermissionMode;
  let textOutput = "";
  let lastAssistantMessage = "";
  const toolCalls: string[] = [];
  let subagentStatus: "completed" | "errored" | "aborted" = "completed";
  let subagentErrorMessage = "";

  const runtimeResult = await runAgentRuntime(
    {
      input: {
        threadId: input.childThreadId,
        userMessage: prompt,
        ...(input.modelOverride.modelRef
          ? { modelRef: input.modelOverride.modelRef }
          : {}),
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
          ...(typeof (
            input.messageMetadata?.traceContext as
              { traceId?: unknown } | undefined
          )?.traceId === "string"
            ? {
                parentTraceId: (
                  input.messageMetadata?.traceContext as { traceId: string }
                ).traceId,
              }
            : {}),
        },
        messageMetadata: input.messageMetadata,
      },
      runtime: {
        sessionId: input.childThreadId,
        deliveryThreadId: input.deliveryThreadId,
        subagentRunId: input.runId,
        subagentId: input.subagentId,
        subagentTaskId: input.subagentTaskId,
        subagentAttempt: input.subagentAttempt,
        ...(subagentType ? { subagentType } : {}),
        ...(input.modelOverride.modelRef
          ? { modelRef: input.modelOverride.modelRef }
          : {}),
        channelId: resolvedChannelId,
        resolvedModelId,
        workspaceId: input.workspaceId,
        threadType: "subagent",
        fileReferenceBinding: input.fileReferenceBinding,
      },
    },
    {
      onSdkMessage: (message) => {
        if (message.type === "assistant") {
          const summary = summarizeSubagentAssistantEvent(
            message.message.content as Array<Record<string, unknown>>,
            textOutput,
            toolCalls,
          );
          textOutput = summary.textOutput;
          lastAssistantMessage =
            summary.lastAssistantMessage || lastAssistantMessage;
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
          ].find(
            (value) => typeof value === "string" && value.trim().length > 0,
          );
          if (
            message.is_error ||
            (typeof message.subtype === "string" &&
              message.subtype !== "success")
          ) {
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
      onToolPermissionRequest:
        input.emitToolPermissionRequest ?? (() => undefined),
    },
  );

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
    status: subagentStatus,
  });
  // 钳制/归一发生时向模型声明实际生效的模式，避免其误以为拿到了更高权限而重试
  const outputWithModeNote =
    permissionModeAdjusted && childPermissionMode
      ? `${finalized.output}\n\n[子代理权限模式: ${requestedPermissionMode} → ${childPermissionMode}（不得超过父线程权限）]`
      : finalized.output;

  return {
    status: subagentStatus,
    output: outputWithModeNote,
    ...(finalized.lastAssistantMessage
      ? { completionSummary: finalized.lastAssistantMessage }
      : {}),
    ...(subagentErrorMessage ? { error: subagentErrorMessage } : {}),
    result: {
      type: "tool_result",
      tool_use_id: "",
      content: outputWithModeNote,
      ...(subagentStatus !== "completed" ? { is_error: true } : {}),
    },
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
          is_error: true,
        },
      });
    }, input.timeoutMs);
    if (
      typeof timeoutId === "object" &&
      "unref" in timeoutId &&
      typeof timeoutId.unref === "function"
    ) {
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

export function resolveForegroundSubagentTimeoutMs(): number {
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
export function createBoundSubagentTaskReportTool(input: {
  runId: string;
  taskId: string;
}): ToolDefinition {
  return defineTool({
    name: "TaskReport",
    description:
      "Submit the current subagent task result. This is a submission for main-agent review, not acceptance.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["submitted", "failed", "blocked"] },
        summary: { type: "string" },
        completedWork: { type: "array", items: { type: "string" } },
        remainingWork: { type: "array", items: { type: "string" } },
        artifacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              description: { type: "string" },
            },
            required: ["path"],
          },
        },
        verification: {
          type: "array",
          items: {
            type: "object",
            properties: {
              command: { type: "string" },
              result: { type: "string" },
              passed: { type: "boolean" },
            },
            required: ["result", "passed"],
          },
        },
        blockers: { type: "array", items: { type: "string" } },
      },
      required: ["status", "summary"],
    },
    isReadOnly: false,
    isConcurrencySafe: false,
    async call(raw) {
      const report = normalizeBoundSubagentReport(raw);
      getSubagentCoordinator().submitReport({ runId: input.runId, report });
      return {
        data: {
          ok: true,
          taskId: input.taskId,
          runId: input.runId,
          status: report.status,
        },
      };
    },
  });
}

function normalizeBoundSubagentReport(raw: unknown): SubagentTaskReport {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const status = value.status;
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (
    (status !== "submitted" && status !== "failed" && status !== "blocked") ||
    !summary
  ) {
    throw new Error(
      "TaskReport 需要 status(submitted|failed|blocked) 和非空 summary",
    );
  }
  const strings = (name: string) =>
    Array.isArray(value[name])
      ? value[name]
          .filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          )
          .map((item) => item.trim())
      : undefined;
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts.flatMap((item) => {
        const record =
          item && typeof item === "object"
            ? (item as Record<string, unknown>)
            : {};
        return typeof record.path === "string" && record.path.trim()
          ? [
              {
                path: record.path.trim(),
                ...(typeof record.description === "string" &&
                record.description.trim()
                  ? { description: record.description.trim() }
                  : {}),
              },
            ]
          : [];
      })
    : undefined;
  const verification = Array.isArray(value.verification)
    ? value.verification.flatMap((item) => {
        const record =
          item && typeof item === "object"
            ? (item as Record<string, unknown>)
            : {};
        return typeof record.result === "string" &&
          typeof record.passed === "boolean"
          ? [
              {
                result: record.result,
                passed: record.passed,
                ...(typeof record.command === "string" && record.command.trim()
                  ? { command: record.command.trim() }
                  : {}),
              },
            ]
          : [];
      })
    : undefined;
  return {
    status,
    summary,
    ...(strings("completedWork")?.length
      ? { completedWork: strings("completedWork") }
      : {}),
    ...(strings("remainingWork")?.length
      ? { remainingWork: strings("remainingWork") }
      : {}),
    ...(artifacts?.length ? { artifacts } : {}),
    ...(verification?.length ? { verification } : {}),
    ...(strings("blockers")?.length ? { blockers: strings("blockers") } : {}),
  };
}

export function buildSubagentTaskInstruction(
  task: SubagentTask,
  feedback: SubagentTaskFeedback[],
): string {
  const latestFeedback = feedback.at(-1)?.instruction;
  return [
    "## Bound task",
    task.objective,
    task.acceptanceCriteria.length
      ? `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
      : undefined,
    task.expectedArtifacts?.length
      ? `Expected artifacts:\n${task.expectedArtifacts.map((item) => `- ${item}`).join("\n")}`
      : undefined,
    latestFeedback && latestFeedback !== task.objective
      ? `## Parent feedback for this attempt\n${latestFeedback}`
      : undefined,
    "Complete only this task, then submit TaskReport.",
  ]
    .filter((item): item is string => Boolean(item))
    .join("\n\n");
}
export function parseTaskRef(
  value: unknown,
  parentThreadId: string,
): AgentTaskRef {
  if (!value || typeof value !== "object")
    throw new Error("task_ref must be { taskListId, taskId, claimToken }");
  const ref = value as Record<string, unknown>;
  if (
    typeof ref.taskListId !== "string" ||
    typeof ref.taskId !== "string" ||
    typeof ref.claimToken !== "string"
  ) {
    throw new Error("task_ref must contain taskListId, taskId, and claimToken");
  }
  if (ref.taskListId !== parentThreadId)
    throw new Error("task_ref.taskListId must match the parent main thread");
  return {
    taskListId: ref.taskListId,
    taskId: ref.taskId,
    claimToken: ref.claimToken,
  };
}

export function assertTaskRefDiscriminant(
  toolInput: Record<string, unknown>,
): void {
  const forbidden = [
    "task_id",
    "new_task",
    "acceptance_criteria",
    "expected_artifacts",
    "subagent_id",
    "team_name",
    "isolation",
  ];
  const present = forbidden.filter((name) => toolInput[name] !== undefined);
  if (present.length > 0)
    throw new Error(
      `task_ref cannot be combined with legacy coordinator fields: ${present.join(", ")}`,
    );
}

export async function runTaskLinkedSubagent(input: {
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
  const actor = {
    threadId: input.parentThreadId,
    threadType: "main" as const,
    actorId: `main:${input.parentThreadId}`,
  };
  const current = await input.taskStore.get(input.taskRef.taskId, actor);
  if (!current || current.claimToken !== input.taskRef.claimToken)
    throw new Error("task_ref claim is missing or expired");
  const executorRef = crypto.randomUUID();
  await input.taskStore.bindExecutor(
    {
      taskId: input.taskRef.taskId,
      claimToken: input.taskRef.claimToken,
      expectedRevision: current.revision,
      executorRef,
    },
    actor,
  );
  let childThreadId: string | undefined;
  let execution: Awaited<ReturnType<typeof runSidecarSubagent>>;
  try {
    const childMeta = getRuntimeHostPorts().createThreadWithModelRef(
      typeof input.toolInput.description === "string"
        ? input.toolInput.description
        : "Task executor",
      input.modelOverride.modelRef,
      input.modelOverride.channelId ?? input.channelId,
      input.workspaceId,
      input.parentThreadId,
      input.modelOverride.resolvedModelId ?? input.context.model,
      { fileContextMode: "inherit" },
    );
    childThreadId = childMeta.id;
    taskExecutorStopHandlers.set(executorRef, () => {
      Promise.resolve()
        .then(() => getRuntimeCoreEntry().stopAgentRuntime(childMeta.id))
        .catch(() => undefined);
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
      subagentType:
        typeof input.toolInput.subagent_type === "string"
          ? input.toolInput.subagent_type
          : undefined,
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
      result: {
        type: "tool_result",
        tool_use_id: "",
        content: error instanceof Error ? error.message : String(error),
        is_error: true,
      },
    };
  } finally {
    taskExecutorStopHandlers.delete(executorRef);
  }
  const ack = await input.taskStore.acknowledgeExecutor(
    {
      taskId: input.taskRef.taskId,
      claimToken: input.taskRef.claimToken,
      executorRef,
      terminal: true,
      error: execution.error,
      resultSummary: execution.completionSummary ?? execution.output,
      resultStatus: execution.status,
    },
    actor,
  );
  if (execution.status !== "completed") {
    const latest = await input.taskStore.get(input.taskRef.taskId, actor);
    if (latest?.task.status === "in_progress") {
      await input.taskStore.update(
        {
          taskId: input.taskRef.taskId,
          status: "pending",
          expectedRevision: latest.revision,
          claimToken: input.taskRef.claimToken,
        },
        actor,
      );
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

export function getResolvedAgentTools(
  agent: Agent,
  fallback: ToolDefinition[],
): ToolDefinition[] {
  const tools = (agent as unknown as { toolPool?: ToolDefinition[] }).toolPool;
  return Array.isArray(tools) ? tools : fallback;
}

/**
 * D7 一级深度拦截：当前父 thread 若本身是某个 subagent run 的 child，
 * 则禁止再 delegate（仅允许一级委托）。
 * 比 resolveSubagentSpawnPolicy 的 maxDepth 更严格。
 */
export function canDelegateFromThread(parentThreadId: string): {
  ok: boolean;
  error?: string;
} {
  const parentRun =
    getSubagentRunRegistry().getLatestByChildThread(parentThreadId);
  const parentMeta = getRuntimeHostPorts().getThreadMeta(parentThreadId);
  if (parentRun || parentMeta?.parentThreadId) {
    return {
      ok: false,
      error: "委托子会话不能再创建新的委托子会话（仅允许一级）",
    };
  }
  return { ok: true };
}

/**
 * 子会话完成时用输出摘要派生标题。
 * output 非空→取前 20 字（折叠空白）；否则保留原标题。
 */
export function deriveDelegateTitle(
  originalTitle: string | undefined,
  output: string | undefined,
): string | undefined {
  if (output && output.trim().length > 0) {
    const trimmed = output.trim().replace(/\s+/g, " ");
    return Array.from(trimmed).slice(0, 20).join("");
  }
  return originalTitle;
}
