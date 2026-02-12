"use client";

import * as React from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  Circle,
  FilePenLine,
  FileText,
  FolderSearch,
  GitBranch,
  Globe,
  ListTodo,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ToolActivity } from "@/atoms";

type ActivityStatus = "pending" | "running" | "backgrounded" | "completed" | "error";

type ActivityGroup = {
  parent: ToolActivity;
  children: ToolActivity[];
};

const SIZE = {
  icon: "size-3",
  spinner: "size-2.5",
  row: "py-[3px]",
  staggerLimit: 10,
  autoScrollThreshold: 6,
  rowHeight: 24,
} as const;

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  Edit: Pencil,
  Write: FilePenLine,
  Read: FileText,
  Bash: Terminal,
  Glob: FolderSearch,
  Grep: Search,
  Task: GitBranch,
  WebFetch: Globe,
  WebSearch: Globe,
  Skill: Zap,
  TodoWrite: ListTodo,
  TodoRead: ListTodo,
  TaskCreate: ListTodo,
  TaskUpdate: ListTodo,
  TaskGet: ListTodo,
  TaskList: ListTodo,
};

function getToolIcon(toolName: string): React.ComponentType<{ className?: string }> {
  return TOOL_ICONS[toolName] ?? Wrench;
}

function getActivityStatus(activity: ToolActivity): ActivityStatus {
  if (activity.isError) return "error";
  if (activity.done) return "completed";
  if (activity.isBackground) return "backgrounded";
  if (activity.result || Object.keys(activity.input).length > 0) return "running";
  return "pending";
}

function groupActivities(activities: ToolActivity[]): Array<ToolActivity | ActivityGroup> {
  const toolIds = new Set(activities.map((activity) => activity.toolUseId));
  const parentIds = new Set<string>();
  for (const activity of activities) {
    if (activity.parentToolUseId && toolIds.has(activity.parentToolUseId)) {
      parentIds.add(activity.parentToolUseId);
    }
  }

  const childMap = new Map<string, ToolActivity[]>();
  const topLevel: ToolActivity[] = [];

  for (const activity of activities) {
    if (activity.parentToolUseId && parentIds.has(activity.parentToolUseId)) {
      const children = childMap.get(activity.parentToolUseId) ?? [];
      children.push(activity);
      childMap.set(activity.parentToolUseId, children);
    } else {
      topLevel.push(activity);
    }
  }

  const grouped: Array<ToolActivity | ActivityGroup> = [];
  for (const item of topLevel) {
    const children = childMap.get(item.toolUseId) ?? [];
    if (parentIds.has(item.toolUseId)) {
      grouped.push({ parent: item, children });
    } else {
      grouped.push(item);
    }
  }
  return grouped;
}

