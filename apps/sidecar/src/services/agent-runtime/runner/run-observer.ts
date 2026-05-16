import { randomUUID } from "node:crypto";
import type { LumeRuntimeEvent, SDKMessage } from "@lume/shared";
import type { LumeInterruption } from "../interruption/interruption";
import type { TaskContractPlanPreview } from "../plan/task-contract-write-tool";
import type { ContextAssemblyInput } from "../context/context-assembler";
import { TraceRecorder } from "../trace/trace-recorder";
import { redactTracePayload, summarizeTraceOutput } from "../trace/trace-redaction";
import { createFileBackedLumeTraceStore } from "../trace/trace-store";
import type { LumeTraceSpan } from "../trace/trace-types";
import type { LumeRunItem } from "./run-items";
import {
  projectAssistantMessageFinalRuntimeEvent,
  projectRunItemToRuntimeEvents
} from "./run-item-events";
import type { LumeRunState, LumeRunStatus } from "./run-state";
import { createFileBackedLumeRunStateStore, type LumeRunStateStore } from "./run-state-store";

export interface CreateLumeRunObserverInput {
  sessionDir: string;
  threadId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  userMessage: string;
  permissionMode?: LumeRunState["input"]["permissionMode"];
  threadType?: string;
  chatType?: string;
  messageMetadata?: Record<string, unknown>;
  rootAgentId?: string;
  currentAgentId?: string;
  model: LumeRunState["model"];
}

export class LumeRunObserver {
  private queue: Promise<void> = Promise.resolve();
  private runSpan?: LumeTraceSpan;
  private readonly toolSpanIds = new Map<string, string>();
  private readonly subagentSpanIds = new Map<string, string>();
  private readonly subagentParentToolCallIds = new Map<string, string>();
  private emittedModelStreamText = false;
  private emittedModelStreamThinking = false;

  private constructor(
    private readonly state: LumeRunState,
    private readonly stateStore: LumeRunStateStore,
    private readonly traceRecorder: TraceRecorder
  ) {}

