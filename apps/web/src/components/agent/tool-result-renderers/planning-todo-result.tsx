import { completePlanningTodo, deletePlanningTodo, reopenPlanningTodo, restorePlanningTodo, updatePlanningTodo } from '@/lib/desktop-api/planning-todo'
import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { ExternalLink, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentWorkspacesAtom, activeTabIdAtom, tabsAtom } from '@/atoms'
import { toast } from 'sonner'
import { DefaultResult } from './default-result'

interface Props { toolName: string; input: Record<string, unknown>; result: unknown }

interface TodoLike {
  id?: string
  title?: string
  status?: string
  priority?: string
  dueDate?: string
  dueAt?: number
  dueTimezone?: string
  workspaceId?: string
  revision?: number
  description?: string
}

type TodoPayload = { schemaVersion?: unknown; operation?: string; todo?: TodoLike; previous?: TodoLike; items?: TodoLike[]; data?: { todo?: TodoLike; items?: TodoLike[] } }

export function PlanningTodoResult({ toolName, input, result }: Props) {
  const payload = result && typeof result === 'object' ? result as TodoPayload : undefined
  if (payload?.schemaVersion !== 1) return <DefaultResult toolName={toolName} input={input} result={result} />
  return <PlanningTodoResultBody toolName={toolName} payload={payload} />
}

function PlanningTodoResultBody({ toolName, payload }: { toolName: string; payload: TodoPayload }) {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const tabs = useAtomValue(tabsAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const [undoing, setUndoing] = useState(false)
  const singleTodo = payload.todo ?? payload.data?.todo
  const todos: TodoLike[] = payload.items ?? payload.data?.items ?? (singleTodo ? [singleTodo] : [])
  if (todos.length === 0) return <span className="text-xs text-muted-foreground">{toolName}：无匹配待办</span>
  return (
    <div className="space-y-1.5">
      {todos.map((todo, index) => (
        <div key={todo.id ?? index} className="rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className={todo.status === 'completed' ? 'text-muted-foreground line-through' : 'text-foreground'}>{todo.title ?? '未命名待办'}</span>
            {todo.priority && <span className="text-muted-foreground">{todo.priority}</span>}
          </div>
          {(todo.dueDate || todo.dueAt || todo.workspaceId) && <div className="mt-1 text-muted-foreground">{todo.dueDate ?? (todo.dueAt ? new Date(todo.dueAt).toLocaleString() : '无截止日期')} · {todo.workspaceId ? workspaces.find((workspace) => workspace.id === todo.workspaceId)?.name ?? '其他项目' : '未分配'}</div>}
          {todo.id && <div className="mt-2 flex gap-1.5">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => { const existing = tabs.find((tab) => tab.type === 'todo' && tab.todoId === todo.id); const tabId = existing?.id ?? `todo:${todo.id}`; if (!existing) setTabs((current) => [...current, { id: tabId, type: 'todo', title: todo.title ?? '待办', workspaceId: todo.workspaceId, todoId: todo.id }]); setActiveTabId(tabId) }}><ExternalLink size={12} />打开</Button>
            {(payload.previous || payload.operation === 'create') && todo.revision !== undefined && <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" disabled={undoing} onClick={() => { void undoPlanningTodo(payload.operation, todo, payload.previous ?? {}, setUndoing) }}><Undo2 size={12} />撤销</Button>}
          </div>}
        </div>
      ))}
    </div>
  )
}

async function undoPlanningTodo(operation: string | undefined, todo: TodoLike, previous: TodoLike, setUndoing: (value: boolean) => void): Promise<void> {
  if (!todo.id || todo.revision === undefined) return
  setUndoing(true)
  try {
    if (operation === 'create') await deletePlanningTodo({ todoId: todo.id, expectedRevision: todo.revision })
    else if (operation === 'complete') await reopenPlanningTodo({ todoId: todo.id, expectedRevision: todo.revision })
    else if (operation === 'reopen') await completePlanningTodo({ todoId: todo.id, expectedRevision: todo.revision })
    else if (operation === 'delete') await restorePlanningTodo({ todoId: todo.id, expectedRevision: todo.revision })
    else if (operation === 'restore') await deletePlanningTodo({ todoId: todo.id, expectedRevision: todo.revision })
    else if (operation === 'update') await updatePlanningTodo({ todoId: todo.id, expectedRevision: todo.revision, patch: { title: previous.title, description: previous.description ?? null, priority: previous.priority as never, workspaceId: previous.workspaceId ?? null, dueDate: previous.dueDate ?? null, dueAt: previous.dueAt ?? null, dueTimezone: previous.dueTimezone ?? null } })
    else return
    toast.success('已撤销 Planning Todo 操作')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '撤销失败，Todo 可能已被更新')
  } finally { setUndoing(false) }
}
