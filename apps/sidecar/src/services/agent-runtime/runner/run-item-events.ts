import { FILE_REFERENCE_PROTOCOL_VERSION } from "@lume/shared";
import type { FileReferenceBinding, LumeRuntimeEvent, RuntimeNormalizedUsage } from "@lume/shared";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getAgentFileContextRootPath } from "../../infra/config-paths";
import type { LumeRunItem } from "./run-items";
import type { LumeRunState } from "./run-state";
import { inferToolMetadata } from "../tools/tool-metadata";

export function projectRunStateToRuntimeEvents(run: LumeRunState): LumeRuntimeEvent[] {
  if (isRuntimeContinuationRun(run)) {
    return [];
  }
  const events: LumeRuntimeEvent[] = [{
    id: `${run.runId}:run.started`,
    type: "run.started",
    threadId: run.threadId,
    runId: run.runId,
    createdAt: run.createdAt,
    workspaceId: run.workspaceId,
    workspaceSlug: run.workspaceSlug,
    model: run.model
  }];
  const userMessage = typeof run.input.userMessage === "string" ? run.input.userMessage : "";
  if (userMessage.trim() && !isHiddenFromChatRun(run)) {
    const metadata = run.input.messageMetadata;
    const attachments = Array.isArray(run.input.messageAttachments)
      ? run.input.messageAttachments
      : Array.isArray(metadata?.messageAttachments)
        ? metadata.messageAttachments
        : undefined;
    const commentAttachments = Array.isArray(run.input.commentAttachments)
      ? run.input.commentAttachments
      : Array.isArray(metadata?.commentAttachments)
        ? metadata.commentAttachments
        : undefined;
    const browserAttachments = Array.isArray(run.input.browserAttachments)
      ? run.input.browserAttachments
      : Array.isArray(metadata?.browserAttachments)
        ? metadata.browserAttachments
        : undefined;
    events.push({
      id: `${run.runId}:message.user.submitted`,
      type: "message.user.submitted",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: run.createdAt,
      text: userMessage,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(commentAttachments?.length ? { commentAttachments } : {}),
      ...(browserAttachments?.length ? { browserAttachments } : {}),
      ...(typeof metadata?.messageId === "string" ? { messageId: metadata.messageId } : {}),
      ...(typeof metadata?.versionGroupId === "string" ? { versionGroupId: metadata.versionGroupId } : {}),
      ...(typeof metadata?.versionIndex === "number" ? { versionIndex: metadata.versionIndex } : {}),
      ...(typeof metadata?.versionCount === "number" ? { versionCount: metadata.versionCount } : {})
    });
  }

  const hasAssistantMessage = run.generatedItems.some((item) =>
    item.type === "assistant_message" && extractText(item.content).trim().length > 0
  );

  for (let index = 0; index < run.generatedItems.length; index += 1) {
    const item = withInferredSubagentOwner(run.generatedItems, index);
    events.push(...projectRunItemToRuntimeEvents(run, item, {
      includeAssistantText: true,
      includeAssistantThinking: true,
      includeModelStreamText: !hasAssistantMessage
    }));
  }

  if (run.status === "completed") {
    events.push({
      id: `${run.runId}:run.completed`,
      type: "run.completed",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: run.completedAt ?? run.updatedAt,
      finalOutput: extractFinalOutput(run.generatedItems),
      ...(run.verificationStatus ? { verificationStatus: run.verificationStatus } : {}),
      ...(run.codingReport ? { codingReport: run.codingReport } : {})
    });
  }

  if (run.status === "failed") {
    events.push({
      id: `${run.runId}:run.failed`,
      type: "run.failed",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: run.completedAt ?? run.updatedAt,
      error: {
        code: run.error?.code ?? "runtime_error",
        message: run.error?.message ?? "Run failed",
        stack: run.error?.stack,
        retryable: run.error?.retryable
      },
      ...(run.verificationStatus ? { verificationStatus: run.verificationStatus } : {}),
      ...(run.codingReport ? { codingReport: run.codingReport } : {})
    });
  }

  if (run.status === "cancelled") {
    events.push({
      id: `${run.runId}:run.cancelled`,
      type: "run.cancelled",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: run.completedAt ?? run.updatedAt
    });
  }

  return events.map((event) => ({
    ...event,
    ...(run.fileReferenceBinding
      ? {
          fileReferenceBinding: run.fileReferenceBinding,
          fileReferenceProtocolVersion: run.fileReferenceProtocolVersion ?? FILE_REFERENCE_PROTOCOL_VERSION
        }
      : {})
  }));
}

