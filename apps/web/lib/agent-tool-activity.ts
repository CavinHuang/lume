import type { SDKMessage, AgentMessage, SubagentRunRecord } from "@lume/shared";
import type { ToolActivity } from "./agent-streaming";
import { resolveTaskTerminalVisualState } from "./subagent-rendering";

export type ToolActivityStatus = "running" | "completed" | "error" | "backgrounded";

const TEAM_CONTEXT_TOOL_NAMES = new Set(["TeamCreate", "TaskCreate", "TaskUpdate", "Task", "Agent"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item): item is { type: string; text?: string } => !!item && typeof item === "object")
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function hasSubagentRunId(message: SDKMessage): boolean {
  return typeof (message as SDKMessage & { subagent_run_id?: unknown }).subagent_run_id === "string"
    && (((message as SDKMessage & { subagent_run_id?: string }).subagent_run_id?.trim().length) ?? 0) > 0;
}

export function getToolActivityStatus(activity: ToolActivity): ToolActivityStatus {
  if (activity.isBackground) return "backgrounded";
  if (!activity.done) return "running";
  if (activity.isError) return "error";
  return "completed";
}

function collectActivitiesFromSdkMessages(messages: SDKMessage[]): ToolActivity[] {
  const order: string[] = [];
  const map = new Map<string, ToolActivity>();
  const taskActivityById = new Map<string, string>();

  const ensureActivity = (toolUseId: string, fallbackToolName = "Unknown"): ToolActivity => {
    const existing = map.get(toolUseId);
    if (existing) return existing;
    const created: ToolActivity = {
      toolUseId,
      toolName: fallbackToolName,
      input: {},
      done: false,
    };
    map.set(toolUseId, created);
    order.push(toolUseId);
    return created;
  };

  for (const message of messages) {
    if (message.type === "assistant") {
      if (hasSubagentRunId(message)) continue;
      for (const block of message.message?.content ?? []) {
        if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
        const toolBlock = block as {
          id: string;
          name: string;
          input?: Record<string, unknown>;
        };
        const current = ensureActivity(toolBlock.id, toolBlock.name);
        map.set(toolBlock.id, {
          ...current,
          toolName: toolBlock.name,
          input: asRecord(toolBlock.input),
          intent: typeof toolBlock.input?._intent === "string" ? toolBlock.input._intent : current.intent,
          displayName: typeof toolBlock.input?._displayName === "string" ? toolBlock.input._displayName : current.displayName,
          parentToolUseId: message.parent_tool_use_id ?? current.parentToolUseId,
          done: false,
        });
      }
      continue;
    }

    if (message.type === "user") {
      if (hasSubagentRunId(message)) continue;
      for (const block of message.message?.content ?? []) {
        if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
        const resultBlock = block as {
          tool_use_id: string;
          content?: unknown;
          is_error?: boolean;
        };
        const current = ensureActivity(resultBlock.tool_use_id);
        map.set(resultBlock.tool_use_id, {
          ...current,
          result: stringifyToolResultContent(resultBlock.content),
          isError: resultBlock.is_error === true,
          done: true,
        });
      }
      continue;
    }

    if (message.type === "tool_result") {
      if (hasSubagentRunId(message)) continue;
      const current = ensureActivity(message.result.tool_use_id, message.result.tool_name || "Unknown");
      map.set(message.result.tool_use_id, {
        ...current,
        toolName: message.result.tool_name || current.toolName,
        result: stringifyToolResultContent(message.result.output),
        isError: false,
        done: true,
      });
      continue;
    }

    if (message.type !== "system") {
      continue;
    }

    if (message.subtype === "task_started") {
      const toolUseId = (message as SDKMessage & { subagent_run_id?: string }).subagent_run_id ?? message.tool_use_id ?? message.task_id;
      taskActivityById.set(message.task_id, toolUseId);
      const current = ensureActivity(toolUseId, "Task");
      map.set(toolUseId, {
        ...current,
        toolName: (message as SDKMessage & { subagent_run_id?: string }).subagent_run_id ? "Agent" : (current.toolName === "Unknown" ? "Task" : current.toolName),
        taskId: message.task_id,
        intent: message.description ?? current.intent,
        displayName: message.workflow_name ?? current.displayName,
        startedAt: current.startedAt ?? Date.now(),
        done: false,
      });
      continue;
    }

    if (message.subtype === "task_progress") {
      const toolUseId = taskActivityById.get(message.task_id)
        ?? (message as SDKMessage & { subagent_run_id?: string }).subagent_run_id
        ?? message.tool_use_id
        ?? message.task_id;
      const current = ensureActivity(toolUseId, "Task");
      map.set(toolUseId, {
        ...current,
        taskId: message.task_id,
        elapsedMs: message.usage?.duration_ms ?? current.elapsedMs,
        elapsedSeconds: message.usage?.duration_ms ? Math.floor(message.usage.duration_ms / 1000) : current.elapsedSeconds,
        progressDescription: message.description ?? current.progressDescription,
        done: false,
      });
      continue;
    }

    if (message.subtype === "task_notification") {
      const toolUseId = taskActivityById.get(message.task_id)
        ?? (message as SDKMessage & { subagent_run_id?: string }).subagent_run_id
        ?? message.tool_use_id
        ?? message.task_id;
      const current = ensureActivity(toolUseId, "Task");
      const terminalState = resolveTaskTerminalVisualState(message.status);
      map.set(toolUseId, {
        ...current,
        taskId: message.task_id,
        result: message.summary ?? message.message ?? current.result,
        isError: terminalState.isError,
        elapsedMs: message.usage?.duration_ms ?? current.elapsedMs,
        done: terminalState.done,
      });
    }
  }

  return order.map((id) => map.get(id)).filter((item): item is ToolActivity => !!item);
}