function isActivityGroup(item: ToolActivity | ActivityGroup): item is ActivityGroup {
  return (item as ActivityGroup).parent !== undefined;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${s}s`;
}

function extractFilePath(input: Record<string, unknown>): string | null {
  const fp = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
  return typeof fp === "string" ? fp : null;
}

interface DiffStats {
  additions: number;
  deletions: number;
}

function computeDiffStats(toolName: string, input: Record<string, unknown>): DiffStats | null {
  if (toolName === "Edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!oldStr && !newStr) return null;
    const oldLines = oldStr.split("\n").length;
    const newLines = newStr.split("\n").length;
    return { additions: Math.max(0, newLines - oldLines + 1), deletions: Math.max(0, oldLines - newLines + 1) };
  }
  return null;
}

function getInputSummary(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === "Bash") {
    const cmd = input.command;
    if (typeof cmd === "string") return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
  }
  if (toolName === "Grep") {
    const pattern = input.pattern;
    if (typeof pattern === "string") return `/${pattern}/`;
  }
  if (toolName === "Glob") {
    const pattern = input.pattern;
    if (typeof pattern === "string") return pattern;
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    const url = input.url ?? input.query;
    if (typeof url === "string") return url.length > 60 ? `${url.slice(0, 60)}…` : url;
  }
  if (toolName === "Skill") {
    const skill = input.skill;
    if (typeof skill === "string") return skill;
  }
  return null;
}

function formatInput(input: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!k.startsWith("_")) filtered[k] = v;
  }
  try {
    return JSON.stringify(filtered, null, 2);
  } catch {
    return "[不可序列化]";
  }
}

function StatusIcon({ status, toolName }: { status: ActivityStatus; toolName?: string }): React.ReactElement {
  const key = `${status}-${toolName}`;

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

function FileBadge({ path }: { path: string }): React.ReactElement {
  const filename = path.split("/").pop() ?? path;
  return <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] leading-none text-foreground/70 shadow-sm">{filename}</span>;
}

function DiffBadges({ stats }: { stats: DiffStats }): React.ReactElement {
  return (
    <span className="shrink-0 flex items-center gap-1">
      {stats.deletions > 0 ? (
        <span className="rounded bg-destructive/5 px-1.5 py-0.5 text-[10px] leading-none text-destructive shadow-sm">-{stats.deletions}</span>
      ) : null}
      {stats.additions > 0 ? (
        <span className="rounded bg-green-500/5 px-1.5 py-0.5 text-[10px] leading-none text-green-600 shadow-sm dark:text-green-400">+{stats.additions}</span>
      ) : null}
    </span>
  );
}

function ErrorBadge(): React.ReactElement {
  return <span className="shrink-0 rounded bg-destructive/5 px-1.5 py-0.5 text-[10px] font-medium leading-none text-destructive shadow-sm">Error</span>;
}

function ActivityDetails({ activity, onClose }: { activity: ToolActivity; onClose: () => void }): React.ReactElement {
  return (
    <div className="mt-1 animate-in fade-in slide-in-from-top-1 duration-150 overflow-hidden rounded-md border border-border/40 bg-muted/20">
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-1.5">
        <span className="text-[11px] font-medium text-foreground/50">{activity.toolName}</span>
        <button type="button" onClick={onClose} className="text-[11px] text-foreground/40 transition-colors hover:text-foreground">
          收起
        </button>
      </div>

      <div className="max-h-[300px] space-y-2 overflow-y-auto px-3 py-2 custom-scrollbar">
        {Object.keys(activity.input).length > 0 ? (
          <div>
            <div className="mb-1 text-[10px] font-medium text-foreground/40">输入</div>
            <pre className="max-h-[150px] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded bg-background/50 p-2 text-[11px] text-foreground/60 custom-scrollbar">
              {formatInput(activity.input)}
            </pre>
          </div>
        ) : null}

        {activity.result ? (
          <div>
            <div className="mb-1 text-[10px] font-medium text-foreground/40">结果</div>
            <pre className={cn(
              "max-h-[150px] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded p-2 text-[11px] custom-scrollbar",
              activity.isError ? "bg-destructive/5 text-destructive/80" : "bg-background/50 text-foreground/60"
            )}>
              {activity.result.length > 2000 ? `${activity.result.slice(0, 2000)}\n… [截断]` : activity.result}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ActivityRow({
  activity,
  index = 0,
  animate = false,
  onOpenDetails,
}: {
  activity: ToolActivity;
  index?: number;
  animate?: boolean;
  onOpenDetails?: (activity: ToolActivity) => void;
}): React.ReactElement {
  const status = getActivityStatus(activity);
  const filePath = extractFilePath(activity.input);
  const diffStats = computeDiffStats(activity.toolName, activity.input);
  const inputSummary = getInputSummary(activity.toolName, activity.input);
  const intent = activity.intent ?? activity.displayName;
  const delay = animate && index < SIZE.staggerLimit ? `${index * 30}ms` : "0ms";

  return (
    <div
      className={cn(
        "group/row flex items-center gap-2 rounded-md text-[13px]",
        SIZE.row,
        animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both",
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <StatusIcon status={status} toolName={activity.toolName} />
      <span className="shrink-0 text-foreground/80">{activity.toolName}</span>
      {diffStats ? <DiffBadges stats={diffStats} /> : null}
      {filePath ? <FileBadge path={filePath} /> : null}
      {activity.isError ? <ErrorBadge /> : null}

      <span className="min-w-0 flex-1 truncate text-foreground/50">
        {intent ? <>{intent}</> : null}
        {!intent && inputSummary ? <>{inputSummary}</> : null}
        {intent && inputSummary ? <> · <span className="opacity-70">{inputSummary}</span></> : null}
      </span>

      {activity.elapsedSeconds !== undefined && activity.elapsedSeconds > 0 ? (
        <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/60">{formatElapsed(activity.elapsedSeconds)}</span>
      ) : null}

      {onOpenDetails && activity.done && (activity.result || Object.keys(activity.input).length > 0) ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetails(activity);
          }}
          className="shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:bg-muted/80 group-hover/row:opacity-100"
        >
          <ArrowUpRight className="size-3 text-muted-foreground" />
        </button>
      ) : null}
    </div>
  );
}

function ActivityGroupRow({
  group,
  index = 0,
  animate = false,
  onOpenDetails,
  detailsId,
  onCloseDetails,
}: {
  group: ActivityGroup;
  index?: number;
  animate?: boolean;
  onOpenDetails?: (activity: ToolActivity) => void;
  detailsId?: string | null;
  onCloseDetails?: () => void;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(true);
  const { parent, children } = group;

  const derivedStatus = React.useMemo((): ActivityStatus => {
    const selfStatus = getActivityStatus(parent);
    if (selfStatus === "completed" || selfStatus === "error") return selfStatus;
    if (children.length > 0 && children.every((c) => c.done)) {
      if (children.some((c) => c.isError)) return "error";
      if (parent.done) return "completed";
    }
    return selfStatus;
  }, [parent, children]);

  const subagentType = typeof parent.input.subagent_type === "string" ? parent.input.subagent_type : undefined;
  const description = typeof parent.input.description === "string"
    ? parent.input.description
    : parent.intent ?? parent.displayName ?? "Task";

  const delay = animate && index < SIZE.staggerLimit ? `${index * 30}ms` : "0ms";

  return (
    <div
      className={cn("w-full", animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both")}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn("w-full cursor-pointer items-center gap-2 rounded-md pl-1 text-left text-[13px] transition-colors hover:text-foreground", SIZE.row, "flex")}
      >
        <ChevronRight className={cn("size-3 text-muted-foreground/60 transition-transform duration-150", expanded && "rotate-90")} />
        <StatusIcon status={derivedStatus} toolName="Task" />

        <span className="shrink-0 rounded bg-background px-1.5 py-0.5 text-[10px] font-medium leading-none shadow-sm">{subagentType ?? "Task"}</span>
        <span className="min-w-0 flex-1 truncate text-foreground/70">{description}</span>

        {parent.elapsedSeconds !== undefined && parent.elapsedSeconds > 0 ? (
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/60">{formatElapsed(parent.elapsedSeconds)}</span>
        ) : null}

        {children.length > 0 ? (
          <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground/40">
            {children.filter((c) => c.done).length}/{children.length}
          </span>
        ) : null}
      </button>

      {expanded && children.length > 0 ? (
        <div className={cn("ml-[7px] border-l-2 border-muted pl-6 pr-1", "animate-in fade-in slide-in-from-top-1 duration-150") }>
          {children.map((child, idx) => (
            <React.Fragment key={child.toolUseId}>
              <ActivityRow activity={child} index={idx} animate={animate} onOpenDetails={onOpenDetails} />
              {detailsId === child.toolUseId ? (
                <ActivityDetails activity={child} onClose={onCloseDetails ?? (() => {})} />
              ) : null}
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function parseTodoItems(input: Record<string, unknown>): Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> | null {
  if (input.todos && Array.isArray(input.todos)) {
    return (input.todos as Array<Record<string, unknown>>).map((todo) => ({
      content: String(todo.subject ?? todo.content ?? ""),
      status: (todo.status as "pending" | "in_progress" | "completed") ?? "pending",
      activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined,
    }));
  }
  return null;
}

interface ToolActivityListProps {
  activities: ToolActivity[];
  animate?: boolean;
}

export function ToolActivityList({ activities, animate = false }: ToolActivityListProps): React.ReactElement | null {
  const [detailsId, setDetailsId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);

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

  const visibleRows = React.useMemo(() => {
    let count = 0;
    for (const item of grouped) {
      count += 1;
      if (isActivityGroup(item)) {
        count += item.children.length;
      }
    }
    return count;
  }, [grouped]);

  const needsCollapse = visibleRows > SIZE.autoScrollThreshold;

  React.useEffect(() => {
    if (animate && listRef.current && needsCollapse) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [visibleRows, needsCollapse, animate]);

  if (normalizedActivities.length === 0) return null;

  const detailActivity = detailsId ? normalizedActivities.find((activity) => activity.toolUseId === detailsId) : null;
  const handleOpenDetails = (activity: ToolActivity): void => {
    setDetailsId((prev) => (prev === activity.toolUseId ? null : activity.toolUseId));
  };

  const isCollapsed = !animate && needsCollapse && !expanded;

  return (
    <div className="w-full">
      <div
        ref={listRef}
        className={cn("space-y-0 custom-scrollbar", animate && needsCollapse && "overflow-y-auto", isCollapsed && "overflow-hidden")}
        style={animate && needsCollapse
          ? { maxHeight: SIZE.autoScrollThreshold * SIZE.rowHeight }
          : isCollapsed
            ? { maxHeight: SIZE.autoScrollThreshold * SIZE.rowHeight }
            : undefined}
      >
        {grouped.map((item, index) => {
          if (isActivityGroup(item)) {
            return (
              <ActivityGroupRow
                key={item.parent.toolUseId}
                group={item}
                index={index}
                animate={animate}
                onOpenDetails={handleOpenDetails}
                detailsId={detailsId}
                onCloseDetails={() => setDetailsId(null)}
              />
            );
          }

          const activity = item as ToolActivity;

          return (
            <React.Fragment key={activity.toolUseId}>
              <ActivityRow activity={activity} index={index} animate={animate} onOpenDetails={handleOpenDetails} />
              {detailsId === activity.toolUseId && detailActivity ? (
                <ActivityDetails activity={detailActivity} onClose={() => setDetailsId(null)} />
              ) : null}
            </React.Fragment>
          );
        })}
      </div>

      {!animate && needsCollapse ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
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
