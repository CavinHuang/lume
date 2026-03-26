import type { AgentMessage, SubagentRunRecord } from "@lume/shared";
import type { ToolActivity } from "./agent-streaming";

export type ToolActivityStatus = "running" | "completed" | "error" | "backgrounded";

const TEAM_CONTEXT_TOOL_NAMES = new Set(["TeamCreate", "TaskCreate", "TaskUpdate", "Task", "Agent"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function getToolActivityStatus(activity: ToolActivity): ToolActivityStatus {
  if (activity.isBackground) return "backgrounded";
  if (!activity.done) return "running";
  if (activity.isError) return "error";
  return "completed";
}

export function extractToolActivitiesFromMessages(messages: AgentMessage[]): ToolActivity[] {
  const order: string[] = [];
  const map = new Map<string, ToolActivity>();

  const ensureEntry = (toolUseId: string): ToolActivity => {
    const existing = map.get(toolUseId);
    if (existing) return existing;
    const created: ToolActivity = {
      toolUseId,
      toolName: "Unknown",
      input: {},
      done: false
    };
    map.set(toolUseId, created);
    order.push(toolUseId);
    return created;
  };

  for (const message of messages) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.events)) continue;
    for (const event of message.events) {
      switch (event.type) {
        case "tool_start": {
          const current = ensureEntry(event.toolUseId);
          map.set(event.toolUseId, {
            ...current,
            toolName: event.toolName,
            input: asRecord(event.input),
            intent: event.intent ?? current.intent,
            displayName: event.displayName ?? current.displayName,
            parentToolUseId: event.parentToolUseId ?? current.parentToolUseId,
            done: false
          });
          break;
        }
        case "tool_result": {
          const current = ensureEntry(event.toolUseId);
          map.set(event.toolUseId, {
            ...current,
            toolName: event.toolName ?? current.toolName,
            result: event.result,
            isError: event.isError,
            done: true
          });
          break;
        }
        case "task_backgrounded": {
          const current = ensureEntry(event.toolUseId);
          map.set(event.toolUseId, {
            ...current,
            isBackground: true,
            taskId: event.taskId
          });
          break;
        }
        case "task_progress": {
          const current = ensureEntry(event.toolUseId);
          map.set(event.toolUseId, {
            ...current,
            elapsedSeconds: event.elapsedSeconds
          });
          break;
        }
        case "shell_backgrounded": {
          const current = ensureEntry(event.toolUseId);
          map.set(event.toolUseId, {
            ...current,
            isBackground: true,
            shellId: event.shellId
          });
          break;
        }
        default:
          break;
      }
    }
  }

  return order.map((id) => map.get(id)).filter((item): item is ToolActivity => !!item);
}

function upsertActivity(
  map: Map<string, ToolActivity>,
  order: string[],
  activity: ToolActivity
): void {
  const current = map.get(activity.toolUseId);
  if (!current) {
    map.set(activity.toolUseId, {
      ...activity,
      input: asRecord(activity.input)
    });
    order.push(activity.toolUseId);
    return;
  }

  map.set(activity.toolUseId, {
    ...current,
    ...activity,
    input: Object.keys(asRecord(activity.input)).length > 0 ? asRecord(activity.input) : current.input,
    intent: activity.intent ?? current.intent,
    displayName: activity.displayName ?? current.displayName,
    parentToolUseId: activity.parentToolUseId ?? current.parentToolUseId,
    result: activity.result ?? current.result,
    isError: activity.isError ?? current.isError,
    elapsedSeconds: activity.elapsedSeconds ?? current.elapsedSeconds,
    taskId: activity.taskId ?? current.taskId,
    shellId: activity.shellId ?? current.shellId,
    isBackground: activity.isBackground ?? current.isBackground,
    done: activity.done
  });
}

export function mergeToolActivities(history: ToolActivity[], streaming: ToolActivity[]): ToolActivity[] {
  const order: string[] = [];
  const map = new Map<string, ToolActivity>();

  for (const item of history) {
    upsertActivity(map, order, item);
  }
  for (const item of streaming) {
    upsertActivity(map, order, item);
  }

  return order.map((id) => map.get(id)).filter((item): item is ToolActivity => !!item);
}

function isTerminalRunStatus(status: SubagentRunRecord["status"]): boolean {
  return (
    status === "completed"
    || status === "errored"
    || status === "aborted"
    || status === "timed_out"
    || status === "canceled"
  );
}

export function buildTeamActivitiesFromRuns(runs: SubagentRunRecord[]): ToolActivity[] {
  return runs.map((run, index) => {
    const endedAt = run.endedAt ?? Date.now();
    const elapsedSeconds = run.startedAt ? Math.max(0, Math.floor((endedAt - run.startedAt) / 1000)) : undefined;
    const done = isTerminalRunStatus(run.status);
    const isError = run.status !== "completed" && done;
    return {
      toolUseId: `subagent-run:${run.runId}`,
      parentToolUseId: run.parentRunId ? `subagent-run:${run.parentRunId}` : undefined,
      toolName: "Agent",
      input: {
        name: run.label || `Subagent ${index + 1}`,
        description: run.task,
        subagent_type: "runtime_subagent",
        run_id: run.runId,
        child_session_key: run.childSessionId,
        announce_status: run.announceStatus,
        usage_events: run.outcome?.usageEvents,
        error_code: run.outcome?.errorCode
      },
      intent: run.task,
      displayName: run.label,
      elapsedSeconds,
      result: run.outcome?.output ?? run.outcome?.error,
      isError,
      done
    };
  });
}

export function selectTeamActivities(activities: ToolActivity[]): ToolActivity[] {
  const includedIds = new Set<string>();

  for (const activity of activities) {
    if (TEAM_CONTEXT_TOOL_NAMES.has(activity.toolName)) {
      includedIds.add(activity.toolUseId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const activity of activities) {
      if (includedIds.has(activity.toolUseId)) continue;
      if (!activity.parentToolUseId) continue;
      if (includedIds.has(activity.parentToolUseId)) {
        includedIds.add(activity.toolUseId);
        changed = true;
      }
    }
  }

  return activities.filter((item) => includedIds.has(item.toolUseId));
}
