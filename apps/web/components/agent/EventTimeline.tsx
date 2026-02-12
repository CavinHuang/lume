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

function TimelineTextEvent({ event, isLast }: TimelineTextEventProps): React.ReactElement {
  return (
    <div className={cn("text-foreground/90 py-1", !isLast && "border-b border-border/40")}>
      <MessageResponse>{event.content}</MessageResponse>
    </div>
  );
}

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

export function EventTimeline({ events, isStreaming = false }: EventTimelineProps): React.ReactElement | null {
  if (events.length === 0) return null;

  type TimelineText = Extract<TimelineEvent, { type: "text" }>;
  type TimelineToolStart = Extract<TimelineEvent, { type: "tool_start" }>;
  type TimelineToolResult = Extract<TimelineEvent, { type: "tool_result" }>;

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

  type RenderSegment =
    | { type: "text"; data: TimelineText }
    | { type: "tools"; data: ToolActivity[] };

  const segments: RenderSegment[] = [];
  let pendingTools: ToolActivity[] = [];

  const flushPendingTools = (): void => {
    if (pendingTools.length === 0) return;
    segments.push({ type: "tools", data: pendingTools });
    pendingTools = [];
  };

  for (const event of events) {
    if (event.type === "text") {
      // 忽略仅空白文本，避免打断连续工具段并产生“多个工具块”。
      if (!event.content.trim()) {
        continue;
      }
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
}
