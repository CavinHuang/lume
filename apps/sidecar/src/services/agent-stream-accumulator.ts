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
    state.events.push(event);
  }

  return state;
}

export function buildAssistantAgentMessage(
  state: AgentStreamAccumulatorState,
  modelId: string,
  now = Date.now()
): AgentMessage | null {
  if (!state.text && state.events.length === 0) {
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
