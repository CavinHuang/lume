"use client";

type ContextUsageBadgeProps = {
  used?: number;
  total?: number;
};

export function ContextUsageBadge({ used, total }: ContextUsageBadgeProps): React.ReactElement {
  if (typeof used !== "number" || typeof total !== "number" || total <= 0) {
    return <span className="text-xs text-muted-foreground">Context N/A</span>;
  }
  const pct = Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  return <span className="text-xs text-muted-foreground">Context {pct}%</span>;
}
