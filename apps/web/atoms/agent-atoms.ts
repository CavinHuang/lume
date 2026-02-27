import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import type {
  AgentEvent,
  AgentMessage,
  AgentPendingFile,
  AgentSessionMeta,
  AgentWorkspace,
  AgentSendInput
} from "@lume/shared";

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
  elapsedSeconds?: number;
  result?: string;
  isError?: boolean;
  done: boolean;
}

/**
 * 时序渲染事件类型 - 用于按顺序渲染 Agent 输出
 */
export interface TimelineTextEvent {
  type: "text";
  content: string;
  eventId: string;
  turnId?: string;
  parentToolUseId?: string;
}

export interface TimelineToolStartEvent {
  type: "tool_start";
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  intent?: string;
  displayName?: string;
  eventId: string;
  turnId?: string;
  parentToolUseId?: string;
}

export interface TimelineToolResultEvent {
  type: "tool_result";
  toolUseId: string;
  toolName?: string;
  result: string;
  isError: boolean;
  eventId: string;
  turnId?: string;
  parentToolUseId?: string;
}

export type TimelineEvent = TimelineTextEvent | TimelineToolStartEvent | TimelineToolResultEvent;

/**
 * 从 AgentMessage.events 中提取并合并为时序渲染事件
 * 保持文本和工具调用的原始顺序
 */
export function extractTimelineEvents(message: AgentMessage): TimelineEvent[] {
  if (!message.events || message.events.length === 0) {
    // 没有 events，使用 content 作为文本
    return message.content ? [{
      type: "text",
      content: message.content,
      eventId: message.id,
    }] : [];
  }

  const events = message.events;
  const timelineEvents: TimelineEvent[] = [];
  const toolStartIndexMap = new Map<string, number>();
  const toolResultIndexMap = new Map<string, number>();
  const textCompleteIndexByTurnId = new Map<string, number>();

  function appendOrMergeTextEvent(next: Omit<TimelineTextEvent, "type">): void {
    const last = timelineEvents[timelineEvents.length - 1];
    const canMergeByPrefix = (
      last?.type === "text"
      && last.parentToolUseId === next.parentToolUseId
      && (
        next.content.startsWith(last.content)
        || last.content.startsWith(next.content)
      )
    );
    if (canMergeByPrefix) {
      timelineEvents[timelineEvents.length - 1] = {
        ...last,
        content: next.content.length >= last.content.length ? next.content : last.content,
        eventId: next.eventId,
        turnId: next.turnId ?? last.turnId
      };
      if (next.turnId) {
        textCompleteIndexByTurnId.set(next.turnId, timelineEvents.length - 1);
      }
      return;
    }
    if (
      last?.type === "text"
      && last.content === next.content
      && last.parentToolUseId === next.parentToolUseId
    ) {
      timelineEvents[timelineEvents.length - 1] = {
        ...last,
        eventId: next.eventId,
        turnId: next.turnId ?? last.turnId
      };
      if (next.turnId) {
        textCompleteIndexByTurnId.set(next.turnId, timelineEvents.length - 1);
      }
      return;
    }

    timelineEvents.push({
      type: "text",
      ...next
    });
    if (next.turnId) {
      textCompleteIndexByTurnId.set(next.turnId, timelineEvents.length - 1);
    }
  }

  // 用于累积连续的文本片段
  let textBuffer = "";
  let textEventIds: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        // 累积文本片段
        textBuffer += event.text;
        // 使用 eventId（如果有）或生成一个
        textEventIds.push(event.turnId || `${message.id}-delta-${timelineEvents.length}`);
        break;

      case "text_complete":
        // 完成一个文本块：只使用单一来源，避免 delta + complete 重复拼接。
        // 规则：优先使用 complete 文本；若为空再回退到累积 delta。
        if (textBuffer || event.text) {
          const content = event.text || textBuffer;
          if (event.turnId && textCompleteIndexByTurnId.has(event.turnId)) {
            const index = textCompleteIndexByTurnId.get(event.turnId)!;
            const existing = timelineEvents[index];
            if (existing?.type === "text") {
              timelineEvents[index] = {
                ...existing,
                content,
                eventId: event.turnId || `${message.id}-complete-${index}`,
                turnId: event.turnId,
                parentToolUseId: event.parentToolUseId ?? existing.parentToolUseId
              };
            }
          } else if (!(event.isIntermediate && !event.turnId)) {
            appendOrMergeTextEvent({
              content,
              eventId: event.turnId || `${message.id}-complete-${timelineEvents.length}`,
              turnId: event.turnId,
              parentToolUseId: event.parentToolUseId
            });
          }
        }
        textBuffer = "";
        textEventIds = [];
        break;

      case "tool_start":
        // 先输出已累积的文本（如果有）
        if (textBuffer) {
          appendOrMergeTextEvent({
            content: textBuffer,
            eventId: textEventIds[0] || `${message.id}-text-before-tool-${event.toolUseId}`,
            turnId: event.turnId,
            parentToolUseId: event.parentToolUseId
          });
          textBuffer = "";
          textEventIds = [];
        }

        // 同一 toolUseId 的重复 tool_start 视为更新，不重复渲染为新调用。
        const existingStartIndex = toolStartIndexMap.get(event.toolUseId);
        if (existingStartIndex !== undefined) {
          const existing = timelineEvents[existingStartIndex];
          if (existing?.type === "tool_start") {
            timelineEvents[existingStartIndex] = {
              ...existing,
              toolName: event.toolName || existing.toolName,
              input: Object.keys(event.input).length > 0 ? event.input : existing.input,
              intent: event.intent ?? existing.intent,
              displayName: event.displayName ?? existing.displayName,
              turnId: event.turnId ?? existing.turnId,
              parentToolUseId: event.parentToolUseId ?? existing.parentToolUseId,
            };
          }
          break;
        }

        timelineEvents.push({
          type: "tool_start",
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          intent: event.intent,
          displayName: event.displayName,
          eventId: `${event.toolUseId}-start`,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        });
        toolStartIndexMap.set(event.toolUseId, timelineEvents.length - 1);
        break;

      case "tool_result":
        // 同一 toolUseId 的重复 result 视为状态更新，保留最后一次结果。
        const existingResultIndex = toolResultIndexMap.get(event.toolUseId);
        if (existingResultIndex !== undefined) {
          const existing = timelineEvents[existingResultIndex];
          if (existing?.type === "tool_result") {
            timelineEvents[existingResultIndex] = {
              ...existing,
              toolName: event.toolName ?? existing.toolName,
              result: event.result || "",
              isError: !!event.isError,
              turnId: event.turnId ?? existing.turnId,
              parentToolUseId: event.parentToolUseId ?? existing.parentToolUseId,
            };
          }
          break;
        }

        timelineEvents.push({
          type: "tool_result",
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          result: event.result || "",
          isError: !!event.isError,
          eventId: `${event.toolUseId}-result`,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        });
        toolResultIndexMap.set(event.toolUseId, timelineEvents.length - 1);
        break;

      case "task_backgrounded":
      case "task_progress":
      case "shell_backgrounded":
      case "usage_update":
      case "compacting":
      case "compact_complete":
        // 这些事件不直接影响渲染时序，跳过
        break;

      case "complete":
      case "error":
        // 流结束，输出剩余的文本缓冲
        if (textBuffer) {
          appendOrMergeTextEvent({
            content: textBuffer,
            eventId: textEventIds[0] || `${message.id}-text-final`,
            turnId: undefined,
            parentToolUseId: undefined
          });
          textBuffer = "";
          textEventIds = [];
        }
        break;
    }
  }

  // 处理最后剩余的文本缓冲
  if (textBuffer) {
    appendOrMergeTextEvent({
      content: textBuffer,
      eventId: textEventIds[0] || `${message.id}-text-remaining`,
      turnId: undefined,
      parentToolUseId: undefined
    });
  }

  // Pi Agent 对齐兜底：某些路径可能只产生工具事件，但 message.content 已有最终文本。
  // 此时补一个文本事件，避免 UI 因 timeline 存在而隐藏正文。
  const hasTextEvent = timelineEvents.some((event) => event.type === "text" && event.content.trim().length > 0);
  if (!hasTextEvent && message.content.trim().length > 0) {
    timelineEvents.push({
      type: "text",
      content: message.content,
      eventId: `${message.id}-content-fallback`
    });
  }

  return timelineEvents;
}

