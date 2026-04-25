import { useState, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentWorkspacesAtom } from '@/atoms'
import { automationJobsAtom, automationRunsAtom } from '@/atoms/automation-atoms'
import { useAutomationListeners } from '@/hooks/useAutomationListeners'
import {
  createAutomationJob,
  updateAutomationJob,
  deleteAutomationJob,
  toggleAutomationJob,
  runAutomationJobNow,
} from '@/lib/desktop-api/automation'
import { AutomationJobCard } from './AutomationJobCard'
import { AutomationJobDialog } from './AutomationJobDialog'
import { AutomationRunList } from './AutomationRunList'
import type { AutomationJob, AutomationSchedule } from '@lume/shared'

type AutomationJobFormData = {
  name: string
  prompt: string
  workspaceId: string
  schedule: AutomationSchedule
}

export function AutomationSettings() {
  useAutomationListeners()

  const workspaces = useAtomValue(agentWorkspacesAtom)
  const jobs = useAtomValue(automationJobsAtom)
  const runs = useAtomValue(automationRunsAtom)
  const [loading, setLoading] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingJob, setEditingJob] = useState<AutomationJob | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const wsList = workspaces.map(w => ({ id: w.id, name: w.name, slug: w.slug }))

  const handleToggle = useCallback(async (id: string) => {
    setLoading(true)
    try {
      await toggleAutomationJob(id)
    } catch (error) {
      console.error('[自动化] 切换失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleCreate = useCallback(async (data: AutomationJobFormData) => {
    setLoading(true)
    try {
      await createAutomationJob(data)
      setDialogOpen(false)
    } catch (error) {
      console.error('[自动化] 创建失败:', error)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleEdit = useCallback(async (data: AutomationJobFormData) => {
    if (!editingJob) return
    setLoading(true)
    try {
      await updateAutomationJob({
        id: editingJob.id,
        name: data.name,
        prompt: data.prompt,
        workspaceId: data.workspaceId || undefined,
        schedule: data.schedule,
      })
      setDialogOpen(false)
      setEditingJob(null)
    } catch (error) {
      console.error('[自动化] 更新失败:', error)
    } finally {
      setLoading(false)
    }
  }, [editingJob])

  const handleDelete = useCallback(async (id: string) => {
    setDeletingId(id)
    try {
      await deleteAutomationJob(id)
    } catch (error) {
      console.error('[自动化] 删除失败:', error)
    } finally {
      setDeletingId(null)
    }
  }, [])

  const handleRunNow = useCallback(async (id: string) => {
    try {
      await runAutomationJobNow(id)
    } catch (error) {
      console.error('[自动化] 执行失败:', error)
    }
  }, [])

  const openCreate = () => {
    setEditingJob(null)
    setDialogOpen(true)
  }

  const openEdit = (job: AutomationJob) => {
    setEditingJob(job)
    setDialogOpen(true)
  }

  const handleDialogSubmit = editingJob ? handleEdit : handleCreate

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-[15px] font-medium">自动化</h2>
          <p className="text-[12px] text-foreground/50 mt-0.5">管理定时任务和工作流自动化</p>
        </div>
        <Button size="sm" onClick={openCreate} className="text-[12px] h-8">
          <Plus size={14} />
          新建任务
        </Button>
      </div>

      {jobs.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-[13px] text-foreground/40">暂无自动化任务</p>
          <p className="text-[12px] text-foreground/30 mt-1">点击"新建任务"或在对话中让 Agent 帮你创建</p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => (
            <AutomationJobCard
              key={job.id}
              job={job}
              runs={runs}
              workspaces={wsList}
              onToggle={handleToggle}
              onEdit={openEdit}
              onDelete={handleDelete}
              onRunNow={handleRunNow}
              loading={loading || deletingId === job.id}
            />
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-[13px] font-medium text-foreground/70">执行历史</h3>
        <AutomationRunList runs={runs} />
      </div>

      <AutomationJobDialog
        open={dialogOpen}
        job={editingJob}
        workspaces={wsList}
        onSubmit={handleDialogSubmit}
        onCancel={() => { setDialogOpen(false); setEditingJob(null) }}
      />
    </div>
  )
}
