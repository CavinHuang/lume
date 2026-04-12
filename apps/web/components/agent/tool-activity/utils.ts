import type { ToolActivity } from "@/atoms";

export interface DiffStats {
  additions: number;
  deletions: number;
}

export type ActivityGroup = {
  parent: ToolActivity;
  children: ToolActivity[];
};

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

export function extractFilePath(input: Record<string, unknown>): string | null {
  const fp = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
  return typeof fp === "string" ? fp : null;
}

export function computeDiffStats(toolName: string, input: Record<string, unknown>): DiffStats | null {
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

export function getInputSummary(toolName: string, input: Record<string, unknown>): string | null {
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "bash") {
    const cmd = input.command;
    if (typeof cmd !== "string") return null;
    const firstLine = cmd.split("\n")[0]?.trim() ?? "";
    if (firstLine.length <= 80) return firstLine;
    // Smart truncation: keep cmd name + tail of args (paths read better from the end)
    const spaceIdx = firstLine.indexOf(" ");
    if (spaceIdx === -1) return `${firstLine.slice(0, 80)}…`;
    const cmdPart = firstLine.slice(0, spaceIdx);
    const argsPart = firstLine.slice(spaceIdx + 1);
    const truncatedArgs = argsPart.length > 60 ? `…${argsPart.slice(-60)}` : argsPart;
    return `${cmdPart} ${truncatedArgs}`;
  }
  if (normalized === "grep") {
    const pattern = input.pattern;
    if (typeof pattern === "string") return `/${pattern}/`;
  }
  if (normalized === "glob") {
    const pattern = input.pattern;
    if (typeof pattern === "string") return pattern;
  }
  if (normalized === "webfetch" || normalized === "websearch" || normalized === "web_fetch" || normalized === "web_search") {
    const url = input.url ?? input.query;
    if (typeof url === "string") return url.length > 60 ? `${url.slice(0, 60)}…` : url;
  }
  if (normalized === "skill") {
    const skill = input.skill;
    if (typeof skill === "string") return skill;
  }
  return null;
}

export function getResultSummary(toolName: string, result: string): string | null {
  if (!result || !result.trim()) return null;
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "edit" || normalized === "write" || normalized === "multiedit") return null;
  const trimmed = result.trim();
  if (normalized === "bash") {
    const lines = trimmed.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;
    const first = lines[0]!;
    return first.length > 50 ? `${first.slice(0, 50)}…` : first;
  }
  if (normalized === "read") {
    const count = trimmed.split("\n").length;
    return `${count} 行`;
  }
  if (normalized === "grep") {
    const matches = trimmed.split("\n").filter((l) => l.trim()).length;
    return matches > 0 ? `${matches} 个匹配` : "无匹配";
  }
  if (normalized === "glob") {
    const files = trimmed.split("\n").filter((l) => l.trim()).length;
    return files > 0 ? `${files} 个文件` : "无结果";
  }
  if (normalized === "websearch" || normalized === "web_search") {
    try {
      const parsed = JSON.parse(trimmed) as { query?: unknown; results?: unknown[] };
      const query = typeof parsed.query === "string" ? parsed.query.trim() : "";
      const count = Array.isArray(parsed.results) ? parsed.results.length : 0;
      if (query) {
        return `${query}${count >= 0 ? ` · ${count} 条结果` : ""}`;
      }
    } catch {
      // ignore
    }
    const first = trimmed.split("\n")[0] ?? "";
    return first.length > 50 ? `${first.slice(0, 50)}…` : first || null;
  }
  if (normalized === "webfetch" || normalized === "web_fetch") {
    const first = trimmed.split("\n")[0] ?? "";
    return first.length > 50 ? `${first.slice(0, 50)}…` : first || null;
  }
  return null;
}

export function getErrorSummary(result: string): string | null {
  if (!result) return null;
  const first = result.trim().split("\n").find((l) => l.trim()) ?? "";
  return first.length > 60 ? `${first.slice(0, 60)}…` : first || null;
}

export function formatInput(input: Record<string, unknown>): string {
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

export function formatInputAsFnCall(input: Record<string, unknown>): string {
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

export function truncateActivityResult(result: string | undefined): string | null {
  if (!result) return null;
  return result.length > 2000 ? `${result.slice(0, 2000)}\n… [截断，共 ${result.length} 字符]` : result;
}

export function parseTodoItems(input: Record<string, unknown>): Array<{ content: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }> | null {
  if (input.todos && Array.isArray(input.todos)) {
    return (input.todos as Array<Record<string, unknown>>).map((todo) => ({
      content: String(todo.subject ?? todo.content ?? ""),
      status: (todo.status as "pending" | "in_progress" | "completed") ?? "pending",
      activeForm: typeof todo.activeForm === "string" ? todo.activeForm : undefined,
    }));
  }
  return null;
}

export function groupActivities(activities: ToolActivity[]): Array<ToolActivity | ActivityGroup> {
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

export function isActivityGroup(item: ToolActivity | ActivityGroup): item is ActivityGroup {
  return (item as ActivityGroup).parent !== undefined;
}
