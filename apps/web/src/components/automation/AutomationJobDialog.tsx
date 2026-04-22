import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { AutomationJob } from '@lume/shared'

type ScheduleMode = 'preset' | 'cron' | 'once'

const PRESET_OPTIONS = [
  { value: 'hourly', label: '每小时', cron: '0 * * * *' },
  { value: 'daily', label: '每天 (09:00)', cron: '0 9 * * *' },
  { value: 'weekly', label: '每周一 (09:00)', cron: '0 9 * * 1' },
  { value: 'monthly', label: '每月1号 (09:00)', cron: '0 9 1 * *' },
]

interface AutomationJobDialogProps {
  open: boolean
  job?: AutomationJob | null
  workspaces: { id: string; name: string; slug: string }[]
  onSubmit: (data: {
    name: string
    prompt: string
    workspaceId: string
    schedule: { type: string; cronExpr?: string; runAt?: number }
  }) => void
  onCancel: () => void
}

export function AutomationJobDialog({ open, job, workspaces, onSubmit, onCancel }: AutomationJobDialogProps) {
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('preset')
  const [preset, setPreset] = useState('daily')
  const [cronExpr, setCronExpr] = useState('0 9 * * *')
  const [runAtDate, setRunAtDate] = useState('')

  useEffect(() => {
    if (job) {
      setName(job.name)
      setPrompt(job.prompt)
      setWorkspaceId(job.workspaceId ?? '')
      if (job.schedule.type === 'once') {
        setScheduleMode('once')
        setRunAtDate(new Date(job.schedule.runAt ?? Date.now()).toISOString().slice(0, 16))
      } else if (job.schedule.type === 'cron') {
        const matching = PRESET_OPTIONS.find(p => p.cron === job.schedule.cronExpr)
        if (matching) {
          setScheduleMode('preset')
          setPreset(matching.value)
        } else {
          setScheduleMode('cron')
          setCronExpr(job.schedule.cronExpr ?? '')
        }
      }
    } else {
      setName('')
      setPrompt('')
      setWorkspaceId(workspaces[0]?.id ?? '')
      setScheduleMode('preset')
      setPreset('daily')
    }
  }, [job, open, workspaces])

  if (!open) return null

  const handleSubmit = () => {
    if (!name.trim() || !prompt.trim()) return
    let schedule: { type: string; cronExpr?: string; runAt?: number }
    if (scheduleMode === 'preset') {
      const opt = PRESET_OPTIONS.find(p => p.value === preset)
      schedule = { type: 'cron', cronExpr: opt?.cron ?? '0 9 * * *' }
    } else if (scheduleMode === 'cron') {
      schedule = { type: 'cron', cronExpr }
    } else {
      schedule = { type: 'once', runAt: new Date(runAtDate).getTime() }
    }
    onSubmit({ name: name.trim(), prompt: prompt.trim(), workspaceId, schedule })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="w-full max-w-lg rounded-2xl border border-border/50 bg-card shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-border/50">
          <h3 className="text-[14px] font-medium">{job ? '编辑任务' : '新建任务'}</h3>
          <button onClick={onCancel} className="text-foreground/40 hover:text-foreground"><X size={16} /></button>
        </div>
        <div className="p-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-[12px]">任务名称</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日 PR 总结" className="text-[13px] h-8" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px]">工作区</Label>
            <select
              value={workspaceId}
              onChange={e => setWorkspaceId(e.target.value)}
              className="w-full h-8 rounded-md border border-input bg-background px-3 text-[13px]"
            >
              <option value="">不绑定工作区</option>
              {workspaces.map(ws => (
                <option key={ws.id} value={ws.id}>{ws.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px]">执行内容</Label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="Agent 执行的 prompt"
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px]">调度方式</Label>
            <div className="flex gap-1.5">
              {(['preset', 'cron', 'once'] as ScheduleMode[]).map(mode => (
                <button
                  key={mode}
                  onClick={() => setScheduleMode(mode)}
                  className={`px-3 py-1.5 rounded-lg text-[12px] transition-colors ${
                    scheduleMode === mode
                      ? 'bg-foreground/[0.08] text-foreground font-medium'
                      : 'text-foreground/50 hover:bg-foreground/[0.04]'
                  }`}
                >
                  {mode === 'preset' ? '预设频率' : mode === 'cron' ? 'Cron' : '一次性'}
                </button>
              ))}
            </div>
            {scheduleMode === 'preset' && (
              <select
                value={preset}
                onChange={e => setPreset(e.target.value)}
                className="w-full h-8 rounded-md border border-input bg-background px-3 text-[13px]"
              >
                {PRESET_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            )}
            {scheduleMode === 'cron' && (
              <Input value={cronExpr} onChange={e => setCronExpr(e.target.value)} placeholder="0 9 * * *" className="text-[13px] h-8 font-mono" />
            )}
            {scheduleMode === 'once' && (
              <Input type="datetime-local" value={runAtDate} onChange={e => setRunAtDate(e.target.value)} className="text-[13px] h-8" />
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border/50">
          <Button variant="ghost" size="sm" onClick={onCancel} className="text-[12px]">取消</Button>
          <Button size="sm" onClick={handleSubmit} disabled={!name.trim() || !prompt.trim()} className="text-[12px]">
            {job ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  )
}
