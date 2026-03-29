"use client";

import * as React from "react";
import {
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  Circle,
  Clock,
  Code2,
  FilePenLine,
  FileText,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Globe,
  ListTodo,
  Loader2,
  Pencil,
  Search,
  Terminal,
  Timer,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import {
  Tool,
  ToolCodeBlock,
  ToolContent,
  ToolFooter,
  ToolHeader,
  ToolSection,
} from "@/components/ai-elements/tool";
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
  staggerLimit: 10,
  autoScrollThreshold: 6,
  cardHeight: 88,
} as const;

/** 工具名 → 图标映射（key 统一小写，getToolIcon 做大小写不敏感查找） */
const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  // 文件操作
  read: FileText,
  write: FilePenLine,
  edit: Pencil,
  multiedit: Pencil,
  // 搜索与目录
  find: FolderSearch,
  grep: Search,
  ls: FolderOpen,
  // 终端
  bash: Terminal,
  // 控制工具
  askuserquestion: Bot,
  todowrite: ListTodo,
  // 子任务 / Agent
  task: GitBranch,
  skill: Zap,
  // 记忆工具
  memory_search: BookOpen,
  memory_get: BookOpen,
  memory_save: BookOpen,
  // 网络工具
  web_search: Globe,
  web_fetch: Globe,
  // 自动化定时
  cron_read: Timer,
  cron_set: Timer,
  cron_query: Timer,
  // LSP / MCP
  lsp: Code2,
  mcpsearch: Search,
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
  return TOOL_ICONS[toolName.toLowerCase()] ?? Wrench;
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

