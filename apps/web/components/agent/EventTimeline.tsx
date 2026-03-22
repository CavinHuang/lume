"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { TimelineEvent, ToolActivity } from "@/atoms/agent-atoms";
import { MessageResponse } from "@/components/ai-elements";
import { ToolActivityList } from "./ToolActivityItem";

interface TimelineTextEventProps {
  event: TimelineEvent & { type: "text" };
  isLast?: boolean;
}

const TimelineTextEvent = React.memo(function TimelineTextEvent({ event, isLast }: TimelineTextEventProps): React.ReactElement {
  return (
    <div className={cn("text-foreground/90 py-1", !isLast && "border-b border-border/40")}>
      <MessageResponse>{event.content}</MessageResponse>
    </div>
  );
}, (prev, next) => prev.event === next.event && prev.isLast === next.isLast);

function toToolActivity(
  startEvent: Extract<TimelineEvent, { type: "tool_start" }>,
  resultEvent?: Extract<TimelineEvent, { type: "tool_result" }>
): ToolActivity {
  return {
    toolUseId: startEvent.toolUseId,
    toolName: startEvent.toolName,
    input: startEvent.input,
    intent: startEvent.intent,
    displayName: startEvent.displayName,
    parentToolUseId: startEvent.parentToolUseId,
    done: !!resultEvent,
    result: resultEvent?.result,
    isError: resultEvent?.isError
  };
}

interface EventTimelineProps {
  events: TimelineEvent[];
  isStreaming?: boolean;
}

type TimelineText = Extract<TimelineEvent, { type: "text" }>;
type TimelineToolStart = Extract<TimelineEvent, { type: "tool_start" }>;
type TimelineToolResult = Extract<TimelineEvent, { type: "tool_result" }>;

type RenderSegment =
  | { type: "text"; data: TimelineText }
  | { type: "tools"; data: ToolActivity[] };

function buildSegments(events: TimelineEvent[]): RenderSegment[] {
  const toolResultMap = new Map<string, TimelineToolResult[]>();
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    const queue = toolResultMap.get(event.toolUseId);
    if (queue) {
      queue.push(event);
    } else {
      toolResultMap.set(event.toolUseId, [event]);
    }
  }

  const segments: RenderSegment[] = [];
  let pendingTools: ToolActivity[] = [];

  const flushPendingTools = (): void => {
    if (pendingTools.length === 0) return;
    segments.push({ type: "tools", data: pendingTools });
    pendingTools = [];
  };

  for (const event of events) {
    if (event.type === "text") {
      if (!event.content.trim()) continue;
      flushPendingTools();
      segments.push({ type: "text", data: event });
      continue;
    }

    if (event.type === "tool_start") {
      const resultQueue = toolResultMap.get(event.toolUseId);
      const resultEvent = resultQueue?.shift();
      pendingTools.push(toToolActivity(event as TimelineToolStart, resultEvent));
    }
  }

  flushPendingTools();
  return segments;
}

export const EventTimeline = React.memo(function EventTimeline({ events, isStreaming = false }: EventTimelineProps): React.ReactElement | null {
  const segments = React.useMemo(() => buildSegments(events), [events]);

  if (segments.length === 0) return null;

  return (
    <div className="space-y-0">
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          const isLast = index === segments.length - 1;
          return (
            <TimelineTextEvent
              key={`${segment.data.eventId}-${index}`}
              event={segment.data}
              isLast={isLast}
            />
          );
        }

        const firstTool = segment.data[0];
        const key = firstTool ? `${firstTool.toolUseId}-${index}` : `tools-${index}`;
        return (
          <div key={key} className="my-2">
            <ToolActivityList activities={segment.data} animate={isStreaming} />
          </div>
        );
      })}
    </div>
  );
})