function withInferredSubagentOwner(items: LumeRunItem[], index: number): LumeRunItem {
  const item = items[index];
  if (!item) {
    throw new Error(`Missing run item at index ${index}`);
  }
  if (item.type !== "assistant_message" || item.parentToolCallId || item.subagentRunId) {
    return item;
  }
  const next = items[index + 1];
  if (next?.type !== "tool_call" || !next.parentToolCallId || next.createdAt !== item.createdAt) {
    return item;
  }
  return {
    ...item,
    parentToolCallId: next.parentToolCallId,
    ...(next.subagentRunId ? { subagentRunId: next.subagentRunId } : {})
  };
}

function isRuntimeContinuationRun(run: LumeRunState): boolean {
  const metadata = run.input.messageMetadata;
  return Boolean(metadata?.runtimeContinuation && typeof metadata.runtimeContinuation === "object");
}

function isHiddenFromChatRun(run: LumeRunState): boolean {
  return run.input.messageMetadata?.hiddenFromChat === true;
}

export function projectRunItemToRuntimeEvents(
  run: LumeRunState,
  item: LumeRunItem,
  options: { includeAssistantText: boolean; includeAssistantThinking?: boolean; includeModelStreamText: boolean }
): LumeRuntimeEvent[] {
  const subagentFields = subagentRuntimeFields(item);

  if (item.type === "assistant_message") {
    const events: LumeRuntimeEvent[] = [];
    for (const block of extractAssistantContentBlocks(item.content)) {
      if (block.kind === "thinking" && options.includeAssistantThinking !== false && block.text.trim()) {
        events.push({
          id: `${run.runId}:${item.id}:assistant.thinking_delta:${events.length}`,
          type: "assistant.thinking_delta",
          threadId: run.threadId,
          runId: run.runId,
          createdAt: item.createdAt,
          delta: block.text,
          messageId: item.id,
          ...subagentFields
        });
      }
      if (block.kind === "text" && options.includeAssistantText && block.text.trim()) {
        events.push({
          id: `${run.runId}:${item.id}:assistant.delta:${events.length}`,
          type: "assistant.delta",
          threadId: run.threadId,
          runId: run.runId,
          createdAt: item.createdAt,
          delta: block.text,
          messageId: item.id,
          ...subagentFields
        });
      }
    }
    return events;
  }

  if (item.type === "model_stream" && options.includeModelStreamText) {
    const delta = extractModelStreamDelta(item.event);
    if (!delta || delta.text.length === 0) return [];
    if (delta.kind === "thinking" && !delta.text.trim()) return [];
    return [{
      id: `${run.runId}:${item.id}:${delta.kind}`,
      type: delta.kind === "thinking" ? "assistant.thinking_delta" : "assistant.delta",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      delta: delta.text,
      ...subagentFields
    }];
  }

  if (item.type === "tool_call") {
    return [{
      id: `${run.runId}:${item.id}:tool.started`,
      type: "tool.started",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      toolCallId: item.id,
      toolName: item.toolName,
      inputPreview: item.input,
      riskLevel: inferToolMetadata(item.toolName).riskLevel,
      ...subagentFields
    }];
  }

  if (item.type === "tool_result") {
    const isError = item.isError === true;
    const execution = normalizeToolExecutionMetadata(item.execution, run.fileReferenceBinding);
    const resultRef = execution?.resultRef;
    if (isError) {
      return [{
        id: `${run.runId}:${item.id}:tool.failed`,
        type: "tool.failed",
        threadId: run.threadId,
        runId: run.runId,
        createdAt: item.createdAt,
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        error: {
          code: "tool_error",
          message: previewRuntimePayload(item.output)
        },
        ...(execution ? { execution } : {}),
        ...(resultRef ? { resultRef } : {}),
        ...subagentFields
      }];
    }
    return [{
      id: `${run.runId}:${item.id}:tool.completed`,
      type: "tool.completed",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      toolCallId: item.toolCallId,
      toolName: item.toolName,
      resultPreview: previewRuntimePayload(item.output),
      ...(execution ? { execution } : {}),
      ...(resultRef ? { resultRef } : {}),
      ...subagentFields
    }];
  }

  if (item.type === "plan_preview") {
    return [{
      id: `${run.runId}:${item.id}:plan.preview`,
      type: "plan.preview",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      contractId: item.contractId,
      title: item.title,
      summary: item.summary,
      markdown: item.markdown,
      ...(item.planFilePath ? { planFilePath: item.planFilePath } : {}),
      ...(item.planVerified !== undefined ? { planVerified: item.planVerified } : {}),
      stepCount: item.stepCount
    }];
  }

  if (item.type === "todo_state") {
    return [{
      id: `${run.runId}:${item.id}:todo.state_updated`,
      type: "todo.state_updated",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      todos: item.todos,
      currentActiveForm: item.currentActiveForm
    }];
  }

  if (item.type === "system_event") {
    return projectSystemEventRuntimeEvents(run, item);
  }

  return [];
}

