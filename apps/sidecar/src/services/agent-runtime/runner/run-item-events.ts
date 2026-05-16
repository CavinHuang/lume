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
    events.push({
      id: `${run.runId}:message.user.submitted`,
      type: "message.user.submitted",
      threadId: run.threadId,
      runId: run.runId,
      createdAt: run.createdAt,
      text: userMessage,
      ...(typeof metadata?.messageId === "string" ? { messageId: metadata.messageId } : {}),
      ...(typeof metadata?.versionGroupId === "string" ? { versionGroupId: metadata.versionGroupId } : {}),
      ...(typeof metadata?.versionIndex === "number" ? { versionIndex: metadata.versionIndex } : {}),
      ...(typeof metadata?.versionCount === "number" ? { versionCount: metadata.versionCount } : {})
    });
  }

  const hasAssistantMessage = run.generatedItems.some((item) =>
    item.type === "assistant_message" && extractText(item.content).trim().length > 0
  );

  for (const item of run.generatedItems) {
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
          messageId: item.id
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
          messageId: item.id
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
      delta: delta.text
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
      inputPreview: item.input
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
        }
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
      resultPreview: previewRuntimePayload(item.output)
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

  return [];
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
