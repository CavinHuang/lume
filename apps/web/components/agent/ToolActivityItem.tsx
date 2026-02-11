"use client";

import type { ToolActivity } from "@/atoms";

export function ToolActivityItem({ activity }: { activity: ToolActivity }): React.ReactElement {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-xs">
      <span className={activity.done ? "h-2 w-2 rounded-full bg-green-500" : "h-2 w-2 rounded-full bg-sky-400"} />
      <strong>{activity.toolName}</strong>
      <span className="truncate opacity-80">{activity.displayName || activity.intent || activity.result || JSON.stringify(activity.input)}</span>
    </div>
  );
}

export function ToolActivityTree({ activities }: { activities: ToolActivity[] }): React.ReactElement {
  const byParent = new Map<string, ToolActivity[]>();
  const topLevel: ToolActivity[] = [];

  for (const activity of activities) {
    if (activity.parentToolUseId) {
      const siblings = byParent.get(activity.parentToolUseId) ?? [];
      siblings.push(activity);
      byParent.set(activity.parentToolUseId, siblings);
    } else {
      topLevel.push(activity);
    }
  }

  const renderNode = (activity: ToolActivity, depth: number): React.ReactElement => {
    const children = byParent.get(activity.toolUseId) ?? [];
    return (
      <div key={activity.toolUseId} className={depth > 0 ? "flex flex-col gap-1" : undefined}>
        <ToolActivityItem activity={activity} />
        {children.length > 0 ? (
          <div className="ml-4 mt-1 flex flex-col gap-1 border-l border-dashed border-slate-700 pl-2">
            {children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      {topLevel.map((activity) => renderNode(activity, 0))}
    </div>
  );
}
