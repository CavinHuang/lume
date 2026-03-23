"use client";

import * as React from "react";
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock,
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
  // Session / subagent tools
  sessions_spawn: GitBranch,
  agents_list: Bot,
  sessions_list: Bot,
  sessions_history: Bot,
  sessions_send: Bot,
  sessions_delete: Bot,
  sessions_delete_all: Bot,
  session_status: Bot,
  subagents_list: Bot,
  subagents_kill: Bot,
  subagents_send: Bot,
  subagents_steer: Bot,
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

/** 已完成工具调用的简短结果摘要，显示在行内 */
function getResultSummary(toolName: string, result: string): string | null {
  if (!result || !result.trim()) return null;
  // Edit/Write 已有 diff badges，无需重复
  if (toolName === "Edit" || toolName === "Write") return null;

  const trimmed = result.trim();

  if (toolName === "Bash") {
    const lines = trimmed.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;
    const first = lines[0]!;
    return first.length > 50 ? `${first.slice(0, 50)}…` : first;
  }
  if (toolName === "Read") {
    const count = trimmed.split("\n").length;
    return `${count} 行`;
  }
  if (toolName === "Grep") {
    const matches = trimmed.split("\n").filter((l) => l.trim()).length;
    return matches > 0 ? `${matches} 个匹配` : "无匹配";
  }
  if (toolName === "Glob") {
    const files = trimmed.split("\n").filter((l) => l.trim()).length;
    return files > 0 ? `${files} 个文件` : "无结果";
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    const first = trimmed.split("\n")[0] ?? "";
    return first.length > 50 ? `${first.slice(0, 50)}…` : first || null;
  }
  return null;
}

