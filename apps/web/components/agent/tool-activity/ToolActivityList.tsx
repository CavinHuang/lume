import * as React from "react";
import { CheckCircle2, ChevronRight, Circle, Loader2, MessageCircleDashed, XCircle } from "lucide-react";
import type { ToolActivity } from "@/atoms";
import { cn } from "@/lib/utils";
import { getToolActivePhrase, getToolDonePhrase } from "../tool-phrase";
import { ToolResultRenderer } from "../tool-result-renderers";
import { getActivityStatus, getToolIcon } from "./meta";
import { formatElapsed, groupActivities, isActivityGroup, parseTodoItems } from "./utils";

const SIZE = {
  icon: "size-2.5",
  spinner: "size-2",
  row: "py-[2px]",
  staggerLimit: 10,
  autoScrollThreshold: 6,
  rowHeight: 22,
} as const;

type ActivityStatus = ReturnType<typeof getActivityStatus>;

function StatusIcon({ status, toolName }: { status: ActivityStatus; toolName?: string }): React.ReactElement {
  const key = `${status}-${toolName ?? ""}`;

  if (status === "running" || status === "backgrounded") {
    return (
      <span key={key} className={cn(SIZE.icon, "flex items-center justify-center animate-in fade-in zoom-in-75 duration-200")}>
        <Loader2 className={cn(SIZE.spinner, "animate-spin", status === "backgrounded" ? "text-primary" : "text-blue-500")} />
      </span>
    );
  }

  if (status === "error") {
    return (
      <span key={key} className={cn(SIZE.icon, "flex items-center justify-center animate-in fade-in zoom-in-75 duration-200")}>
        <XCircle className={cn(SIZE.icon, "text-destructive")} />
      </span>
    );
  }

  if (status === "completed") {
    const ToolIcon = toolName ? getToolIcon(toolName) : null;
    if (ToolIcon && (toolName === "Edit" || toolName === "Write")) {
      return (
        <span key={key} className={cn(SIZE.icon, "flex items-center justify-center animate-in fade-in zoom-in-75 duration-200")}>
          <ToolIcon className={cn(SIZE.icon, "text-primary")} />
        </span>
      );
    }
    return (
      <span key={key} className={cn(SIZE.icon, "flex items-center justify-center animate-in fade-in zoom-in-75 duration-200")}>
        <CheckCircle2 className={cn(SIZE.icon, "text-green-500")} />
      </span>
    );
  }

  return (
    <span key={key} className={cn(SIZE.icon, "flex items-center justify-center")}>
      <Circle className={cn(SIZE.icon, "text-muted-foreground/50")} />
    </span>
  );
}

function ErrorBadge(): React.ReactElement {
  return (
    <span className="shrink-0 rounded bg-destructive/5 px-1.5 py-0.5 text-[10px] font-medium leading-none text-destructive shadow-sm">
      Error
    </span>
  );
}

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

