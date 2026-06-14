import { useState } from "react"
import type { RoutineEntry, PredefinedRoutineActivity, RoutineEntryStatus } from "@lume/shared"
import {
  BookOpen,
  BookMarked,
  Brain,
  RefreshCw,
  Sun,
  CalendarDays,
  ListTodo,
  Sparkles,
  Briefcase,
  Loader2,
  Check,
  AlertCircle,
  Minus,
  ChevronDown,
  ChevronUp,
  Info,
} from "lucide-react"
import { cn } from "../../lib/utils"

const ACTIVITY_CONFIG: Record<PredefinedRoutineActivity, { label: string; icon: typeof BookOpen; color: string; tooltip: string }> = {
  reading_note: { label: "读书笔记", icon: BookMarked, color: "#9a7444", tooltip: "为在读的书籍自动生成读书笔记，基于已读内容总结要点和感悟" },
  reading_progress: { label: "读书进度", icon: BookOpen, color: "#7c6c3f", tooltip: "自动推进在读书籍的阅读进度，读完后自动标记为已读完" },
  memory_organize: { label: "记忆整理", icon: Brain, color: "#6b5ce7", tooltip: "回顾近期对话，提取关键事实和偏好，去重后写入长期记忆" },
  data_sync: { label: "数据同步", icon: RefreshCw, color: "#3b82f6", tooltip: "同步微信读书书架、更新阅读进度、刷新划线和书签数据" },
  daily_summary: { label: "每日总结", icon: Sun, color: "#f59e0b", tooltip: "汇总今日所有活动结果，生成简短的每日回顾" },
  weekly_summary: { label: "每周总结", icon: CalendarDays, color: "#8b5cf6", tooltip: "汇总本周读书进度、笔记数量、记忆增长和待办完成情况" },
  todo_review: { label: "待办提醒", icon: ListTodo, color: "#ef4444", tooltip: "检查对话中提取的待办事项，按优先级排序并生成提醒" },
  interest_digest: { label: "兴趣资讯", icon: Sparkles, color: "#ec4899", tooltip: "根据你配置的兴趣标签搜索聚合资讯，筛选 3-5 条推荐" },
  work_overview: { label: "工作概览", icon: Briefcase, color: "#10b981", tooltip: "检查近期代码提交和项目状态，生成简要工作日报" },
}

const STATUS_CONFIG: Record<RoutineEntryStatus, { label: string; dotClass: string; icon?: typeof Loader2; iconClass?: string }> = {
  pending: { label: "待执行", dotClass: "bg-[var(--text-3)]/40" },
  running: { label: "执行中", dotClass: "bg-blue-500", icon: Loader2, iconClass: "animate-spin text-blue-500" },
  completed: { label: "已完成", dotClass: "bg-emerald-500" },
  skipped: { label: "已跳过", dotClass: "bg-[var(--text-3)]/30" },
  failed: { label: "失败", dotClass: "bg-red-400" },
}

interface RoutineEntryItemProps {
  entry: RoutineEntry
  onTrigger?: (entryId: string) => void
  onViewResult?: (entry: RoutineEntry) => void
}

