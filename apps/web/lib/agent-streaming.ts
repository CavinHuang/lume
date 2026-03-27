import type { AgentEvent } from "@lume/shared";

export interface ToolActivity {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  intent?: string;
  displayName?: string;
  parentToolUseId?: string;
  taskId?: string;
  shellId?: string;
  isBackground?: boolean;
  startedAt?: number;
  elapsedSeconds?: number;
  elapsedMs?: number;
  progressDescription?: string;
  result?: string;
  isError?: boolean;
  done: boolean;
}

export interface TeammateState {
  taskId: string;
  toolUseId?: string;
  description: string;
  agentName?: string;
  index: number;
  status: "running" | "completed" | "failed" | "stopped";
  progressDescription?: string;
  currentToolName?: string;
  currentToolElapsedSeconds?: number;
  toolHistory: string[];
  summary?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  startedAt: number;
  endedAt?: number;
}

export interface AgentStreamState {
  running: boolean;
  content: string;
  reasoning?: string;
  toolActivities: ToolActivity[];
  teammates: TeammateState[];
  events?: AgentEvent[];
  model?: string;
  inputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  isCompacting?: boolean;
  streamStartedAt?: number;
  firstOutputAt?: number;
}

export function mergeStreamingText(current: string, next: string): string {
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

export function applyAgentEvent(prev: AgentStreamState, event: AgentEvent): AgentStreamState {
  const nextEvents = [...(prev.events ?? []), event];
  const now = Date.now();
  const streamStartedAt = prev.streamStartedAt ?? now;
  const isOutputEvent = event.type === "text_delta"
    || event.type === "text_complete"
    || event.type === "reasoning_delta"
    || event.type === "reasoning_complete"
    || event.type === "tool_start";
  const firstOutputAt = prev.firstOutputAt ?? (isOutputEvent ? now : undefined);

  const base = { ...prev, streamStartedAt, firstOutputAt };
  switch (event.type) {
    case "text_delta":
      return { ...base, content: base.content + event.text, events: nextEvents };
    case "text_complete":
      return {
        ...base,
        content: mergeStreamingText(base.content, event.text),
        events: nextEvents
      };
    case "reasoning_delta":
      return {
        ...base,
        reasoning: (base.reasoning ?? "") + event.text,
        events: nextEvents
      };
    case "reasoning_complete":
      return {
        ...base,
        reasoning: mergeStreamingText(base.reasoning ?? "", event.text),
        events: nextEvents
      };
    case "tool_start": {
      const exists = base.toolActivities.find((item) => item.toolUseId === event.toolUseId);
      if (exists) {
        return {
          ...base,
          events: nextEvents,
          toolActivities: base.toolActivities.map((item) =>
            item.toolUseId === event.toolUseId
              ? {
                  ...item,
                  input: event.input,
                  intent: event.intent ?? item.intent,
                  displayName: event.displayName ?? item.displayName,
                  parentToolUseId: event.parentToolUseId ?? item.parentToolUseId
                }
              : item
          )
        };
      }
      return {
        ...base,
        events: nextEvents,
        toolActivities: [
          ...base.toolActivities,
          {
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            input: event.input,
            intent: event.intent,
            displayName: event.displayName,
            parentToolUseId: event.parentToolUseId,
            startedAt: now,
            done: false
          }
        ]
      };
    }
    case "tool_result":
      return {
        ...base,
        events: nextEvents,
        toolActivities: base.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? {
                ...item,
                done: true,
                isError: event.isError,
                result: event.result,
                elapsedMs: item.startedAt ? Math.max(0, now - item.startedAt) : item.elapsedMs
              }
            : item
        )
      };
    case "task_backgrounded":
      return {
        ...base,
        events: nextEvents,
        toolActivities: base.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, isBackground: true, taskId: event.taskId }
            : item
        )
      };
    case "task_progress": {
      let nextState = {
        ...base,
        events: nextEvents,
        toolActivities: base.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? {
                ...item,
                elapsedSeconds: event.elapsedSeconds || item.elapsedSeconds,
                elapsedMs: event.usage?.durationMs ?? item.elapsedMs,
                progressDescription: event.description ?? item.progressDescription
              }
            : item
        )
      };
      if (event.taskId) {
        nextState = {
          ...nextState,
          teammates: nextState.teammates.map((t) =>
            t.taskId === event.taskId
              ? {
                  ...t,
                  progressDescription: event.description ?? t.progressDescription,
                  currentToolName: event.lastToolName ?? t.currentToolName,
                  currentToolElapsedSeconds: event.elapsedSeconds ?? t.currentToolElapsedSeconds,
                  toolHistory: event.lastToolName && !t.toolHistory.includes(event.lastToolName)
                    ? [...t.toolHistory, event.lastToolName]
                    : t.toolHistory,
                  usage: event.usage ?? t.usage
                }
              : t
          )
        };
      }
      return nextState;
    }
    case "task_started": {
      const existing = base.teammates.find((t) => t.taskId === event.taskId);
      if (existing) return { ...base, events: nextEvents };
      const newTeammate: TeammateState = {
        taskId: event.taskId,
        toolUseId: event.toolUseId,
        description: event.description,
        agentName: event.agentName,
        index: base.teammates.length,
        status: "running",
        toolHistory: [],
        startedAt: Date.now()
      };
      return {
        ...base,
        events: nextEvents,
        teammates: [...base.teammates, newTeammate]
      };
    }
    case "task_notification":
      return {
        ...base,
        events: nextEvents,
        teammates: base.teammates.map((t) =>
          t.taskId === event.taskId
            ? {
                ...t,
                status: event.status === "completed" ? "completed" : event.status === "failed" ? "failed" : "stopped",
                summary: event.summary,
                usage: event.usage ?? t.usage,
                endedAt: Date.now()
              }
            : t
        )
      };
    case "usage_update":
      return {
        ...base,
        events: nextEvents,
        inputTokens: event.usage.inputTokens,
        totalTokens: event.usage.totalTokens ?? base.totalTokens ?? event.usage.inputTokens,
        contextWindow: event.usage.contextWindow ?? base.contextWindow
      };
    case "compacting":
      return {
        ...base,
        events: nextEvents,
        isCompacting: true
      };
    case "compact_complete":
      return {
        ...base,
        events: nextEvents,
        isCompacting: false
      };
    case "shell_backgrounded":
      return {
        ...base,
        events: nextEvents,
        toolActivities: base.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, isBackground: true, shellId: event.shellId }
            : item
        )
      };
    case "complete":
      return {
        ...base,
        running: false,
        isCompacting: false,
        events: nextEvents,
        inputTokens: event.usage?.inputTokens ?? base.inputTokens,
        totalTokens: event.usage?.totalTokens ?? base.totalTokens,
        contextWindow: event.usage?.contextWindow ?? base.contextWindow,
        toolActivities: base.toolActivities.map((item) =>
          item.done ? item : { ...item, done: true }
        ),
        teammates: base.teammates.map((t) =>
          t.status === "running" ? { ...t, status: "stopped" as const, endedAt: Date.now() } : t
        )
      };
    case "error":
      return {
        ...base,
        running: false,
        isCompacting: false,
        events: nextEvents,
        toolActivities: base.toolActivities.map((item) =>
          item.done ? item : { ...item, done: true, isError: true }
        )
      };
    default:
      return { ...base, events: nextEvents };
  }
}
