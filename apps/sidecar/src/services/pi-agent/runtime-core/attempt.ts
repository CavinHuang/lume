import { type CanUseToolFn } from "@lume/agent-sdk";
import { createLogger } from "../../infra/logger";
import { buildRuntimeAttemptLogData } from "../../agent/agent-log-summary";
import { resolveMockAttempt } from "./mock-attempt";
import type { PiAgentRunParams, PiAgentRunResult, PiAgentRuntimeEmitter } from "../runner/types";
import { resolveSubagentInteractiveLabel } from "./subagent-interactive-display";
import { hasRuntimeCoreSessionTranscript } from "./session-store";
import {
  isToolAlwaysAllowed,
  markToolAlwaysAllowed,
  setToolPermissionApprovalSession,
  waitForToolPermissionDecision
} from "../../agent-runtime/interruption/tool-permission-session";
import {
  setAskUserQuestionApprovalSession,
  waitForPiAskUserQuestionAnswers
} from "../../agent-runtime/interruption/ask-user-question-session";
import type { AgentAskUserQuestionQuestion } from "@lume/shared";
import { builtinToolInputGuardrails } from "../../agent-runtime/guardrails/builtin-tool-guardrails";
import { LumeGuardrailRunner } from "../../agent-runtime/guardrails/guardrail-runner";
import { LumeRunner } from "../../agent-runtime/runner/lume-runner";
import { ToolExecutionGateway } from "../../agent-runtime/tools/tool-execution-gateway";
import { prepareRuntimeCoreAttempt, type PreparedRuntimeCoreAttempt } from "./prepare-attempt";
import { persistToolApprovalInterruption } from "../../agent-runtime/interruption/approval-service";

interface RunRuntimeCoreAttemptOptions {
  registerAbort: (threadId: string, abort: () => Promise<void>) => void;
  unregisterAbort: (threadId: string) => void;
}

const log = createLogger("pi-agent-runtime-core-attempt");
const toolInputGuardrails = new LumeGuardrailRunner(builtinToolInputGuardrails);
const toolExecutionGateway = new ToolExecutionGateway({ guardrails: toolInputGuardrails });

function sanitizeToolInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  const copied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 2000) {
      copied[key] = `${value.slice(0, 2000)}...(truncated)`;
    } else {
      copied[key] = value;
    }
  }
  return copied;
}

function toReadableString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function parseAskUserQuestions(input: Record<string, unknown>): AgentAskUserQuestionQuestion[] {
  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  const result: AgentAskUserQuestionQuestion[] = [];
  for (const item of rawQuestions) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const question = toReadableString(record.question);
    const header = toReadableString(record.header) || `问题${result.length + 1}`;
    const rawOptions = Array.isArray(record.options) ? record.options : [];
    const options = rawOptions
      .map((option) => {
        if (typeof option === "string") {
          const text = option.trim();
          return text ? { label: text, description: text } : null;
        }
        if (!option || typeof option !== "object") return null;
        const optionRecord = option as Record<string, unknown>;
        const label = toReadableString(optionRecord.label) || toReadableString(optionRecord.text);
        const description = toReadableString(optionRecord.description) || label;
        if (!label) return null;
        return { label, description };
      })
      .filter((option): option is { label: string; description: string } => !!option);
    if (!question || options.length < 2) continue;
    result.push({
      header,
      question,
      options,
      multiSelect: record.multiSelect === true
    });
  }
  return result;
}