export function RoutineEntryItem({ entry, onTrigger, onViewResult }: RoutineEntryItemProps) {
  const [expanded, setExpanded] = useState(false)
  const time = new Date(entry.scheduledAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })
  const config = ACTIVITY_CONFIG[entry.activity as PredefinedRoutineActivity]
  const label = config?.label ?? entry.customName ?? entry.activity
  const Icon = config?.icon ?? Sun
  const iconColor = config?.color ?? "#9a7444"
  const tooltipText = config?.tooltip
  const statusConfig = STATUS_CONFIG[entry.status]
  const isClickable = entry.status === "failed" || (entry.status === "completed" && entry.result?.summary)
  const hasResult = entry.result?.summary

  return (
    <div className="group relative flex gap-3">
      {/* Timeline connector */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
            entry.status === "completed" && "border-emerald-500/30 bg-emerald-500/10",
            entry.status === "running" && "border-blue-500/30 bg-blue-500/10",
            entry.status === "failed" && "border-red-400/30 bg-red-400/10",
            entry.status === "pending" && "border-[var(--reading-border)] bg-[var(--reading-card)]",
            entry.status === "skipped" && "border-[var(--reading-border)]/50 bg-[var(--surface-2)]",
          )}
        >
          {statusConfig.icon ? (
            <statusConfig.icon size={15} className={statusConfig.iconClass} />
          ) : entry.status === "completed" ? (
            <Check size={15} className="text-emerald-500" />
          ) : entry.status === "failed" ? (
            <AlertCircle size={15} className="text-red-400" />
          ) : entry.status === "skipped" ? (
            <Minus size={15} className="text-[var(--text-3)]" />
          ) : (
            <Icon size={15} style={{ color: iconColor }} />
          )}
        </div>
        <div className="w-px flex-1 bg-[var(--reading-border)]" />
      </div>

      {/* Content card */}
      <div
        className={cn(
          "mb-3 flex-1 rounded-[10px] border bg-[var(--reading-card)] px-4 py-3 transition-all",
          entry.status === "completed" && "border-emerald-500/15",
          entry.status === "running" && "border-blue-500/20 shadow-[0_0_0_1px_rgba(59,130,246,0.08)]",
          entry.status === "failed" && "border-red-400/20",
          entry.status === "pending" && "border-[var(--reading-border)]",
          entry.status === "skipped" && "border-[var(--reading-border)]/40 opacity-50",
          isClickable && "cursor-pointer hover:border-[var(--reading-accent)]/40 hover:shadow-[0_2px_12px_-4px_rgba(154,116,68,0.12)]",
        )}
        onClick={() => {
          if (!isClickable) return
          if (entry.status === "completed" && entry.result?.summary) {
            onViewResult?.(entry)
          } else {
            onTrigger?.(entry.id)
          }
        }}
      >
        {/* Header row */}
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "shrink-0 rounded-[5px] p-1",
              entry.status === "completed" && "bg-emerald-500/10",
              entry.status === "running" && "bg-blue-500/10",
              entry.status === "failed" && "bg-red-400/10",
              entry.status === "pending" && "bg-[var(--reading-soft)]",
            )}
          >
            <Icon size={13} style={{ color: entry.status === "completed" ? "#10b981" : entry.status === "running" ? "#3b82f6" : iconColor }} />
          </span>
          <span className="text-[13px] font-medium text-[var(--text-1)]">{label}</span>
          <span className="text-[11px] text-[var(--text-3)]">{time}</span>
          {tooltipText && (
            <span className="routine-tooltip-wrapper relative shrink-0">
              <Info
                size={12}
                className="text-[var(--text-3)] opacity-0 transition-opacity group-hover:opacity-100"
              />
              <span className="routine-tooltip">
                {tooltipText}
              </span>
            </span>
          )}
          {entry.status === "running" && (
            <span className="ml-auto rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-500">执行中</span>
          )}
          {entry.status === "pending" && (
            <span className="ml-auto rounded-full bg-[var(--reading-soft)] px-2 py-0.5 text-[10px] text-[var(--text-3)]">待执行</span>
          )}
          {entry.status === "failed" && (
            <span className="ml-auto rounded-full bg-red-400/10 px-2 py-0.5 text-[10px] font-medium text-red-400">点击重试</span>
          )}
          {entry.status === "completed" && entry.result?.summary && (
            <span className="ml-auto rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">查看结果</span>
          )}
        </div>

        {/* Description */}
        {entry.description && (
          <p className="mt-1.5 pl-7 text-[12px] leading-5 text-[var(--text-3)]">{entry.description}</p>
        )}

        {/* Expandable result */}
        {hasResult && (
          <div className="mt-2 pl-7">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}
              className="flex items-center gap-1 text-[11px] text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]"
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? "收起结果" : "查看结果"}
            </button>
            {expanded && (
              <div className="mt-2 max-h-[200px] overflow-y-auto whitespace-pre-wrap rounded-xl border bg-[var(--reading-panel)] px-4 py-3 text-[13px] leading-6 text-[var(--text-2)]">
                {entry.result!.summary}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
