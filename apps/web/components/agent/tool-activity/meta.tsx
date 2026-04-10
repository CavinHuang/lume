import {
  BookOpen,
  Bot,
  CheckCircle2,
  Circle,
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
import { cn } from "@/lib/utils";
import type { ToolActivity } from "@/atoms";
import type * as React from "react";

export type ActivityStatus = "pending" | "running" | "backgrounded" | "completed" | "error";
export type ToolVisualCategory = "file" | "search" | "terminal" | "network" | "memory" | "agent" | "planner" | "default";

export type ToolVisualMeta = {
  category: ToolVisualCategory;
  label: string;
  iconWrapClassName: string;
  iconClassName: string;
  runningDotClassName: string;
};

const TOOL_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read: FileText,
  write: FilePenLine,
  edit: Pencil,
  multiedit: Pencil,
  find: FolderSearch,
  grep: Search,
  ls: FolderOpen,
  bash: Terminal,
  askuserquestion: Bot,
  todowrite: ListTodo,
  task: GitBranch,
  skill: Zap,
  memory_search: BookOpen,
  memory_get: BookOpen,
  memory_save: BookOpen,
  web_search: Globe,
  web_fetch: Globe,
  cron_read: Timer,
  cron_set: Timer,
  cron_query: Timer,
  lsp: Code2,
  mcpsearch: Search,
  threads_spawn: GitBranch,
  agents_list: Bot,
  threads_list: Bot,
  threads_history: Bot,
  threads_send: Bot,
  threads_delete: Bot,
  threads_delete_all: Bot,
  thread_status: Bot,
  subagents_list: Bot,
  subagents_kill: Bot,
  subagents_send: Bot,
  subagents_steer: Bot,
};

export function getToolIcon(toolName: string): React.ComponentType<{ className?: string }> {
  return TOOL_ICONS[toolName.toLowerCase()] ?? Wrench;
}

export function getActivityStatus(activity: ToolActivity): ActivityStatus {
  if (activity.isError) return "error";
  if (activity.done) return "completed";
  if (activity.isBackground) return "backgrounded";
  if (activity.result || Object.keys(activity.input).length > 0) return "running";
  return "pending";
}

export function resolveToolVisualMeta(toolName: string): ToolVisualMeta {
  const name = toolName.toLowerCase();
  const byCategory: Record<ToolVisualCategory, ToolVisualMeta> = {
    file: {
      category: "file",
      label: "文件",
      iconWrapClassName: "border-emerald-300/20 bg-emerald-500/8 text-emerald-200",
      iconClassName: "text-emerald-200",
      runningDotClassName: "bg-emerald-300/90",
    },
    search: {
      category: "search",
      label: "搜索",
      iconWrapClassName: "border-cyan-300/20 bg-cyan-500/8 text-cyan-200",
      iconClassName: "text-cyan-200",
      runningDotClassName: "bg-cyan-300/90",
    },
    terminal: {
      category: "terminal",
      label: "终端",
      iconWrapClassName: "border-amber-300/20 bg-amber-500/8 text-amber-200",
      iconClassName: "text-amber-200",
      runningDotClassName: "bg-amber-300/90",
    },
    network: {
      category: "network",
      label: "网络",
      iconWrapClassName: "border-sky-300/20 bg-sky-500/8 text-sky-200",
      iconClassName: "text-sky-200",
      runningDotClassName: "bg-sky-300/90",
    },
    memory: {
      category: "memory",
      label: "记忆",
      iconWrapClassName: "border-violet-300/20 bg-violet-500/8 text-violet-200",
      iconClassName: "text-violet-200",
      runningDotClassName: "bg-violet-300/90",
    },
    agent: {
      category: "agent",
      label: "Agent",
      iconWrapClassName: "border-fuchsia-300/20 bg-fuchsia-500/8 text-fuchsia-200",
      iconClassName: "text-fuchsia-200",
      runningDotClassName: "bg-fuchsia-300/90",
    },
    planner: {
      category: "planner",
      label: "计划",
      iconWrapClassName: "border-indigo-300/20 bg-indigo-500/8 text-indigo-200",
      iconClassName: "text-indigo-200",
      runningDotClassName: "bg-indigo-300/90",
    },
    default: {
      category: "default",
      label: "工具",
      iconWrapClassName: "border-white/10 bg-black/10 text-[#c7ced8]",
      iconClassName: "text-[#c7ced8]",
      runningDotClassName: "bg-blue-400/80",
    },
  };

  const category: ToolVisualCategory =
    ["read", "write", "edit", "multiedit"].includes(name) ? "file"
      : ["find", "grep", "glob", "ls", "mcpsearch", "lsp"].includes(name) ? "search"
        : ["bash"].includes(name) ? "terminal"
          : ["web_search", "web_fetch"].includes(name) ? "network"
            : ["memory_search", "memory_get", "memory_save"].includes(name) ? "memory"
              : ["task", "skill", "threads_spawn", "agents_list", "threads_list", "threads_history", "threads_send", "threads_delete", "threads_delete_all", "thread_status", "subagents_list", "subagents_kill", "subagents_send", "subagents_steer"].includes(name) ? "agent"
                : ["todowrite", "taskcreate", "taskupdate", "cron_read", "cron_set", "cron_query", "askuserquestion"].includes(name) ? "planner"
                  : "default";

  return byCategory[category];
}

export function StatusIcon({ status, toolName }: { status: ActivityStatus; toolName?: string }): React.ReactElement {
  const key = `${status}-${toolName}`;
  if (status === "running" || status === "backgrounded") {
    return (
      <span key={key} className={cn("size-3 flex items-center justify-center animate-in fade-in zoom-in-75 duration-200")}>
        <Loader2 className={cn("size-2.5 animate-spin", status === "backgrounded" ? "text-primary" : "text-blue-500")} />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span key={key} className={cn("size-3 flex items-center justify-center animate-in fade-in zoom-in-75 duration-200")}>
        <XCircle className={cn("size-3 text-destructive")} />
      </span>
    );
  }
  if (status === "completed") {
    const ToolIcon = toolName ? getToolIcon(toolName) : null;
    if (ToolIcon && (toolName === "Edit" || toolName === "Write")) {
      return (
        <span key={key} className={cn("size-3 flex items-center justify-center animate-in fade-in zoom-in-75 duration-200")}>
          <ToolIcon className={cn("size-3 text-primary")} />
        </span>
      );
    }
    return (
      <span key={key} className={cn("size-3 flex items-center justify-center animate-in fade-in zoom-in-75 duration-200")}>
        <CheckCircle2 className={cn("size-3 text-green-500")} />
      </span>
    );
  }
  return (
    <span key={key} className={cn("size-3 flex items-center justify-center")}>
      <Circle className={cn("size-3 text-muted-foreground/50")} />
    </span>
  );
}