function createCanUseToolHandler(
  params: PiAgentRunParams,
  prepared: PreparedRuntimeCoreAttempt,
  emit: PiAgentRuntimeEmitter,
  askUserSignal: AbortSignal,
  runId?: string
): CanUseToolFn {
  return async (tool, input, metadata) => {
    const toolName = tool.name || "unknown_tool";
    const approvalThreadId = params.runtime.deliveryThreadId ?? params.runtime.sessionId;
    const originThreadId = params.runtime.deliveryThreadId
      ? params.runtime.sessionId
      : undefined;
    const subagentRunId = params.runtime.subagentRunId;
    const subagentLabel = resolveSubagentInteractiveLabel(subagentRunId);
    const automationExecution = isAutomationExecution(params.input.messageMetadata);
    const requestRunId = runId;
    const toolStartTime = Date.now();
    log.debug("[Agent 工具] 调用", {
      toolName,
      threadId: params.runtime.sessionId.slice(0, 8),
      toolUseId: metadata?.toolUseId
    });
    const authorization = await toolExecutionGateway.authorize({
      toolName,
      input,
      permissionMode: params.input.permissionMode,
      context: {
        threadId: params.runtime.sessionId,
        cwd: prepared.agentCwd,
        workspaceSlug: prepared.workspaceSlug
      }
    });
    if (authorization.status === "deny") {
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: false,
        reason: "denied"
      });
      return {
        behavior: "deny",
        message: authorization.message
      };
    }

    if (toolName === "AskUserQuestion") {
      const normalizedInput = input && typeof input === "object"
        ? input as Record<string, unknown>
        : {};
      const questions = parseAskUserQuestions(normalizedInput);
      if (questions.length === 0) {
        log.debug("[Agent 工具] 完成", {
          toolName,
          threadId: params.runtime.sessionId.slice(0, 8),
          durationMs: Date.now() - toolStartTime,
          ok: false,
          reason: "denied"
        });
        return {
          behavior: "deny",
          message: "AskUserQuestion 缺少有效问题，已拒绝执行"
        };
      }
      const askResult = await waitForPiAskUserQuestionAnswers(
        params.runtime.sessionId,
        metadata?.toolUseId ?? toolName,
        questions,
        askUserSignal,
        (request) => {
          if (approvalThreadId !== request.threadId) {
            setAskUserQuestionApprovalSession(request.toolUseId, approvalThreadId);
          }
          emit.onAskUserQuestion({
            ...request,
            ...(requestRunId ? { runId: requestRunId } : {}),
            threadId: approvalThreadId,
            ...(originThreadId ? { originThreadId } : {}),
            ...(subagentRunId ? { subagentRunId } : {}),
            ...(subagentLabel ? { subagentLabel } : {})
          });
        },
        {
          ...(requestRunId ? { runId: requestRunId } : {}),
          originThreadId,
          subagentRunId,
          subagentLabel
        }
      );
      if (askResult.status !== "answered" || !askResult.answers) {
        log.debug("[Agent 工具] 完成", {
          toolName,
          threadId: params.runtime.sessionId.slice(0, 8),
          durationMs: Date.now() - toolStartTime,
          ok: false,
          reason: "denied"
        });
        if (askResult.status === "timeout") {
          return { behavior: "deny", message: "AskUserQuestion 等待用户回答超时" };
        }
        if (askResult.status === "aborted") {
          return { behavior: "deny", message: "AskUserQuestion 被线程中止" };
        }
        return { behavior: "deny", message: "用户取消了 AskUserQuestion" };
      }
      const result = {
        behavior: "allow" as const,
        updatedInput: {
          ...normalizedInput,
          questions,
          answers: askResult.answers
        }
      };
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true
      });
      return result;
    }

    if (authorization.status === "allow") {
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true
      });
      return { behavior: "allow" };
    }

    if (isToolAlwaysAllowed(params.runtime.sessionId, toolName)) {
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true
      });
      return { behavior: "allow" };
    }

    const request = {
      threadId: params.runtime.sessionId,
      ...(requestRunId ? { runId: requestRunId } : {}),
      ...(originThreadId ? { originThreadId } : {}),
      ...(subagentRunId ? { subagentRunId } : {}),
      ...(subagentLabel ? { subagentLabel } : {}),
      requestId: metadata?.toolUseId ?? toolName,
      toolUseId: metadata?.toolUseId ?? toolName,
      toolName,
      risk: authorization.risk,
      reason: authorization.reason,
      input: sanitizeToolInput(input),
      ...(automationExecution ? {
        interruptionType: "automation_approval" as const,
        ...(typeof params.input.messageMetadata?.automationJobId === "string"
          ? { automationJobId: params.input.messageMetadata.automationJobId }
          : {}),
        ...(typeof params.input.messageMetadata?.automationTrigger === "string"
          ? { automationTrigger: params.input.messageMetadata.automationTrigger }
          : {})
      } : {})
    } as const;

    if (automationExecution) {
      await persistToolApprovalInterruption(request);
      emit.onToolPermissionRequest({
        ...request,
        threadId: approvalThreadId,
        ...(originThreadId ? { originThreadId } : {}),
        ...(subagentRunId ? { subagentRunId } : {}),
        ...(subagentLabel ? { subagentLabel } : {})
      });
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: false,
        reason: "denied"
      });
      return {
        behavior: "deny",
        message: `自动化任务已暂停，等待用户确认工具执行: ${toolName}`
      };
    }

    let permissionTimedOut = false;
    const decision = await waitForToolPermissionDecision(
      request,
      new AbortController().signal,
      (permissionRequest) => {
        if (approvalThreadId !== permissionRequest.threadId) {
          setToolPermissionApprovalSession(permissionRequest.requestId, approvalThreadId);
        }
        emit.onToolPermissionRequest({
          ...permissionRequest,
          threadId: approvalThreadId,
          ...(originThreadId ? { originThreadId } : {}),
          ...(subagentRunId ? { subagentRunId } : {}),
          ...(subagentLabel ? { subagentLabel } : {})
        });
      },
      {
        onTimeout: (permissionRequest) => {
          permissionTimedOut = true;
          emit.onRuntimeEvent?.({
            id: `${requestRunId ?? params.runtime.sessionId}:${permissionRequest.toolUseId}:tool.permission_timeout`,
            type: "tool.permission_timeout",
            threadId: approvalThreadId,
            runId: requestRunId ?? permissionRequest.runId ?? params.runtime.sessionId,
            createdAt: new Date().toISOString(),
            toolCallId: permissionRequest.toolUseId,
            requestId: permissionRequest.requestId,
            toolName,
            message: `工具权限确认超时: ${toolName}`
          });
        }
      }
    );
    if (decision === "allow_always") {
      markToolAlwaysAllowed(params.runtime.sessionId, toolName);
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true
      });
      return { behavior: "allow" };
    }
    if (decision === "allow_once") {
      log.debug("[Agent 工具] 完成", {
        toolName,
        threadId: params.runtime.sessionId.slice(0, 8),
        durationMs: Date.now() - toolStartTime,
        ok: true
      });
      return { behavior: "allow" };
    }
    log.debug("[Agent 工具] 完成", {
      toolName,
      threadId: params.runtime.sessionId.slice(0, 8),
      durationMs: Date.now() - toolStartTime,
      ok: false,
      reason: "denied"
    });
    return {
      behavior: "deny",
      message: permissionTimedOut
        ? `工具权限确认超时: ${toolName}`
        : `用户拒绝执行工具: ${toolName}`
    };
  };
}

