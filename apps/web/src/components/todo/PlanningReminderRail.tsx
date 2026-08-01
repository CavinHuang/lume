import { Bell, Check, Clock3 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  acknowledgePlanningReminder,
  listActivePlanningReminders,
  onPlanningRemindersDue,
  onPlanningTodoChange,
  snoozePlanningReminder,
} from '@/lib/desktop-api'
import type { ActivePlanningReminder } from '@lume/shared'

export function PlanningReminderRail() {
  const [items, setItems] = useState<ActivePlanningReminder[]>([])
  const load = useCallback(() => {
    void listActivePlanningReminders()
      .then(setItems)
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    load()
    let active = true
    const disposers: Array<() => void> = []
    void onPlanningRemindersDue((next) =>
      setItems((current) => merge(current, next)),
    ).then((off) => {
      if (active) disposers.push(off)
      else off()
    })
    void onPlanningTodoChange((change) => {
      if (change.resources?.includes('reminders')) load()
    }).then((off) => {
      if (active) disposers.push(off)
      else off()
    })
    return () => {
      active = false
      for (const dispose of disposers) dispose()
    }
  }, [load])
  const acknowledge = async (id: string) => {
    try {
      await acknowledgePlanningReminder(id)
      setItems((current) => current.filter((item) => item.id !== id))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提醒处理失败')
    }
  }
  const snooze = async (id: string, minutes: number) => {
    try {
      await snoozePlanningReminder({ reminderId: id, minutes })
      setItems((current) => current.filter((item) => item.id !== id))
      toast.success(
        `已推迟 ${minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '稍后提醒失败')
    }
  }
  if (!items.length) return null
  return (
    <aside
      className="fixed right-4 top-14 z-[90] w-[min(360px,calc(100vw-2rem))] space-y-2"
      aria-label="到期提醒"
    >
      {items.slice(0, 3).map((item) => (
        <section
          key={item.id}
          className="rounded-xl border border-border/60 bg-popover p-3 text-popover-foreground shadow-xl"
        >
          <div className="flex items-start gap-2">
            <Bell className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {item.targetTitle}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {item.targetType === 'calendar_event' ? '日程' : 'Todo'} ·{' '}
                {new Date(item.snoozedUntil ?? item.triggerAt).toLocaleString()}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void acknowledge(item.id)}
              aria-label="确认提醒"
            >
              <Check />
            </Button>
          </div>
          <div className="mt-2 flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void snooze(item.id, 5)}
            >
              <Clock3 />5 分钟
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void snooze(item.id, 60)}
            >
              1 小时
            </Button>
          </div>
        </section>
      ))}
      {items.length > 3 && (
        <div className="text-right text-xs text-muted-foreground">
          另有 {items.length - 3} 条提醒
        </div>
      )}
    </aside>
  )
}

function merge(
  current: ActivePlanningReminder[],
  next: ActivePlanningReminder[],
): ActivePlanningReminder[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of next) byId.set(item.id, item)
  return [...byId.values()].sort(
    (a, b) => (a.snoozedUntil ?? a.triggerAt) - (b.snoozedUntil ?? b.triggerAt),
  )
}
