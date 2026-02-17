import type { AgentEvent } from "@lume/shared";
import type { AgentEvent as PiCoreAgentEvent } from "@mariozechner/pi-agent-core";

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
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractAssistantText(message: {
  content?: unknown;
}): string {
  const content = message.content;
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const block = item as { type?: string; text?: unknown };
    if (block.type !== "text") {
      continue;
    }
    if (typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text);
    }
  }
  return parts.join("");
}
