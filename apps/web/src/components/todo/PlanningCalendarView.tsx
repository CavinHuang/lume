import { useAtomValue } from 'jotai'
import { ChevronLeft, ChevronRight, Clock3, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { listAutomationJobs } from '@/lib/desktop-api/automation'
import {
  createPlanningCalendarEvent,
  createPlanningGroup,
  createPlanningReminder,
  createPlanningTag,
  deletePlanningCalendarEvent,
  deletePlanningReminder,
  listPlanningCalendarEvents,
  listPlanningGroups,
  listPlanningTags,
  listPlanningTodos,
  onPlanningTodoChange,
  updatePlanningCalendarEvent,
} from '@/lib/desktop-api'
import type {
  AutomationJob,
  PlanningCalendarEvent,
  PlanningGroup,
  PlanningTag,
  PlanningTodo,
} from '@lume/shared'

type CalendarMode = 'month' | 'week'
type CalendarItem = {
  id: string
  kind: 'event' | 'todo' | 'automation'
  title: string
  at: number
  event?: PlanningCalendarEvent
}

export function PlanningCalendarView({
  createRequest = 0,
}: {
  createRequest?: number
}) {
  const workspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const [mode, setMode] = useState<CalendarMode>('month')
  const [anchor, setAnchor] = useState(startOfDay(Date.now()))
  const [events, setEvents] = useState<PlanningCalendarEvent[]>([])
  const [todos, setTodos] = useState<PlanningTodo[]>([])
  const [automations, setAutomations] = useState<AutomationJob[]>([])
  const [groups, setGroups] = useState<PlanningGroup[]>([])
  const [tags, setTags] = useState<PlanningTag[]>([])
  const [editing, setEditing] = useState<
    PlanningCalendarEvent | null | undefined
  >(undefined)
  const [expandedDay, setExpandedDay] = useState<number>()
  const handledCreateRequest = useRef(createRequest)
  useEffect(() => {
    if (handledCreateRequest.current === createRequest) return
    handledCreateRequest.current = createRequest
    setEditing(null)
  }, [createRequest])
  const range = useMemo(() => visibleRange(anchor, mode), [anchor, mode])
  const load = useCallback(async () => {
    try {
      const [nextEvents, nextTodos, nextAutomations, nextGroups, nextTags] =
        await Promise.all([
          listPlanningCalendarEvents({
            from: range.from,
            to: range.to,
            scope: workspaceId ? 'current' : 'unassigned',
            ...(workspaceId ? { workspaceId } : {}),
          }),
          listPlanningTodos({
            scope: workspaceId ? 'current' : 'unassigned',
            workspaceId: workspaceId ?? undefined,
            view: 'all',
            limit: 100,
          }),
          listAutomationJobs(),
          listPlanningGroups('calendar'),
          listPlanningTags(),
        ])
      setEvents(nextEvents)
      setTodos(nextTodos.items)
      setAutomations(nextAutomations)
      setGroups(nextGroups)
      setTags(nextTags)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '日程加载失败')
    }
  }, [range.from, range.to, workspaceId])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    let active = true
    let off: (() => void) | undefined
    void onPlanningTodoChange((change) => {
      if (
        !change.resources ||
        change.resources.some((resource) =>
          [
            'calendar_events',
            'calendar_groups',
            'tags',
            'todos',
            'reminders',
          ].includes(resource),
        )
      )
        void load()
    }).then((value) => {
      if (active) off = value
      else value()
    })
    return () => {
      active = false
      off?.()
    }
  }, [load])

  const items = useMemo(
    () => buildItems(events, todos, automations, range),
    [events, todos, automations, range],
  )
  const days = mode === 'month' ? monthGridDays(anchor) : weekDays(anchor)
  const move = (delta: number) =>
    setAnchor((value) =>
      mode === 'month'
        ? new Date(
            new Date(value).getFullYear(),
            new Date(value).getMonth() + delta,
            1,
          ).getTime()
        : value + delta * 7 * DAY,
    )
  return (
    <section className="flex w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-1)] shadow-sm">
      <div className="relative flex flex-wrap items-center gap-3 border-b border-border/60 px-5 py-4">
        <Tabs
          value={mode}
          onValueChange={(value) => setMode(value as CalendarMode)}
        >
          <TabsList>
            <TabsTrigger value="month">月</TabsTrigger>
            <TabsTrigger value="week">周</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-1 sm:absolute sm:left-1/2 sm:-translate-x-1/2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => move(-1)}
            aria-label="上一周期"
          >
            <ChevronLeft />
          </Button>
          <div className="min-w-32 text-center text-sm font-semibold">
            {range.label}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => move(1)}
            aria-label="下一周期"
          >
            <ChevronRight />
          </Button>
        </div>
        <Button
          variant="outline"
          className="ml-auto"
          onClick={() => setAnchor(startOfDay(Date.now()))}
        >
          今天
        </Button>
      </div>
      <div className="grid shrink-0 grid-cols-7 border-b border-border/60 bg-muted/15">
        {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map(
          (label) => (
            <div
              key={label}
              className="border-r border-border/40 px-3 py-2 text-center text-[11px] font-medium text-muted-foreground last:border-r-0"
            >
              {label}
            </div>
          ),
        )}
      </div>
      <div
        className={`grid grid-cols-7 ${mode === 'month' ? 'auto-rows-[minmax(128px,auto)]' : 'auto-rows-[minmax(480px,auto)]'}`}
      >
        {days.map((day) => (
          <CalendarDay
            key={day}
            day={day}
            currentMonth={
              new Date(day).getMonth() === new Date(anchor).getMonth()
            }
            items={items.filter((item) => sameDay(item.at, day))}
            onOpen={(event) => setEditing(event)}
            maxVisibleItems={mode === 'month' ? 4 : undefined}
            onOpenAll={() => setExpandedDay(day)}
          />
        ))}
      </div>
      <DayItemsDialog
        day={expandedDay}
        items={
          expandedDay === undefined
            ? []
            : items.filter((item) => sameDay(item.at, expandedDay))
        }
        onOpenChange={(open) => {
          if (!open) setExpandedDay(undefined)
        }}
        onOpenEvent={(event) => {
          setExpandedDay(undefined)
          setEditing(event)
        }}
      />
      <CalendarEventDialog
        open={editing !== undefined}
        event={editing ?? undefined}
        workspaceId={workspaceId ?? undefined}
        workspaces={workspaces}
        todos={todos.filter(
          (todo) => todo.status === 'open' && !todo.deletedAt,
        )}
        groups={groups}
        tags={tags}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined)
        }}
        onSaved={(saved, close) => {
          if (close) setEditing(undefined)
          else if (saved) setEditing(saved)
          void load()
        }}
        onGroups={setGroups}
        onTags={setTags}
      />
    </section>
  )
}

