import type { AgentEvent } from "@lume/shared";
import type { AgentEvent as PiCoreAgentEvent } from "@mariozechner/pi-agent-core";
import type { AgentStreamAccumulatorState } from "../../agent-stream-accumulator";
import { appendAgentEvents } from "../../agent-stream-accumulator";
import { extractRenderableAssistantText } from "../content-extraction";
import { mapPiSessionEventToAgentEvents } from "./map-pi-session-event";

interface HandlePiSessionEventInput {
  event: PiCoreAgentEvent;
  contextWindow?: number;
  accumulator: AgentStreamAccumulatorState;
  onEvent: (event: AgentEvent) => void;
}

export function handlePiSessionEvent(input: HandlePiSessionEventInput): AgentEvent[] {
  const mappedEvents = mapPiSessionEventToAgentEvents(input.event, {
    contextWindow: input.contextWindow
  });
  const hasMappedTextEvent = mappedEvents.some((event) =>
    event.type === "text_delta" || event.type === "text_complete"
  );
  const fallbackTextEvents = hasMappedTextEvent
    ? []
    : buildFallbackTextEvents(input.event, input.accumulator.text);
  const normalizedEvents = [...mappedEvents, ...fallbackTextEvents];
  if (normalizedEvents.length === 0) {
    return normalizedEvents;
  }
  appendAgentEvents(input.accumulator, normalizedEvents);
  for (const event of normalizedEvents) {
    input.onEvent(event);
  }
  return normalizedEvents;
}

function buildFallbackTextEvents(
  event: PiCoreAgentEvent,
  accumulatedText: string
): AgentEvent[] {
  const assistantText = extractAssistantTextFromPiEvent(event);
  if (!assistantText) return [];
  if (!accumulatedText) {
    return [{ type: "text_delta", text: assistantText }];
  }
  if (assistantText === accumulatedText) {
    return [];
  }
  if (assistantText.startsWith(accumulatedText)) {
    return [{ type: "text_delta", text: assistantText.slice(accumulatedText.length) }];
  }
  return [{ type: "text_complete", text: assistantText, isIntermediate: false }];
}

function extractAssistantTextFromPiEvent(event: PiCoreAgentEvent): string {
  if (event.type !== "message_update" && event.type !== "message_end") {
    return "";
  }
  if (event.message.role !== "assistant") {
    return "";
  }
  return extractRenderableAssistantText(event.message.content);
}
