import { Play, Pencil, Trash2, Clock, Loader2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { AutomationJob, AutomationRun } from '@lume/shared'

interface AutomationJobCardProps {
  job: AutomationJob
  runs: AutomationRun[]
  workspaces: { id: string; name: string; slug: string }[]
  onToggle: (id: string) => void
  onEdit: (job: AutomationJob) => void
  onDelete: (id: string) => void
  onRunNow: (id: string) => void
  loading: boolean
}

function describeSchedule(job: AutomationJob): string {
  const s = job.schedule
  if (s.type === 'cron') return `Cron: ${s.cronExpr}`
  if (s.type === 'once') return `一次性: ${new Date(s.runAt ?? 0).toLocaleString('zh-CN')}`
  if (s.type === 'manual') return '手动运行'
  if (s.type === 'interval') {
    const mins = Math.round((s.intervalMs ?? 0) / 60000)
    return `间隔: ${mins >= 60 ? `${Math.round(mins / 60)}小时` : `${mins}分钟`}`
  }
  return '未知调度'
}

function lastRunSummary(runs: AutomationRun[], jobId: string): string | null {
  const jobRuns = runs.filter(r => r.jobId === jobId)
  if (jobRuns.length === 0) return null
  const last = jobRuns[0]
  const time = new Date(last.startedAt).toLocaleString('zh-CN')
  const statusText = last.status === 'success' ? '成功' : last.status === 'failed' ? '失败' : '跳过'
  return `${time} · ${statusText}`
}

export function AutomationJobCard({ job, runs, workspaces, onToggle, onEdit, onDelete, onRunNow, loading }: AutomationJobCardProps) {
  const ws = workspaces.find(w => w.id === job.workspaceId)
  return (
    <div className="rounded-xl border border-border/50 bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground truncate">{job.name}</span>
            {!job.enabled && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">已禁用</Badge>
            )}
          </div>
          <p className="text-[12px] text-foreground/50">{describeSchedule(job)}</p>
        </div>
        <Switch
          checked={job.enabled}
          onCheckedChange={() => onToggle(job.id)}
          disabled={loading}
        />
      </div>

      <div className="flex items-center gap-3 text-[11px] text-foreground/40">
        <span className="flex items-center gap-1"><Clock size={11} /> {ws ? ws.name : '未绑定工作区'}</span>
        {lastRunSummary(runs, job.id) && (
          <span className="truncate">上次: {lastRunSummary(runs, job.id)}</span>
        )}
      </div>

      <p className="text-[12px] text-foreground/60 line-clamp-2">{job.prompt}</p>

      <div className="flex items-center gap-1.5 pt-1">
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onRunNow(job.id)} disabled={loading || !job.enabled}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
          执行
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onEdit(job)}>
          <Pencil size={12} />
          编辑
        </Button>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-destructive hover:text-destructive" onClick={() => onDelete(job.id)}>
          <Trash2 size={12} />
          删除
        </Button>
      </div>
    </div>
  )
}
