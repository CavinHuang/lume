import * as React from "react";
import { CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import type { ToolActivity } from "@/atoms";
import type { TaskGroup } from "@/lib/agent-tool-activity";
import { cn } from "@/lib/utils";
import { getActivityStatus, getToolIcon } from "./tool-activity/meta";
import { formatElapsed } from "./tool-activity/utils";

function SubActivityRow({ activity }: { activity: ToolActivity }) {
  const status = getActivityStatus(activity);
  const Icon = getToolIcon(activity.toolName);
  const label = activity.displayName ?? activity.intent ?? activity.toolName;
  return (
    <div className="flex items-center gap-2 py-[3px] text-[12px] text-muted-foreground">
      <Icon className="size-3 shrink-0 opacity-60" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {status === "running" ? <Loader2 className="size-2.5 animate-spin text-blue-500" /> : null}
      {status === "completed" ? <CheckCircle2 className="size-2.5 text-green-500" /> : null}
      {status === "error" ? <XCircle className="size-2.5 text-destructive" /> : null}
    </div>
  );
}

export function TaskContainerCard({
  group,
  defaultExpanded = false,
}: {
  group: TaskGroup;
  defaultExpanded?: boolean;
}) {
  const { parent, children } = group;
  const [expanded, setExpanded] = React.useState(defaultExpanded);
  const isDone = parent.done;
  const isError = parent.isError;
  const label = parent.displayName ?? parent.intent ?? parent.toolName;
  const elapsed = parent.elapsedSeconds != null ? formatElapsed(parent.elapsedSeconds) : null;

  React.useEffect(() => {
    if (!isDone) setExpanded(true);
  }, [isDone]);

  const hasContent = children.length > 0 || !!parent.result;

  return (
    <div className="my-1.5 max-w-[630px] rounded-lg border border-border/60 bg-muted/25">
      <button
        type="button"
        onClick={() => hasContent && setExpanded(v => !v)}
        className={cn("flex w-full items-center gap-2 px-3.5 py-2.5 text-left", !hasContent && "cursor-default")}
      >
        <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-90")} />
        {!isDone ? <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" /> : null}
        {isDone && !isError ? <CheckCircle2 className="size-3.5 shrink-0 text-green-500" /> : null}
        {isDone && isError ? <XCircle className="size-3.5 shrink-0 text-destructive" /> : null}
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground/80">{label}</span>
        {elapsed ? <span className="shrink-0 text-[11px] text-muted-foreground/50">{elapsed}</span> : null}
        <span className="shrink-0 text-[11px] text-muted-foreground/40">{children.length} 步</span>
      </button>
      {expanded && (children.length > 0 || parent.result) ? (
        <div className="border-t border-border/40 px-3.5 py-2">
          {children.map(child => <SubActivityRow key={child.toolUseId} activity={child} />)}
          {children.length === 0 && parent.result ? (
            <p className="text-[12px] text-muted-foreground whitespace-pre-wrap break-words">{parent.result}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
