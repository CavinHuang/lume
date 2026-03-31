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

export interface AgentStreamState {
  running: boolean;
  content: string;
  reasoning?: string;
  toolActivities: ToolActivity[];
  events?: AgentEvent[];
  model?: string;
  inputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  isCompacting?: boolean;
  streamStartedAt?: number;
  firstOutputAt?: number;
  /** 当前活跃的 turnId */
  currentTurnId?: string;
  /** 已完成的 turn 数量 */
  turnCount?: number;
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
    case "task_progress":
      return {
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
    case "task_started":
      return { ...base, events: nextEvents };
    case "task_notification":
      return { ...base, events: nextEvents };
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
    case "turn_start":
      return {
        ...base,
        events: nextEvents,
        currentTurnId: event.turnId
      };
    case "turn_end":
      return {
        ...base,
        events: nextEvents,
        currentTurnId: undefined,
        turnCount: (base.turnCount ?? 0) + 1
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
