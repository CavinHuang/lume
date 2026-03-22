/**
 * Migrated from:
 * /Users/cavinhuang/workspace/projects/ai-projects/Proma/apps/electron/src/renderer/atoms/agent-atoms.ts
 * Adaptation:
 * - 保持 Lume Web 侧轻量提取层，支持消息事件与 run registry 轮询数据合并。
 */

import type { AgentMessage } from "@lume/shared";
import type { SubagentRunRecord } from "@lume/shared";
import type { ToolActivity } from "@/atoms/agent-atoms";

export type TeamActivityStatus = "running" | "completed" | "error" | "backgrounded";

export interface TeamTaskItem {
  toolUseId: string;
  subject: string;
  description?: string;
  activeForm?: string;
  blockedBy: string[];
  status?: string;
  taskNumber?: string;
}

export interface TeamAgentInfo {
  toolUseId: string;
  name: string;
  description: string;
  subagentType?: string;
  teamName?: string;
  status: TeamActivityStatus;
  elapsedSeconds?: number;
  runId?: string;
  childSessionKey?: string;
  announceStatus?: string;
  errorCode?: string;
  usageEvents?: number;
  childActivities: ToolActivity[];
  currentToolName?: string;
  progressDescription?: string;
  toolHistory?: string[];
  durationMs?: number;
  tokenUsage?: number;
  toolCallCount?: number;
}

export interface TeamOverview {
  teamName?: string;
  teamDescription?: string;
  tasks: TeamTaskItem[];
  agents: TeamAgentInfo[];
}

export interface TeamInboxItem {
  messageId: string;
  createdAt: number;
  runId?: string;
  childSessionKey?: string;
  status?: string;
  summary: string;
  isError: boolean;
}

const TEAM_ROOT_TOOL_NAMES = new Set(["Task", "Agent"]);
const TEAM_CONTEXT_TOOL_NAMES = new Set(["TeamCreate", "TaskCreate", "TaskUpdate", "Task", "Agent"]);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function truncateSummary(value: string, maxChars = 120): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}

function extractAnnounceSummary(content: string): string {
  const normalized = content.trim();
  if (!normalized) return "子任务状态更新";
  const lines = normalized
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (lines.length === 0) return "子任务状态更新";
  return truncateSummary(lines[0] as string);
}

export function getActivityStatus(activity: ToolActivity): TeamActivityStatus {
  if (activity.isBackground) return "backgrounded";
  if (!activity.done) return "running";
  if (activity.isError) return "error";
  return "completed";
}

/**
 * 从持久化消息中重建工具活动，保证流式状态清理后仍可展示 Team 历史。
 */
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

/**
 * 仅保留 Team 相关活动：TeamCreate/TaskCreate/TaskUpdate/Task/Agent 及其后代工具调用。
 */
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

