import * as React from "react";
import { CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Circle, ListTodo, Loader2, XCircle } from "lucide-react";
import type { ToolActivity } from "@/atoms";
import { cn } from "@/lib/utils";

export interface TaskProgressItem {
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "deleted";
  activeForm?: string;
}

export interface TaskAnnouncementItem {
  id: string;
  label: string;
  status: "completed" | "failed";
  outputText?: string;
  errorText?: string;
  childSessionId?: string;
}

const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskUpdate", "TodoWrite"]);
const AGENT_TASK_TOOL_NAMES = new Set(["task", "agent", "threads_spawn", "subagents_send", "subagents_steer", "subagents_kill"]);
const MAX_VISIBLE = 8;

export function aggregateTaskProgressItems(
  activities: ToolActivity[],
  streamEnded: boolean
): TaskProgressItem[] {
  const taskMap = new Map<string, TaskProgressItem>();
  let todoAutoId = 0;

  for (const activity of activities) {
    if (!TASK_TOOL_NAMES.has(activity.toolName)) continue;

    if (activity.toolName === "TodoWrite") {
      for (const key of taskMap.keys()) {
        if (key.startsWith("todo-")) {
          taskMap.delete(key);
        }
      }
      const todos = readTodosFromInput(activity.input);
      for (const todo of todos) {
        const id = `todo-${todoAutoId++}`;
        taskMap.set(id, {
          id,
          subject: todo.subject,
          status: todo.status,
          activeForm: todo.activeForm
        });
      }
      continue;
    }

    if (activity.toolName === "TaskCreate") {
      const taskId = resolveTaskCreateId(activity);
      taskMap.set(taskId, {
        id: taskId,
        subject: readTaskSubject(activity.input) ?? "未命名任务",
        status: "pending",
        activeForm: typeof activity.input.activeForm === "string" ? activity.input.activeForm : undefined
      });
      continue;
    }

    if (activity.toolName === "TaskUpdate") {
      const taskId = resolveTaskUpdateId(activity.input);
      if (!taskId) continue;
      const existing = taskMap.get(taskId);
      taskMap.set(taskId, {
        id: taskId,
        subject: readTaskSubject(activity.input) ?? existing?.subject ?? `任务 #${taskId}`,
        status: readTaskStatus(activity.input) ?? existing?.status ?? "pending",
        activeForm: typeof activity.input.activeForm === "string"
          ? activity.input.activeForm
          : existing?.activeForm
      });
    }
  }

  for (const activity of activities) {
    const normalizedName = activity.toolName.toLowerCase();
    if (!AGENT_TASK_TOOL_NAMES.has(normalizedName)) continue;

    const existing = taskMap.get(activity.toolUseId);
    const subject = readAgentTaskSubject(activity) ?? existing?.subject ?? "子任务";
    taskMap.set(activity.toolUseId, {
      id: activity.toolUseId,
      subject,
      status: resolveAgentTaskStatus(activity),
      activeForm: activity.progressDescription ?? existing?.activeForm ?? subject
    });
  }

  let items = Array.from(taskMap.values()).filter((item) => item.status !== "deleted");
  if (streamEnded) {
    items = items.map((item) => (
      item.status === "in_progress" ? { ...item, status: "pending" } : item
    ));
  }
  return items;
}

function readTodosFromInput(input: Record<string, unknown>): Array<{
  subject: string;
  status: TaskProgressItem["status"];
  activeForm?: string;
}> {
  if (!Array.isArray(input.todos)) return [];
  return input.todos
    .filter((todo): todo is Record<string, unknown> => typeof todo === "object" && todo !== null)
    .map((todo) => ({
      subject: String(todo.subject ?? todo.content ?? "").trim(),
      status: typeof todo.status === "string" ? todo.status as TaskProgressItem["status"] : "pending",
      activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined
    }))
    .filter((todo) => todo.subject.length > 0);
}

function readTaskSubject(input: Record<string, unknown>): string | null {
  if (typeof input.subject === "string" && input.subject.trim().length > 0) {
    return input.subject.trim();
  }
  if (typeof input.description === "string" && input.description.trim().length > 0) {
    return input.description.trim();
  }
  return null;
}