function CalendarDay({
  day,
  currentMonth,
  items,
  onOpen,
  maxVisibleItems,
  onOpenAll,
}: {
  day: number
  currentMonth: boolean
  items: CalendarItem[]
  onOpen: (event: PlanningCalendarEvent) => void
  maxVisibleItems?: number
  onOpenAll: () => void
}) {
  const today = sameDay(day, Date.now())
  const visibleItems =
    maxVisibleItems === undefined ? items : items.slice(0, maxVisibleItems)
  const hiddenItemCount = items.length - visibleItems.length
  return (
    <section className="min-h-28 border-b border-r border-border/40 bg-background/20 p-2 transition-colors hover:bg-muted/15">
      <div
        className={`mb-2 inline-flex size-7 items-center justify-center rounded-full text-xs ${today ? 'bg-primary text-primary-foreground' : currentMonth ? '' : 'text-muted-foreground/50'}`}
      >
        {new Date(day).getDate()}
      </div>
      <div className="space-y-1">
        {visibleItems.map((item) =>
          item.kind === 'event' ? (
            <Button
              key={`${item.kind}:${item.id}`}
              variant="ghost"
              className="h-auto w-full justify-start gap-1 overflow-hidden px-1.5 py-1 text-left text-xs"
              onClick={() => onOpen(item.event!)}
            >
              <span className="size-1.5 shrink-0 rounded-full bg-primary" />
              <span className="truncate">{item.title}</span>
              <time className="ml-auto text-[10px] text-muted-foreground">
                {formatTime(item.at, item.event?.allDay)}
              </time>
            </Button>
          ) : (
            <div
              key={`${item.kind}:${item.id}`}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground"
            >
              <span
                className={`size-1.5 rounded-full ${item.kind === 'todo' ? 'bg-amber-500' : 'bg-violet-500'}`}
              />
              <span className="truncate">{item.title}</span>
            </div>
          ),
        )}
        {hiddenItemCount > 0 && (
          <Button
            variant="ghost"
            size="xs"
            className="w-full justify-start text-muted-foreground"
            onClick={onOpenAll}
          >
            还有 {hiddenItemCount} 项
          </Button>
        )}
      </div>
    </section>
  )
}

