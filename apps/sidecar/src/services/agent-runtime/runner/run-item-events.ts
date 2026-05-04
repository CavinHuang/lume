import type { LumeRunEvent } from "@lume/shared";
import type { LumeRunItem } from "./run-items";
import type { LumeRunState } from "./run-state";

export function projectRunStateToRunEvents(run: LumeRunState): LumeRunEvent[] {
  if (isRuntimeContinuationRun(run)) {
    return [];
  }
  const events: LumeRunEvent[] = [];
  const userMessage = typeof run.input.userMessage === "string" ? run.input.userMessage : "";
  if (userMessage.trim() && !isHiddenFromChatRun(run)) {
    const metadata = run.input.messageMetadata;
    events.push({
      type: "user_message_submitted",
      text: userMessage,
      createdAt: run.createdAt,
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
    const itemEvents = projectRunItemToRunEvents(item, {
      includeAssistantText: true,
      includeAssistantThinking: true,
      includeModelStreamText: !hasAssistantMessage
    });
    events.push(...itemEvents);
  }

  if (run.status === "completed") {
    events.push({
      type: "run_completed",
      result: {
        status: "completed",
        finalOutput: extractFinalOutput(run.generatedItems)
      }
    });
  }

  if (run.status === "failed" || run.status === "cancelled") {
    events.push({
      type: "run_failed",
      error: {
        code: run.error?.code ?? run.status,
        message: run.error?.message ?? (run.status === "cancelled" ? "Run cancelled" : "Run failed"),
        retryable: run.error?.retryable
      }
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

export function projectRunItemToRunEvent(
  item: LumeRunItem,
  options: { includeAssistantText: boolean; includeAssistantThinking?: boolean; includeModelStreamText: boolean }
): LumeRunEvent | null {
  return projectRunItemToRunEvents(item, options)[0] ?? null;
}

export function projectRunItemToRunEvents(
  item: LumeRunItem,
  options: { includeAssistantText: boolean; includeAssistantThinking?: boolean; includeModelStreamText: boolean }
): LumeRunEvent[] {
  if (item.type === "assistant_message") {
    const events: LumeRunEvent[] = [];
    for (const block of extractAssistantContentBlocks(item.content)) {
      if (block.kind === "thinking" && options.includeAssistantThinking !== false && block.text.trim()) {
        events.push({ type: "assistant_thinking_delta", text: block.text });
      }
      if (block.kind === "text" && options.includeAssistantText && block.text.trim()) {
        events.push({ type: "assistant_delta", text: block.text });
      }
    }
    return events;
  }

  if (item.type === "model_stream" && options.includeModelStreamText) {
    const delta = extractModelStreamDelta(item.event);
    if (!delta || delta.text.length === 0) return [];
    if (delta.kind === "thinking" && !delta.text.trim()) return [];
    return [{
      type: delta.kind === "thinking" ? "assistant_thinking_delta" : "assistant_delta",
      text: delta.text
    }];
  }

  if (item.type === "tool_call") {
    return [{ type: "tool_call_started", item }];
  }

  if (item.type === "tool_result") {
    return [{ type: "tool_call_completed", item }];
  }

  if (item.type === "subagent") {
    return [{ type: "subagent_updated", item }];
  }

  if (item.type === "handoff") {
    return [{ type: "handoff_updated", item }];
  }

  return [];
}

export function projectAssistantMessageFinalEvent(item: LumeRunItem): LumeRunEvent | null {
  if (item.type !== "assistant_message") return null;
  const blocks = extractAssistantContentBlocks(item.content)
    .filter((block) => block.text.trim())
    .map((block) => ({
      type: block.kind,
      text: block.text
    }));
  return blocks.length > 0 ? { type: "assistant_message_final", blocks } : null;
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

function extractModelStreamText(event: unknown): string {
  return extractModelStreamDelta(event)?.text ?? "";
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
