import { useAtomValue, useSetAtom } from 'jotai'
import {
  CalendarDays,
  Check,
  Circle,
  Clock3,
  ListTodo,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  activeTabIdAtom,
  currentWorkspaceIdAtom,
  agentWorkspacesAtom,
  tabsAtom,
} from '@/atoms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  createPlanningTodo,
  deletePlanningTodo,
  completePlanningTodo,
  createPlanningReminder,
  deletePlanningReminder,
  getPlanningTodo,
  listPlanningReminders,
  listPlanningTodos,
  onPlanningTodoChange,
  purgePlanningTodo,
  reopenPlanningTodo,
  restorePlanningTodo,
  startPlanningTodo,
  updatePlanningTodo,
} from '@/lib/desktop-api'
import type {
  PlanningTodo,
  PlanningTodoListView,
  PlanningTodoScope,
  PlanningReminder,
} from '@lume/shared'
import { PlanningCalendarView } from './PlanningCalendarView'

export function TodoView({
  workspaceId,
  todoId,
  initialTitle,
}: {
  workspaceId?: string
  todoId?: string
  initialTitle?: string
}) {
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const [scope, setScope] = useState<PlanningTodoScope>(
    todoId ? 'all' : 'current',
  )
  const [view, setView] = useState<PlanningTodoListView>('open')
  const [search, setSearch] = useState('')
  const [title, setTitle] = useState(initialTitle ?? '')
  const [todos, setTodos] = useState<PlanningTodo[]>([])
  const [busy, setBusy] = useState(false)
  const [selectedTodoId, setSelectedTodoId] = useState(todoId)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [planningView, setPlanningView] = useState<'todos' | 'calendar'>(
    'todos',
  )
  const selectedWorkspaceId = workspaceId ?? currentWorkspaceId ?? undefined
  const refresh = useCallback(() => {
    void listPlanningTodos({
      scope,
      view,
      search: search.trim() || undefined,
      workspaceId: selectedWorkspaceId,
    })
      .then((result) => {
        setTodos(result.items)
        setLoadError(null)
      })
      .catch((error) =>
        setLoadError(error instanceof Error ? error.message : '待办加载失败'),
      )
  }, [scope, view, search, selectedWorkspaceId])
  useEffect(() => {
    refresh()
  }, [refresh])
  useEffect(() => {
    let active = true
    let unsubscribe: (() => void) | undefined
    void onPlanningTodoChange(() => refresh()).then((off) => {
      if (active) unsubscribe = off
      else off()
    })
    return () => {
      active = false
      unsubscribe?.()
    }
  }, [refresh])
  const create = async () => {
    if (!title.trim()) return
    setBusy(true)
    try {
      await createPlanningTodo({
        title: title.trim(),
        workspaceId: selectedWorkspaceId,
      })
      setTitle('')
      refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '待办创建失败')
    } finally {
      setBusy(false)
    }
  }
  const mutate = async (
    todo: PlanningTodo,
    action: 'complete' | 'reopen' | 'delete' | 'restore' | 'purge',
  ) => {
    if (
      action === 'purge' &&
      !window.confirm(`永久删除「${todo.title}」？此操作不可撤销。`)
    )
      return
    const previous = todo
    const optimistic =
      action === 'complete'
        ? { ...todo, status: 'completed' as const }
        : action === 'reopen'
          ? { ...todo, status: 'open' as const }
          : action === 'delete'
            ? { ...todo, deletedAt: Date.now() }
            : action === 'restore'
              ? { ...todo, deletedAt: undefined }
              : null
    setTodos((items) =>
      optimistic
        ? items.map((item) => (item.id === todo.id ? optimistic : item))
        : items.filter((item) => item.id !== todo.id),
    )
    const fn = {
      complete: completePlanningTodo,
      reopen: reopenPlanningTodo,
      delete: deletePlanningTodo,
      restore: restorePlanningTodo,
      purge: purgePlanningTodo,
    }[action]
    try {
      await fn({ todoId: todo.id, expectedRevision: todo.revision })
      refresh()
    } catch (error) {
      setTodos((items) =>
        items.some((item) => item.id === todo.id)
          ? items.map((item) => (item.id === todo.id ? previous : item))
          : [...items, previous],
      )
      setLoadError(error instanceof Error ? error.message : '待办更新失败')
    }
  }
  const start = async (todo: PlanningTodo) => {
    try {
      const result = await startPlanningTodo({
        todoId: todo.id,
        expectedRevision: todo.revision,
        workspaceId: todo.workspaceId ?? selectedWorkspaceId,
        idempotencyKey: crypto.randomUUID(),
      })
      if (!result.threadId) {
        toast.error(result.operation.error ?? '无法开始处理该待办')
        return
      }
      const threadId = result.threadId
      if (!tabs.some((tab) => tab.id === threadId))
        setTabs((previous) => [
          ...previous,
          {
            id: threadId,
            type: 'agent',
            title: `处理：${todo.title}`,
            threadId,
            workspaceId: todo.workspaceId,
          },
        ])
      setActiveTabId(threadId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '开始处理失败')
    }
  }
  if (planningView === 'calendar')
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--lume-bg-panel)]">
        <div className="flex items-center gap-2 border-b border-border/50 px-5 py-4">
          <div className="mr-auto">
            <h1 className="text-lg font-semibold">规划</h1>
            <p className="text-xs text-muted-foreground">Todo 与日程</p>
          </div>
          <Button variant="ghost" onClick={() => setPlanningView('todos')}>
            <ListTodo />
            待办
          </Button>
          <Button variant="secondary">
            <CalendarDays />
            日程
          </Button>
        </div>
        <PlanningCalendarView />
      </div>
    )
  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--lume-bg-panel)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-5 py-4">
        <div className="mr-auto">
          <h1 className="text-lg font-semibold">待办</h1>
          <p className="text-xs text-muted-foreground">
            Planning Todo · 跨任务持久化
          </p>
        </div>
        <Button variant="secondary">
          <ListTodo />
          待办
        </Button>
        <Button variant="ghost" onClick={() => setPlanningView('calendar')}>
          <CalendarDays />
          日程
        </Button>
        <Select
          value={scope}
          onValueChange={(value) => setScope(value as PlanningTodoScope)}
        >
          <SelectTrigger className="w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="current">当前项目</SelectItem>
            <SelectItem value="all">全部项目</SelectItem>
            <SelectItem value="unassigned">未分配</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={view}
          onValueChange={(value) => setView(value as PlanningTodoListView)}
        >
          <SelectTrigger className="w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">进行中</SelectItem>
            <SelectItem value="today">今天</SelectItem>
            <SelectItem value="upcoming">即将到期</SelectItem>
            <SelectItem value="completed">已完成</SelectItem>
            <SelectItem value="trash">回收站</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="搜索待办…"
          className="w-[180px]"
        />
      </div>
      <div className="flex items-center gap-2 border-b border-border/40 px-5 py-3">
        <Input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create()
          }}
          placeholder="快速添加待办…"
          disabled={busy}
        />
        <Button onClick={() => void create()} disabled={busy || !title.trim()}>
          <Plus size={15} />
          添加
        </Button>
      </div>
      {loadError && (
        <div className="border-b border-destructive/30 bg-destructive/5 px-5 py-2 text-xs text-destructive">
          {loadError} · 请重试或检查连接
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="flex min-w-0 gap-5">
          {todos.length === 0 ? (
            <div className="min-w-0 flex-1 py-16 text-center text-sm text-muted-foreground">
              暂无待办
            </div>
          ) : (
            <div className="min-w-0 flex-1 space-y-2">
              {todos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  selected={selectedTodoId === todo.id}
                  onSelect={() => setSelectedTodoId(todo.id)}
                  onAction={mutate}
                  onStart={start}
                  workspaceName={
                    workspaces.find((item) => item.id === todo.workspaceId)
                      ?.name
                  }
                />
              ))}
            </div>
          )}
          {selectedTodoId &&
            todos.some((item) => item.id === selectedTodoId) && (
              <TodoInspector
                todo={todos.find((item) => item.id === selectedTodoId)!}
                workspaces={workspaces}
                onSaved={refresh}
                onClose={() => setSelectedTodoId(undefined)}
              />
            )}
        </div>
      </div>
    </div>
  )
}