export interface AgentStreamState {
  running: boolean;
  content: string;
  toolActivities: ToolActivity[];
  events?: AgentEvent[];
  model?: string;
  inputTokens?: number;
  contextWindow?: number;
  isCompacting?: boolean;
}

export const agentSessionsAtom = atom<AgentSessionMeta[]>([]);
export const agentWorkspacesAtom = atom<AgentWorkspace[]>([]);
export const agentChannelIdAtom = atomWithStorage<string | null>("lume-agent-channel-id", null);
export const agentModelIdAtom = atomWithStorage<string | null>("lume-agent-model-id", null);
export const agentPermissionModeAtom = atomWithStorage<NonNullable<AgentSendInput["permissionMode"]>>(
  "lume-agent-permission-mode",
  "bypassPermissions"
);
export const agentPendingPromptAtom = atom<{ sessionId: string; message: string } | null>(null);
export const agentPendingFilesAtom = atom<AgentPendingFile[]>([]);
export const workspaceCapabilitiesVersionAtom = atom<number>(0);
export const workspaceFilesVersionAtom = atom<number>(0);
export const currentAgentWorkspaceIdAtom = atom<string | null>(null);
export const currentAgentSessionIdAtom = atom<string | null>(null);
export const currentAgentMessagesAtom = atom<AgentMessage[]>([]);
export const agentStreamingStatesAtom = atom<Map<string, AgentStreamState>>(new Map());
export const agentStreamErrorsAtom = atom<Map<string, string>>(new Map());

