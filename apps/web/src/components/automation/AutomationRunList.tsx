import { CheckCircle2, XCircle, MinusCircle, ExternalLink, Clock3 } from 'lucide-react'
import type { AutomationRun, AutomationRunStatus } from '@lume/shared'

interface AutomationRunListProps {
  runs: AutomationRun[]
  onViewThread?: (threadId: string) => void
}

const statusConfig: Record<AutomationRunStatus, {
  icon: typeof CheckCircle2
  label: string
  color: string
}> = {
  success: { icon: CheckCircle2, label: '成功', color: 'text-green-500' },
  failed: { icon: XCircle, label: '失败', color: 'text-red-500' },
  skipped: { icon: MinusCircle, label: '跳过', color: 'text-yellow-500' },
  waiting_for_approval: { icon: Clock3, label: '等待确认', color: 'text-amber-500' },
}

export function AutomationRunList({ runs, onViewThread }: AutomationRunListProps) {
  if (runs.length === 0) {
    return (
      <div className="py-8 text-center text-[12px] text-foreground/40">
        暂无执行记录
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {runs.map(run => {
        const cfg = statusConfig[run.status] ?? statusConfig.skipped
        const Icon = cfg.icon
        return (
          <div
            key={run.id}
            className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-foreground/[0.02] text-[12px] group"
          >
            <Icon size={13} className={cfg.color} />
            <span className="text-foreground/70 truncate flex-1">{run.jobName}</span>
            <span className={`text-[11px] ${cfg.color}`}>{cfg.label}</span>
            <span className="text-foreground/40">
              {new Date(run.startedAt).toLocaleString('zh-CN')}
            </span>
            {run.threadId && onViewThread && (
              <button
                onClick={() => onViewThread(run.threadId!)}
                className="opacity-0 group-hover:opacity-100 transition-opacity text-foreground/40 hover:text-foreground"
              >
                <ExternalLink size={12} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
