import { useEffect, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { agentPlanStateAtom } from '@/atoms'
import { cn } from '@/lib/utils'
import { CheckCircle, Circle, Loader2, XCircle } from 'lucide-react'

interface PlanPanelProps {
  threadId: string
}

const statusIcon = {
  pending: <Circle size={13} className="text-foreground/30" />,
  in_progress: <Loader2 size={13} className="animate-spin text-blue-500" />,
  completed: <CheckCircle size={13} className="text-green-500" />,
  failed: <XCircle size={13} className="text-destructive" />,
}

export function PlanPanel({ threadId }: PlanPanelProps) {
  const planStates = useAtomValue(agentPlanStateAtom)
  const plan = planStates[threadId]
  const activeStepRef = useRef<HTMLDivElement>(null)

  // 自动滚动到当前执行步骤
  useEffect(() => {
    activeStepRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [plan?.steps])

  if (!plan?.steps?.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-foreground/30 text-[13px]">
        暂无 Plan
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 py-2.5 border-b border-border/50 text-[12px] font-medium text-foreground/60">
        Plan 步骤
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 scrollbar-none">
        {plan.steps.map((step) => (
          <div
            key={step.id}
            ref={step.status === 'in_progress' ? activeStepRef : undefined}
            className={cn(
              'flex items-start gap-2 px-2 py-2 rounded-lg text-[12px]',
              step.status === 'in_progress' && 'bg-blue-500/5 border border-blue-500/20',
              step.status === 'failed' && 'bg-destructive/5 border border-destructive/20'
            )}
          >
            <span className="mt-0.5 flex-shrink-0">{statusIcon[step.status]}</span>
            <div className="flex-1 min-w-0 space-y-1">
              <span className={cn(
                'block leading-relaxed',
                step.status === 'completed' ? 'text-foreground/40 line-through' : 'text-foreground/70'
              )}>
                {step.text}
              </span>
              {step.status === 'failed' && step.lastError && (
                <p className="text-[11px] text-destructive/80 leading-relaxed break-words">
                  {step.lastError}
                </p>
              )}
              {step.failCount > 0 && step.status !== 'completed' && (
                <p className="text-[10px] text-amber-600/70 dark:text-amber-400/70">
                  已失败 {step.failCount} 次
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
