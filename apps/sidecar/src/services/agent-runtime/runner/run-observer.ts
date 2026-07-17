import { randomUUID } from "node:crypto";
import type {
  AgentTraceContext,
  FileReferenceBinding,
  LumeRuntimeEvent,
  RuntimeBillingUsageSummary,
  RuntimeNormalizedUsage,
  RuntimeUsageContextSnapshot,
  SDKMessage
} from "@lume/shared";
import type { LumeInterruption } from "../interruption/interruption";
import type { TaskContractPlanPreview } from "../plan/task-contract-write-tool";
import type { ContextAssemblyInput } from "../context/context-assembler";
import { TraceRecorder, type TraceRecorderEvent } from "../trace/trace-recorder";
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
import { stripMemoryUserMessagePrefix } from "../../memory-v2/user-message-prefix";
import type { LumeWorkflowTraceRecord } from "../../workflow-hooks/hook-effects";
import { writeLogRecord } from "../../infra/logger";

export interface CreateLumeRunObserverInput {
  sessionDir: string;
  threadId: string;
  workspaceId?: string;
  workspaceSlug?: string;
  fileReferenceBinding?: FileReferenceBinding;
  userMessage: string;
  permissionMode?: LumeRunState["input"]["permissionMode"];
  threadType?: string;
  chatType?: string;
  messageMetadata?: Record<string, unknown>;
  rootAgentId?: string;
  currentAgentId?: string;
  model: LumeRunState["model"];
  traceContext?: AgentTraceContext;
}

function publishTraceRecorderEvent(event: TraceRecorderEvent): void {
  const correlationTraceId = event.trace.correlationTraceId;
  if (!correlationTraceId) return;
  if (event.type === "trace.started") {
    writeLogRecord({
      level: "info",
      kind: "trace",
      context: "agent.runtime",
      event: "agent.run.started",
      message: "agent run started",
      status: "started",
      traceId: correlationTraceId,
      parentTraceId: event.trace.parentCorrelationTraceId,
      runId: event.trace.runId,
      threadId: event.trace.threadId,
      origin: typeof event.trace.metadata?.origin === "string" ? event.trace.metadata.origin : undefined,
      data: { storeTraceId: event.trace.id }
    });
    return;
  }
  if (event.type === "trace.ended") {
    const failed = event.trace.status === "failed";
    writeLogRecord({
      level: failed ? "error" : "info",
      kind: "trace",
      context: "agent.runtime",
      event: failed ? "agent.run.failed" : "agent.run.completed",
      message: failed ? "agent run failed" : "agent run completed",
      status: failed ? "error" : event.trace.status === "cancelled" ? "cancelled" : "ok",
      traceId: correlationTraceId,
      runId: event.trace.runId,
      threadId: event.trace.threadId,
      data: { storeTraceId: event.trace.id }
    });
    return;
  }
  const span = event.span;
  const suffix = event.type === "span.started"
    ? "started"
    : span.status === "failed" ? "failed" : "completed";
  const eventName = span.type === "model_call"
    ? `provider.request.${suffix}`
    : span.type === "tool_call"
      ? `tool.${suffix}`
      : `agent.span.${suffix}`;
  writeLogRecord({
    level: span.status === "failed" ? "error" : "info",
    kind: "trace",
    context: `agent.runtime.${span.type}`,
    event: eventName,
    message: `${span.name} ${suffix}`,
    status: event.type === "span.started" ? "started" : span.status === "failed" ? "error" : "ok",
    durationMs: span.durationMs,
    traceId: correlationTraceId,
    spanId: span.id,
    parentSpanId: span.parentId,
    runId: event.trace.runId,
    threadId: event.trace.threadId,
    providerAttemptId: span.type === "model_call" ? span.id : undefined,
    toolCallId: span.type === "tool_call" ? span.id : undefined,
    data: {
      storeTraceId: event.trace.id,
      spanType: span.type,
      spanName: span.name,
      ...(span.metadata ? { metadata: span.metadata } : {}),
      ...(span.type === "model_call" && span.output && typeof span.output === "object"
        ? { usage: (span.output as { usage?: unknown }).usage }
        : {}),
      ...(span.error ? { error: span.error } : {})
    }
  });
}

