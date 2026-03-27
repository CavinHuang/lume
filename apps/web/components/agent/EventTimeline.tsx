"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { TimelineEvent, ToolActivity } from "@/atoms/agent-atoms";
import { MessageResponse } from "@/components/ai-elements";
import { ToolActivityList } from "./ToolActivityItem";

interface TimelineTextEventProps {
  event: TimelineEvent & { type: "text" };
  isLast?: boolean;
  /** 最后一段文字且前面紧跟着工具组时，视为"结论段"，加分割线强调 */
  isConclusion?: boolean;
}

const TimelineTextEvent = React.memo(function TimelineTextEvent({
  event,
  isLast,
  isConclusion,
}: TimelineTextEventProps): React.ReactElement {
  return (
    <div
      className={cn(
        "py-1 text-foreground/90",
        !isLast && "border-b border-border/40",
        isConclusion && "mt-2 border-t border-border/30 pt-3",
      )}
    >
      <MessageResponse>{event.content}</MessageResponse>
    </div>
  );
}, (prev, next) =>
  prev.event === next.event &&
  prev.isLast === next.isLast &&
  prev.isConclusion === next.isConclusion
);

function toToolActivity(
  startEvent: Extract<TimelineEvent, { type: "tool_start" }>,
  resultEvent?: Extract<TimelineEvent, { type: "tool_result" }>,
  activityMeta?: ToolActivity
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
    isError: resultEvent?.isError,
    elapsedSeconds: activityMeta?.elapsedSeconds,
    elapsedMs: activityMeta?.elapsedMs,
    isBackground: activityMeta?.isBackground,
    progressDescription: activityMeta?.progressDescription,
  };
}

interface EventTimelineProps {
  events: TimelineEvent[];
  activities?: ToolActivity[];
  isStreaming?: boolean;
}

type TimelineText = Extract<TimelineEvent, { type: "text" }>;
type TimelineToolStart = Extract<TimelineEvent, { type: "tool_start" }>;
type TimelineToolResult = Extract<TimelineEvent, { type: "tool_result" }>;

type RenderSegment =
  | { type: "text"; data: TimelineText }
  | { type: "tools"; data: ToolActivity[] };

function buildSegments(events: TimelineEvent[], activities: ToolActivity[] = []): RenderSegment[] {
  const toolResultMap = new Map<string, TimelineToolResult[]>();
  const activityMetaMap = new Map<string, ToolActivity>();
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    const queue = toolResultMap.get(event.toolUseId);
    if (queue) {
      queue.push(event);
    } else {
      toolResultMap.set(event.toolUseId, [event]);
    }
  }
  for (const activity of activities) {
    activityMetaMap.set(activity.toolUseId, activity);
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
      pendingTools.push(toToolActivity(event as TimelineToolStart, resultEvent, activityMetaMap.get(event.toolUseId)));
    }
  }

  flushPendingTools();
  return segments;
}

export const EventTimeline = React.memo(function EventTimeline({
  events,
  activities,
  isStreaming = false,
}: EventTimelineProps): React.ReactElement | null {
  const segments = React.useMemo(() => buildSegments(events, activities), [activities, events]);

  if (segments.length === 0) return null;

  return (
    <div className="space-y-0">
      {segments.map((segment, index) => {
        if (segment.type === "text") {
          const isLast = index === segments.length - 1;
          // 结论段：最后一个文字段且前面紧跟工具组
          const prevSegment = index > 0 ? segments[index - 1] : null;
          const isConclusion = isLast && prevSegment?.type === "tools";

          return (
            <TimelineTextEvent
              key={`${segment.data.eventId}-${index}`}
              event={segment.data}
              isLast={isLast}
              isConclusion={isConclusion}
            />
          );
        }

        const firstTool = segment.data[0];
        const key = firstTool ? `${firstTool.toolUseId}-${index}` : `tools-${index}`;

        return (
          <div key={key} className="my-1.5">
            <ToolActivityList activities={segment.data} animate={isStreaming} />
          </div>
        );
      })}
    </div>
  );
});
