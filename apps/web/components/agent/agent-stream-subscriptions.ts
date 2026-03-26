import type { AgentEvent } from "@lume/shared";

export function shouldAutoOpenTeamPanel(event: AgentEvent): boolean {
  return event.type === "task_started"
    || (
      event.type === "tool_start"
      && (event.toolName === "Agent" || event.toolName === "Task" || event.toolName === "sessions_spawn")
    );
}