export class LumeRunObserver {
  private queue: Promise<void> = Promise.resolve();
  private runSpan?: LumeTraceSpan;
  private modelSpan?: LumeTraceSpan;
  private readonly toolSpanIds = new Map<string, string>();
  private readonly subagentSpanIds = new Map<string, string>();
  private readonly subagentParentToolCallIds = new Map<string, string>();
  private readonly nextRuntimeSequenceByRun = new Map<string, number>();
  private compactionSpanId?: string;
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
    const traceRecorder = new TraceRecorder(traceStore, { onEvent: publishTraceRecorderEvent });
    const runId = randomUUID();
    const trace = await traceRecorder.startTrace({
      runId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      name: "Lume agent run",
      correlationTraceId: input.traceContext?.traceId,
      parentCorrelationTraceId: input.traceContext?.parentTraceId,
      linkedCorrelationTraceId: input.traceContext?.linkedTraceId,
      metadata: {
        workspaceSlug: input.workspaceSlug,
        permissionMode: input.permissionMode,
        origin: input.traceContext?.origin,
        submissionId: input.traceContext?.submissionId
      }
    });
    const now = new Date().toISOString();
    const state: LumeRunState = {
      version: 1,
      runId,
      threadId: input.threadId,
      workspaceId: input.workspaceId,
      workspaceSlug: input.workspaceSlug,
      fileReferenceBinding: input.fileReferenceBinding,
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
        messageMetadata: input.messageMetadata,
        traceContext: input.traceContext
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
    observer.modelSpan = await traceRecorder.startSpan({
      traceId: trace.id,
      parentId: observer.runSpan.id,
      type: "model_call",
      name: `${input.model.provider}/${input.model.modelId}`,
      metadata: {
        provider: input.model.provider,
        modelId: input.model.modelId,
        modelRef: input.model.modelRef,
        channelId: input.model.channelId
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
          if (finalRuntimeEvent) this.emitRuntimeEvent(emitRuntimeEvent, finalRuntimeEvent);
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
          this.emitRuntimeEvent(emitRuntimeEvent, event);
        }
      }
      await this.recordSdkMessageTrace(message);
      if (message.type === "result" && message.contextUsage && message.billingUsage) {
        const context = normalizeRuntimeContextUsage(message.contextUsage);
        const billing = normalizeRuntimeBillingUsage(message.billingUsage);
        const cumulative = billing.cumulative;
        await this.stateStore.update(this.state.runId, {
          usage: {
            inputTokens: cumulative.inputTokens,
            outputTokens: cumulative.outputTokens,
            totalTokens: context.totalTokens,
            costUSD: billing.totalCostUSD,
            context,
            billing
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
        this.emitRuntimeEvent(emitRuntimeEvent, event);
      }
    });
  }

  recordTodoState(
    state: { todos: { content: string; activeForm: string; status: "pending" | "in_progress" | "completed" }[]; currentActiveForm: string | null },
    emitRuntimeEvent?: (event: LumeRuntimeEvent) => void
  ): void {
    this.enqueue(async () => {
      const createdAt = new Date().toISOString();
      const item: LumeRunItem = {
        type: "todo_state",
        id: `todo:${this.state.runId}:${createdAt}-${randomUUID().slice(0, 8)}`,
        todos: state.todos,
        currentActiveForm: state.currentActiveForm,
        createdAt
      };
      await this.stateStore.appendItem(this.state.runId, item);
      for (const event of projectRunItemToRuntimeEvents(this.state, item, {
        includeAssistantText: true,
        includeAssistantThinking: true,
        includeModelStreamText: true
      })) {
        this.emitRuntimeEvent(emitRuntimeEvent, event);
      }
    });
  }

  recordMemoryContextUsed(event: Extract<LumeRuntimeEvent, { type: "memory.context.used" }>): void {
    this.enqueue(async () => {
      const item: LumeRunItem = {
        type: "system_event",
        id: "memory-context-used",
        name: "memory_context_used",
        payload: {
          items: event.items,
          hidden: event.hidden
        },
        createdAt: event.createdAt
      };
      await this.stateStore.appendItem(this.state.runId, item);
    });
  }

  recordTurnLimited(reason?: string): void {
    this.enqueue(async () => {
      const item: LumeRunItem = {
        type: "system_event",
        id: "turn-limited",
        name: "turn_limited",
        payload: {
          reason
        },
        createdAt: new Date().toISOString()
      };
      await this.stateStore.appendItem(this.state.runId, item);
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

  getWorkspaceSlug(): string | undefined {
    return this.state.workspaceSlug;
  }

  getFileReferenceBinding(): FileReferenceBinding | undefined {
    return this.state.fileReferenceBinding;
  }

  getUserMessage(): string {
    return this.state.input.userMessage;
  }

  async getRunState(): Promise<LumeRunState | null> {
    await this.flush();
    return this.stateStore.get(this.state.runId);
  }

  async recordWorkflowHookTrace(input: {
    sourceContributionId: string;
    createdAt: string;
    record: LumeWorkflowTraceRecord;
  }): Promise<void> {
    await this.traceRecorder.withSpan({
      traceId: this.state.traceId,
      parentId: this.runSpan?.id,
      type: "guardrail",
      name: `workflow hook: ${input.record.event}`,
      input: input.record,
      metadata: {
        contributionId: input.record.contributionId,
        event: input.record.event,
        status: input.record.status,
        elapsedMs: input.record.elapsedMs,
        effectTypes: input.record.effectTypes,
        errorMessage: input.record.errorMessage,
        sourceContributionId: input.sourceContributionId,
        hookCreatedAt: input.createdAt
      }
    }, async () => ({ status: input.record.status }));
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
    if (this.modelSpan) {
      if (status === "failed") {
        await this.traceRecorder.failSpan(this.modelSpan.id, error ?? "model call failed");
      } else {
        await this.traceRecorder.endSpan(this.modelSpan.id, {
          status,
          usage: (await this.stateStore.get(this.state.runId))?.usage
        });
      }
      this.modelSpan = undefined;
    }
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

  private emitRuntimeEvent(
    emit: ((event: LumeRuntimeEvent) => void) | undefined,
    event: LumeRuntimeEvent
  ): void {
    if (!emit) return;
    const sequence = this.nextRuntimeSequenceByRun.get(event.runId) ?? 0;
    this.nextRuntimeSequenceByRun.set(event.runId, sequence + 1);
    emit({ ...event, fileReferenceBinding: this.state.fileReferenceBinding, sequence });
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
    if (message.type === "system" && message.subtype === "context_compaction_started") {
      const metadata = extractCompactionMetadata(message);
      const span = await this.traceRecorder.startSpan({
        traceId: this.state.traceId,
        parentId: this.runSpan?.id,
        type: "compaction",
        name: "context compaction",
        input: metadata
      });
      this.compactionSpanId = span.id;
      return;
    }

    if (message.type === "system" && message.subtype === "compact_boundary") {
      const metadata = extractCompactionMetadata(message);
      if (!this.compactionSpanId) {
        const span = await this.traceRecorder.startSpan({
          traceId: this.state.traceId,
          parentId: this.runSpan?.id,
          type: "compaction",
          name: "context compaction",
          input: metadata
        });
        this.compactionSpanId = span.id;
      }
      await this.traceRecorder.endSpan(this.compactionSpanId, metadata);
      this.compactionSpanId = undefined;
      return;
    }

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
      content: stripUserMessageContent(message.message.content),
      createdAt
    }];
  }
  if (message.type === "assistant") {
    const items: LumeRunItem[] = [];
    const subagentRunId = typeof message.subagent_run_id === "string" ? message.subagent_run_id : undefined;
    const parentToolCallId = extractSubagentParentToolCallId(message as SDKMessage & Record<string, unknown>)
      ?? (subagentRunId ? context.subagentParentToolCallIds.get(subagentRunId) : undefined);
    const textContent = message.message.content.filter((block) => block.type === "text" || block.type === "thinking");
    if (textContent.length > 0) {
      items.push({
        type: "assistant_message",
        id,
        content: textContent,
        ...(subagentRunId ? { subagentRunId } : {}),
        ...(parentToolCallId ? { parentToolCallId } : {}),
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
        ...(parentToolCallId ? { parentToolCallId } : {}),
        ...(subagentRunId ? { subagentRunId } : {}),
        status: "pending",
        createdAt
      });
    }
    return items;
  }
  if (message.type === "tool_result") {
    const metadata = message as SDKMessage & { parent_tool_use_id?: string; subagent_run_id?: string };
    return [{
      type: "tool_result",
      id,
      toolCallId: message.result.tool_use_id,
      toolName: message.result.tool_name,
      output: message.result.output,
      parentToolCallId: metadata.parent_tool_use_id ?? undefined,
      subagentRunId: typeof metadata.subagent_run_id === "string" ? metadata.subagent_run_id : undefined,
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

function stripUserMessageContent(content: unknown): unknown {
  if (typeof content === "string") {
    return stripMemoryUserMessagePrefix(content);
  }
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (!item || typeof item !== "object") return item;
      const block = item as Record<string, unknown>;
      if (typeof block.text === "string") {
        return { ...block, text: stripMemoryUserMessagePrefix(block.text) };
      }
      if (typeof block.content === "string") {
        return { ...block, content: stripMemoryUserMessagePrefix(block.content) };
      }
      return item;
    });
  }
  return content;
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

function extractCompactionMetadata(message: SDKMessage): Record<string, unknown> {
  const metadata = asRecord((message as SDKMessage & {
    compact_metadata?: unknown;
  }).compact_metadata);
  return {
    trigger: typeof metadata.trigger === "string" ? metadata.trigger : undefined,
    preTokens: typeof metadata.pre_tokens === "number" ? metadata.pre_tokens : undefined,
    postTokens: typeof metadata.post_tokens === "number" ? metadata.post_tokens : undefined,
    summary: typeof metadata.summary === "string" ? metadata.summary : undefined,
    policy: typeof metadata.policy === "string" ? metadata.policy : undefined,
    source: typeof metadata.source === "string" ? metadata.source : undefined,
  };
}

function normalizeRuntimeContextUsage(value: unknown): RuntimeUsageContextSnapshot {
  const record = asRecord(value);
  const sections = asRecord(record.sections);
  const normalizedSections = {
    ...optionalNumber("systemTokens", numberOrUndefined(sections.systemTokens)),
    ...optionalNumber("memoryTokens", numberOrUndefined(sections.memoryTokens)),
    ...optionalNumber("toolSchemaTokens", numberOrUndefined(sections.toolSchemaTokens)),
    ...optionalNumber("messageTokens", numberOrUndefined(sections.messageTokens))
  };
  return {
    source: record.source === "provider" ? "provider" : "estimated",
    ...normalizeRuntimeUsage(record),
    estimatedTailTokens: numberValue(record.estimatedTailTokens),
    ...(Object.keys(normalizedSections).length > 0 ? { sections: normalizedSections } : {}),
    contextWindow: numberValue(record.contextWindow),
    contextWindowSource: record.contextWindowSource === "model" || record.contextWindowSource === "provider"
      ? record.contextWindowSource
      : "fallback"
  };
}

function normalizeRuntimeBillingUsage(value: unknown): RuntimeBillingUsageSummary {
  const record = asRecord(value);
  const latestRecord = normalizeRuntimeBillingRecord(record.latestRecord);
  return {
    cumulative: normalizeRuntimeUsage(record.cumulative),
    ...(latestRecord ? { latestRecord } : {}),
    records: Array.isArray(record.records)
      ? record.records.map(normalizeRuntimeBillingRecord).filter((item): item is NonNullable<typeof item> => item !== null)
      : [],
    totalCostUSD: numberValue(record.totalCostUSD)
  };
}

function normalizeRuntimeBillingRecord(value: unknown): RuntimeBillingUsageSummary["records"][number] | null {
  const record = asRecord(value);
  const usage = normalizeRuntimeUsage(record);
  if (usage.totalTokens <= 0) return null;
  const identity = asRecord(record.usageIdentity);
  const callerKind = typeof identity.callerKind === "string" && identity.callerKind.trim()
    ? identity.callerKind
    : stringField(record.callerKind) ?? "conversation";
  return {
    callerLabel: stringField(record.callerLabel) ?? stringField(identity.callerLabel) ?? "LLM call",
    callerKind,
    ...(typeof record.model === "string" && record.model.trim() ? { model: record.model } : {}),
    ...(typeof record.turn === "number" && Number.isFinite(record.turn) ? { turn: record.turn } : {}),
    ...(typeof identity.threadId === "string" && identity.threadId.trim()
      ? {
          usageIdentity: {
            threadId: identity.threadId,
            callerKind,
            ...(typeof identity.runId === "string" && identity.runId.trim() ? { runId: identity.runId } : {}),
            ...(typeof identity.parentThreadId === "string" && identity.parentThreadId.trim() ? { parentThreadId: identity.parentThreadId } : {}),
            ...(typeof identity.parentRunId === "string" && identity.parentRunId.trim() ? { parentRunId: identity.parentRunId } : {}),
            ...(typeof identity.subagentRunId === "string" && identity.subagentRunId.trim() ? { subagentRunId: identity.subagentRunId } : {}),
            ...(typeof identity.responseId === "string" && identity.responseId.trim() ? { responseId: identity.responseId } : {}),
            ...(typeof identity.turn === "number" && Number.isFinite(identity.turn) ? { turn: identity.turn } : {}),
            ...(typeof identity.callerLabel === "string" && identity.callerLabel.trim() ? { callerLabel: identity.callerLabel } : {})
          }
        }
      : {}),
    ...usage,
    ...(typeof record.ttftMs === "number" && Number.isFinite(record.ttftMs) ? { ttftMs: record.ttftMs } : {}),
    ...(typeof record.costUSD === "number" && Number.isFinite(record.costUSD) ? { costUSD: record.costUSD } : {})
  };
}

function normalizeRuntimeUsage(value: unknown): RuntimeNormalizedUsage {
  const record = asRecord(value);
  const inputTokens = numberValue(record.inputTokens);
  const outputTokens = numberValue(record.outputTokens);
  const cacheReadInputTokens = numberValue(record.cacheReadInputTokens);
  const cacheCreationInputTokens = numberValue(record.cacheCreationInputTokens);
  const directCachedTokens = numberValue(record.cachedTokens);
  const hasSplitCacheUsage = cacheReadInputTokens > 0 || cacheCreationInputTokens > 0;
  const cachedTokens = hasSplitCacheUsage ? cacheReadInputTokens : directCachedTokens;
  const explicitTotalTokens = numberValue(record.totalTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    cachedTokens,
    totalTokens: explicitTotalTokens > 0
      ? explicitTotalTokens
      : inputTokens + outputTokens + cachedTokens + cacheCreationInputTokens
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalNumber<K extends string>(key: K, value: number | undefined): Record<K, number> | {} {
  return value === undefined ? {} : { [key]: value } as Record<K, number>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
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