function TodoList({ items }: { items: TodoItem[] }): React.ReactElement {
  return (
    <div className="ml-[5px] space-y-0.5 border-l-2 border-muted pl-5">
      {items.map((todo, index) => (
        <div
          key={`${todo.content}-${index}`}
          className={cn(
            "flex items-center gap-2 text-[13px]",
            SIZE.row,
            todo.status === "completed" && "opacity-50"
          )}
        >
          {todo.status === "pending" ? <Circle className={cn(SIZE.icon, "text-muted-foreground/50")} /> : null}
          {todo.status === "in_progress" ? <Loader2 className={cn(SIZE.spinner, "animate-spin text-blue-500")} /> : null}
          {todo.status === "completed" ? <CheckCircle2 className={cn(SIZE.icon, "text-green-500")} /> : null}
          <span className={cn("flex-1 truncate", todo.status === "completed" && "line-through")}>
            {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
          </span>
        </div>
      ))}
    </div>
  );
}

function getPhrase(activity: ToolActivity, status: ActivityStatus): string {
  return status === "running" || status === "backgrounded"
    ? getToolActivePhrase(activity.toolName, activity.input)
    : getToolDonePhrase(activity.toolName, activity.input);
}

export interface ActivityRowProps {
  activity: ToolActivity;
  index?: number;
  animate?: boolean;
  onOpenDetails?: (activity: ToolActivity) => void;
}

export function ActivityRow({
  activity,
  index = 0,
  animate = false,
  onOpenDetails,
}: ActivityRowProps): React.ReactElement {
  const status = getActivityStatus(activity);
  const displayLabel = getPhrase(activity, status);
  const delay = animate && index < SIZE.staggerLimit ? `${index * 30}ms` : "0ms";
  const canExpand = !!onOpenDetails && activity.done && !!(activity.result || Object.keys(activity.input).length > 0);

  return (
    <div
      className={cn(
        "group/row flex items-center gap-1.5 rounded-md text-[12px]",
        SIZE.row,
        animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both"
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      {canExpand ? (
        <button
          type="button"
          className="group/expand flex min-w-0 flex-1 items-center gap-1.5"
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetails(activity);
          }}
        >
          <StatusIcon status={status} toolName={activity.toolName} />
          <span className="flex-1 truncate text-foreground/80 transition-colors duration-150 group-hover/expand:text-foreground">{displayLabel}</span>
          {activity.isError ? <ErrorBadge /> : null}
          {activity.elapsedSeconds !== undefined && activity.elapsedSeconds > 0 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
              {formatElapsed(activity.elapsedSeconds)}
            </span>
          ) : null}
          <ChevronRight className="size-2.5 shrink-0 text-muted-foreground/40 transition-colors duration-150 group-hover/expand:text-foreground/60" />
        </button>
      ) : (
        <>
          <StatusIcon status={status} toolName={activity.toolName} />
          <span className="truncate text-foreground/80">{displayLabel}</span>
          {activity.isError ? <ErrorBadge /> : null}
          {activity.elapsedSeconds !== undefined && activity.elapsedSeconds > 0 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
              {formatElapsed(activity.elapsedSeconds)}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

function ActivityDetails({ activity }: { activity: ToolActivity }): React.ReactElement {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = (): void => {
    const parts: string[] = [`[${activity.toolName}]`];
    if (activity.result) parts.push(activity.result);
    void navigator.clipboard.writeText(parts.join("\n\n")).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="mt-1 animate-in fade-in slide-in-from-top-2 overflow-hidden rounded-md border border-border/40 bg-muted/20 duration-300 ease-out">
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-1.5">
        <span className="text-[11px] font-medium text-foreground/50">{getToolDonePhrase(activity.toolName, activity.input)}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="text-[11px] text-foreground/40 transition-colors hover:text-foreground"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>

      <div className="max-h-[400px] space-y-2 overflow-y-auto px-3 py-2">
        {activity.result ? (
          <ToolResultRenderer
            toolName={activity.toolName}
            input={activity.input}
            result={activity.result}
            isError={activity.isError ?? false}
          />
        ) : null}
      </div>
    </div>
  );
}

function IntermediateRow({
  text,
  index,
  animate,
}: {
  text: string;
  index: number;
  animate: boolean;
}): React.ReactElement {
  const delay = animate && index < SIZE.staggerLimit ? `${index * 30}ms` : "0ms";
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-[13px] text-foreground/50",
        SIZE.row,
        animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both"
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <MessageCircleDashed className={cn(SIZE.icon, "text-muted-foreground/50")} />
      <span className="flex-1 truncate">{text}</span>
    </div>
  );
}

function ActivityGroupRow({
  parent,
  children,
  index = 0,
  animate = false,
  onOpenDetails,
  detailsId,
}: {
  parent: ToolActivity;
  children: ToolActivity[];
  index?: number;
  animate?: boolean;
  onOpenDetails?: (activity: ToolActivity) => void;
  detailsId?: string | null;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(parent.toolName !== "Agent");
  const derivedStatus = React.useMemo(() => {
    const selfStatus = getActivityStatus(parent);
    if (selfStatus === "completed" || selfStatus === "error") return selfStatus;
    if (children.length > 0 && children.every((child) => child.done)) {
      if (children.some((child) => child.isError)) return "error";
      if (parent.done) return "completed";
    }
    return selfStatus;
  }, [children, parent]);
  const displayLabel = getPhrase(parent, derivedStatus);
  const delay = animate && index < SIZE.staggerLimit ? `${index * 30}ms` : "0ms";
  const subagentType = typeof parent.input.subagent_type === "string" ? parent.input.subagent_type : undefined;

  return (
    <div
      className={cn("w-full", animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both")}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-1.5 rounded-md pl-1 text-left text-[12px] transition-colors hover:text-foreground",
          SIZE.row
        )}
      >
        <ChevronRight className={cn("size-2.5 text-muted-foreground/60 transition-transform duration-150", expanded && "rotate-90")} />
        <StatusIcon status={derivedStatus} toolName={parent.toolName} />
        {subagentType ? (
          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium leading-none text-primary">
            {subagentType}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-foreground/80">{displayLabel}</span>
        {parent.elapsedSeconds !== undefined && parent.elapsedSeconds > 0 ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
            {formatElapsed(parent.elapsedSeconds)}
          </span>
        ) : null}
        {children.length > 0 ? (
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/50">
            {children.filter((child) => child.done).length}/{children.length}
          </span>
        ) : null}
      </button>

      {expanded && children.length > 0 ? (
        <div className="ml-[7px] space-y-0 border-l-2 border-muted pl-6 pr-1 animate-in fade-in slide-in-from-top-1 duration-150">
          {children.map((child, childIndex) => (
            <React.Fragment key={child.toolUseId}>
              <ActivityRow
                activity={child}
                index={childIndex}
                animate={animate}
                onOpenDetails={onOpenDetails}
              />
              {detailsId === child.toolUseId ? <ActivityDetails activity={child} /> : null}
            </React.Fragment>
          ))}
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
  const [detailsId, setDetailsId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);

  const grouped = React.useMemo(() => groupActivities(activities), [activities]);
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
  }, [animate, needsCollapse, visibleRows]);

  if (activities.length === 0) return null;

  const detailActivity = detailsId ? activities.find((activity) => activity.toolUseId === detailsId) : null;
  const handleOpenDetails = (activity: ToolActivity): void => {
    setDetailsId((previous) => previous === activity.toolUseId ? null : activity.toolUseId);
  };
  const isCollapsed = !animate && needsCollapse && !expanded;

  return (
    <div className="w-full">
      <div
        ref={listRef}
        className={cn(
          "space-y-0",
          animate && needsCollapse && "overflow-y-auto",
          isCollapsed && "overflow-hidden"
        )}
        style={
          animate && needsCollapse
            ? { maxHeight: SIZE.autoScrollThreshold * SIZE.rowHeight }
            : isCollapsed
              ? { maxHeight: SIZE.autoScrollThreshold * SIZE.rowHeight }
              : undefined
        }
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
                onOpenDetails={handleOpenDetails}
                detailsId={detailsId}
              />
            );
          }

          const activity = item as ToolActivity;
          if (activity.toolName === "TodoWrite" || activity.toolName === "TaskCreate") {
            const todos = parseTodoItems(activity.input);
            if (todos && todos.length > 0) {
              return (
                <React.Fragment key={activity.toolUseId}>
                  <ActivityRow activity={activity} index={index} animate={animate} />
                  <TodoList items={todos} />
                </React.Fragment>
              );
            }
          }

          const isIntermediate = activity.toolName === "status" && typeof activity.result === "string" && activity.result.trim().length > 0;
          if (isIntermediate) {
            return (
              <IntermediateRow
                key={activity.toolUseId}
                text={activity.result ?? ""}
                index={index}
                animate={animate}
              />
            );
          }

          return (
            <React.Fragment key={activity.toolUseId}>
              <ActivityRow
                activity={activity}
                index={index}
                animate={animate}
                onOpenDetails={handleOpenDetails}
              />
              {detailsId === activity.toolUseId && detailActivity ? <ActivityDetails activity={detailActivity} /> : null}
            </React.Fragment>
          );
        })}
      </div>

      {!animate && needsCollapse ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-foreground/80"
        >
          {expanded ? "收起工具活动" : `展开全部 ${visibleRows} 项工具活动`}
        </button>
      ) : null}
    </div>
  );
}

export function ToolActivityItem({ activity }: { activity: ToolActivity }): React.ReactElement {
  return <ToolActivityList activities={[activity]} />;
}

export function ToolActivityTree({ activities }: { activities: ToolActivity[] }): React.ReactElement {
  return <ToolActivityList activities={activities} animate />;
}