function DayItemsDialog({
  day,
  items,
  onOpenChange,
  onOpenEvent,
}: {
  day?: number
  items: CalendarItem[]
  onOpenChange: (open: boolean) => void
  onOpenEvent: (event: PlanningCalendarEvent) => void
}) {
  return (
    <Dialog open={day !== undefined} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {day === undefined
              ? '当天安排'
              : new Intl.DateTimeFormat('zh-CN', {
                  month: 'long',
                  day: 'numeric',
                  weekday: 'long',
                }).format(day)}
          </DialogTitle>
          <DialogDescription>当天共 {items.length} 项安排</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {items.map((item) =>
            item.kind === 'event' ? (
              <Button
                key={`${item.kind}:${item.id}`}
                variant="outline"
                className="h-auto w-full justify-start px-3 py-2.5 text-left"
                onClick={() => onOpenEvent(item.event!)}
              >
                <span className="size-2 rounded-full bg-primary" />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <time className="text-xs text-muted-foreground">
                  {formatTime(item.at, item.event?.allDay)}
                </time>
              </Button>
            ) : (
              <div
                key={`${item.kind}:${item.id}`}
                className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2.5 text-sm"
              >
                <span
                  className={`size-2 rounded-full ${item.kind === 'todo' ? 'bg-amber-500' : 'bg-violet-500'}`}
                />
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                <span className="text-xs text-muted-foreground">
                  {item.kind === 'todo' ? 'Todo' : '自动化'}
                </span>
              </div>
            ),
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CalendarEventDialog({
  open,
  event,
  workspaceId,
  workspaces,
  todos,
  groups,
  tags,
  onOpenChange,
  onSaved,
  onGroups,
  onTags,
}: {
  open: boolean
  event?: PlanningCalendarEvent
  workspaceId?: string
  workspaces: Array<{ id: string; name: string }>
  todos: PlanningTodo[]
  groups: PlanningGroup[]
  tags: PlanningTag[]
  onOpenChange: (open: boolean) => void
  onSaved: (saved?: PlanningCalendarEvent, close?: boolean) => void
  onGroups: (groups: PlanningGroup[]) => void
  onTags: (tags: PlanningTag[]) => void
}) {
  const defaultStart = roundToHalfHour(Date.now())
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [startAt, setStartAt] = useState(toLocalInput(defaultStart))
  const [endAt, setEndAt] = useState(toLocalInput(defaultStart + 30 * 60_000))
  const [allDay, setAllDay] = useState(false)
  const [selectedWorkspace, setSelectedWorkspace] = useState(
    workspaceId ?? 'unassigned',
  )
  const [groupId, setGroupId] = useState('none')
  const [todoId, setTodoId] = useState('none')
  const [tagIds, setTagIds] = useState<string[]>([])
  const [reminderAt, setReminderAt] = useState('')
  const [newGroup, setNewGroup] = useState('')
  const [newTag, setNewTag] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(event?.revision ?? 0)
  const dirtyRef = useRef(false)
  const dirtyVersionRef = useRef(0)
  useEffect(() => {
    const start = event?.startAt ?? defaultStart
    setTitle(event?.title ?? '')
    setNotes(event?.notes ?? '')
    setStartAt(toLocalInput(start))
    setEndAt(toLocalInput(event?.endAt ?? start + 30 * 60_000))
    setAllDay(event?.allDay ?? false)
    setSelectedWorkspace(event?.workspaceId ?? workspaceId ?? 'unassigned')
    setGroupId(event?.groupId ?? 'none')
    setTodoId(event?.todoId ?? 'none')
    setTagIds(event?.tags.map((tag) => tag.id) ?? [])
    setReminderAt('')
    setRevision(event?.revision ?? 0)
    dirtyRef.current = false
    dirtyVersionRef.current = 0
  }, [event?.id, event?.revision, open, workspaceId])
  const save = async (close = true) => {
    if (!title.trim()) return
    const start = new Date(startAt).getTime()
    const end = endAt ? new Date(endAt).getTime() : undefined
    const savingVersion = dirtyVersionRef.current
    setBusy(true)
    try {
      let saved: PlanningCalendarEvent
      if (event)
        saved = await updatePlanningCalendarEvent({
          eventId: event.id,
          expectedRevision: revision,
          patch: {
            title: title.trim(),
            notes: notes || null,
            startAt: start,
            endAt: end ?? null,
            allDay,
            workspaceId:
              selectedWorkspace === 'unassigned' ? null : selectedWorkspace,
            groupId: groupId === 'none' ? null : groupId,
            todoId: todoId === 'none' ? null : todoId,
            tagIds,
          },
        })
      else
        saved = await createPlanningCalendarEvent({
          title: title.trim(),
          notes: notes || undefined,
          startAt: start,
          endAt: end,
          allDay,
          workspaceId:
            selectedWorkspace === 'unassigned' ? undefined : selectedWorkspace,
          groupId: groupId === 'none' ? undefined : groupId,
          todoId: todoId === 'none' ? undefined : todoId,
          tagIds,
          reminderTimes: reminderAt
            ? [new Date(reminderAt).getTime()]
            : undefined,
        })
      if (event && reminderAt)
        await createPlanningReminder({
          targetType: 'calendar_event',
          targetId: saved.id,
          triggerAt: new Date(reminderAt).getTime(),
        })
      setRevision(saved.revision)
      if (reminderAt) setReminderAt('')
      if (savingVersion === dirtyVersionRef.current) {
        dirtyRef.current = false
        onSaved(saved, close)
      } else {
        onSaved(undefined, false)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '日程保存失败')
    } finally {
      setBusy(false)
    }
  }
  const markDirty = () => {
    if (!event) return
    dirtyRef.current = true
    dirtyVersionRef.current += 1
  }
  useEffect(() => {
    if (!event || !dirtyRef.current || busy || !title.trim()) return
    const timer = window.setTimeout(() => void save(false), 500)
    return () => window.clearTimeout(timer)
  }, [
    title,
    notes,
    startAt,
    endAt,
    allDay,
    selectedWorkspace,
    groupId,
    todoId,
    tagIds,
    reminderAt,
    busy,
    event?.id,
    revision,
  ])
  const remove = async () => {
    if (!event || !window.confirm(`删除日程「${event.title}」？`)) return
    setBusy(true)
    try {
      await deletePlanningCalendarEvent(event.id, event.revision)
      onSaved(undefined, true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '日程删除失败')
    } finally {
      setBusy(false)
    }
  }
  const addGroup = async () => {
    if (!newGroup.trim()) return
    try {
      const group = await createPlanningGroup({
        scope: 'calendar',
        name: newGroup.trim(),
      })
      onGroups([...groups, group])
      setGroupId(group.id)
      markDirty()
      setNewGroup('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '分组创建失败')
    }
  }
  const addTag = async () => {
    if (!newTag.trim()) return
    try {
      const tag = await createPlanningTag({ name: newTag.trim() })
      onTags([...tags, tag])
      setTagIds((ids) => [...ids, tag.id])
      markDirty()
      setNewTag('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '标签创建失败')
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{event ? '日程详情' : '新建日程'}</DialogTitle>
          <DialogDescription>
            日程与 Todo 独立，可选择关联 Todo，并设置一个或多个提醒。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              markDirty()
            }}
            placeholder="日程标题"
            autoFocus
          />
          <Textarea
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value)
              markDirty()
            }}
            placeholder="地点、议程、会议链接或其他信息"
          />
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allDay}
              onCheckedChange={(value) => {
                setAllDay(value === true)
                markDirty()
              }}
            />
            全天
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? startAt.slice(0, 10) : startAt}
              onChange={(e) => {
                setStartAt(allDay ? `${e.target.value}T00:00` : e.target.value)
                markDirty()
              }}
              aria-label="开始时间"
            />
            <Input
              type={allDay ? 'date' : 'datetime-local'}
              value={allDay ? endAt.slice(0, 10) : endAt}
              onChange={(e) => {
                setEndAt(allDay ? `${e.target.value}T23:59` : e.target.value)
                markDirty()
              }}
              aria-label="结束时间"
            />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Select
              value={selectedWorkspace}
              onValueChange={(value) => {
                if (!value) return
                setSelectedWorkspace(value)
                markDirty()
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="项目">
                  {(value) =>
                    value === 'unassigned'
                      ? '未分配'
                      : (workspaces.find(
                          (workspace) => workspace.id === value,
                        )?.name ?? '其他项目')
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unassigned">未分配</SelectItem>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={groupId}
              onValueChange={(value) => {
                if (!value) return
                setGroupId(value)
                markDirty()
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="分组">
                  {(value) =>
                    value === 'none'
                      ? '未分组'
                      : (groups.find((group) => group.id === value)?.name ??
                        '其他分组')
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">未分组</SelectItem>
                {groups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    {group.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={todoId}
              onValueChange={(value) => {
                if (!value) return
                setTodoId(value)
                markDirty()
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="关联 Todo">
                  {(value) =>
                    value === 'none'
                      ? '不关联'
                      : (todos.find((todo) => todo.id === value)?.title ??
                        '关联 Todo')
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不关联</SelectItem>
                {todos.map((todo) => (
                  <SelectItem key={todo.id} value={todo.id}>
                    {todo.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              placeholder="新分组"
            />
            <Button variant="outline" onClick={() => void addGroup()}>
              添加分组
            </Button>
            <Input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              placeholder="新标签"
            />
            <Button variant="outline" onClick={() => void addTag()}>
              添加标签
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <Button
                key={tag.id}
                type="button"
                size="sm"
                variant={tagIds.includes(tag.id) ? 'secondary' : 'outline'}
                onClick={() => {
                  setTagIds((ids) =>
                    ids.includes(tag.id)
                      ? ids.filter((id) => id !== tag.id)
                      : [...ids, tag.id],
                  )
                  markDirty()
                }}
              >
                #{tag.name}
              </Button>
            ))}
          </div>
          <label className="grid gap-1 text-sm">
            <span className="text-muted-foreground">新增提醒（可选）</span>
            <Input
              type="datetime-local"
              value={reminderAt}
              onChange={(e) => {
                setReminderAt(e.target.value)
                markDirty()
              }}
            />
          </label>
          {event && event.reminders.length > 0 && (
            <div className="space-y-2">
              <span className="text-sm text-muted-foreground">已有提醒</span>
              {event.reminders.map((reminder) => (
                <div
                  key={reminder.id}
                  className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                >
                  <Clock3 className="size-3" />
                  <span>
                    {new Date(
                      reminder.snoozedUntil ?? reminder.triggerAt,
                    ).toLocaleString()}{' '}
                    · {reminder.status}
                  </span>
                  <Button
                    className="ml-auto"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() =>
                      void deletePlanningReminder(reminder.id).then(() =>
                        onSaved(undefined, true),
                      )
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          {event && (
            <Button
              variant="ghost"
              className="mr-auto text-destructive"
              onClick={() => void remove()}
              disabled={busy}
            >
              <Trash2 />
              删除
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            onClick={() => void save(true)}
            disabled={busy || !title.trim()}
          >
            {event ? (busy ? '保存中…' : '完成') : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const DAY = 86_400_000
function startOfDay(value: number): number {
  const date = new Date(value)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}
function sameDay(left: number, right: number): boolean {
  return startOfDay(left) === startOfDay(right)
}
function weekDays(anchor: number): number[] {
  const date = new Date(anchor)
  const start = startOfDay(anchor) - date.getDay() * DAY
  return Array.from({ length: 7 }, (_, index) => start + index * DAY)
}
function monthGridDays(anchor: number): number[] {
  const date = new Date(anchor)
  const first = new Date(date.getFullYear(), date.getMonth(), 1).getTime()
  const start = first - new Date(first).getDay() * DAY
  return Array.from({ length: 42 }, (_, index) => start + index * DAY)
}
function visibleRange(
  anchor: number,
  mode: CalendarMode,
): { from: number; to: number; label: string } {
  if (mode === 'week') {
    const days = weekDays(anchor)
    return {
      from: days[0]!,
      to: days[6]! + DAY - 1,
      label: `${new Date(days[0]!).toLocaleDateString()} – ${new Date(days[6]!).toLocaleDateString()}`,
    }
  }
  const date = new Date(anchor)
  const days = monthGridDays(anchor)
  return {
    from: days[0]!,
    to: days[41]! + DAY - 1,
    label: `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`,
  }
}
function buildItems(
  events: PlanningCalendarEvent[],
  todos: PlanningTodo[],
  automations: AutomationJob[],
  range: { from: number; to: number },
): CalendarItem[] {
  return [
    ...events.flatMap((event): CalendarItem[] => {
      const firstDay = startOfDay(Math.max(event.startAt, range.from))
      const lastDay = startOfDay(
        Math.min(event.endAt ?? event.startAt, range.to),
      )
      const dayCount = Math.max(0, Math.floor((lastDay - firstDay) / DAY)) + 1
      return Array.from({ length: dayCount }, (_, index) => ({
        id: `${event.id}:${firstDay + index * DAY}`,
        kind: 'event' as const,
        title: event.title,
        at:
          firstDay + index * DAY === startOfDay(event.startAt)
            ? event.startAt
            : firstDay + index * DAY,
        event,
      }))
    }),
    ...todos.flatMap((todo): CalendarItem[] =>
      todo.dueAt && todo.dueAt >= range.from && todo.dueAt <= range.to
        ? [{ id: todo.id, kind: 'todo', title: todo.title, at: todo.dueAt }]
        : [],
    ),
    ...automations.flatMap((job): CalendarItem[] =>
      job.enabled &&
      job.nextRunAt &&
      job.nextRunAt >= range.from &&
      job.nextRunAt <= range.to
        ? [
            {
              id: job.id,
              kind: 'automation',
              title: job.name,
              at: job.nextRunAt,
            },
          ]
        : [],
    ),
  ].sort((a, b) => a.at - b.at)
}
function roundToHalfHour(value: number): number {
  return Math.ceil(value / (30 * 60_000)) * 30 * 60_000
}
function toLocalInput(value: number): string {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}
function formatTime(value: number, allDay?: boolean): string {
  return allDay
    ? '全天'
    : new Date(value).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })
}
