/**
 * 工具辅助工具集 — 图标映射、diff 统计、文件路径提取等
 *
 * 从 ToolActivityItem.tsx 提取的通用逻辑，供 ContentBlock 等组件复用。
 */
import type { ComponentType } from "react";
import {
  BookOpen,
  Bot,
  Code2,
  FilePenLine,
  FileText,
  FolderOpen,
  FolderSearch,
  GitBranch,
  Globe,
  ListTodo,
  Pencil,
  Search,
  Terminal,
  Timer,
  Wrench,
  Zap,
} from "lucide-react";

// ─── 图标映射 ───

const TOOL_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  // 文件操作
  read: FileText,
  write: FilePenLine,
  edit: Pencil,
  multiedit: Pencil,
  // 搜索与目录
  find: FolderSearch,
  grep: Search,
  ls: FolderOpen,
  glob: Search,
  // 终端
  bash: Terminal,
  // 控制工具
  askuserquestion: Bot,
  todowrite: ListTodo,
  taskcreate: ListTodo,
  taskupdate: ListTodo,
  // 子任务 / Agent
  task: GitBranch,
  agent: GitBranch,
  skill: Zap,
  // 记忆工具
  memory_search: BookOpen,
  memory_get: BookOpen,
  memory_save: BookOpen,
  // 网络工具
  web_search: Globe,
  web_fetch: Globe,
  webfetch: Globe,
  websearch: Globe,
  // 定时
  cron_read: Timer,
  cron_set: Timer,
  cron_query: Timer,
  // LSP / MCP
  lsp: Code2,
  mcpsearch: Search,
  // Session / subagent
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

/**
 * 获取工具图标组件
 */
export function getToolIcon(toolName: string): ComponentType<{ className?: string }> {
  return TOOL_ICONS[toolName.toLowerCase()] ?? Wrench;
}

// ─── Diff 统计 ───

export interface DiffStats {
  additions: number;
  deletions: number;
}

/**
 * 从 Edit 工具 input 中计算 diff 统计
 */
export function computeDiffStats(toolName: string, input: Record<string, unknown>): DiffStats | null {
  if (toolName === "Edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!oldStr && !newStr) return null;
    const oldLines = oldStr.split("\n").length;
    const newLines = newStr.split("\n").length;
    return {
      additions: Math.max(0, newLines - oldLines + 1),
      deletions: Math.max(0, oldLines - newLines + 1),
    };
  }
  return null;
}

// ─── 文件路径 ───

/**
 * 从工具 input 中提取文件路径
 */
export function extractFilePath(input: Record<string, unknown>): string | null {
  const fp = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
  return typeof fp === "string" ? fp : null;
}

/**
 * 取文件名（basename）
 */
export function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? path;
}

// ─── Input / Result 摘要 ───

/**
 * 获取工具 input 的简短摘要
 */
export function getInputSummary(toolName: string, input: Record<string, unknown>): string | null {
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

/**
 * 已完成工具调用的简短结果摘要
 */
export function getResultSummary(toolName: string, result: string): string | null {
  if (!result || !result.trim()) return null;
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

// ─── 耗时格式化 ───

/**
 * 格式化耗时
 */
export function formatElapsed(value: number, unit: "ms" | "s" = "s"): string {
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