export function extractToolActivitiesFromMessages(messages: AgentMessage[]): ToolActivity[] {
  const collected: ToolActivity[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.sdkMessages) || message.sdkMessages.length === 0) continue;
    collected.push(...collectActivitiesFromSdkMessages(message.sdkMessages));
  }
  return collected;
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
    startedAt: activity.startedAt ?? current.startedAt,
    elapsedSeconds: activity.elapsedSeconds ?? current.elapsedSeconds,
    elapsedMs: activity.elapsedMs ?? current.elapsedMs,
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
    const elapsedMs = run.startedAt ? Math.max(0, endedAt - run.startedAt) : undefined;
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
        child_session_key: run.childThreadId,
        announce_status: run.announceStatus,
        usage_events: run.outcome?.usageEvents,
        error_code: run.outcome?.errorCode
      },
      intent: run.task,
      displayName: run.label,
      startedAt: run.startedAt,
      elapsedSeconds,
      elapsedMs,
      result: run.outcome?.output ?? run.outcome?.error,
      isError,
      done
    };
  });
}

export const AGENT_TASK_TOOL_NAMES = new Set([
  "task", "agent", "threads_spawn", "subagents_send", "subagents_steer", "subagents_kill"
]);

export interface TaskGroup {
  parent: ToolActivity;
  children: ToolActivity[];
}

export interface SeparatedActivities {
  mainActivities: ToolActivity[];
  taskGroups: TaskGroup[];
}

export function separateActivities(activities: ToolActivity[]): SeparatedActivities {
  const containerIds = new Set<string>();
  const groupMap = new Map<string, TaskGroup>();

  for (const a of activities) {
    if (AGENT_TASK_TOOL_NAMES.has(a.toolName.toLowerCase())) {
      containerIds.add(a.toolUseId);
      groupMap.set(a.toolUseId, { parent: a, children: [] });
    }
  }

  const childIds = new Set<string>();
  for (const a of activities) {
    if (containerIds.has(a.toolUseId)) continue;
    if (a.parentToolUseId && containerIds.has(a.parentToolUseId)) {
      groupMap.get(a.parentToolUseId)!.children.push(a);
      childIds.add(a.toolUseId);
    }
  }

  const mainActivities = activities.filter(
    a => !containerIds.has(a.toolUseId) && !childIds.has(a.toolUseId)
  );

  return { mainActivities, taskGroups: [...groupMap.values()] };
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