function normalizeToolExecutionMetadata(
  value: unknown,
  binding?: FileReferenceBinding,
): import("@lume/shared").ToolExecutionMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const terminationReason = record.terminationReason;
  if ((record.version !== 1 && record.version !== 2) || typeof record.command !== "string" || typeof record.durationMs !== "number") return undefined;
  if (terminationReason !== "completed" && terminationReason !== "nonzero" && terminationReason !== "timeout" && terminationReason !== "aborted" && terminationReason !== "output_limit" && terminationReason !== "spawn_error" && terminationReason !== "running" && terminationReason !== "interrupted") return undefined;
  const resultRef = normalizeFileResultRef(record.resultRef, binding);
  const stdoutRef = normalizeFileResultRef(record.stdoutRef, binding);
  const stderrRef = normalizeFileResultRef(record.stderrRef, binding);
  if (record.version === 2) {
    const outcome = record.outcome;
    if (outcome !== "running" && outcome !== "succeeded" && outcome !== "failed" && outcome !== "timed_out" && outcome !== "cancelled" && outcome !== "interrupted") return undefined;
    if (record.shell !== "bash" && record.shell !== "powershell") return undefined;
    return {
      version: 2,
      outcome,
      ...(typeof record.exitCode === "number" || record.exitCode === null ? { exitCode: record.exitCode } : {}),
      ...(typeof record.stdoutPreview === "string" ? { stdoutPreview: record.stdoutPreview } : {}),
      ...(typeof record.stderrPreview === "string" ? { stderrPreview: record.stderrPreview } : {}),
      ...(stdoutRef ? { stdoutRef } : {}),
      ...(stderrRef ? { stderrRef } : {}),
      ...(typeof record.timedOut === "boolean" ? { timedOut: record.timedOut } : {}),
      ...(typeof record.aborted === "boolean" ? { aborted: record.aborted } : {}),
      ...(typeof record.outputLimitReached === "boolean" ? { outputLimitReached: record.outputLimitReached } : {}),
      durationMs: record.durationMs,
      command: record.command,
      shell: record.shell,
      ...(record.semanticOutcome === "no_matches" || record.semanticOutcome === "condition_false" || record.semanticOutcome === "files_differ"
        ? { semanticOutcome: record.semanticOutcome } : {}),
      ...(typeof record.purpose === "string" ? { purpose: record.purpose } : {}),
      ...(typeof record.workspaceChanged === "boolean" ? { workspaceChanged: record.workspaceChanged } : {}),
      ...(resultRef ? { resultRef } : {}),
      terminationReason,
    };
  }
  if (terminationReason === "interrupted") return undefined;
  return {
    version: 1,
    ...(typeof record.exitCode === "number" || record.exitCode === null ? { exitCode: record.exitCode } : {}),
    ...(typeof record.stdoutPreview === "string" ? { stdoutPreview: record.stdoutPreview } : {}),
    ...(typeof record.stderrPreview === "string" ? { stderrPreview: record.stderrPreview } : {}),
    ...(typeof record.timedOut === "boolean" ? { timedOut: record.timedOut } : {}),
    ...(typeof record.aborted === "boolean" ? { aborted: record.aborted } : {}),
    ...(typeof record.outputLimitReached === "boolean" ? { outputLimitReached: record.outputLimitReached } : {}),
    durationMs: record.durationMs,
    command: record.command,
    ...(record.shell === "bash" || record.shell === "powershell" ? { shell: record.shell } : {}),
    ...(record.semanticOutcome === "no_matches" || record.semanticOutcome === "condition_false" || record.semanticOutcome === "files_differ"
      ? { semanticOutcome: record.semanticOutcome } : {}),
    ...(typeof record.purpose === "string" ? { purpose: record.purpose } : {}),
    ...(typeof record.workspaceChanged === "boolean" ? { workspaceChanged: record.workspaceChanged } : {}),
    ...(resultRef ? { resultRef } : {}),
    terminationReason,
  };
}

