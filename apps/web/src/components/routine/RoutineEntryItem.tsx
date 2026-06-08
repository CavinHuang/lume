import type { RoutineEntry, RoutineActivity } from "@lume/shared"
import { cn } from "../../lib/utils"

const ACTIVITY_LABELS: Record<RoutineActivity, string> = {
  reading_note: "读书笔记",
  reading_progress: "读书进度",
  memory_organize: "记忆整理",
  data_sync: "数据同步",
  daily_summary: "每日总结",
  weekly_summary: "每周总结",
  todo_review: "待办提醒",
  interest_digest: "兴趣资讯",
  work_overview: "工作概览",
}

interface RoutineEntryItemProps {
  entry: RoutineEntry
  onTrigger?: (entryId: string) => void
}

export function RoutineEntryItem({ entry, onTrigger }: RoutineEntryItemProps) {
  const time = new Date(entry.scheduledAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })
  const label = ACTIVITY_LABELS[entry.activity] ?? entry.activity
  const isClickable = entry.status === "pending" || entry.status === "failed"

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-colors",
        entry.status === "completed" && "text-[var(--text-3)]",
        entry.status === "skipped" && "text-[var(--text-3)] line-through",
        entry.status === "running" && "text-blue-500",
        entry.status === "failed" && "text-red-400",
        isClickable && "cursor-pointer hover:bg-[var(--surface-2)]",
      )}
      onClick={() => isClickable && onTrigger?.(entry.id)}
    >
      <span className="w-5 text-center">
        {entry.status === "pending" && "☐"}
        {entry.status === "running" && <span className="inline-block animate-spin">⟳</span>}
        {entry.status === "completed" && "✅"}
        {entry.status === "skipped" && "—"}
        {entry.status === "failed" && "❌"}
      </span>
      <span className="text-[var(--text-3)]">{time}</span>
      <span className="flex-1">{label}</span>
      {entry.result && (
        <span className="max-w-[200px] truncate text-[11px] text-[var(--text-3)]">{entry.result.summary}</span>
      )}
    </div>
  )
}
