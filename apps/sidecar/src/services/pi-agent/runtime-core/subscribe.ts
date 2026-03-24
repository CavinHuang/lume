import type { AgentEvent } from "@lume/shared";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { mapPiSessionEventToAgentEvents } from "../subscribe/map-pi-session-event";

export interface ProjectRuntimeCoreEventOptions {
  contextWindow?: number;
}

export function projectLifecycleRuntimeCoreEventToLumeEvents(
  event: AgentSessionEvent
): AgentEvent[] | null {
  if (event.type === "auto_compaction_start") {
    return [{ type: "compacting" }];
  }
  if (event.type === "auto_compaction_end") {
    return [{ type: "compact_complete" }];
  }
  if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
    return [];
  }
  return null;
}

export function projectMessageRuntimeCoreEventToLumeEvents(
  event: AgentSessionEvent,
  options: ProjectRuntimeCoreEventOptions = {}
): AgentEvent[] | null {
  if (event.type !== "message_update" && event.type !== "message_end") {
    return null;
  }
  return mapPiSessionEventToAgentEvents(event, {
    contextWindow: options.contextWindow
  });
}

export function projectToolRuntimeCoreEventToLumeEvents(
  event: AgentSessionEvent,
  options: ProjectRuntimeCoreEventOptions = {}
): AgentEvent[] | null {
  if (
    event.type !== "tool_execution_start"
    && event.type !== "tool_execution_update"
    && event.type !== "tool_execution_end"
  ) {
    return null;
  }
  return mapPiSessionEventToAgentEvents(event, {
    contextWindow: options.contextWindow
  });
}

export function projectRuntimeCoreEventToLumeEvents(
  event: AgentSessionEvent,
  options: ProjectRuntimeCoreEventOptions = {}
): AgentEvent[] {
  const lifecycleEvents = projectLifecycleRuntimeCoreEventToLumeEvents(event);
  if (lifecycleEvents) {
    return lifecycleEvents;
  }

  const messageEvents = projectMessageRuntimeCoreEventToLumeEvents(event, options);
  if (messageEvents) {
    return messageEvents;
  }

  const toolEvents = projectToolRuntimeCoreEventToLumeEvents(event, options);
  if (toolEvents) {
    return toolEvents;
  }

  return [];
}