function normalizeFileResultRef(
  value: unknown,
  binding?: FileReferenceBinding,
): import("@lume/shared").FileResultRef | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "file" || typeof record.path !== "string" || typeof record.size !== "number") return undefined;
  const fileRef = binding ? sessionArtifactFileRef(record.path, binding) : undefined;
  return {
    kind: "file",
    path: record.path,
    size: record.size,
    ...(typeof record.mimeType === "string" ? { mimeType: record.mimeType } : {}),
    ...(fileRef ? { fileRef } : {}),
  };
}

function sessionArtifactFileRef(path: string, binding: FileReferenceBinding): import("@lume/shared").FileRef | undefined {
  if (!isAbsolute(path)) return undefined;
  try {
    const root = resolve(getAgentFileContextRootPath(binding.fileContextId));
    const relativePath = relative(root, resolve(path));
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return undefined;
    const normalized = relativePath.split(sep).join("/");
    if (!normalized.startsWith("artifacts/")) return undefined;
    return {
      source: "session",
      scopeId: binding.fileContextId,
      relativePath: normalized,
    };
  } catch {
    return undefined;
  }
}

function subagentRuntimeFields(item: LumeRunItem): Pick<LumeRuntimeEvent, "subagentRunId" | "parentToolUseId"> {
  const source = item as LumeRunItem & {
    subagentRunId?: string;
    parentToolCallId?: string;
    event?: unknown;
  };
  const event = asRecord(source.event);
  const subagentRunId = stringField(source.subagentRunId) ?? stringField(event.subagent_run_id);
  const parentToolUseId = stringField(source.parentToolCallId) ?? stringField(event.parent_tool_use_id);
  return {
    ...(subagentRunId ? { subagentRunId } : {}),
    ...(parentToolUseId ? { parentToolUseId } : {})
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function projectSystemEventRuntimeEvents(run: LumeRunState, item: LumeRunItem): LumeRuntimeEvent[] {
  if (item.type !== "system_event") return [];
  const payload = asRecord(item.payload);
  const metadata = asRecord(payload.compact_metadata);
  if (item.name === "memory_context_used") {
    const items = normalizeMemoryContextUsedItems(payload.items);
    if (items.length === 0) return [];
    return [{
      id: `${run.runId}:${item.id}:memory.context.used`,
      type: "memory.context.used",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      items,
      hidden: payload.hidden !== false
    }];
  }
  if (item.name === "advisor_reviewed") {
    const severity = stringValue(payload.severity, "suggestion");
    if (severity !== "clear" && severity !== "suggestion" && severity !== "concern" && severity !== "blocker") return [];
    const modelRef = stringValue(payload.modelRef, "unknown");
    const summary = stringValue(payload.summary, "Advisor review completed");
    return [{
      id: `${run.runId}:${item.id}:advisor.reviewed`,
      type: "advisor.reviewed",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      severity,
      summary,
      ...(stringValue(payload.details, "") ? { details: stringValue(payload.details, "") } : {}),
      modelRef,
      ...(typeof payload.durationMs === "number" ? { durationMs: payload.durationMs } : {})
    }];
  }
  if (item.name === "task_notification") {
    const event = projectBackgroundTaskNotificationRuntimeEvent(run.threadId, payload, item.createdAt);
    return event ? [event] : [];
  }
  if (item.name === "lsp_diagnostics") {
    const diagnostics = asRecord(payload.diagnostics);
    const filePath = stringValue(payload.file_path, "");
    const sha256 = stringValue(payload.sha256, "");
    if (!filePath || !sha256) return [];
    return [{
      id: `${run.runId}:${item.id}:lsp.diagnostics.updated`,
      type: "lsp.diagnostics.updated",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      ...(typeof payload.tool_use_id === "string" ? { toolUseId: payload.tool_use_id } : {}),
      filePath,
      mutationVersion: numberValue(payload.mutation_version),
      sha256,
      delayed: payload.delayed === true,
      diagnostics: {
        servers: Array.isArray(diagnostics.servers) ? diagnostics.servers.filter((value): value is string => typeof value === "string") : [],
        total: numberValue(diagnostics.total),
        errors: numberValue(diagnostics.errors),
        warnings: numberValue(diagnostics.warnings),
        truncated: diagnostics.truncated === true,
        items: Array.isArray(diagnostics.items) ? diagnostics.items as Extract<LumeRuntimeEvent, { type: "lsp.diagnostics.updated" }>["diagnostics"]["items"] : [],
        ...(diagnostics.artifact && typeof diagnostics.artifact === "object"
          ? { artifact: diagnostics.artifact as Extract<LumeRuntimeEvent, { type: "lsp.diagnostics.updated" }>["diagnostics"]["artifact"] }
          : {})
      }
    }];
  }
  if (item.name === "context_compaction_started") {
    return [{
      id: `${run.runId}:${item.id}:context.compaction.started`,
      type: "context.compaction.started",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      trigger: stringValue(metadata.trigger, "auto"),
      preTokens: numberValue(metadata.pre_tokens),
      ...optionalNumber("contextWindow", contextWindowFromMetadata(metadata)),
      ...optionalBudget(metadata),
      policy: stringValue(metadata.policy, "sdk-default"),
      source: stringValue(metadata.source, "agent-sdk")
    }];
  }
  if (item.name === "context_compaction_progress") {
    return [{
      id: `${run.runId}:${item.id}:context.compaction.progress`,
      type: "context.compaction.progress",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      trigger: stringValue(metadata.trigger, "auto"),
      preTokens: numberValue(metadata.pre_tokens),
      ...optionalNumber("contextWindow", contextWindowFromMetadata(metadata)),
      ...optionalBudget(metadata),
      policy: stringValue(metadata.policy, "sdk-default"),
      source: stringValue(metadata.source, "agent-sdk"),
      stage: stringValue(metadata.stage, "summarizing"),
      progress: clampProgress(numberValue(metadata.progress)),
      ...(typeof metadata.message === "string" ? { message: metadata.message } : {})
    }];
  }
  if (item.name === "compact_boundary") {
    return [{
      id: `${run.runId}:${item.id}:context.compaction.completed`,
      type: "context.compaction.completed",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      trigger: stringValue(metadata.trigger, "auto"),
      preTokens: numberValue(metadata.pre_tokens),
      ...(typeof metadata.post_tokens === "number" ? { postTokens: metadata.post_tokens } : {}),
      ...optionalNumber("contextWindow", contextWindowFromMetadata(metadata)),
      ...optionalBudget(metadata),
      policy: stringValue(metadata.policy, "sdk-default"),
      source: stringValue(metadata.source, "agent-sdk"),
      ...(typeof metadata.summary === "string" ? { summary: metadata.summary } : {})
    }];
  }
  if (item.name === "result") {
    const context = normalizeRuntimeContextUsage(payload.contextUsage);
    const billing = normalizeRuntimeBillingUsage(payload.billingUsage);
    if (!context || !billing) return [];
    return [{
      id: `${run.runId}:${item.id}:usage.updated`,
      type: "usage.updated",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      ...(stringField(payload.subagent_run_id) ? { subagentRunId: stringField(payload.subagent_run_id) } : {}),
      ...(stringField(payload.parent_tool_use_id) ? { parentToolUseId: stringField(payload.parent_tool_use_id) } : {}),
      scope: usageScopeFromBilling(billing),
      context,
      billing
    }];
  }
  return [];
}

export function projectBackgroundTaskNotificationRuntimeEvent(
  threadId: string,
  payload: unknown,
  createdAt: string
): Extract<LumeRuntimeEvent, { type: "background.task.completed" }> | null {
  const record = asRecord(payload);
  const taskId = stringField(record.task_id);
  const status = normalizeBackgroundTaskStatus(record.status);
  if (!taskId || !status || stringField(record.subagent_run_id)) return null;
  const usage = asRecord(record.usage);
  const execution = normalizeToolExecutionMetadata(record.execution);
  return {
    id: `background-task:${threadId}:${taskId}:completed`,
    type: "background.task.completed",
    threadId,
    runId: `background-task:${taskId}`,
    createdAt,
    taskId,
    status,
    ...(stringField(record.summary) ? { summary: stringField(record.summary) } : {}),
    ...(stringField(record.message) ? { message: stringField(record.message) } : {}),
    ...(stringField(record.output_file) ? { outputFile: stringField(record.output_file) } : {}),
    ...(stringField(record.tool_use_id) ? { toolUseId: stringField(record.tool_use_id) } : {}),
    ...(typeof usage.total_tokens === "number" && typeof usage.tool_uses === "number" && typeof usage.duration_ms === "number"
      ? { usage: { totalTokens: usage.total_tokens, toolUses: usage.tool_uses, durationMs: usage.duration_ms } }
      : {}),
    ...(execution ? { execution } : {})
  };
}

function normalizeBackgroundTaskStatus(value: unknown): Extract<LumeRuntimeEvent, { type: "background.task.completed" }>['status'] | undefined {
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "stopped" || value === "killed") return "stopped";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return undefined;
}

type MemoryContextUsedItem = Extract<LumeRuntimeEvent, { type: "memory.context.used" }>["items"][number];

function normalizeMemoryContextUsedItems(value: unknown): MemoryContextUsedItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const record = asRecord(item);
      if (
        !isMemoryKind(record.kind)
        || !isMemoryScope(record.scope)
        || !isMemoryStatus(record.status)
        || typeof record.id !== "string"
        || typeof record.citation !== "string"
        || typeof record.reason !== "string"
      ) {
        return null;
      }
      return {
        id: record.id,
        kind: record.kind,
        scope: record.scope,
        status: record.status,
        citation: record.citation,
        ...(isMemoryFileRef(record.fileRef) ? { fileRef: record.fileRef } : {}),
        reason: record.reason,
        ...(isMemoryClaim(record.claim) ? { claim: record.claim } : {})
      };
    })
    .filter((item): item is MemoryContextUsedItem => item !== null);
}