export function extractTeamOverview(activities: ToolActivity[], teammates?: import("@/atoms/agent-atoms").TeammateState[]): TeamOverview | null {
  let teamName: string | undefined;
  let teamDescription: string | undefined;
  const tasks: TeamTaskItem[] = [];
  const tasksByNumber = new Map<string, TeamTaskItem>();

  const rootActivities = activities.filter((item) => TEAM_ROOT_TOOL_NAMES.has(item.toolName));
  const rootIds = new Set(rootActivities.map((item) => item.toolUseId));
  const childMap = new Map<string, ToolActivity[]>();

  for (const activity of activities) {
    if (!activity.parentToolUseId || !rootIds.has(activity.parentToolUseId)) continue;
    const current = childMap.get(activity.parentToolUseId) ?? [];
    current.push(activity);
    childMap.set(activity.parentToolUseId, current);
  }

  for (const activity of activities) {
    if (activity.toolName === "TeamCreate") {
      teamName = asNonEmptyString(activity.input.team_name) ?? teamName;
      teamDescription = asNonEmptyString(activity.input.description) ?? teamDescription;
      continue;
    }

    if (activity.toolName === "TaskCreate") {
      const subject = asNonEmptyString(activity.input.subject);
      if (!subject) continue;
      const taskNumberMatch = activity.result?.match(/(?:Task\s+)?#(\d+)/i);
      const taskNumber = taskNumberMatch?.[1];
      const task: TeamTaskItem = {
        toolUseId: activity.toolUseId,
        subject,
        description: asNonEmptyString(activity.input.description),
        activeForm: asNonEmptyString(activity.input.activeForm),
        blockedBy: [],
        status: asNonEmptyString(activity.input.status),
        taskNumber
      };
      tasks.push(task);
      if (taskNumber) tasksByNumber.set(taskNumber, task);
      continue;
    }

    if (activity.toolName === "TaskUpdate") {
      const taskId = asNonEmptyString(activity.input.taskId);
      if (!taskId) continue;
      const task = tasksByNumber.get(taskId);
      if (!task) continue;

      if (Array.isArray(activity.input.addBlockedBy)) {
        for (const dependency of activity.input.addBlockedBy) {
          const dep = asNonEmptyString(dependency);
          if (!dep || task.blockedBy.includes(dep)) continue;
          task.blockedBy.push(dep);
        }
      }

      const status = asNonEmptyString(activity.input.status);
      if (status) task.status = status;
    }
  }

  const agents: TeamAgentInfo[] = rootActivities.map((activity, index) => {
    const name = activity.toolName === "Agent"
      ? asNonEmptyString(activity.input.name) ?? `Agent ${index + 1}`
      : `Task Agent ${index + 1}`;

    const description =
      asNonEmptyString(activity.input.description)
      ?? asNonEmptyString(activity.input.prompt)
      ?? activity.intent
      ?? activity.displayName
      ?? "子任务";

    const runId = asNonEmptyString(activity.input.run_id);
    const teammate = teammates?.find(t => t.taskId === runId || t.toolUseId === activity.toolUseId);

    return {
      toolUseId: activity.toolUseId,
      name,
      description,
      subagentType: asNonEmptyString(activity.input.subagent_type),
      teamName: asNonEmptyString(activity.input.team_name) ?? teamName,
      status: teammate
        ? (teammate.status === 'running' ? 'running' : teammate.status === 'completed' ? 'completed' : 'error')
        : getActivityStatus(activity),
      elapsedSeconds: activity.elapsedSeconds,
      runId,
      childSessionKey: asNonEmptyString(activity.input.child_session_key),
      announceStatus: asNonEmptyString(activity.input.announce_status),
      errorCode: asNonEmptyString(activity.input.error_code),
      usageEvents: asFiniteNumber(activity.input.usage_events),
      childActivities: childMap.get(activity.toolUseId) ?? [],
      currentToolName: teammate?.currentToolName,
      progressDescription: teammate?.progressDescription,
      toolHistory: teammate?.toolHistory,
      durationMs: teammate?.usage?.durationMs,
      tokenUsage: teammate?.usage?.totalTokens,
      toolCallCount: teammate?.usage?.toolUses
    };
  });

  if (!teamName && !teamDescription && tasks.length === 0 && agents.length === 0) {
    return null;
  }

  return {
    teamName,
    teamDescription,
    tasks,
    agents
  };
}

export function buildTeamActivitiesFromSession(
  messages: AgentMessage[],
  streamingActivities: ToolActivity[]
): ToolActivity[] {
  const history = extractToolActivitiesFromMessages(messages);
  const merged = mergeToolActivities(history, streamingActivities);
  return selectTeamActivities(merged);
}

export function extractTeamInboxFromMessages(messages: AgentMessage[]): TeamInboxItem[] {
  const items: TeamInboxItem[] = [];
  for (const message of messages) {
    if (!message || message.role !== "assistant") continue;
    const metadata = asRecord(message.metadata);
    if (metadata.subagentAnnounce !== true) continue;
    const status = asNonEmptyString(metadata.status);
    items.push({
      messageId: message.id,
      createdAt: message.createdAt,
      runId: asNonEmptyString(metadata.runId),
      childSessionKey: asNonEmptyString(metadata.childSessionId),
      status,
      summary: extractAnnounceSummary(message.content),
      isError: status !== "completed"
    });
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}