/** 错误的第一行摘要，显示在行内替代 ErrorBadge */
function getErrorSummary(result: string): string | null {
  if (!result) return null;
  const first = result.trim().split("\n").find((l) => l.trim()) ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first || null;
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

/** 将 input 格式化为函数调用风格: (key=value, key=value) */
function formatInputAsFnCall(input: Record<string, unknown>): string {
  const filtered = Object.entries(input).filter(([k]) => !k.startsWith("_"));
  if (filtered.length === 0) return "()";
  const parts = filtered.map(([k, v]) => {
    if (typeof v === "string") {
      const display = v.length > 80 ? `${v.slice(0, 80)}…` : v;
      return `${k}="${display}"`;
    }
    if (typeof v === "boolean" || typeof v === "number") return `${k}=${String(v)}`;
    try {
      const s = JSON.stringify(v);
      return `${k}=${s.length > 60 ? `${s.slice(0, 60)}…` : s}`;
    } catch {
      return `${k}=...`;
    }
  });
  return `(${parts.join(", ")})`;
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

function ActivityDetails({ activity, onClose }: { activity: ToolActivity; onClose: () => void }): React.ReactElement {
  const truncatedResult = activity.result
    ? (activity.result.length > 2000 ? `${activity.result.slice(0, 2000)}\n… [截断，共 ${activity.result.length} 字符]` : activity.result)
    : null;

  return (
    <div className="mt-0.5 mb-1 animate-in fade-in slide-in-from-top-1 duration-150 overflow-hidden rounded-md border border-border/40 bg-muted/20">
      <div className="flex items-center justify-between border-b border-border/30 px-3 py-1.5">
        <span className="text-[11px] font-medium text-foreground/50">{activity.toolName}</span>
        <button type="button" onClick={onClose} className="text-[11px] text-foreground/40 transition-colors hover:text-foreground">
          收起
        </button>
      </div>

      <div className="max-h-[320px] space-y-2.5 overflow-y-auto px-3 py-2 custom-scrollbar">
        {/* ARGUMENTS */}
        {Object.keys(activity.input).length > 0 ? (
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-foreground/30">ARGUMENTS</div>
            <pre className="max-h-[160px] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/30 bg-muted/30 p-2.5 text-[11px] leading-relaxed text-foreground/60 custom-scrollbar">
              {formatInputAsFnCall(activity.input)}
            </pre>
          </div>
        ) : null}

        {/* ERROR (when isError) */}
        {truncatedResult && activity.isError ? (
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-destructive/60">ERROR</div>
            <pre className="max-h-[160px] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-destructive/20 bg-destructive/5 p-2.5 text-[11px] leading-relaxed text-destructive/80 custom-scrollbar">
              {truncatedResult}
            </pre>
          </div>
        ) : null}

        {/* RESULT (when not error) */}
        {truncatedResult && !activity.isError ? (
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-foreground/30">RESULT</div>
            <pre className="max-h-[160px] overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-border/30 bg-background/50 p-2.5 text-[11px] leading-relaxed text-foreground/60 custom-scrollbar">
              {truncatedResult}
            </pre>
          </div>
        ) : null}
      </div>

      {/* Footer: Call ID + Duration */}
      <div className="flex items-center gap-4 border-t border-border/30 px-3 py-1.5 text-[10px] text-muted-foreground/50">
        <span>Call ID: {activity.toolUseId}</span>
        {activity.elapsedSeconds !== undefined && activity.elapsedSeconds > 0 ? (
          <span>Duration: {formatElapsed(activity.elapsedSeconds)}</span>
        ) : null}
      </div>
    </div>
  );
}

function ActivityRow({
  activity,
  index = 0,
  animate = false,
  expanded = false,
  onToggleDetails,
}: {
  activity: ToolActivity;
  index?: number;
  animate?: boolean;
  expanded?: boolean;
  onToggleDetails?: (activity: ToolActivity) => void;
}): React.ReactElement {
  const status = getActivityStatus(activity);
  const filePath = extractFilePath(activity.input);
  const diffStats = computeDiffStats(activity.toolName, activity.input);
  const inputSummary = getInputSummary(activity.toolName, activity.input);
  const intent = activity.intent ?? activity.displayName;
  const delay = animate && index < SIZE.staggerLimit ? `${index * 30}ms` : "0ms";

  const resultSummary = status === "completed" && activity.result
    ? getResultSummary(activity.toolName, activity.result)
    : null;
  const errorSummary = status === "error" && activity.result
    ? getErrorSummary(activity.result)
    : null;

  const hasDetails = Object.keys(activity.input).length > 0 || !!activity.result;
  const isInteractive = !!onToggleDetails && hasDetails;

  return (
    <div
      role={isInteractive ? "button" : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={isInteractive ? () => onToggleDetails(activity) : undefined}
      onKeyDown={isInteractive ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggleDetails(activity); }
      } : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md text-[13px]",
        SIZE.row,
        animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both",
        isInteractive && "cursor-pointer hover:bg-muted/40 transition-colors duration-100 select-none",
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <StatusIcon status={status} toolName={activity.toolName} />
      <span className="shrink-0 text-foreground/80">{activity.toolName}</span>
      {diffStats ? <DiffBadges stats={diffStats} /> : null}
      {filePath ? <FileBadge path={filePath} /> : null}

      {/* 主文本区：意图 / 输入摘要 + 状态内联展示 */}
      <span className="min-w-0 flex-1 truncate text-foreground/50">
        {intent && !inputSummary ? intent : null}
        {!intent && inputSummary ? inputSummary : null}
        {intent && inputSummary ? <>{intent} · <span className="opacity-70">{inputSummary}</span></> : null}

        {/* 执行中：有进度文字时显示文字；否则显示三点弹跳 */}
        {status === "running" ? (
          activity.progressDescription ? (
            <span className="ml-1.5 text-blue-400/70 truncate">{activity.progressDescription}</span>
          ) : (
            <span className="ml-2 inline-flex items-center gap-[3px] align-middle">
              <span className="size-[3px] rounded-full bg-blue-400/80 animate-bounce [animation-delay:0ms]" />
              <span className="size-[3px] rounded-full bg-blue-400/80 animate-bounce [animation-delay:120ms]" />
              <span className="size-[3px] rounded-full bg-blue-400/80 animate-bounce [animation-delay:240ms]" />
            </span>
          )
        ) : null}

        {/* 后台运行：稳定闪烁点 */}
        {status === "backgrounded" ? (
          <span className="ml-2 inline-flex items-center gap-1 align-middle">
            <span className="size-[3px] rounded-full bg-primary/70 animate-pulse" />
            <span className="text-[10px] text-primary/70">后台</span>
          </span>
        ) : null}

        {/* 完成摘要 */}
        {resultSummary ? (
          <span className="ml-1.5 text-foreground/35"> · {resultSummary}</span>
        ) : null}

        {/* 错误摘要 */}
        {errorSummary ? (
          <span className="ml-1.5 text-destructive/60"> — {errorSummary}</span>
        ) : null}
      </span>

      {/* Error badge */}
      {status === "error" ? (
        <span className="shrink-0 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
          Error
        </span>
      ) : null}

      {activity.elapsedSeconds !== undefined && activity.elapsedSeconds > 0 ? (
        <span className="shrink-0 flex items-center gap-1 tabular-nums text-[11px] text-muted-foreground/60">
          <Clock className="size-2.5" />
          {formatElapsed(activity.elapsedSeconds)}
        </span>
      ) : null}

      {/* 可展开指示器 */}
      {isInteractive ? (
        <ChevronRight
          className={cn(
            "shrink-0 size-3 text-muted-foreground/30 transition-transform duration-150",
            expanded && "rotate-90"
          )}
        />
      ) : null}
    </div>
  );
}

function ActivityGroupRow({
  group,
  index = 0,
  animate = false,
  onToggleDetails,
  detailsId,
  onCloseDetails,
}: {
  group: ActivityGroup;
  index?: number;
  animate?: boolean;
  onToggleDetails?: (activity: ToolActivity) => void;
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
        className={cn("w-full cursor-pointer items-center gap-2 rounded-md pl-1 text-left text-[13px] transition-colors hover:bg-muted/40 hover:text-foreground", SIZE.row, "flex")}
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
        <div className={cn("ml-[7px] border-l-2 border-muted pl-6 pr-1", "animate-in fade-in slide-in-from-top-1 duration-150")}>
          {children.map((child, idx) => (
            <React.Fragment key={child.toolUseId}>
              <ActivityRow
                activity={child}
                index={idx}
                animate={animate}
                expanded={detailsId === child.toolUseId}
                onToggleDetails={onToggleDetails}
              />
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

/** 生成工具类型分布摘要文字，最多展示 3 种 */
function summarizeTools(activities: ToolActivity[]): string {
  const counts: Record<string, number> = {};
  for (const a of activities) {
    counts[a.toolName] = (counts[a.toolName] ?? 0) + 1;
  }
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const shown = entries.slice(0, 3);
  const rest = entries.length - shown.length;
  const parts = shown.map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  if (rest > 0) parts.push(`+${rest}`);
  return parts.join(" · ");
}

/** 折叠态的单行摘要栏 */
function ActivitySummaryBar({
  activities,
  isExpanded,
  hasError,
  onToggle,
}: {
  activities: ToolActivity[];
  isExpanded: boolean;
  hasError: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const summary = React.useMemo(() => summarizeTools(activities), [activities]);

  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 rounded-md px-1 py-[3px] text-left text-[12px] transition-colors duration-100 hover:bg-muted/40 select-none"
    >
      <ChevronRight
        className={cn(
          "size-3 shrink-0 text-muted-foreground/50 transition-transform duration-200 ease-in-out",
          isExpanded && "rotate-90"
        )}
      />
      <span className="shrink-0 text-foreground/60">{activities.length} 步操作</span>
      {hasError ? (
        <span className="shrink-0 rounded bg-destructive/10 px-1 py-0.5 text-[10px] text-destructive">含错误</span>
      ) : null}
      <span className="min-w-0 truncate text-foreground/35">{summary}</span>
    </button>
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
  /** 完成后默认折叠为摘要行（streaming 时不生效） */
  defaultCollapsed?: boolean;
}

export function ToolActivityList({ activities, animate = false, defaultCollapsed = false }: ToolActivityListProps): React.ReactElement | null {
  const [detailsId, setDetailsId] = React.useState<string | null>(null);
  const [expanded, setExpanded] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);

  // 折叠摘要态：streaming 时始终展开；有错误时默认展开（方便排查）
  const [isGroupCollapsed, setIsGroupCollapsed] = React.useState(() => {
    if (animate || !defaultCollapsed) return false;
    return !activities.some((a) => a.isError);
  });

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
  const handleToggleDetails = (activity: ToolActivity): void => {
    setDetailsId((prev) => (prev === activity.toolUseId ? null : activity.toolUseId));
  };

  const isCollapsed = !animate && needsCollapse && !expanded;
  const showSummaryBar = defaultCollapsed && !animate;
  const hasError = normalizedActivities.some((a) => a.isError);

  return (
    <div className="w-full">
      {/* 摘要栏：仅在 defaultCollapsed 模式下显示 */}
      {showSummaryBar ? (
        <ActivitySummaryBar
          activities={normalizedActivities}
          isExpanded={!isGroupCollapsed}
          hasError={hasError}
          onToggle={() => setIsGroupCollapsed((v) => !v)}
        />
      ) : null}

      {/* 动画容器：grid 0fr↔1fr 实现丝滑高度过渡 */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] ease-in-out",
          showSummaryBar ? "duration-300" : "duration-0",
          !isGroupCollapsed ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div
          className={cn(
            "overflow-hidden transition-opacity ease-in-out",
            showSummaryBar ? "duration-200" : "duration-0",
            !isGroupCollapsed ? "opacity-100" : "opacity-0"
          )}
        >
          {/* 内容区加少量内边距，防止顶部被裁切 */}
          <div className={cn(showSummaryBar && "pt-0.5 pb-0.5")}>
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
                      onToggleDetails={handleToggleDetails}
                      detailsId={detailsId}
                      onCloseDetails={() => setDetailsId(null)}
                    />
                  );
                }

                const activity = item as ToolActivity;

                return (
                  <React.Fragment key={activity.toolUseId}>
                    <ActivityRow
                      activity={activity}
                      index={index}
                      animate={animate}
                      expanded={detailsId === activity.toolUseId}
                      onToggleDetails={handleToggleDetails}
                    />
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
        </div>
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