function isMemoryFileRef(value: unknown): value is NonNullable<MemoryContextUsedItem["fileRef"]> {
  const record = asRecord(value);
  return record.source === "memory"
    && typeof record.scopeId === "string"
    && typeof record.relativePath === "string";
}

function isMemoryClaim(value: unknown): value is MemoryContextUsedItem["claim"] {
  const record = asRecord(value);
  return typeof record.subject === "string"
    && typeof record.predicate === "string"
    && typeof record.object === "string";
}

function isMemoryKind(value: unknown): value is MemoryContextUsedItem["kind"] {
  return value === "preference"
    || value === "fact"
    || value === "decision"
    || value === "lesson"
    || value === "state";
}

function isMemoryScope(value: unknown): value is MemoryContextUsedItem["scope"] {
  return value === "global" || value === "workspace";
}

function isMemoryStatus(value: unknown): value is MemoryContextUsedItem["status"] {
  return value === "active" || value === "suspected_stale";
}

export function projectAssistantMessageFinalRuntimeEvent(
  run: LumeRunState,
  item: LumeRunItem
): LumeRuntimeEvent | null {
  if (item.type !== "assistant_message") return null;
  const blocks = extractAssistantContentBlocks(item.content)
    .filter((block) => block.text.trim())
    .map((block) => ({
      type: block.kind,
      text: block.text
    }));
  return blocks.length > 0
    ? {
        id: `${run.runId}:${item.id}:assistant.final`,
        type: "assistant.final",
        threadId: run.threadId,
        runId: run.runId,
        createdAt: item.createdAt,
        blocks
      }
    : null;
}

