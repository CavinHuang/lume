/**
 * Migrated from:
 * E:\projects\ai-projects\Proma\apps\electron\src\main\lib\agent-service.ts
 * Adaptation:
 * - Isolated stream accumulation logic into sidecar-agnostic helper.
 * - Keeps persistent payload generation independent from UI/event transport.
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentMessage } from "@lume/shared";

export interface AgentStreamAccumulatorState {
  text: string;
  events: AgentEvent[];
}

export function createAgentStreamAccumulatorState(): AgentStreamAccumulatorState {
  return {
    text: "",
    events: []
  };
}

export function appendAgentEvents(
  state: AgentStreamAccumulatorState,
  incomingEvents: AgentEvent[]
): AgentStreamAccumulatorState {
  for (const event of incomingEvents) {
    if (event.type === "text_delta") {
      state.text += event.text;
    }
    if (event.type === "text_complete") {
      state.text = mergeAccumulatedText(state.text, event.text);
    }
    state.events.push(event);
  }

  return state;
}

function mergeAccumulatedText(current: string, next: string): string {
  if (!next) return current;
  if (!current) return next;
  if (current === next) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;

  const maxOverlap = Math.min(current.length, next.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    if (current.endsWith(next.slice(0, overlap))) {
      return current + next.slice(overlap);
    }
  }
  return current + next;
}

export function buildAssistantAgentMessage(
  state: AgentStreamAccumulatorState,
  modelId: string,
  now = Date.now()
): AgentMessage | null {
  if (!hasRenderableAssistantOutput(state)) {
    return null;
  }

  return {
    id: randomUUID(),
    role: "assistant",
    content: state.text,
    createdAt: now,
    model: modelId,
    events: state.events
  };
}

export function hasRenderableAssistantOutput(state: AgentStreamAccumulatorState): boolean {
  if (state.text.trim().length > 0) {
    return true;
  }
  return state.events.some((event) =>
    event.type === "text_delta"
    || event.type === "text_complete"
    || event.type === "tool_start"
    || event.type === "tool_result"
  );
}