  static async create(input: CreateLumeRunObserverInput): Promise<LumeRunObserver> {
    const stateStore = createFileBackedLumeRunStateStore(input.sessionDir);
    const traceStore = createFileBackedLumeTraceStore(input.sessionDir);
    const traceRecorder = new TraceRecorder(traceStore);
    const runId = randomUUID();
    const trace = await traceRecorder.startTrace({
      runId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      name: "Lume agent run",
      metadata: {
        workspaceSlug: input.workspaceSlug,
        permissionMode: input.permissionMode
      }
    });
    const now = new Date().toISOString();
    const state: LumeRunState = {
      version: 1,
      runId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      workspaceSlug: input.workspaceSlug,
      rootAgentId: input.rootAgentId ?? "runtime-core",
      currentAgentId: input.currentAgentId ?? "runtime-core",
      status: "running",
      currentStep: {
        id: randomUUID(),
        type: "model_call",
        status: "running",
        startedAt: now
      },
      input: {
        userMessage: input.userMessage,
        permissionMode: input.permissionMode,
        threadType: input.threadType,
        chatType: input.chatType,
        messageMetadata: input.messageMetadata
      },
      generatedItems: [],
      pendingInterruptions: [],
      approvals: {
        alwaysAllowedTools: []
      },
      traceId: trace.id,
      model: input.model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0
      },
      createdAt: now,
      updatedAt: now
    };
    await stateStore.create(state);
    const observer = new LumeRunObserver(state, stateStore, traceRecorder);
    observer.runSpan = await traceRecorder.startSpan({
      traceId: trace.id,
      type: "run",
      name: "runtime-core attempt",
      input: {
        userMessage: input.userMessage,
        permissionMode: input.permissionMode
      }
    });
    return observer;
  }

  recordSdkMessage(
    message: SDKMessage,
    emitRuntimeEvent?: (event: LumeRuntimeEvent) => void
  ): void {
    this.enqueue(async () => {
      this.rememberSubagentParentToolCall(message as SDKMessage & Record<string, unknown>);
      const items = mapSdkMessageToRunItems(message, {
        currentAgentId: this.state.currentAgentId,
        parentRunId: this.state.runId,
        subagentParentToolCallIds: this.subagentParentToolCallIds
      });
      for (const item of items) {
        await this.stateStore.appendItem(this.state.runId, item);
        if (item.type === "assistant_message" && (this.emittedModelStreamText || this.emittedModelStreamThinking)) {
          const finalRuntimeEvent = projectAssistantMessageFinalRuntimeEvent(this.state, item);
          if (finalRuntimeEvent) emitRuntimeEvent?.(finalRuntimeEvent);
          continue;
        }
        const runtimeEvents = projectRunItemToRuntimeEvents(this.state, item, {
          includeAssistantText: !this.emittedModelStreamText,
          includeAssistantThinking: !this.emittedModelStreamThinking,
          includeModelStreamText: true
        });
        for (const event of runtimeEvents) {
          if (event.type === "assistant.delta" && item.type === "model_stream") {
            this.emittedModelStreamText = true;
          }
          if (event.type === "assistant.thinking_delta" && item.type === "model_stream") {
            this.emittedModelStreamThinking = true;
          }
          emitRuntimeEvent?.(event);
        }
      }
      await this.recordSdkMessageTrace(message);
      if (message.type === "result" && message.usage) {
        const inputTokens = message.usage.input_tokens ?? 0;
        const outputTokens = message.usage.output_tokens ?? 0;
        await this.stateStore.update(this.state.runId, {
          usage: {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
            costUSD: message.total_cost_usd
          }
        });
      }
    });
  }

  recordPlanPreview(
    preview: TaskContractPlanPreview,
    emitRuntimeEvent?: (event: LumeRuntimeEvent) => void
  ): void {
    this.enqueue(async () => {
      const item: LumeRunItem = {
        type: "plan_preview",
        id: `plan:${preview.contractId}`,
        contractId: preview.contractId,
        title: preview.title,
        summary: preview.summary,
        markdown: preview.markdown,
        planFilePath: preview.planFilePath,
        planVerified: preview.planVerified,
        stepCount: preview.stepCount,
        createdAt: new Date().toISOString()
      };
      await this.stateStore.appendItem(this.state.runId, item);
      for (const event of projectRunItemToRuntimeEvents(this.state, item, {
        includeAssistantText: true,
        includeAssistantThinking: true,
        includeModelStreamText: true
      })) {
        emitRuntimeEvent?.(event);
      }
    });
  }

  recordInterruption(interruption: LumeInterruption): void {
    this.enqueue(async () => {
      const stored = await this.stateStore.get(this.state.runId);
      if (!stored) return;
      const pendingInterruptions = [
        ...stored.pendingInterruptions.filter((item) => item.id !== interruption.id),
        interruption
      ].filter((item) => item.status === "pending");
      await this.stateStore.update(this.state.runId, {
        status: interruption.type === "ask_user" ? "waiting_for_user" : "waiting_for_approval",
        currentStep: {
          id: randomUUID(),
          type: interruption.type === "ask_user" ? "tool_approval" : "tool_approval",
          status: "running",
          startedAt: new Date().toISOString(),
          input: interruption
        },
        pendingInterruptions
      });
      await this.traceRecorder.startSpan({
        traceId: this.state.traceId,
        type: "approval",
        name: interruption.type,
        input: interruption.payload,
        metadata: {
          interruptionId: interruption.id,
          source: interruption.source
        }
      });
    });
  }

  getContextAssemblyTrace(): NonNullable<ContextAssemblyInput["trace"]> {
    return {
      recorder: this.traceRecorder,
      traceId: this.state.traceId,
      parentSpanId: this.runSpan?.id
    };
  }

  getRunId(): string {
    return this.state.runId;
  }

  getThreadId(): string {
    return this.state.threadId;
  }

  async finalize(status: Extract<LumeRunStatus, "completed" | "failed" | "cancelled">, error?: Error | string): Promise<void> {
    await this.flush();
    const completedAt = new Date().toISOString();
    const patch: Partial<LumeRunState> = {
      status,
      currentStep: {
        id: randomUUID(),
        type: "finalize",
        status: status === "failed" ? "failed" : "completed",
        startedAt: completedAt,
        endedAt: completedAt,
        error: error ? normalizeErrorMessage(error) : undefined
      },
      completedAt,
      pendingInterruptions: []
    };
    if (error) {
      patch.error = {
        code: "runtime_error",
        message: normalizeErrorMessage(error),
        stack: error instanceof Error ? error.stack : undefined
      };
    }
    await this.stateStore.update(this.state.runId, patch);
    if (this.runSpan) {
      if (status === "failed") {
        await this.traceRecorder.failSpan(this.runSpan.id, error ?? "runtime failed");
      } else {
        await this.traceRecorder.endSpan(this.runSpan.id, { status });
      }
    }
    await this.traceRecorder.endTrace(
      this.state.traceId,
      status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed"
    );
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task, task);
  }

  private rememberSubagentParentToolCall(message: SDKMessage & Record<string, unknown>): void {
    if (message.type !== "system") return;
    const subagentRunId = typeof message.subagent_run_id === "string" ? message.subagent_run_id : "";
    const parentToolCallId = extractSubagentParentToolCallId(message);
    if (subagentRunId && parentToolCallId) {
      this.subagentParentToolCallIds.set(subagentRunId, parentToolCallId);
    }
  }

  private async recordSdkMessageTrace(message: SDKMessage): Promise<void> {
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        const span = await this.traceRecorder.startSpan({
          traceId: this.state.traceId,
          parentId: this.runSpan?.id,
          type: "tool_call",
          name: block.name,
          input: redactTracePayload(block.input, "diagnostic"),
          metadata: {
            toolUseId: block.id,
            parentToolUseId: message.parent_tool_use_id ?? undefined
          }
        });
        this.toolSpanIds.set(block.id, span.id);
      }
      return;
    }

    if (message.type === "tool_result") {
      const spanId = this.toolSpanIds.get(message.result.tool_use_id);
      if (!spanId) return;
      const isError = Boolean((message.result as { is_error?: boolean }).is_error);
      if (isError) {
        await this.traceRecorder.failSpan(spanId, {
          message: String(message.result.output || "tool call failed")
        });
      } else {
        await this.traceRecorder.endSpan(spanId, {
          toolName: message.result.tool_name,
          isError: false,
          outputPreview: summarizeTraceOutput(message.result.output)
        });
      }
      this.toolSpanIds.delete(message.result.tool_use_id);
    }

    if (message.type === "system") {
      await this.recordSubagentTrace(message as SDKMessage & Record<string, unknown>);
    }
  }

  private async recordSubagentTrace(message: SDKMessage & Record<string, unknown>): Promise<void> {
    const subagentRunId = typeof message.subagent_run_id === "string" ? message.subagent_run_id : "";
    if (!subagentRunId) return;
    if (message.subtype !== "task_started" && message.subtype !== "task_progress" && message.subtype !== "task_notification") return;

    let spanId = this.subagentSpanIds.get(subagentRunId);
    if (!spanId) {
      const span = await this.traceRecorder.startSpan({
        traceId: this.state.traceId,
        parentId: this.runSpan?.id,
        type: "subagent",
        name: extractSubagentTask(message),
        input: {
          taskId: typeof message.task_id === "string" ? message.task_id : undefined,
          prompt: typeof message.prompt === "string" ? message.prompt : undefined
        },
        metadata: {
          subagentRunId,
          parentToolCallId: extractSubagentParentToolCallId(message)
        }
      });
      spanId = span.id;
      this.subagentSpanIds.set(subagentRunId, spanId);
    }

    if (message.subtype !== "task_notification") return;
    const status = normalizeSubagentStatus(message.status);
    if (status === "failed") {
      await this.traceRecorder.failSpan(spanId, {
        message: typeof message.message === "string" ? message.message : "subagent failed"
      });
    } else if (status === "cancelled") {
      await this.traceRecorder.failSpan(spanId, {
        message: "subagent cancelled"
      });
    } else if (status === "completed") {
      await this.traceRecorder.endSpan(spanId, {
        summary: typeof message.summary === "string" ? message.summary : undefined,
        outputFile: typeof message.output_file === "string" ? message.output_file : undefined
      });
    }
    this.subagentSpanIds.delete(subagentRunId);
  }
}

