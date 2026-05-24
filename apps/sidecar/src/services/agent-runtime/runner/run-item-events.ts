import type { LumeRuntimeEvent } from "@lume/shared";
import type { LumeRunItem } from "./run-items";
import type { LumeRunState } from "./run-state";

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
    events.push({
      id: `${run.runId}:message.user.submitted`,
      type: "message.user.submitted",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: run.createdAt,
      text: userMessage,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
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
      finalOutput: extractFinalOutput(run.generatedItems)
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
      }
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

  return events;
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
      ...subagentFields
    }];
  }

  if (item.type === "tool_result") {
    const isError = item.isError === true;
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

  if (item.type === "system_event") {
    return projectSystemEventRuntimeEvents(run, item);
  }

  return [];
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
    const usage = asRecord(payload.usage);
    const inputTokens = numberValue(usage.input_tokens);
    const outputTokens = numberValue(usage.output_tokens);
    const cachedTokens = numberValue(usage.cache_read_input_tokens)
      + numberValue(usage.cache_creation_input_tokens);
    const totalTokens = inputTokens
      + outputTokens
      + cachedTokens;
    return [{
      id: `${run.runId}:${item.id}:usage.updated`,
      type: "usage.updated",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: item.createdAt,
      inputTokens,
      outputTokens,
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      ...optionalUsageRecords(payload.usageRecords, payload.modelUsage),
      totalTokens,
      ...optionalNumber("contextWindow", contextWindowFromModelUsage(payload.modelUsage)),
      ...(typeof payload.total_cost_usd === "number" ? { costUSD: payload.total_cost_usd } : {})
    }];
  }
  return [];
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
        reason: record.reason,
        ...(isMemoryClaim(record.claim) ? { claim: record.claim } : {})
      };
    })
    .filter((item): item is MemoryContextUsedItem => item !== null);
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

function contextWindowFromModelUsage(modelUsage: unknown): number | undefined {
  const usageByModel = asRecord(modelUsage);
  for (const usage of Object.values(usageByModel)) {
    const record = asRecord(usage);
    if (typeof record.contextWindow === "number" && Number.isFinite(record.contextWindow)) {
      return record.contextWindow;
    }
  }
  return undefined;
}

function optionalUsageRecords(
  sdkUsageRecords: unknown,
  modelUsage: unknown
): Pick<Extract<LumeRuntimeEvent, { type: "usage.updated" }>, "usageRecords"> | {} {
  if (Array.isArray(sdkUsageRecords)) {
    const usageRecords = sdkUsageRecords
      .map((usage) => {
        const record = asRecord(usage);
        const inputTokens = numberValue(record.inputTokens);
        const outputTokens = numberValue(record.outputTokens);
        const directCachedTokens = numberValue(record.cachedTokens);
        const cachedTokens = directCachedTokens > 0
          ? directCachedTokens
          : numberValue(record.cacheReadInputTokens) + numberValue(record.cacheCreationInputTokens);
        return {
          callerLabel: stringValue(record.callerLabel, "LLM call"),
          ...(typeof record.model === "string" && record.model.trim() ? { model: record.model } : {}),
          ...(typeof record.turn === "number" && Number.isFinite(record.turn) ? { turn: record.turn } : {}),
          inputTokens,
          outputTokens,
          ...(cachedTokens > 0 ? { cachedTokens } : {}),
          ...(typeof record.costUSD === "number" && Number.isFinite(record.costUSD) ? { costUSD: record.costUSD } : {})
        };
      })
      .filter((record) => record.inputTokens > 0 || record.outputTokens > 0 || (record.cachedTokens ?? 0) > 0);
    if (usageRecords.length > 0) return { usageRecords };
  }

  const usageByModel = asRecord(modelUsage);
  const usageRecords = Object.entries(usageByModel)
    .map(([modelId, usage]) => {
      const record = asRecord(usage);
      const inputTokens = numberValue(record.inputTokens);
      const outputTokens = numberValue(record.outputTokens);
      const cachedTokens = numberValue(record.cacheReadInputTokens)
        + numberValue(record.cacheCreationInputTokens);
      return {
        callerLabel: modelId,
        inputTokens,
        outputTokens,
        ...(cachedTokens > 0 ? { cachedTokens } : {}),
        ...(typeof record.costUSD === "number" && Number.isFinite(record.costUSD) ? { costUSD: record.costUSD } : {})
      };
    })
    .filter((record) => record.inputTokens > 0 || record.outputTokens > 0 || (record.cachedTokens ?? 0) > 0);
  return usageRecords.length > 0 ? { usageRecords } : {};
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
