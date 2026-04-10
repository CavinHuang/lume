import * as React from "react";
import type { ToolActivity } from "@/atoms";
import { ToolCard } from "./ToolCard";
import { groupActivities, isActivityGroup, parseTodoItems } from "./utils";

const SIZE = {
  autoScrollThreshold: 6,
  cardHeight: 88,
} as const;

function ActivityGroupRow({
  parent,
  children,
  index = 0,
  animate = false,
  expanded = false,
  onExpandedChange,
  expandedChildren,
  onChildExpandedChange,
}: {
  parent: ToolActivity;
  children: ToolActivity[];
  index?: number;
  animate?: boolean;
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  expandedChildren: Record<string, boolean>;
  onChildExpandedChange: (toolUseId: string, open: boolean) => void;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <ToolCard activity={parent} index={index} animate={animate} expanded={expanded} onExpandedChange={onExpandedChange} />
      {children.length > 0 && expanded ? (
        <div className="ml-4 border-l border-border/40 pl-4">
          <div className="space-y-2">
            {children.map((child, idx) => (
              <ToolCard
                key={child.toolUseId}
                activity={child}
                index={idx}
                animate={animate}
                expanded={expandedChildren[child.toolUseId] === true}
                onExpandedChange={(open) => onChildExpandedChange(child.toolUseId, open)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export interface ToolActivityListProps {
  activities: ToolActivity[];
  animate?: boolean;
}

export function ToolActivityList({ activities, animate = false }: ToolActivityListProps): React.ReactElement | null {
  const listRef = React.useRef<HTMLDivElement>(null);
  const [expandedCards, setExpandedCards] = React.useState<Record<string, boolean>>({});

  const latestTodoActivityIndex = React.useMemo(() => {
    for (let i = activities.length - 1; i >= 0; i--) {
      const activity = activities[i];
      if (!activity) continue;
      if (activity.toolName !== "TodoWrite" && activity.toolName !== "TaskCreate") continue;
      const todos = parseTodoItems(activity.input);
      if (todos && todos.length > 0) return i;
    }
    return -1;
  }, [activities]);

  const normalizedActivities = React.useMemo(() => {
    if (latestTodoActivityIndex < 0) return activities;
    return activities.filter((activity, index) => {
      if (activity.toolName !== "TodoWrite" && activity.toolName !== "TaskCreate") return true;
      return index === latestTodoActivityIndex;
    });
  }, [activities, latestTodoActivityIndex]);

  const grouped = React.useMemo(() => groupActivities(normalizedActivities), [normalizedActivities]);
  const visibleToolIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const item of grouped) {
      if (isActivityGroup(item)) {
        ids.add(item.parent.toolUseId);
        for (const child of item.children) ids.add(child.toolUseId);
      } else {
        ids.add((item as ToolActivity).toolUseId);
      }
    }
    return ids;
  }, [grouped]);

  const visibleRows = React.useMemo(() => {
    let count = 0;
    for (const item of grouped) {
      count += 1;
      if (isActivityGroup(item)) count += item.children.length;
    }
    return count;
  }, [grouped]);

  const needsCollapse = visibleRows > SIZE.autoScrollThreshold;

  React.useEffect(() => {
    if (animate && listRef.current && needsCollapse) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [visibleRows, needsCollapse, animate]);

  React.useEffect(() => {
    setExpandedCards((prev) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [toolUseId, open] of Object.entries(prev)) {
        if (visibleToolIds.has(toolUseId)) next[toolUseId] = open;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleToolIds]);

  if (normalizedActivities.length === 0) return null;

  return (
    <div className="w-full max-w-[620px]">
      <div
        ref={listRef}
        className={animate && needsCollapse ? "space-y-2 custom-scrollbar overflow-y-auto" : "space-y-2 custom-scrollbar"}
        style={animate && needsCollapse ? { maxHeight: SIZE.autoScrollThreshold * SIZE.cardHeight } : undefined}
      >
        {grouped.map((item, index) => {
          if (isActivityGroup(item)) {
            return (
              <ActivityGroupRow
                key={item.parent.toolUseId}
                parent={item.parent}
                children={item.children}
                index={index}
                animate={animate}
                expanded={expandedCards[item.parent.toolUseId] === true}
                onExpandedChange={(open) => {
                  setExpandedCards((prev) => ({ ...prev, [item.parent.toolUseId]: open }));
                }}
                expandedChildren={expandedCards}
                onChildExpandedChange={(toolUseId, open) => {
                  setExpandedCards((prev) => ({ ...prev, [toolUseId]: open }));
                }}
              />
            );
          }
          const activity = item as ToolActivity;
          return (
            <ToolCard
              key={activity.toolUseId}
              activity={activity}
              index={index}
              animate={animate}
              expanded={expandedCards[activity.toolUseId] === true}
              onExpandedChange={(open) => {
                setExpandedCards((prev) => ({ ...prev, [activity.toolUseId]: open }));
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export function ToolActivityItem({ activity }: { activity: ToolActivity }): React.ReactElement {
  return <ToolActivityList activities={[activity]} />;
}

export function ToolActivityTree({ activities }: { activities: ToolActivity[] }): React.ReactElement {
  return <ToolActivityList activities={activities} animate />;
}