export const currentAgentStreamStateAtom = atom<AgentStreamState | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return get(agentStreamingStatesAtom).get(currentId) ?? null;
});

export const agentStreamingAtom = atom<boolean>((get) => !!get(currentAgentStreamStateAtom)?.running);

export const agentStreamingContentAtom = atom<string>((get) => get(currentAgentStreamStateAtom)?.content ?? "");

export const agentToolActivitiesAtom = atom<ToolActivity[]>((get) => get(currentAgentStreamStateAtom)?.toolActivities ?? []);

export const agentStreamingTimelineEventsAtom = atom<TimelineEvent[]>((get) => {
  const streamState = get(currentAgentStreamStateAtom);
  if (!streamState) return [];
  const events = streamState.events ?? [];
  if (events.length === 0) return [];
  const syntheticMessage: AgentMessage = {
    id: "streaming",
    role: "assistant",
    content: streamState.content,
    createdAt: Date.now(),
    events
  };
  return extractTimelineEvents(syntheticMessage);
});

export const agentContextStatusAtom = atom<{
  inputTokens?: number;
  contextWindow?: number;
  isCompacting: boolean;
}>((get) => {
  const state = get(currentAgentStreamStateAtom);
  return {
    inputTokens: state?.inputTokens,
    contextWindow: state?.contextWindow,
    isCompacting: !!state?.isCompacting
  };
});

export const currentAgentSessionAtom = atom<AgentSessionMeta | null>((get) => {
  const sessions = get(agentSessionsAtom);
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return sessions.find((item) => item.id === currentId) ?? null;
});

export const agentRunningSessionIdsAtom = atom<Set<string>>((get) => {
  const states = get(agentStreamingStatesAtom);
  const ids = new Set<string>();
  for (const [id, state] of states) {
    if (state.running) ids.add(id);
  }
  return ids;
});

export const currentAgentErrorAtom = atom<string | null>((get) => {
  const currentId = get(currentAgentSessionIdAtom);
  if (!currentId) return null;
  return get(agentStreamErrorsAtom).get(currentId) ?? null;
});

export function applyAgentEvent(prev: AgentStreamState, event: AgentEvent): AgentStreamState {
  const nextEvents = [...(prev.events ?? []), event];
  switch (event.type) {
    case "text_delta":
      return { ...prev, content: prev.content + event.text, events: nextEvents };
    case "text_complete":
      return {
        ...prev,
        content: mergeStreamingText(prev.content, event.text),
        events: nextEvents
      };
    case "tool_start":
      {
        const exists = prev.toolActivities.find((item) => item.toolUseId === event.toolUseId);
        if (exists) {
          return {
            ...prev,
            events: nextEvents,
            toolActivities: prev.toolActivities.map((item) =>
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
      }
      return {
        ...prev,
        events: nextEvents,
        toolActivities: [
          ...prev.toolActivities,
          {
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            input: event.input,
            intent: event.intent,
            displayName: event.displayName,
            parentToolUseId: event.parentToolUseId,
            done: false
          }
        ]
      };
    case "tool_result":
      return {
        ...prev,
        events: nextEvents,
        toolActivities: prev.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, done: true, isError: event.isError, result: event.result }
            : item
        )
      };
    case "task_backgrounded":
      return {
        ...prev,
        events: nextEvents,
        toolActivities: prev.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, isBackground: true, taskId: event.taskId }
            : item
        )
      };
    case "task_progress":
      return {
        ...prev,
        events: nextEvents,
        toolActivities: prev.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, elapsedSeconds: event.elapsedSeconds }
            : item
        )
      };
    case "usage_update":
      return {
        ...prev,
        events: nextEvents,
        inputTokens: event.usage.inputTokens,
        contextWindow: event.usage.contextWindow ?? prev.contextWindow
      };
    case "compacting":
      return {
        ...prev,
        events: nextEvents,
        isCompacting: true
      };
    case "compact_complete":
      return {
        ...prev,
        events: nextEvents,
        isCompacting: false
      };
    case "shell_backgrounded":
      return {
        ...prev,
        events: nextEvents,
        toolActivities: prev.toolActivities.map((item) =>
          item.toolUseId === event.toolUseId
            ? { ...item, isBackground: true, shellId: event.shellId }
            : item
        )
      };
    case "complete":
      return {
        ...prev,
        running: false,
        isCompacting: false,
        events: nextEvents,
        toolActivities: prev.toolActivities.map((item) =>
          item.done ? item : { ...item, done: true }
        )
      };
    case "error":
      return {
        ...prev,
        running: false,
        isCompacting: false,
        events: nextEvents,
        toolActivities: prev.toolActivities.map((item) =>
          item.done ? item : { ...item, done: true, isError: true }
        )
      };
    default:
      return { ...prev, events: nextEvents };
  }
}

function mergeStreamingText(current: string, next: string): string {
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