function isAutomationExecution(messageMetadata?: Record<string, unknown>): boolean {
  if (!messageMetadata) return false;
  return typeof messageMetadata.automationJobId === "string"
    || typeof messageMetadata.automationTrigger === "string";
}

export async function runRuntimeCoreAttempt(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter,
  options: RunRuntimeCoreAttemptOptions
): Promise<PiAgentRunResult> {
  const { input, runtime } = params;

  const mockHandler = resolveMockAttempt(input);
  const prepared = await prepareRuntimeCoreAttempt(params);
  if ("status" in prepared) {
    return prepared;
  }

  const runner = await LumeRunner.create({ params, prepared, emit });

  if (mockHandler) {
    try {
      const result = await mockHandler(params, runner.emit, options, prepared);
      return runner.finalizeResult(result);
    } catch (error) {
      await runner.finalizeError(error);
      throw error;
    }
  }

  const resumeExistingSession = hasRuntimeCoreSessionTranscript(runtime.sessionId, prepared.agentDir);
  log.info("[Agent 编排] 准备启动 runtime", buildRuntimeAttemptLogData({
    sessionId: runtime.sessionId,
    workspaceSlug: prepared.workspaceSlug,
    provider: prepared.modelResolution.provider,
    modelId: prepared.modelResolution.resolvedModelId,
    resume: resumeExistingSession,
    permissionMode: input.permissionMode,
    cwd: prepared.agentCwd
  }));

  return runner.runPreparedRuntimeCoreAttempt({
    params,
    prepared,
    options,
    createCanUseTool: (askUserSignal) =>
      createCanUseToolHandler(params, prepared, runner.emit, askUserSignal, runner.getRunId())
  });
}

