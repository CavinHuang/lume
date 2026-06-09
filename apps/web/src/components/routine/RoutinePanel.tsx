import { useCallback, useEffect, useMemo, useState } from "react"
import type { DailyRoutine } from "@lume/shared"
import {
  CalendarDays,
  RefreshCw,
  BookOpen,
  ListTodo,
  Brain,
  Clock,
} from "lucide-react"
import { getRoutineToday, triggerRoutineEntry, regenerateRoutine } from "../../lib/desktop-api/routine"
import { RoutineEntryItem } from "./RoutineEntryItem"

export function RoutinePanel() {
  const [routine, setRoutine] = useState<DailyRoutine | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const result = await getRoutineToday()
      setRoutine(result)
    } catch (error) {
      console.error("[RoutinePanel] 加载失败:", error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  const handleTrigger = useCallback(async (entryId: string) => {
    try {
      const result = await triggerRoutineEntry(entryId)
      setRoutine(result)
    } catch (error) {
      console.error("[RoutinePanel] 触发失败:", error)
    }
  }, [])

  const handleRegenerate = useCallback(async () => {
    setLoading(true)
    try {
      const result = await regenerateRoutine()
      setRoutine(result)
    } catch (error) {
      console.error("[RoutinePanel] 重新生成失败:", error)
    } finally {
      setLoading(false)
    }
  }, [])

  const { pending, done, completedCount, totalCount, progressPercent } = useMemo(() => {
    if (!routine) return { pending: [], done: [], completedCount: 0, totalCount: 0, progressPercent: 0 }
    const pending = routine.entries.filter((e) => e.status === "pending")
    const done = routine.entries.filter((e) => e.status !== "pending")
    const completedCount = routine.entries.filter((e) => e.status === "completed").length
    const totalCount = routine.entries.length
    const progressPercent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
    return { pending, done, completedCount, totalCount, progressPercent }
  }, [routine])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-[13px] text-[var(--text-3)]">
        <RefreshCw size={16} className="mr-2 animate-spin" />
        正在加载日程...
      </div>
    )
  }

  if (!routine) {
    return (
      <EmptyState onRegenerate={handleRegenerate} />
    )
  }

  const dateLabel = formatDateLabel(routine.date)
  const dayLabel = formatDayLabel(routine.date)

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <CalendarDays size={18} className="text-[var(--reading-accent)]" />
            <h2 className="text-[18px] font-semibold text-[var(--text-1)]">今日日程</h2>
          </div>
          <p className="mt-1 text-[13px] text-[var(--text-3)]">{dateLabel} {dayLabel}</p>
        </div>

        {/* Progress ring */}
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-[20px] font-semibold tabular-nums text-[var(--reading-accent)]">
              {completedCount}<span className="text-[13px] font-normal text-[var(--text-3)]">/{totalCount}</span>
            </div>
            <div className="text-[11px] text-[var(--text-3)]">已完成</div>
          </div>
          <ProgressRing percent={progressPercent} size={44} />
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--reading-soft)]">
          <div
            className="h-full rounded-full bg-[var(--reading-accent)] transition-all duration-500"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-[var(--text-3)]">{progressPercent}%</span>
      </div>

      {/* Context summary */}
      <div className="flex flex-wrap gap-2">
        <ContextBadge icon={<BookOpen size={12} />} label={`${routine.context.activeBooks} 本在读`} active={routine.context.activeBooks > 0} />
        <ContextBadge icon={<ListTodo size={12} />} label={`${routine.context.unfinishedTodos} 项待办`} active={routine.context.unfinishedTodos > 0} />
        <ContextBadge icon={<Brain size={12} />} label={`${routine.context.pendingMemories} 条记忆`} active={routine.context.pendingMemories > 0} />
      </div>

      {/* Timeline entries */}
      {pending.length > 0 && (
        <section>
          <div className="mb-3 flex items-center gap-2 text-[13px] font-medium text-[var(--text-2)]">
            <Clock size={13} className="text-[var(--text-3)]" />
            待执行 · {pending.length} 项
          </div>
          {pending.map((entry) => (
            <RoutineEntryItem key={entry.id} entry={entry} onTrigger={handleTrigger} />
          ))}
        </section>
      )}

      {done.length > 0 && (
        <section>
          <div className="mb-3 text-[13px] font-medium text-[var(--text-3)]">
            已完成 · {completedCount} 项
          </div>
          {done.map((entry) => (
            <RoutineEntryItem key={entry.id} entry={entry} onTrigger={handleTrigger} />
          ))}
        </section>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between border-t border-[var(--reading-border)] pt-4">
        <div className="text-[12px] text-[var(--text-3)]">
          {routine.generationSource === "llm" ? "AI 生成" : "规则生成"}
          {routine.context.recentNotes !== undefined && ` · 本周 ${routine.context.recentNotes} 篇笔记`}
        </div>
        <button
          type="button"
          onClick={handleRegenerate}
          className="flex items-center gap-1.5 rounded-[8px] border border-[var(--reading-border)] bg-[var(--reading-card)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-2)] transition-colors hover:border-[var(--reading-accent)]/30 hover:text-[var(--reading-accent)]"
        >
          <RefreshCw size={12} />
          重新生成
        </button>
      </div>
    </div>
  )
}

function ProgressRing({ percent, size }: { percent: number; size: number }) {
  const strokeWidth = 3
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (percent / 100) * circumference
  const center = size / 2

  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="var(--reading-soft)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke="var(--reading-accent)"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-all duration-500"
      />
    </svg>
  )
}

function ContextBadge({ icon, label, active }: { icon: React.ReactNode; label: string; active: boolean }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
      style={{
        borderColor: active ? "var(--reading-accent)/20" : "var(--reading-border)",
        color: active ? "var(--reading-accent)" : "var(--text-3)",
        backgroundColor: active ? "var(--reading-accent)/5" : "transparent",
      }}
    >
      {icon}
      {label}
    </div>
  )
}

function EmptyState({ onRegenerate }: { onRegenerate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <div className="flex size-16 items-center justify-center rounded-full bg-[var(--reading-soft)]">
        <CalendarDays size={28} className="text-[var(--reading-accent)]" />
      </div>
      <h3 className="mt-4 text-[15px] font-medium text-[var(--text-1)]">今日暂无日程</h3>
      <p className="mt-1.5 text-[13px] text-[var(--text-3)]">点击下方按钮生成今日日程</p>
      <button
        type="button"
        onClick={onRegenerate}
        className="mt-5 flex items-center gap-2 rounded-[8px] bg-[var(--reading-accent)] px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
      >
        <RefreshCw size={14} />
        生成今日日程
      </button>
    </div>
  )
}

function formatDateLabel(dateStr: string): string {
  const [, m, d] = dateStr.split("-").map(Number)
  return `${m}月${d}日`
}

function formatDayLabel(dateStr: string): string {
  const days = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
  const date = new Date(dateStr)
  return days[date.getDay()]
}