function mapSdkMessageToRunItems(
  message: SDKMessage,
  context: {
    currentAgentId: string;
    parentRunId: string;
    subagentParentToolCallIds: ReadonlyMap<string, string>;
  }
): LumeRunItem[] {
  const createdAt = new Date().toISOString();
  const id = "uuid" in message && typeof message.uuid === "string" ? message.uuid : randomUUID();
  if (message.type === "user") {
    return [{
      type: "user_message",
      id,
      content: message.message.content,
      createdAt
    }];
  }
  if (message.type === "assistant") {
    const items: LumeRunItem[] = [];
    const textContent = message.message.content.filter((block) => block.type === "text" || block.type === "thinking");
    if (textContent.length > 0) {
      items.push({
        type: "assistant_message",
        id,
        content: textContent,
        createdAt
      });
    }
    for (const toolUse of message.message.content.filter((block) => block.type === "tool_use")) {
      items.push({
        type: "tool_call",
        id: toolUse.id,
        toolName: toolUse.name,
        input: toolUse.input,
        parentAgentId: context.currentAgentId,
        parentToolCallId: message.parent_tool_use_id ?? undefined,
        status: "pending",
        createdAt
      });
    }
    return items;
  }
  if (message.type === "tool_result") {
    return [{
      type: "tool_result",
      id,
      toolCallId: message.result.tool_use_id,
      toolName: message.result.tool_name,
      output: message.result.output,
      createdAt
    }];
  }
  if (message.type === "system" && message.subtype === "task_notification") {
    const subagentRunId = typeof message.subagent_run_id === "string" ? message.subagent_run_id : "";
    if (subagentRunId) {
      return [{
        type: "subagent",
        id,
        runId: subagentRunId,
        parentRunId: context.parentRunId,
        parentToolCallId: extractSubagentParentToolCallId(message as SDKMessage & Record<string, unknown>)
          ?? context.subagentParentToolCallIds.get(subagentRunId),
        task: extractSubagentTask(message as SDKMessage & Record<string, unknown>),
        status: normalizeSubagentStatus(message.status),
        childThreadId: subagentRunId,
        output: typeof message.summary === "string" ? message.summary : undefined,
        error: normalizeSubagentStatus(message.status) === "failed" && typeof message.message === "string"
          ? message.message
          : undefined,
        createdAt
      }];
    }
  }
  if (message.type === "stream_event" || message.type === "partial_message") {
    return [{
      type: "model_stream",
      id,
      event: message,
      createdAt
    }];
  }
  if (message.type === "system" || message.type === "result") {
    return [{
      type: "system_event",
      id,
      name: message.type === "system" ? message.subtype : "result",
      payload: message,
      createdAt
    }];
  }
  return [];
}

function extractSubagentParentToolCallId(message: SDKMessage & Record<string, unknown>): string | undefined {
  return typeof message.tool_use_id === "string"
    ? message.tool_use_id
    : typeof message.parent_tool_use_id === "string"
      ? message.parent_tool_use_id
      : undefined;
}

function extractSubagentTask(message: SDKMessage & Record<string, unknown>): string {
  const candidates = [message.description, message.summary, message.message, message.prompt];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return "Subagent run";
}

function normalizeSubagentStatus(status: unknown): "running" | "completed" | "failed" | "cancelled" {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "errored" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled" || status === "aborted") return "cancelled";
  return "running";
}

function normalizeErrorMessage(error: Error | string): string {
  return error instanceof Error ? error.message : error;
}