function readAgentTaskSubject(activity: ToolActivity): string | null {
  const input = activity.input;
  const candidates = [
    input.task,
    input.message,
    input.prompt,
    input.description,
    input.content,
    input.label,
    input.title
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  if (typeof activity.displayName === "string" && activity.displayName.trim().length > 0) {
    return activity.displayName.trim();
  }
  if (typeof activity.intent === "string" && activity.intent.trim().length > 0) {
    return activity.intent.trim();
  }
  return null;
}

function resolveAgentTaskStatus(activity: ToolActivity): TaskProgressItem["status"] {
  if (activity.isError) return "failed";
  if (activity.done) return "completed";
  return "in_progress";
}

function readTaskStatus(input: Record<string, unknown>): TaskProgressItem["status"] | null {
  if (typeof input.status !== "string") return null;
  if (input.status === "pending" || input.status === "in_progress" || input.status === "completed" || input.status === "deleted") {
    return input.status;
  }
  return null;
}

function resolveTaskCreateId(activity: ToolActivity): string {
  if (activity.result) {
    const match = activity.result.match(/Task\s*#(\d+)/i);
    if (match?.[1]) {
      return match[1];
    }
  }
  return activity.toolUseId;
}

function resolveTaskUpdateId(input: Record<string, unknown>): string | null {
  if (typeof input.taskId === "string" && input.taskId.trim().length > 0) {
    return input.taskId.trim();
  }
  if (typeof input.taskId === "number") {
    return String(input.taskId);
  }
  return null;
}

function TaskRow({ item }: { item: TaskProgressItem }): React.ReactElement {
  const isCompleted = item.status === "completed";
  const isInProgress = item.status === "in_progress";
  const isFailed = item.status === "failed";

  return (
    <div className={cn("flex items-center gap-2 py-[3px] text-[13px]", isCompleted && "opacity-55")}>
      <span className="flex size-3 items-center justify-center shrink-0">
        {item.status === "pending" ? <Circle className="size-2.5 text-muted-foreground/45" /> : null}
        {isInProgress ? <Loader2 className="size-2.5 animate-spin text-blue-500" /> : null}
        {isCompleted ? <CheckCircle2 className="size-2.5 text-green-500" /> : null}
        {isFailed ? <XCircle className="size-2.5 text-destructive" /> : null}
      </span>
      <span className={cn(
        "min-w-0 flex-1 truncate",
        isCompleted && "line-through text-muted-foreground",
        isFailed && "text-destructive"
      )}>
        {isInProgress && item.activeForm ? item.activeForm : item.subject}
      </span>
    </div>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }): React.ReactElement | null {
  if (total <= 1) return null;
  const percent = Math.max(0, Math.min(100, Math.round((completed / total) * 100)));
  return (
    <div className="mb-2 h-1 overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${percent}%` }} />
    </div>
  );
}

function AnnouncementRow({
  item,
  onOpenSession
}: {
  item: TaskAnnouncementItem;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement {
  const [expanded, setExpanded] = React.useState(false);
  const hasDetails = Boolean(item.outputText || item.errorText || (item.childSessionId && onOpenSession));

  return (
    <div className="rounded-md border border-border/50 bg-background/55">
      <button
        type="button"
        disabled={!hasDetails}
        onClick={() => hasDetails && setExpanded((prev) => !prev)}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2 text-left",
          hasDetails && "transition-colors hover:bg-muted/30",
          !hasDetails && "cursor-default"
        )}
      >
        {item.status === "completed" ? (
          <CheckCircle2 className="size-3.5 shrink-0 text-green-500" />
        ) : (
          <XCircle className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="min-w-0 flex-1 truncate text-[13px]">{item.label}</span>
        <span className={cn(
          "rounded px-1.5 py-0.5 text-[10px] font-medium",
          item.status === "completed" ? "bg-green-500/10 text-green-600" : "bg-destructive/10 text-destructive"
        )}>
          {item.status === "completed" ? "Completed" : "Failed"}
        </span>
        {hasDetails ? (
          <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-90")} />
        ) : null}
      </button>

      {expanded ? (
        <div className="space-y-2 border-t border-border/40 px-3 py-2.5">
          {item.outputText ? (
            <div className="rounded-md bg-muted/35 px-2.5 py-2 text-[11px] leading-relaxed text-foreground/80">
              {item.outputText}
            </div>
          ) : null}
          {item.errorText ? (
            <div className="rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
              <span className="font-medium">错误: </span>
              {item.errorText}
            </div>
          ) : null}
          {item.childSessionId && onOpenSession ? (
            <button
              type="button"
              onClick={() => onOpenSession(item.childSessionId!)}
              className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              查看子任务对话 →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function TaskProgressCard({
  activities,
  announcementItems = [],
  streamEnded = false,
  animate = false,
  onOpenSession
}: {
  activities: ToolActivity[];
  announcementItems?: TaskAnnouncementItem[];
  streamEnded?: boolean;
  animate?: boolean;
  onOpenSession?: (sessionId: string) => void;
}): React.ReactElement | null {
  const items = React.useMemo(
    () => aggregateTaskProgressItems(activities, streamEnded),
    [activities, streamEnded]
  );
  const [expanded, setExpanded] = React.useState(false);

  const hasAnnouncements = announcementItems.length > 0;
  const onlyAnnouncements = items.length === 0 && hasAnnouncements;
  if (items.length === 0 && !hasAnnouncements) return null;

  const completed = items.filter((item) => item.status === "completed").length;
  const needsCollapse = items.length > MAX_VISIBLE;
  const visibleItems = needsCollapse && !expanded ? items.slice(0, MAX_VISIBLE) : items;

  return (
    <div className={cn("my-2 max-w-[630px]", animate && "animate-in fade-in duration-200")}>
      <div className="rounded-lg border border-border/60 bg-muted/25 px-3.5 py-3">
        {!onlyAnnouncements ? (
          <div className="mb-1.5 flex items-center gap-1.5">
            <ListTodo className="size-3.5 text-muted-foreground" />
            <span className="text-[13px] font-medium text-foreground/75">任务进度</span>
            <span className="text-[11px] tabular-nums text-muted-foreground/60">{completed}/{items.length}</span>
          </div>
        ) : null}

        {!onlyAnnouncements ? <ProgressBar completed={completed} total={items.length} /> : null}

        <div className="space-y-0.5">
          {visibleItems.map((item) => <TaskRow key={item.id} item={item} />)}
          {announcementItems.map((item) => (
            <AnnouncementRow key={item.id} item={item} onOpenSession={onOpenSession} />
          ))}
        </div>

        {needsCollapse ? (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground/60 transition-colors hover:text-foreground/75"
          >
            {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
            <span>{expanded ? "收起" : `展开全部 ${items.length} 项`}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
