import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createPlanningTodo } from '@/lib/desktop-api/planning-todo'
import { getCurrentWindow } from '@/lib/desktop-runtime/window'
import type { AgentWorkspace } from '@lume/shared'

export function QuickInputTodoCapture({ workspaces, workspaceId, initialTitle = '', onSaved }: { workspaces: AgentWorkspace[]; workspaceId: string | null; initialTitle?: string; onSaved: () => void }) {
  const [title, setTitle] = useState(initialTitle)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(workspaceId ?? 'unassigned')
  const [priority, setPriority] = useState<'none' | 'low' | 'medium' | 'high'>('none')
  const [dueDate, setDueDate] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!title.trim()) return
    setBusy(true)
    try {
      const result = await createPlanningTodo({
        title: title.trim(),
        priority,
        workspaceId: selectedWorkspaceId === 'unassigned' ? undefined : selectedWorkspaceId,
        ...(dueDate ? { dueDate } : {}),
        ...(dueAt ? { dueAt: new Date(dueAt).getTime(), dueTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
      })
      // 同 TodoView：去重时保留输入并提示，避免无声成功（见 #19）
      if (result.deduplicated) {
        toast.info('已存在相同标题的待办，未重复创建。请修改标题后重试。')
        return
      }
      setTitle('')
      onSaved()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '待办保存失败')
    } finally {
      setBusy(false)
    }
  }
  return <div className="flex w-full max-w-xl flex-col gap-3 p-5"><div><h2 className="text-base font-semibold">记录待办</h2><p className="text-xs text-muted-foreground">直接保存到 Planning Todo，不调用模型。</p></div><Input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void save(); if (event.key === 'Escape') void getCurrentWindow().close() }} placeholder="要记下什么？" disabled={busy} /><Select value={selectedWorkspaceId} onValueChange={(value) => { if (value) setSelectedWorkspaceId(value) }}><SelectTrigger><SelectValue placeholder="项目" /></SelectTrigger><SelectContent><SelectItem value="unassigned">未分配</SelectItem>{workspaces.map((workspace) => <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>)}</SelectContent></Select><Select value={priority} onValueChange={(value) => setPriority(value as typeof priority)}><SelectTrigger><SelectValue placeholder="优先级" /></SelectTrigger><SelectContent>{(['none', 'low', 'medium', 'high'] as const).map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select><div className="flex gap-2"><Input type="date" value={dueDate} onChange={(event) => { setDueDate(event.target.value); if (event.target.value) setDueAt('') }} aria-label="截止日期" /><Input type="datetime-local" value={dueAt} onChange={(event) => { setDueAt(event.target.value); if (event.target.value) setDueDate('') }} aria-label="截止时间" /></div><Button onClick={() => void save()} disabled={busy || !title.trim()}>保存待办</Button></div>
}