function extractFinalOutput(items: LumeRunItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.type === "assistant_message") {
      const text = extractText(item.content).trim();
      if (text) return text;
    }
    if (item.type === "system_event" && item.name === "result") {
      const payload = asRecord(item.payload);
      if (typeof payload.result === "string" && payload.result.trim()) {
        return payload.result;
      }
    }
  }
  return undefined;
}

function extractModelStreamDelta(event: unknown): { kind: "text" | "thinking"; text: string } | null {
  const record = asRecord(event);
  if (record.type !== "stream_event") return null;
  const streamEvent = asRecord(record.event);
  const delta = asRecord(streamEvent.delta);
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return { kind: "text", text: delta.text };
  }
  if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
    return { kind: "thinking", text: delta.thinking };
  }
  return null;
}

function extractText(content: unknown): string {
  return extractAssistantContentBlocks(content)
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("");
}

function previewRuntimePayload(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractAssistantContentBlocks(content: unknown): Array<{ kind: "text" | "thinking"; text: string }> {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ kind: "text" | "thinking"; text: string }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record.type === "text" && typeof record.text === "string") {
      blocks.push({ kind: "text", text: record.text });
    }
    if ((record.type === "thinking" || record.type === "reasoning") && typeof record.thinking === "string") {
      blocks.push({ kind: "thinking", text: record.thinking });
    }
  }
  return blocks;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumber<K extends string>(key: K, value: number | undefined): Record<K, number> | {} {
  return value === undefined ? {} : { [key]: value } as Record<K, number>;
}

