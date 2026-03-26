import type { AgentMessage } from "@lume/shared";

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

export function extractTimelineEvents(message: AgentMessage): TimelineEvent[] {
  if (!message.events || message.events.length === 0) {
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

  let textBuffer = "";
  let textEventIds: string[] = [];

  for (const event of events) {
    switch (event.type) {
      case "text_delta":
        textBuffer += event.text;
        textEventIds.push(event.turnId || `${message.id}-delta-${timelineEvents.length}`);
        break;
      case "text_complete":
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
      case "tool_start": {
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
              parentToolUseId: event.parentToolUseId ?? existing.parentToolUseId
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
      }
      case "tool_result": {
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
      }
      case "task_backgrounded":
      case "task_progress":
      case "task_started":
      case "task_notification":
      case "shell_backgrounded":
      case "usage_update":
      case "compacting":
      case "compact_complete":
        break;
      case "complete":
      case "error":
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

  if (textBuffer) {
    appendOrMergeTextEvent({
      content: textBuffer,
      eventId: textEventIds[0] || `${message.id}-text-remaining`,
      turnId: undefined,
      parentToolUseId: undefined
    });
  }

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
