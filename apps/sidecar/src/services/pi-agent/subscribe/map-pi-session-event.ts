import type { AgentEvent, AgentEventUsage } from "@lume/shared";
import type { AgentEvent as PiCoreAgentEvent } from "@mariozechner/pi-agent-core";
import { extractAssistantReasoningText, extractRenderableAssistantText } from "../content-extraction";

const TOOL_RESULT_MAX_BYTES = 20_000;
const TOOL_RESULT_TRUNCATE_SUFFIX = "\n...(输出过长已截断)";

interface MapPiSessionEventOptions {
  contextWindow?: number;
}

export function mapPiSessionEventToAgentEvents(
  event: PiCoreAgentEvent,
  options: MapPiSessionEventOptions = {}
): AgentEvent[] {
  switch (event.type) {
    case "message_update": {
      const reasoningEvents = extractReasoningUpdates(event.assistantMessageEvent);
      if (event.assistantMessageEvent.type === "done") {
        const text = extractAssistantText(event.assistantMessageEvent.message);
        const mapped: AgentEvent[] = [...reasoningEvents];
        if (!text) return mapped;
        mapped.push({
          type: "text_complete",
          text,
          isIntermediate: false
        });
        return mapped;
      }
      if (reasoningEvents.length > 0) {
        return reasoningEvents;
      }
      if (event.assistantMessageEvent.type === "text_delta") {
        return [{ type: "text_delta", text: event.assistantMessageEvent.delta }];
      }
      if (event.assistantMessageEvent.type === "text_end") {
        return [{
          type: "text_complete",
          text: event.assistantMessageEvent.content,
          isIntermediate: false
        }];
      }
      return [];
    }
    case "message_end": {
      if (event.message.role !== "assistant") {
        return [];
      }
      const mapped: AgentEvent[] = [];
      const text = extractAssistantText(event.message);
      const reasoning = extractAssistantReasoning(event.message);
      if (reasoning) {
        mapped.push({
          type: "reasoning_complete",
          text: reasoning,
          isIntermediate: false
        });
      }
      if (text) {
        mapped.push({
          type: "text_complete",
          text,
          isIntermediate: false
        });
      }
      if (
        event.message.usage &&
        (
          typeof event.message.usage.input === "number"
          || typeof event.message.usage.totalTokens === "number"
        )
      ) {
        mapped.push({
          type: "usage_update",
          usage: mapPiUsage(event.message.usage, options.contextWindow)
        });
      }
      return mapped;
    }
    case "tool_execution_start":
      return [{
        type: "tool_start",
        toolName: event.toolName,
        toolUseId: event.toolCallId,
        input: toRecord(event.args)
      }];
    case "tool_execution_end":
      return [{
        type: "tool_result",
        toolUseId: event.toolCallId,
        toolName: event.toolName,
        result: stringifyResult(event.result),
        isError: event.isError
      }];
    case "tool_execution_update": {
      const description = extractPartialResultText(event.partialResult);
      if (!description) return [];
      return [{
        type: "task_progress",
        toolUseId: event.toolCallId,
        elapsedSeconds: 0,
        description
      }];
    }
    default:
      return [];
  }
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function stringifyResult(value: unknown): string {
  let result: string;
  if (typeof value === "string") {
    result = value;
  } else {
    try {
      result = JSON.stringify(value, null, 2);
    } catch {
      result = String(value);
    }
  }
  if (result.length > TOOL_RESULT_MAX_BYTES) {
    return result.slice(0, TOOL_RESULT_MAX_BYTES) + TOOL_RESULT_TRUNCATE_SUFFIX;
  }
  return result;
}

function extractPartialResultText(partialResult: unknown): string {
  if (!partialResult || typeof partialResult !== "object") return "";
  const record = partialResult as { content?: unknown };
  if (!Array.isArray(record.content)) return "";
  const parts: string[] = [];
  for (const item of record.content) {
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string; text?: unknown };
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  const text = parts.join(" ");
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function extractAssistantText(message: {
  content?: unknown;
}): string {
  return extractRenderableAssistantText(message.content);
}

function extractAssistantReasoning(message: {
  content?: unknown;
}): string {
  return extractAssistantReasoningText(message.content);
}

function extractReasoningUpdates(assistantMessageEvent: unknown): AgentEvent[] {
  if (!assistantMessageEvent || typeof assistantMessageEvent !== "object") {
    return [];
  }
  const record = assistantMessageEvent as {
    type?: unknown;
    delta?: unknown;
    content?: unknown;
    reasoning?: unknown;
    thinking?: unknown;
    message?: { content?: unknown };
  };
  const eventType = typeof record.type === "string" ? record.type : "";

  if (eventType === "reasoning_delta" || eventType === "thinking_delta") {
    const delta = typeof record.delta === "string"
      ? record.delta
      : typeof record.reasoning === "string"
        ? record.reasoning
        : typeof record.thinking === "string"
          ? record.thinking
          : "";
    return delta
      ? [{ type: "reasoning_delta", text: delta }]
      : [];
  }

  if (eventType === "reasoning_end" || eventType === "thinking_end") {
    const content = typeof record.content === "string"
      ? record.content
      : typeof record.reasoning === "string"
        ? record.reasoning
        : typeof record.thinking === "string"
          ? record.thinking
          : "";
    return content
      ? [{ type: "reasoning_complete", text: content, isIntermediate: false }]
      : [];
  }

  if (eventType === "done" && record.message) {
    const reasoning = extractAssistantReasoning(record.message);
    return reasoning
      ? [{ type: "reasoning_complete", text: reasoning, isIntermediate: false }]
      : [];
  }

  return [];
}

function mapPiUsage(
  usage: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  },
  contextWindow?: number
): AgentEventUsage {
  const inputTokens = usage.input ?? 0;
  const outputTokens = usage.output ?? 0;
  const cacheReadTokens = usage.cacheRead ?? 0;
  const cacheCreationTokens = usage.cacheWrite ?? 0;
  const totalTokens = typeof usage.totalTokens === "number"
    ? usage.totalTokens
    : inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    costUsd: usage.cost?.total,
    contextWindow
  };
}
