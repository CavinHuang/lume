import { useAtomValue, useSetAtom } from 'jotai'
import {
  Bot,
  CalendarDays,
  Check,
  Circle,
  Clock3,
  Flag,
  FolderKanban,
  Inbox,
  ListTodo,
  Play,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { toast } from 'sonner'
import {
  activeTabIdAtom,
  currentWorkspaceIdAtom,
  agentWorkspacesAtom,
  tabsAtom,
} from '@/atoms'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { cn } from '@/lib/utils'
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
  const [createOpen, setCreateOpen] = useState(Boolean(initialTitle))
  const [createPriority, setCreatePriority] = useState<
    PlanningTodo['priority']
  >('medium')
  const [createWorkspaceId, setCreateWorkspaceId] = useState(
    selectedWorkspaceId ?? 'unassigned',
  )
  const [createDueAt, setCreateDueAt] = useState('')
  const [calendarCreateRequest, setCalendarCreateRequest] = useState(0)
  const [pendingStartTodo, setPendingStartTodo] = useState<PlanningTodo>()
  const [startWorkspaceId, setStartWorkspaceId] = useState('')
  const [startingTodoId, setStartingTodoId] = useState<string>()
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
      const result = await createPlanningTodo({
        title: title.trim(),
        priority: createPriority,
        ...(createWorkspaceId === 'unassigned'
          ? {}
          : { workspaceId: createWorkspaceId }),
        ...(createDueAt
          ? {
              dueAt: new Date(createDueAt).getTime(),
              dueTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }
          : {}),
      })
      // 后端对同 workspace 下标题 normalize 后相同的 open 待办会静默去重（deduplicated:true）。
      // 此时未真正创建，保留 Dialog 让用户修改标题，而非无声关闭（见 #19）。
      if (result.deduplicated) {
        toast.info('已存在相同标题的待办，未重复创建。请修改标题后重试。')
        return
      }
      setTitle('')
      setCreatePriority('medium')
      setCreateDueAt('')
      setCreateOpen(false)
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
  const startInWorkspace = async (todo: PlanningTodo, workspaceId: string) => {
    setStartingTodoId(todo.id)
    try {
      const result = await startPlanningTodo({
        todoId: todo.id,
        expectedRevision: todo.revision,
        workspaceId,
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
            workspaceId: result.todo.workspaceId,
          },
        ])
      setTodos((items) =>
        items.map((item) => (item.id === result.todo.id ? result.todo : item)),
      )
      setPendingStartTodo(undefined)
      setActiveTabId(threadId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '开始处理失败')
    } finally {
      setStartingTodoId(undefined)
    }
  }
  const start = async (todo: PlanningTodo) => {
    if (todo.workspaceId) {
      await startInWorkspace(todo, todo.workspaceId)
      return
    }
    setStartWorkspaceId(
      workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.id ??
        workspaces[0]?.id ??
        '',
    )
    setPendingStartTodo(todo)
  }
  const openCreateDialog = () => {
    setCreateWorkspaceId(
      workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.id ??
        'unassigned',
    )
    setCreateOpen(true)
  }
  const viewItems: Array<{
    value: PlanningTodoListView
    label: string
    icon: typeof ListTodo
  }> = [
    { value: 'open', label: '全部待办', icon: ListTodo },
    { value: 'today', label: '今天', icon: CalendarDays },
    { value: 'upcoming', label: '即将到期', icon: Clock3 },
    { value: 'completed', label: '已完成', icon: Check },
    { value: 'trash', label: '回收站', icon: Trash2 },
  ]
  const currentViewLabel =
    viewItems.find((item) => item.value === view)?.label ?? '全部待办'

  return (
    <div
      className={cn(
        'flex h-full min-h-0 w-full flex-col bg-[var(--lume-bg-app)]',
        planningView === 'calendar'
          ? 'agent-message-scrollbar overflow-x-hidden overflow-y-auto'
          : 'overflow-hidden',
      )}
    >
      <header className="shrink-0 px-6 pt-3 md:px-8 lg:px-10 lg:pt-4">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">任务 / 日程</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              安排待办、日程与跨任务承诺
            </p>
          </div>
          <Button
            size="lg"
            onClick={() => {
              if (planningView === 'todos') openCreateDialog()
              else setCalendarCreateRequest((value) => value + 1)
            }}
          >
            <Plus />
            {planningView === 'todos' ? '新建 Todo' : '新建日程'}
          </Button>
        </div>
        <div className="mt-4 inline-flex rounded-xl bg-muted/60 p-1 shadow-inner">
          <Button
            variant="ghost"
            className={cn(
              'h-8 rounded-lg px-4',
              planningView === 'todos' &&
                'bg-background shadow-sm hover:bg-background',
            )}
            onClick={() => setPlanningView('todos')}
          >
            <ListTodo />
            Todo
          </Button>
          <Button
            variant="ghost"
            className={cn(
              'h-8 rounded-lg px-4',
              planningView === 'calendar' &&
                'bg-background shadow-sm hover:bg-background',
            )}
            onClick={() => setPlanningView('calendar')}
          >
            <CalendarDays />
            日程
          </Button>
        </div>
      </header>

      <main
        className={cn(
          'w-full px-6 pb-6 pt-4 md:px-8 lg:px-10 lg:pb-8',
          planningView === 'calendar' ? 'shrink-0' : 'min-h-0 flex-1',
        )}
      >
        {planningView === 'calendar' ? (
          <PlanningCalendarView createRequest={calendarCreateRequest} />
        ) : (
          <section className="h-full min-h-[480px] w-full overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-1)] shadow-sm">
            <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[12.5rem_minmax(0,1fr)]">
              <aside className="hidden min-h-0 border-r border-border/60 bg-muted/20 p-3 md:flex md:flex-col">
                <div className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  视图
                </div>
                <nav className="space-y-1">
                  {viewItems.map((item) => {
                    const Icon = item.icon
                    return (
                      <Button
                        key={item.value}
                        variant={view === item.value ? 'secondary' : 'ghost'}
                        className="w-full justify-start"
                        onClick={() => setView(item.value)}
                      >
                        <Icon />
                        {item.label}
                      </Button>
                    )
                  })}
                </nav>
                <div className="mt-auto border-t border-border/50 pt-4">
                  <div className="px-2 pb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    项目范围
                  </div>
                  <Select
                    value={scope}
                    onValueChange={(value) =>
                      setScope(value as PlanningTodoScope)
                    }
                  >
                    <SelectTrigger className="w-full bg-background/70">
                      <SelectValue>
                        {(value) =>
                          ({
                            current: '当前项目',
                            all: '全部项目',
                            unassigned: '未分配',
                          })[value as PlanningTodoScope]
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="current">当前项目</SelectItem>
                      <SelectItem value="all">全部项目</SelectItem>
                      <SelectItem value="unassigned">未分配</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </aside>

              <div className="flex min-h-0 min-w-0 overflow-hidden">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-5 py-4">
                    <div className="mr-auto min-w-0">
                      <h2 className="font-semibold">{currentViewLabel}</h2>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {todos.length} 个项目
                      </p>
                    </div>
                    <div className="relative w-full sm:w-60">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="搜索 Todo…"
                        className="bg-background pl-8"
                      />
                    </div>
                  </div>
                  {loadError && (
                    <div className="border-b border-destructive/30 bg-destructive/5 px-5 py-2 text-xs text-destructive">
                      {loadError} · 请重试或检查连接
                    </div>
                  )}
                  <div className="min-h-0 flex-1 overflow-auto">
                    {todos.length === 0 ? (
                      <div className="flex h-full min-h-72 flex-col items-center justify-center px-6 text-center">
                        <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                          <Inbox className="size-5" />
                        </div>
                        <h3 className="text-sm font-medium">
                          这里还没有 Todo
                        </h3>
                        <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                          点击右上角“新建 Todo”，把接下来要推进的事情放进来。
                        </p>
                      </div>
                    ) : (
                      todos.map((todo) => (
                        <TodoRow
                          key={todo.id}
                          todo={todo}
                          selected={selectedTodoId === todo.id}
                          onSelect={() => setSelectedTodoId(todo.id)}
                          onAction={mutate}
                          onStart={start}
                          starting={startingTodoId === todo.id}
                          workspaceName={
                            workspaces.find(
                              (item) => item.id === todo.workspaceId,
                            )?.name
                          }
                        />
                      ))
                    )}
                  </div>
                </div>
                {selectedTodoId &&
                  todos.some((item) => item.id === selectedTodoId) && (
                    <TodoInspector
                      todo={todos.find((item) => item.id === selectedTodoId)!}
                      workspaces={workspaces}
                      onSaved={refresh}
                      onStart={start}
                      onClose={() => setSelectedTodoId(undefined)}
                    />
                  )}
              </div>
            </div>
          </section>
        )}
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="top-[38%] gap-0 p-3 sm:max-w-xl">
          <DialogTitle className="sr-only">新建 Todo</DialogTitle>
          <form
            className="overflow-hidden rounded-lg border border-border/60 bg-background focus-within:ring-1 focus-within:ring-ring/40"
            onSubmit={(event) => {
              event.preventDefault()
              void create()
            }}
          >
            <Textarea
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key !== 'Enter' ||
                event.shiftKey ||
                event.nativeEvent.isComposing
              )
                return
              event.preventDefault()
              void create()
            }}
            placeholder="输入任务内容，Enter 创建，Shift+Enter 换行"
            disabled={busy}
            autoFocus
            className="min-h-28 resize-y rounded-none border-0 bg-transparent px-3 py-3 text-lg shadow-none focus-visible:ring-0"
            />
            <div className="flex flex-wrap items-center gap-1 border-t border-border/60 bg-muted/20 p-1.5">
              <Input
                type="datetime-local"
                value={createDueAt}
                onChange={(event) => setCreateDueAt(event.target.value)}
                aria-label="计划完成时间"
                className="h-9 w-auto border-0 bg-transparent shadow-none hover:bg-muted/70"
              />
              <Select
                value={createPriority}
                onValueChange={(value) =>
                  setCreatePriority(value as PlanningTodo['priority'])
                }
              >
                <SelectTrigger className="h-9 w-auto gap-1.5 border-0 bg-transparent shadow-none hover:bg-muted/70">
                  <Flag />
                  <SelectValue>
                    {(value) =>
                      priorityLabel(value as PlanningTodo['priority'])
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {(['none', 'low', 'medium', 'high'] as const).map(
                    (value) => (
                      <SelectItem key={value} value={value}>
                        {priorityLabel(value)}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <WorkspaceSelect
                value={createWorkspaceId}
                onValueChange={setCreateWorkspaceId}
                workspaces={workspaces}
                className="h-9 w-auto max-w-52 gap-1.5 border-0 bg-transparent shadow-none hover:bg-muted/70"
              />
              <Button
                type="submit"
                size="sm"
                className="ml-auto h-9 px-4"
                disabled={busy || !title.trim()}
              >
                {busy ? '添加中…' : '添加'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingStartTodo !== undefined}
        onOpenChange={(open) => {
          if (!open && !startingTodoId) setPendingStartTodo(undefined)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>选择执行项目</DialogTitle>
            <DialogDescription>
              “{pendingStartTodo?.title}”尚未分配项目，运行 Agent 前请选择项目。
            </DialogDescription>
          </DialogHeader>
          {workspaces.length ? (
            <WorkspaceSelect
              value={startWorkspaceId}
              onValueChange={setStartWorkspaceId}
              workspaces={workspaces}
              allowUnassigned={false}
              className="w-full"
            />
          ) : (
            <div className="rounded-lg bg-muted/50 px-3 py-3 text-sm text-muted-foreground">
              暂无可用项目，请先在左侧栏创建项目。
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingStartTodo(undefined)}
              disabled={Boolean(startingTodoId)}
            >
              取消
            </Button>
            <Button
              disabled={
                !pendingStartTodo || !startWorkspaceId || Boolean(startingTodoId)
              }
              onClick={() => {
                if (pendingStartTodo && startWorkspaceId)
                  void startInWorkspace(pendingStartTodo, startWorkspaceId)
              }}
            >
              <Bot />
              {startingTodoId ? '启动中…' : '在此项目中运行'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TodoRow({
  todo,
  selected,
  onSelect,
  onAction,
  onStart,
  starting,
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
  starting: boolean
  workspaceName?: string
}) {
  const trashed = todo.deletedAt !== undefined
  return (
    <div
      className={cn(
        'group flex min-h-[68px] items-center gap-3 border-b border-border/50 px-4 py-3 transition-colors hover:bg-muted/30',
        selected && 'bg-primary/[0.06] hover:bg-primary/[0.08]',
      )}
      onClick={onSelect}
    >
      <Button
        variant={todo.status === 'completed' ? 'secondary' : 'outline'}
        size="icon-sm"
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
              ? 'truncate text-sm font-medium text-muted-foreground line-through'
              : 'truncate text-sm font-medium'
          }
        >
          {todo.title}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="rounded-md bg-muted px-1.5 py-0.5">
            {workspaceName ?? '未分配'}
          </span>
          {todo.priority !== 'none' && (
            <span
              className={cn(
                'rounded-md px-1.5 py-0.5',
                todo.priority === 'high'
                  ? 'bg-destructive/10 text-destructive'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
              )}
            >
              {priorityLabel(todo.priority)}
            </span>
          )}
          {(todo.dueDate || todo.dueAt) && (
            <span className="inline-flex items-center gap-1 px-1 py-0.5">
              <Clock3 className="size-3" />
              {todo.dueDate ?? new Date(todo.dueAt!).toLocaleString()}
            </span>
          )}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        title="开始或继续处理"
        className="opacity-70 group-hover:opacity-100"
        onClick={(event) => {
          event.stopPropagation()
          void onStart(todo)
        }}
        disabled={trashed || todo.status === 'completed' || starting}
      >
        {starting ? <Clock3 size={15} /> : <Play size={15} />}
      </Button>
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
  onStart,
  onClose,
}: {
  todo: PlanningTodo
  workspaces: Array<{ id: string; name: string }>
  onSaved: () => void
  onStart: (todo: PlanningTodo) => Promise<void>
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
      const result = await updatePlanningTodo({
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
      return result.todo
    } catch {
      dirtyRef.current = true
      dirtyTodoIdRef.current = todo.id
      setConflict(true)
      try {
        setServerTodo((await getPlanningTodo(todo.id)).todo)
      } catch {
        setServerTodo(null)
      }
      return undefined
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
  const run = async () => {
    const candidate = dirtyRef.current ? await save() : todo
    if (candidate) await onStart(candidate)
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
    <aside className="agent-message-scrollbar fixed inset-y-0 right-0 z-30 w-[min(380px,94vw)] overflow-auto border-l border-border/60 bg-[var(--surface-1)] shadow-xl xl:static xl:z-auto xl:w-[min(380px,40vw)] xl:shrink-0 xl:shadow-none">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border/60 bg-[var(--surface-1)] px-5 py-3">
        <h2 className="text-sm font-semibold">待办详情</h2>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {saving ? '保存中…' : saved ? '已保存' : `修订 ${todo.revision}`}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={onClose}
            aria-label="关闭详情"
          >
            <X size={14} />
          </Button>
        </div>
      </div>
      <div className="space-y-7 p-5">
        {conflict && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            保存冲突：本地草稿已保留。
            {serverTodo && (
              <div className="mt-1 text-muted-foreground">
                服务端：{serverTodo.title}（修订 {serverTodo.revision}）
              </div>
            )}
            <span className="mt-2 inline-flex gap-2">
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
          aria-label="Todo 标题"
          className="h-auto border-0 bg-transparent px-0 text-lg font-semibold shadow-none focus-visible:ring-0"
        />

        <TodoDetailField label="描述">
          <Textarea
            value={description}
            onChange={(event) => {
              setDescription(event.target.value)
              markDirty()
            }}
            onBlur={() => void save()}
            placeholder="添加描述…"
            className="min-h-40 resize-y border-0 bg-muted/35 shadow-none focus-visible:ring-2"
          />
        </TodoDetailField>

        <TodoDetailSection title="时间">
          <TodoDetailField label="截止日期">
            <Input
              type="date"
              value={dueDate}
              onChange={(event) => {
                setDueDate(event.target.value)
                if (event.target.value) setDueAt('')
                markDirty()
              }}
              onBlur={() => void save()}
              className="border-0 bg-muted/45 shadow-none"
            />
          </TodoDetailField>
          <TodoDetailField label="精确截止时间">
            <Input
              type="datetime-local"
              value={dueAt}
              onChange={(event) => {
                setDueAt(event.target.value)
                if (event.target.value) setDueDate('')
                markDirty()
              }}
              onBlur={() => void save()}
              className="border-0 bg-muted/45 shadow-none"
            />
          </TodoDetailField>
        </TodoDetailSection>

        <TodoDetailSection title="组织">
          <TodoDetailField label="优先级">
            <Select
              value={priority}
              onValueChange={(value) => {
                if (!value) return
                setPriority(value as PlanningTodo['priority'])
                markDirty()
              }}
            >
              <SelectTrigger className="w-full border-0 bg-muted/45 shadow-none">
                <SelectValue>
                  {(value) =>
                    priorityLabel(value as PlanningTodo['priority'])
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {(['none', 'low', 'medium', 'high'] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {priorityLabel(value)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </TodoDetailField>
        </TodoDetailSection>

        <TodoDetailSection title="项目与 Agent">
          <TodoDetailField label="执行项目">
            <WorkspaceSelect
              value={selectedWorkspaceId}
              onValueChange={(value) => {
                setSelectedWorkspaceId(value)
                markDirty()
              }}
              workspaces={workspaces}
              className="w-full border-0 bg-muted/45 shadow-none"
            />
          </TodoDetailField>
          <Button
            className="w-full"
            disabled={saving || conflict || todo.status === 'completed'}
            onClick={() => void run()}
          >
            <Bot />
            {selectedWorkspaceId === 'unassigned'
              ? '选择项目并运行 Agent'
              : '开始运行 Agent'}
          </Button>
        </TodoDetailSection>

        <TodoDetailSection title="提醒">
          <div className="flex gap-2">
            <Input
              type="datetime-local"
              value={reminderAt}
              onChange={(event) => setReminderAt(event.target.value)}
              aria-label="新增提醒时间"
              className="border-0 bg-muted/45 shadow-none"
            />
            <Button
              variant="outline"
              onClick={() => void addReminder()}
              disabled={!reminderAt || reminderSaving}
            >
              添加
            </Button>
          </div>
          <div className="space-y-1.5">
            {reminders.map((reminder) => (
              <div
                key={reminder.id}
                className="flex items-center gap-2 rounded-md bg-muted/35 px-2 py-1.5 text-xs"
              >
                <Clock3 className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {new Date(
                    reminder.snoozedUntil ?? reminder.triggerAt,
                  ).toLocaleString()}
                  {reminder.origin === 'todo_due_at'
                    ? ' · 跟随截止时间'
                    : ''}
                  {reminder.status !== 'pending'
                    ? ` · ${reminder.status}`
                    : ''}
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
        </TodoDetailSection>
      </div>
    </aside>
  )
}

function TodoDetailSection({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="space-y-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

function TodoDetailField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  )
}

function WorkspaceSelect({
  value,
  onValueChange,
  workspaces,
  allowUnassigned = true,
  className,
}: {
  value: string
  onValueChange: (value: string) => void
  workspaces: Array<{ id: string; name: string }>
  allowUnassigned?: boolean
  className?: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(nextValue) => {
        if (nextValue) onValueChange(nextValue)
      }}
    >
      <SelectTrigger className={className} aria-label="项目">
        <FolderKanban />
        <SelectValue placeholder="选择项目">
          {(selectedValue) =>
            selectedValue === 'unassigned'
              ? '未分配'
              : (workspaces.find(
                  (workspace) => workspace.id === selectedValue,
                )?.name ?? '选择项目')
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allowUnassigned && (
          <SelectItem value="unassigned">未分配</SelectItem>
        )}
        {workspaces.map((workspace) => (
          <SelectItem key={workspace.id} value={workspace.id}>
            {workspace.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function priorityLabel(priority: PlanningTodo['priority']): string {
  return {
    none: '无优先级',
    low: '低优先级',
    medium: '中优先级',
    high: '高优先级',
  }[priority]
}

function toLocalDateTimeInput(value: number): string {
  const date = new Date(value - new Date(value).getTimezoneOffset() * 60_000)
  return date.toISOString().slice(0, 16)
}
