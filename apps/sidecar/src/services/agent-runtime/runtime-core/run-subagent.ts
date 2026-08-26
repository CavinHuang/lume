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
import { getRuntimeHostPorts } from "../host-ports";
import { FileBackedTaskStore } from "../task/task-store";

const DEFAULT_FOREGROUND_SUBAGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const taskExecutorStopHandlers = new Map<string, () => void>();

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
    // isolation 剥离已随 Agent schema 删参一并移除（#575）：schema 不再声明
    // 该字段，历史剥离点只是死代码；模型幻觉出的未知字段按普通透传处理。
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
  // 钳制/归一发生时向模型声明实际生效的模式，避免其误以为拿到了更高权限而重试；
  // 组装逻辑抽入 composeSidecarRunOutput 以便接线级测试（#729 review）
  const output = composeSidecarRunOutput({
    baseOutput: finalized.output,
    status: subagentStatus,
    codingReport: runtimeResult.codingReport,
    permissionModeAdjusted,
    requestedPermissionMode,
    childPermissionMode,
  });

  return {
    status: subagentStatus,
    output,
    ...(finalized.lastAssistantMessage
      ? { completionSummary: finalized.lastAssistantMessage }
      : {}),
    ...(subagentErrorMessage ? { error: subagentErrorMessage } : {}),
    result: {
      type: "tool_result",
      tool_use_id: "",
      content: output,
      ...(subagentStatus !== "completed" ? { is_error: true } : {}),
    },
  };
}

/** touched-files 回传上限：防巨型重构把父级上下文撑爆。 */
const MAX_REPORTED_CHANGED_FILES = 20;

/** 单行折断：模型可控字符串进结果注记前统一封换行/制表（#729 review 安全方向）。 */
function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ");
}

/**
 * 结果输出组装的完整管线：权限钳制注记在前、touched-files 清单收尾。
 * 抽出为独立导出是接线级测试面——runSidecarSubagent 本体直调不可行级 mock
 * （见 run.delegate.test S2 注释），漏传 codingReport 之类接线回归在此钉死。
 */
export function composeSidecarRunOutput(input: {
  baseOutput: string;
  status: "completed" | "errored" | "aborted" | "timed_out";
  codingReport?: { changedFiles?: string[] };
  permissionModeAdjusted: boolean;
  requestedPermissionMode?: string;
  childPermissionMode?: string;
}): string {
  const withModeNote =
    input.permissionModeAdjusted && input.childPermissionMode
      ? `${input.baseOutput}\n\n[子代理权限模式: ${sanitizeSingleLine(String(input.requestedPermissionMode))} → ${sanitizeSingleLine(String(input.childPermissionMode))}（不得超过父线程权限）]`
      : input.baseOutput;
  return appendSubagentChangedFiles(withModeNote, input.status, input.codingReport);
}

/**
 * 子代理变更文件清单随结果回传（#575 残余收口）：tracker 数据闭锁在子线程
 * run 内部，经 AgentRuntimeRunResult.codingReport 既有通道带出，父级无需新
 * 订阅链路。仅成功运行附列——失败/中止的半成品清单只会误导父级。
 */
export function appendSubagentChangedFiles(
  output: string,
  status: "completed" | "errored" | "aborted" | "timed_out",
  report: { changedFiles?: string[] } | undefined,
): string {
  if (status !== "completed") return output;
  const changedFiles = (report?.changedFiles ?? []).filter(
    (path) => typeof path === "string" && path.trim(),
  ).map((path) =>
    // 换行/控制字符会折断单行清单格式甚至伪造追加行（#729 review 安全方向）
    sanitizeSingleLine(path),
  );
  if (changedFiles.length === 0) return output;
  const listed = changedFiles.slice(0, MAX_REPORTED_CHANGED_FILES);
  const overflow = changedFiles.length > MAX_REPORTED_CHANGED_FILES
    ? `, +${changedFiles.length - MAX_REPORTED_CHANGED_FILES} more`
    : "";
  return `${output}\n\n[Changed files: ${listed.join(", ")}${overflow}]`;
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
  completionSummary?: string;
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
      const stopped = await input.stopSubagent(input.childThreadId).catch(() => false);
      // 取消未确认时必须如实披露：子会话可能仍在运行，调用方据此提示用户
      const cancelNote = stopped ? "" : " Automatic cancellation was not confirmed; the child session may still be running.";
      // 超时文案必须指路后台模式（#575）：前台默认 10 分钟强杀，重型任务
      // 不指路 run_in_background 会让模型反复重试同一注定超时的调用。
      const error = `Subagent timed out after ${input.timeoutMs}ms and was cancelled.${cancelNote} For long-running work, relaunch with run_in_background: true and collect the result via WaitForDelegations instead of blocking the foreground.`;
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
    // task_ref 子代理与前台委派同纪律，受同一 wall-clock 上限保护（#647 P1-3）：
    // 超时取消后 status="timed_out" 走下方 acknowledge(terminal) + 回退 pending
    // 的既有失败链路，主 run 不会因子代理死循环/网络挂起而永久阻塞。
    execution = await runForegroundSubagentWithTimeout({
      execution: runSidecarSubagent({
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
      }),
      childThreadId: childMeta.id,
      timeoutMs: resolveForegroundSubagentTimeoutMs(),
      stopSubagent: async (threadId: string) =>
        getRuntimeCoreEntry().stopAgentRuntime(threadId),
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

export function getResolvedAgentTools(agent: Agent): ToolDefinition[] {
  // #584:改经公开只读访问器取值。此前双重断言读私有 toolPool 并以
  // "读不到就退 fallback" 静默兜底——重命名即 CI 全绿的行为漂移。
  return [...agent.resolvedTools];
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