function contextWindowFromMetadata(metadata: Record<string, unknown>): number | undefined {
  if (typeof metadata.context_window === "number" && Number.isFinite(metadata.context_window)) {
    return metadata.context_window;
  }
  const budget = asRecord(metadata.budget);
  if (typeof budget.totalTokens === "number" && Number.isFinite(budget.totalTokens)) {
    return budget.totalTokens;
  }
  if (typeof budget.total === "number" && Number.isFinite(budget.total)) {
    return budget.total;
  }
  return undefined;
}

function normalizeRuntimeContextUsage(
  value: unknown
): Extract<LumeRuntimeEvent, { type: "usage.updated" }>["context"] | null {
  const record = asRecord(value);
  const contextWindow = numberValue(record.contextWindow);
  if (contextWindow <= 0) return null;
  const usage = normalizeRuntimeUsage(record);
  const sections = asRecord(record.sections);
  const normalizedSections = {
    ...optionalNumber("systemTokens", numberOrUndefined(sections.systemTokens)),
    ...optionalNumber("memoryTokens", numberOrUndefined(sections.memoryTokens)),
    ...optionalNumber("toolSchemaTokens", numberOrUndefined(sections.toolSchemaTokens)),
    ...optionalNumber("messageTokens", numberOrUndefined(sections.messageTokens))
  };
  return {
    source: record.source === "provider" ? "provider" : "estimated",
    ...usage,
    estimatedTailTokens: numberValue(record.estimatedTailTokens),
    ...(Object.keys(normalizedSections).length > 0 ? { sections: normalizedSections } : {}),
    contextWindow,
    contextWindowSource: isContextWindowSource(record.contextWindowSource)
      ? record.contextWindowSource
      : "fallback"
  };
}