// ─── Pi Agent runner (migrated from runner/run.ts) ───

const activePiSessions = new Map<string, { abort: () => Promise<void> }>();
const DEFAULT_MAX_ATTEMPTS = 1;
const RETRY_DELAY_MS = 700;

export async function runPiAgent(
  params: PiAgentRunParams,
  emit: PiAgentRuntimeEmitter
): Promise<PiAgentRunResult> {
  const maxAttempts = resolveMaxAttempts();
  let attempt = 0;
  let lastResult: PiAgentRunResult = { status: "errored", errorMessage: "Pi Agent 未执行" };

  while (attempt < maxAttempts) {
    attempt += 1;
    log.info("[Agent 编排] 开始执行 attempt", {
      threadId: params.runtime.sessionId.slice(0, 8),
      attempt,
      maxAttempts
    });
    const result = await runRuntimeCoreAttempt(params, emit, {
      registerAbort: (sessionId, abort) => {
        activePiSessions.set(sessionId, { abort });
      },
      unregisterAbort: (sessionId) => {
        activePiSessions.delete(sessionId);
      }
    });
    lastResult = result;
    log.info("[Agent 编排] attempt 结束", {
      threadId: params.runtime.sessionId.slice(0, 8),
      attempt,
      status: result.status,
      errorMessage: result.status === "errored" ? result.errorMessage : undefined
    });
    if (result.status !== "errored") {
      return result;
    }
    const retryable = shouldRetryError(result.errorMessage);
    if (!retryable || attempt >= maxAttempts) {
      const message = result.errorMessage ?? "未知错误";
      emit.onError(`Pi Agent runtime 执行失败: ${message}`);
      return result;
    }

    log.warn("Pi Agent attempt 失败，准备重试", {
      threadId: params.runtime.sessionId.slice(0, 8),
      attempt,
      maxAttempts,
      errorMessage: result.errorMessage
    });
    await sleep(RETRY_DELAY_MS);
  }

  const fallbackMessage = lastResult.errorMessage ?? "未知错误";
  emit.onError(`Pi Agent runtime 执行失败: ${fallbackMessage}`);
  return lastResult;
}

function resolveMaxAttempts(): number {
  const raw = process.env.LUME_PI_AGENT_MAX_ATTEMPTS?.trim();
  const parsed = raw ? Number(raw) : DEFAULT_MAX_ATTEMPTS;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_ATTEMPTS;
  }
  return Math.max(1, Math.min(3, Math.floor(parsed)));
}

function shouldRetryError(errorMessage?: string): boolean {
  if (!errorMessage) return false;
  const value = errorMessage.toLowerCase();
  return (
    value.includes("timeout")
    || value.includes("timed out")
    || value.includes("rate limit")
    || value.includes("429")
    || value.includes("temporar")
    || value.includes("econnreset")
    || value.includes("enotfound")
    || value.includes("network")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

export async function stopPiAgent(threadId: string): Promise<boolean> {
  const active = activePiSessions.get(threadId);
  if (!active) {
    return false;
  }
  await active.abort();
  activePiSessions.delete(threadId);
  return true;
}

export function isPiAgentSessionActive(threadId: string): boolean {
  return activePiSessions.has(threadId);
}

export async function stopAllPiAgents(): Promise<void> {
  const all = Array.from(activePiSessions.entries());
  for (const [sessionId, active] of all) {
    await active.abort();
    activePiSessions.delete(sessionId);
  }
}
