import type { AgentEvent } from "@lume/shared";
import type { AgentEvent as PiCoreAgentEvent } from "@mariozechner/pi-agent-core";
import { extractRenderableAssistantText } from "../content-extraction";

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
      if (event.assistantMessageEvent.type === "done") {
        const text = extractAssistantText(event.assistantMessageEvent.message);
        if (!text) return [];
        return [{
          type: "text_complete",
          text,
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
      if (text) {
        mapped.push({
          type: "text_complete",
          text,
          isIntermediate: false
        });
      }
      if (
        event.message.usage &&
        typeof event.message.usage.totalTokens === "number"
      ) {
        mapped.push({
          type: "usage_update",
          usage: {
            inputTokens: event.message.usage.totalTokens,
            contextWindow: options.contextWindow
          }
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