function normalizeRuntimeBillingUsage(
  value: unknown
): Extract<LumeRuntimeEvent, { type: "usage.updated" }>["billing"] | null {
  const record = asRecord(value);
  const cumulative = normalizeRuntimeUsage(record.cumulative);
  const records = Array.isArray(record.records)
    ? record.records.map(normalizeRuntimeBillingRecord).filter((item): item is NonNullable<typeof item> => item !== null)
    : [];
  const latestRecord = normalizeRuntimeBillingRecord(record.latestRecord);
  if (
    cumulative.totalTokens <= 0
    && records.length === 0
    && !latestRecord
  ) {
    return null;
  }
  return {
    cumulative,
    ...(latestRecord ? { latestRecord } : {}),
    records,
    totalCostUSD: numberValue(record.totalCostUSD)
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

function normalizeRuntimeBillingRecord(
  value: unknown
): Extract<LumeRuntimeEvent, { type: "usage.updated" }>["billing"]["records"][number] | null {
  const record = asRecord(value);
  const usage = normalizeRuntimeUsage(record);
  if (usage.totalTokens <= 0) return null;
  const usageIdentity = normalizeRuntimeUsageIdentity(record.usageIdentity);
  return {
    callerLabel: stringValue(record.callerLabel, usageIdentity?.callerLabel ?? "LLM call"),
    callerKind: usageIdentity?.callerKind ?? stringValue(record.callerKind, "conversation"),
    ...(usageIdentity ? { usageIdentity } : {}),
    ...(typeof record.model === "string" && record.model.trim() ? { model: record.model } : {}),
    ...(typeof record.turn === "number" && Number.isFinite(record.turn) ? { turn: record.turn } : usageIdentity?.turn !== undefined ? { turn: usageIdentity.turn } : {}),
    ...(typeof record.threadId === "string" && record.threadId.trim() ? { threadId: record.threadId } : usageIdentity?.threadId ? { threadId: usageIdentity.threadId } : {}),
    ...(typeof record.runId === "string" && record.runId.trim() ? { runId: record.runId } : usageIdentity?.runId ? { runId: usageIdentity.runId } : {}),
    ...(typeof record.parentThreadId === "string" && record.parentThreadId.trim() ? { parentThreadId: record.parentThreadId } : usageIdentity?.parentThreadId ? { parentThreadId: usageIdentity.parentThreadId } : {}),
    ...(typeof record.parentRunId === "string" && record.parentRunId.trim() ? { parentRunId: record.parentRunId } : usageIdentity?.parentRunId ? { parentRunId: usageIdentity.parentRunId } : {}),
    ...(typeof record.subagentRunId === "string" && record.subagentRunId.trim() ? { subagentRunId: record.subagentRunId } : usageIdentity?.subagentRunId ? { subagentRunId: usageIdentity.subagentRunId } : {}),
    ...(typeof record.responseId === "string" && record.responseId.trim() ? { responseId: record.responseId } : usageIdentity?.responseId ? { responseId: usageIdentity.responseId } : {}),
    ...usage,
    ...(typeof record.ttftMs === "number" && Number.isFinite(record.ttftMs) ? { ttftMs: record.ttftMs } : {}),
    ...(typeof record.costUSD === "number" && Number.isFinite(record.costUSD) ? { costUSD: record.costUSD } : {})
  };
}

function normalizeRuntimeUsageIdentity(
  value: unknown
): Extract<LumeRuntimeEvent, { type: "usage.updated" }>["billing"]["records"][number]["usageIdentity"] | undefined {
  const record = asRecord(value);
  if (typeof record.threadId !== "string" || !record.threadId.trim()) return undefined;
  return {
    threadId: record.threadId,
    callerKind: stringValue(record.callerKind, "conversation"),
    ...(typeof record.runId === "string" && record.runId.trim() ? { runId: record.runId } : {}),
    ...(typeof record.parentThreadId === "string" && record.parentThreadId.trim() ? { parentThreadId: record.parentThreadId } : {}),
    ...(typeof record.parentRunId === "string" && record.parentRunId.trim() ? { parentRunId: record.parentRunId } : {}),
    ...(typeof record.subagentRunId === "string" && record.subagentRunId.trim() ? { subagentRunId: record.subagentRunId } : {}),
    ...(typeof record.responseId === "string" && record.responseId.trim() ? { responseId: record.responseId } : {}),
    ...(typeof record.turn === "number" && Number.isFinite(record.turn) ? { turn: record.turn } : {}),
    ...(typeof record.callerLabel === "string" && record.callerLabel.trim() ? { callerLabel: record.callerLabel } : {})
  };
}

function usageScopeFromBilling(
  billing: Extract<LumeRuntimeEvent, { type: "usage.updated" }>["billing"]
): Extract<LumeRuntimeEvent, { type: "usage.updated" }>["scope"] {
  const latest = billing.latestRecord ?? billing.records[billing.records.length - 1];
  if (latest?.callerKind === "subagent" || latest?.subagentRunId) return "subagent";
  if (latest && latest.callerKind !== "conversation") return "background";
  return "main";
}

function isContextWindowSource(value: unknown): value is Extract<LumeRuntimeEvent, { type: "usage.updated" }>["context"]["contextWindowSource"] {
  return value === "model" || value === "provider" || value === "fallback";
}

function optionalBudget(metadata: Record<string, unknown>): { budget: NonNullable<Extract<LumeRuntimeEvent, { type: "context.compaction.started" }>["budget"]> } | {} {
  const budget = asRecord(metadata.budget);
  const sections = asRecord(budget.sections);
  const snapshot = {
    totalTokens: numberValue(budget.totalTokens),
    usedTokens: numberValue(budget.usedTokens),
    remainingTokens: numberValue(budget.remainingTokens),
    sections: {
      ...optionalNumber("system", numberOrUndefined(sections.system)),
      ...optionalNumber("memory", numberOrUndefined(sections.memory)),
      ...optionalNumber("session", numberOrUndefined(sections.session)),
      ...optionalNumber("toolSchemas", numberOrUndefined(sections.toolSchemas)),
      ...optionalNumber("reservedOutput", numberOrUndefined(sections.reservedOutput))
    }
  };
  if (snapshot.totalTokens <= 0 && snapshot.usedTokens <= 0 && Object.keys(snapshot.sections).length === 0) {
    return {};
  }
  return { budget: snapshot };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}