function formatElapsed(value: number, unit: "ms" | "s" = "s"): string {
  if (unit === "ms") {
    if (value < 1000) return `${Math.round(value)} ms`;
    const seconds = value / 1000;
    if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m${s}s`;
  }
  if (value > 0 && value < 1) return `${Math.round(value * 1000)} ms`;
  if (value < 60) return `${Math.round(value)}s`;
  const m = Math.floor(value / 60);
  const s = Math.round(value % 60);
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

function truncateActivityResult(result: string | undefined): string | null {
  if (!result) return null;
  return result.length > 2000 ? `${result.slice(0, 2000)}\n… [截断，共 ${result.length} 字符]` : result;
}

function ToolCard({
  activity,
  index = 0,
  animate = false,
}: {
  activity: ToolActivity;
  index?: number;
  animate?: boolean;
}): React.ReactElement {
  const status = getActivityStatus(activity);
  const ToolIcon = getToolIcon(activity.toolName);
  const filePath = extractFilePath(activity.input);
  const diffStats = computeDiffStats(activity.toolName, activity.input);
  const inputSummary = getInputSummary(activity.toolName, activity.input);
  const intent = activity.intent ?? activity.displayName;
  const delay = animate && index < SIZE.staggerLimit ? `${index * 30}ms` : "0ms";
  const hasDetails = Object.keys(activity.input).length > 0 || !!activity.result;
  const isBash = activity.toolName.toLowerCase() === "bash";
  const truncatedResult = truncateActivityResult(activity.result);
  const [isExpanded, setIsExpanded] = React.useState(false);

  const resultSummary = status === "completed" && activity.result
    ? getResultSummary(activity.toolName, activity.result)
    : null;
  const errorSummary = status === "error" && activity.result
    ? getErrorSummary(activity.result)
    : null;

  const summaryText = React.useMemo(() => {
    if (isBash && inputSummary) return inputSummary;
    if (intent && inputSummary) return `${intent} · ${inputSummary}`;
    return intent ?? inputSummary ?? activity.toolName;
  }, [activity.toolName, inputSummary, intent, isBash]);
  const elapsedLabel = activity.elapsedMs !== undefined && activity.elapsedMs > 0
    ? formatElapsed(activity.elapsedMs, "ms")
    : activity.elapsedSeconds !== undefined && activity.elapsedSeconds > 0
      ? formatElapsed(activity.elapsedSeconds)
      : null;

  const detailLabel = activity.isError ? "ERROR" : isBash ? "OUTPUT" : "RESULT";
  const detailText = truncatedResult;

  return (
    <Tool
      open={hasDetails ? isExpanded : false}
      onOpenChange={hasDetails ? setIsExpanded : undefined}
      className={cn(
        animate && "animate-in fade-in slide-in-from-left-2 duration-200 fill-mode-both",
      )}
      style={animate ? { animationDelay: delay } : undefined}
    >
      <ToolHeader
        disabled={!hasDetails}
        aria-expanded={hasDetails ? isExpanded : undefined}
        summary={
          <span className={cn(
            "truncate text-[15px] leading-none text-[#cfd5df]",
            isBash ? "font-mono" : "font-medium"
          )}>
            {summaryText}

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

            {status === "backgrounded" ? (
              <span className="ml-2 inline-flex items-center gap-1 align-middle">
                <span className="size-[3px] rounded-full bg-primary/70 animate-pulse" />
                <span className="text-[10px] text-primary/70">后台</span>
              </span>
            ) : null}

            {resultSummary ? (
              <span className="ml-1.5 text-foreground/40">· {resultSummary}</span>
            ) : null}

            {errorSummary ? (
              <span className="ml-1.5 text-destructive/70">{errorSummary}</span>
            ) : null}
          </span>
        }
        icon={(
          <span className="flex size-5 items-center justify-center rounded-md border border-white/10 bg-black/10 text-[#c7ced8]">
            <ToolIcon className="size-3.5" />
          </span>
        )}
        meta={
          <>
            {filePath ? <FileBadge path={filePath} /> : null}
            {diffStats ? <DiffBadges stats={diffStats} /> : null}
          </>
        }
        status={<StatusIcon status={status} toolName={activity.toolName} />}
        trailing={
          <>
            {elapsedLabel ? (
              <span className="flex items-center gap-1 text-[11px] tabular-nums text-[#aab3bf]">
                <Clock className="size-2.5" />
                {elapsedLabel}
              </span>
            ) : null}

            {hasDetails ? (
              <ChevronDown
                className={cn(
                  "size-3.5 text-muted-foreground/50 transition-transform duration-200",
                  isExpanded && "rotate-180"
                )}
              />
            ) : null}
          </>
        }
        className={cn(
          hasDetails
            ? "cursor-pointer transition-colors duration-100 hover:bg-muted/20"
            : "cursor-default"
        )}
      />

      <ToolContent>
        <div className="space-y-2 border-t border-border/40 px-3 py-3">
            {isBash ? (
              Object.keys(activity.input).length > 0 ? (
                <ToolSection label="COMMAND">
                  <ToolCodeBlock tone="success">
                    {typeof activity.input.command === "string" ? activity.input.command : formatInput(activity.input)}
                  </ToolCodeBlock>
                </ToolSection>
              ) : null
            ) : Object.keys(activity.input).length > 0 ? (
              <ToolSection label="ARGUMENTS">
                <ToolCodeBlock className="bg-muted/30">
                  {formatInputAsFnCall(activity.input)}
                </ToolCodeBlock>
              </ToolSection>
            ) : null}

            {detailText ? (
              <ToolSection label={detailLabel} tone={activity.isError ? "error" : "default"}>
                <ToolCodeBlock tone={activity.isError ? "error" : "default"}>
                  {detailText}
                </ToolCodeBlock>
              </ToolSection>
            ) : null}

            <ToolFooter>
              <span>Call ID: {activity.toolUseId}</span>
              {elapsedLabel ? (
                <span>Duration: {elapsedLabel}</span>
              ) : null}
            </ToolFooter>
        </div>
      </ToolContent>
    </Tool>
  );
}

function ActivityGroupRow({
  group,
  index = 0,
  animate = false,
}: {
  group: ActivityGroup;
  index?: number;
  animate?: boolean;
}): React.ReactElement {
  const { parent, children } = group;

  return (
    <div className="space-y-2">
      <ToolCard activity={parent} index={index} animate={animate} />
      {children.length > 0 ? (
        <div className="ml-4 border-l border-border/40 pl-4">
          <div className="space-y-2">
            {children.map((child, idx) => (
              <ToolCard key={child.toolUseId} activity={child} index={idx} animate={animate} />
            ))}
          </div>
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

  return (
    <div className="w-full max-w-[620px]">
      <div
        ref={listRef}
        className={cn(
          "space-y-2 custom-scrollbar",
          animate && needsCollapse && "overflow-y-auto"
        )}
        style={animate && needsCollapse ? { maxHeight: SIZE.autoScrollThreshold * SIZE.cardHeight } : undefined}
      >
        {grouped.map((item, index) => {
          if (isActivityGroup(item)) {
            return (
              <ActivityGroupRow
                key={item.parent.toolUseId}
                group={item}
                index={index}
                animate={animate}
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
