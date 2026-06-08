import { useCallback, useEffect, useState } from "react"
import type { DailyRoutine } from "@lume/shared"
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

  if (loading) {
    return <div className="p-6 text-[13px] text-[var(--text-3)]">加载日程中...</div>
  }

  if (!routine) {
    return <div className="p-6 text-[13px] text-[var(--text-3)]">今日暂无日程</div>
  }

  const pending = routine.entries.filter((e) => e.status === "pending")
  const done = routine.entries.filter((e) => e.status !== "pending")

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-[16px] font-semibold">📅 今日日程</h2>
        <span className="text-[12px] text-[var(--text-3)]">
          {routine.date} {done.length}/{routine.entries.length} 已完成
        </span>
      </div>

      {pending.length > 0 && (
        <div className="flex flex-col gap-1">
          {pending.map((entry) => (
            <RoutineEntryItem key={entry.id} entry={entry} onTrigger={handleTrigger} />
          ))}
        </div>
      )}

      {done.length > 0 && (
        <>
          <div className="border-t border-[var(--reading-border)]" />
          <div className="flex flex-col gap-1">
            {done.map((entry) => (
              <RoutineEntryItem key={entry.id} entry={entry} onTrigger={handleTrigger} />
            ))}
          </div>
        </>
      )}

      <div className="flex gap-2 pt-2">
        <button
          type="button"
          onClick={handleRegenerate}
          className="rounded-lg border border-[var(--reading-border)] px-3 py-1.5 text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]"
        >
          重新生成日程
        </button>
      </div>
    </div>
  )
}