function TodoRow({
  todo,
  selected,
  onSelect,
  onAction,
  onStart,
  workspaceName,
}: {
  todo: PlanningTodo
  selected: boolean
  onSelect: () => void
  onAction: (
    todo: PlanningTodo,
    action: 'complete' | 'reopen' | 'delete' | 'restore' | 'purge',
  ) => Promise<void>
  onStart: (todo: PlanningTodo) => Promise<void>
  workspaceName?: string
}) {
  const trashed = todo.deletedAt !== undefined
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border bg-card px-3 py-3 ${selected ? 'border-primary/50' : 'border-border/50'}`}
      onClick={onSelect}
    >
      <Button
        variant="ghost"
        size="icon"
        title="开始或继续处理"
        onClick={(event) => {
          event.stopPropagation()
          void onStart(todo)
        }}
        disabled={trashed || todo.status === 'completed'}
      >
        <Play size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title={todo.status === 'completed' ? '重开' : '完成'}
        onClick={(event) => {
          event.stopPropagation()
          void onAction(
            todo,
            todo.status === 'completed' ? 'reopen' : 'complete',
          )
        }}
        disabled={trashed}
      >
        {todo.status === 'completed' ? (
          <Check size={16} />
        ) : (
          <Circle size={16} />
        )}
      </Button>
      <div className="min-w-0 flex-1">
        <div
          className={
            todo.status === 'completed'
              ? 'truncate text-sm text-muted-foreground line-through'
              : 'truncate text-sm'
          }
        >
          {todo.title}
        </div>
        <div className="text-xs text-muted-foreground">
          {workspaceName ?? '未分配'} · {todo.priority}
        </div>
      </div>
      {trashed ? (
        <>
          <Button
            variant="ghost"
            size="icon"
            title="恢复"
            onClick={(event) => {
              event.stopPropagation()
              void onAction(todo, 'restore')
            }}
          >
            <RotateCcw size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="永久删除"
            onClick={(event) => {
              event.stopPropagation()
              void onAction(todo, 'purge')
            }}
          >
            <Trash2 size={15} />
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          title="移入回收站"
          onClick={(event) => {
            event.stopPropagation()
            void onAction(todo, 'delete')
          }}
        >
          <Trash2 size={15} />
        </Button>
      )}
    </div>
  )
}

function TodoInspector({
  todo,
  workspaces,
  onSaved,
  onClose,
}: {
  todo: PlanningTodo
  workspaces: Array<{ id: string; name: string }>
  onSaved: () => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(todo.title)
  const [description, setDescription] = useState(todo.description ?? '')
  const [priority, setPriority] = useState(todo.priority)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(
    todo.workspaceId ?? 'unassigned',
  )
  const [dueDate, setDueDate] = useState(todo.dueDate ?? '')
  const [dueAt, setDueAt] = useState(
    todo.dueAt ? toLocalDateTimeInput(todo.dueAt) : '',
  )
  const [reminders, setReminders] = useState<PlanningReminder[]>([])
  const [reminderAt, setReminderAt] = useState('')
  const [reminderSaving, setReminderSaving] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [serverTodo, setServerTodo] = useState<PlanningTodo | null>(null)
  const dirtyRef = useRef(false)
  const dirtyTodoIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (dirtyRef.current && dirtyTodoIdRef.current === todo.id) return
    setTitle(todo.title)
    setDescription(todo.description ?? '')
    setPriority(todo.priority)
    setSelectedWorkspaceId(todo.workspaceId ?? 'unassigned')
    setDueDate(todo.dueDate ?? '')
    setDueAt(todo.dueAt ? toLocalDateTimeInput(todo.dueAt) : '')
    setConflict(false)
    setServerTodo(null)
    dirtyRef.current = false
    dirtyTodoIdRef.current = null
  }, [
    todo.id,
    todo.revision,
    todo.title,
    todo.description,
    todo.priority,
    todo.workspaceId,
    todo.dueDate,
    todo.dueAt,
  ])
  const loadReminders = useCallback(async () => {
    try {
      setReminders(await listPlanningReminders('todo', todo.id))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提醒加载失败')
    }
  }, [todo.id])
  useEffect(() => {
    void loadReminders()
  }, [loadReminders])
  const patch = () => ({
    title: title.trim(),
    description: description || null,
    priority,
    workspaceId:
      selectedWorkspaceId === 'unassigned' ? null : selectedWorkspaceId,
    dueDate: dueDate || null,
    dueAt: dueAt ? new Date(dueAt).getTime() : null,
    dueTimezone: dueAt
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : null,
  })
  const save = async (expectedRevision = todo.revision) => {
    if (!title.trim() || saving) return
    setSaving(true)
    setSaved(false)
    try {
      await updatePlanningTodo({
        todoId: todo.id,
        expectedRevision,
        patch: patch(),
      })
      dirtyRef.current = false
      dirtyTodoIdRef.current = null
      setSaved(true)
      setConflict(false)
      setServerTodo(null)
      onSaved()
    } catch {
      dirtyRef.current = true
      dirtyTodoIdRef.current = todo.id
      setConflict(true)
      try {
        setServerTodo((await getPlanningTodo(todo.id)).todo)
      } catch {
        setServerTodo(null)
      }
    } finally {
      setSaving(false)
    }
  }
  const reload = async () => {
    const latest = serverTodo ?? (await getPlanningTodo(todo.id)).todo
    dirtyRef.current = false
    dirtyTodoIdRef.current = null
    setConflict(false)
    setServerTodo(null)
    setTitle(latest.title)
    setDescription(latest.description ?? '')
    setPriority(latest.priority)
    setSelectedWorkspaceId(latest.workspaceId ?? 'unassigned')
    setDueDate(latest.dueDate ?? '')
    setDueAt(latest.dueAt ? toLocalDateTimeInput(latest.dueAt) : '')
    onSaved()
  }
  const addReminder = async () => {
    if (!reminderAt || reminderSaving) return
    setReminderSaving(true)
    try {
      await createPlanningReminder({
        targetType: 'todo',
        targetId: todo.id,
        triggerAt: new Date(reminderAt).getTime(),
      })
      setReminderAt('')
      await loadReminders()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提醒创建失败')
    } finally {
      setReminderSaving(false)
    }
  }
  const removeReminder = async (reminderId: string) => {
    try {
      await deletePlanningReminder(reminderId)
      await loadReminders()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '提醒删除失败')
    }
  }
  const markDirty = () => {
    dirtyRef.current = true
    dirtyTodoIdRef.current = todo.id
    setSaved(false)
  }
  useEffect(() => {
    if (
      !dirtyRef.current ||
      dirtyTodoIdRef.current !== todo.id ||
      conflict ||
      saving
    )
      return
    const timer = window.setTimeout(() => {
      void save()
    }, 500)
    return () => window.clearTimeout(timer)
  }, [
    title,
    description,
    priority,
    selectedWorkspaceId,
    dueDate,
    dueAt,
    conflict,
    saving,
    todo.id,
  ])
  return (
    <aside className="fixed inset-y-0 right-0 z-30 w-[min(360px,92vw)] overflow-auto border-l border-border/60 bg-card p-4 shadow-xl xl:static xl:z-auto xl:w-[min(360px,35vw)] xl:shrink-0 xl:rounded-xl xl:border xl:shadow-none">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">待办详情</h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {saving ? '保存中…' : saved ? '已保存' : `修订 ${todo.revision}`}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 xl:hidden"
            onClick={onClose}
            aria-label="关闭详情"
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      {conflict && (
        <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          保存冲突：本地草稿已保留。
          {serverTodo && (
            <div className="mt-1 text-muted-foreground">
              服务端：{serverTodo.title}（修订 {serverTodo.revision}）
            </div>
          )}
          <span className="mt-1 inline-flex gap-2">
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={() => void reload()}
            >
              重新加载
            </Button>
            <Button
              variant="link"
              className="h-auto p-0 text-xs"
              disabled={!serverTodo}
              onClick={() => {
                if (serverTodo) void save(serverTodo.revision)
              }}
            >
              基于最新版本覆盖
            </Button>
          </span>
        </div>
      )}
      <Input
        value={title}
        onChange={(event) => {
          setTitle(event.target.value)
          markDirty()
        }}
        onBlur={() => void save()}
        className="mb-3"
      />
      <Textarea
        value={description}
        onChange={(event) => {
          setDescription(event.target.value)
          markDirty()
        }}
        onBlur={() => void save()}
        placeholder="描述（可选）"
        className="mb-3 min-h-24"
      />
      <Select
        value={priority}
        onValueChange={(value) => {
          if (!value) return
          setPriority(value as PlanningTodo['priority'])
          markDirty()
        }}
      >
        <SelectTrigger className="mb-3">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(['none', 'low', 'medium', 'high'] as const).map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={selectedWorkspaceId}
        onValueChange={(value) => {
          if (!value) return
          setSelectedWorkspaceId(value)
          markDirty()
        }}
      >
        <SelectTrigger className="mb-3">
          <SelectValue placeholder="项目" />
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
      <div className="flex gap-2">
        <Input
          type="date"
          value={dueDate}
          onChange={(event) => {
            setDueDate(event.target.value)
            if (event.target.value) setDueAt('')
            markDirty()
          }}
          onBlur={() => void save()}
          aria-label="截止日期"
        />
        <Input
          type="datetime-local"
          value={dueAt}
          onChange={(event) => {
            setDueAt(event.target.value)
            if (event.target.value) setDueDate('')
            markDirty()
          }}
          onBlur={() => void save()}
          aria-label="截止时间"
        />
      </div>
      <div className="mt-4 space-y-2 border-t border-border/50 pt-4">
        <div className="text-xs font-medium">提醒</div>
        <div className="flex gap-2">
          <Input
            type="datetime-local"
            value={reminderAt}
            onChange={(event) => setReminderAt(event.target.value)}
            aria-label="新增提醒时间"
          />
          <Button
            variant="outline"
            onClick={() => void addReminder()}
            disabled={!reminderAt || reminderSaving}
          >
            添加
          </Button>
        </div>
        {reminders.map((reminder) => (
          <div
            key={reminder.id}
            className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
          >
            <Clock3 className="size-3 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              {new Date(
                reminder.snoozedUntil ?? reminder.triggerAt,
              ).toLocaleString()}
              {reminder.origin === 'todo_due_at' ? ' · 跟随截止时间' : ''}
              {reminder.status !== 'pending' ? ` · ${reminder.status}` : ''}
            </span>
            {reminder.origin === 'manual' && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="删除提醒"
                onClick={() => void removeReminder(reminder.id)}
              >
                <Trash2 />
              </Button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        {todo.workspaceId
          ? (workspaces.find((workspace) => workspace.id === todo.workspaceId)
              ?.name ?? '其他项目')
          : '未分配'}{' '}
        ·{' '}
        {todo.dueDate ??
          (todo.dueAt ? new Date(todo.dueAt).toLocaleString() : '无截止日期')}
      </div>
    </aside>
  )
}

function toLocalDateTimeInput(value: number): string {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}
