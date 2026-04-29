import type { SDKMessage } from "@lume/shared";
import type { LumeInterruption } from "../interruption/interruption";
import type { LumePlan } from "../plan/plan-types";
import type { LumeTraceSpan } from "../trace/trace-types";
import type { LumeRunError } from "./run-errors";
import type { LumeToolCallItem, LumeToolResultItem } from "./run-items";
import type { LumeRunResult } from "./run-result";
import type { LumeRunState, LumeRunStep } from "./run-state";

export type LumeRunEvent =
  | { type: "run_started"; state: LumeRunState }
  | { type: "run_step_started"; step: LumeRunStep }
  | { type: "run_step_completed"; step: LumeRunStep }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_call_started"; item: LumeToolCallItem }
  | { type: "tool_call_completed"; item: LumeToolResultItem }
  | { type: "interruption_created"; interruption: LumeInterruption }
  | { type: "interruption_resolved"; interruption: LumeInterruption }
  | { type: "plan_updated"; plan: LumePlan }
  | { type: "trace_span_started"; span: LumeTraceSpan }
  | { type: "trace_span_completed"; span: LumeTraceSpan }
  | { type: "run_completed"; result: LumeRunResult }
  | { type: "run_failed"; error: LumeRunError };

export interface MapSdkMessageToRunEventsState {
  currentAgentId: string;
}

export function mapSdkMessageToRunEvents(
  message: SDKMessage,
  state: MapSdkMessageToRunEventsState = { currentAgentId: "runtime-core" },
  now: () => string = () => new Date().toISOString()
): LumeRunEvent[] {
  if (message.type === "assistant") {
    const events: LumeRunEvent[] = [];
    const text = message.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    if (text.length > 0) {
      events.push({ type: "assistant_delta", text });
    }

    for (const block of message.message.content) {
      if (block.type !== "tool_use") continue;
      events.push({
        type: "tool_call_started",
        item: {
          type: "tool_call",
          id: block.id,
          toolName: block.name,
          input: block.input,
          parentAgentId: state.currentAgentId,
          parentToolCallId: message.parent_tool_use_id ?? undefined,
          status: "pending",
          createdAt: now()
        }
      });
    }

    return events;
  }

  if (message.type === "stream_event") {
    const delta = message.event.delta;
    if (isTextDelta(delta)) {
      return [{ type: "assistant_delta", text: delta.text }];
    }
    return [];
  }

  if (message.type === "partial_message" && message.partial.type === "text" && message.partial.text) {
    return [{ type: "assistant_delta", text: message.partial.text }];
  }

  if (message.type === "tool_result") {
    return [{
      type: "tool_call_completed",
      item: {
        type: "tool_result",
        id: `${message.result.tool_use_id}-result`,
        toolCallId: message.result.tool_use_id,
        toolName: message.result.tool_name,
        output: message.result.output,
        createdAt: now()
      }
    }];
  }

  if (message.type === "result") {
    if (message.is_error || message.subtype.startsWith("error_")) {
      return [{
        type: "run_failed",
        error: {
          code: message.subtype,
          message: message.errors?.find(Boolean) ?? message.result ?? message.stop_reason ?? "runtime errored"
        }
      }];
    }
    if (message.subtype === "success") {
      return [{
        type: "run_completed",
        result: {
          status: "completed",
          finalOutput: message.result
        }
      }];
    }
  }

  return [];
}

function isTextDelta(value: unknown): value is { type: "text_delta"; text: string } {
  return Boolean(
    value
      && typeof value === "object"
      && "type" in value
      && value.type === "text_delta"
      && "text" in value
      && typeof value.text === "string"
  );
}
