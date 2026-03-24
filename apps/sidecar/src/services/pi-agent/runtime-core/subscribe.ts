import type { AgentEvent } from "@lume/shared";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { mapPiSessionEventToAgentEvents } from "../subscribe/map-pi-session-event";

export interface ProjectRuntimeCoreEventOptions {
  contextWindow?: number;
}

export function projectRuntimeCoreEventToLumeEvents(
  event: AgentSessionEvent,
  options: ProjectRuntimeCoreEventOptions = {}
): AgentEvent[] {
  if (
    event.type === "auto_compaction_start"
    || event.type === "auto_compaction_end"
    || event.type === "auto_retry_start"
    || event.type === "auto_retry_end"
  ) {
    return [];
  }
  return mapPiSessionEventToAgentEvents(event, {
    contextWindow: options.contextWindow
  });
}
