import { useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { agentPendingInteractiveAtom } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { getPendingInteractive, listStructuredPlans, resumeAgentRun, submitPlanApproval } from '@/lib/desktop-api'
import { CheckCircle, Circle, Loader2, XCircle } from 'lucide-react'
import { buildStructuredPlanSteps } from './runtime-state-projections'
import { removePendingPlanApproval, upsertPendingPlanApproval } from '@/hooks/pending-interactive-state'
import type { AgentStructuredPlan, PlanStep } from '@lume/shared'

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
  const pendingInteractive = useAtomValue(agentPendingInteractiveAtom)[threadId]
  const setPendingInteractive = useSetAtom(agentPendingInteractiveAtom)
  const activeStepRef = useRef<HTMLDivElement>(null)
  const [structuredSteps, setStructuredSteps] = useState<PlanStep[]>([])
  const [structuredPlans, setStructuredPlans] = useState<AgentStructuredPlan[]>([])
  const [approvalBusy, setApprovalBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void listStructuredPlans({ threadId })
      .then((result) => {
        if (!cancelled) {
          setStructuredPlans(result.plans)
          setStructuredSteps(buildStructuredPlanSteps(result.plans))
        }
      })
      .catch((error) => {
        console.error('[PlanPanel] 加载结构化 Plan 失败:', error)
        if (!cancelled) setStructuredSteps([])
      })
    return () => {
      cancelled = true
    }
  }, [threadId])

  useEffect(() => {
    let cancelled = false
    void getPendingInteractive({ threadId })
      .then((states) => {
        if (cancelled) return
        setPendingInteractive((prev) => {
          let next = prev
          for (const state of states) {
            for (const request of state.planApprovals ?? []) {
              next = upsertPendingPlanApproval(next, request)
            }
          }
          return next
        })
      })
      .catch((error) => console.error('[PlanPanel] 加载 plan approval 失败:', error))
    return () => {
      cancelled = true
    }
  }, [setPendingInteractive, threadId])

  const steps = structuredSteps
  const latestStructuredPlan = [...structuredPlans].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]
  const pendingPlanApproval = pendingInteractive?.planApprovals?.find((item) => (
    item.planId === latestStructuredPlan?.id
  ))

  const resolveApproval = async (decision: 'approve' | 'reject') => {
    if (!pendingPlanApproval) return
    setApprovalBusy(true)
    try {
      const result = await submitPlanApproval({
        threadId,
        planId: pendingPlanApproval.planId,
        decision,
      })
      if (result.ok) {
        setPendingInteractive((prev) => removePendingPlanApproval(prev, threadId, pendingPlanApproval.planId))
        setStructuredPlans((prev) => prev.map((item) => item.id === pendingPlanApproval.planId
          ? {
              ...item,
              status: decision === 'approve' ? 'approved' : 'cancelled',
              approvedAt: decision === 'approve' ? new Date().toISOString() : item.approvedAt,
              updatedAt: new Date().toISOString(),
            }
          : item))
        if (decision === 'approve') {
          void resumeAgentRun({ threadId, runId: pendingPlanApproval.runId })
            .catch((error) => console.error('[PlanPanel] plan approval 后 resume 失败:', error))
        }
      }
    } catch (error) {
      console.error('[PlanPanel] 提交 plan approval 失败:', error)
    } finally {
      setApprovalBusy(false)
    }
  }

  // 自动滚动到当前执行步骤
  useEffect(() => {
    activeStepRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [steps])

  if (!steps.length) {
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
      {pendingPlanApproval && (
        <div className="border-b border-border/50 bg-amber-500/[0.055] px-3 py-2">
          <div className="text-[12px] font-medium text-foreground/70">{pendingPlanApproval.title}</div>
          <p className="mt-1 text-[11px] leading-relaxed text-foreground/45">
            {pendingPlanApproval.message}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={approvalBusy}
              onClick={() => void resolveApproval('approve')}
              className="rounded-md bg-green-500/12 px-2 py-1 text-[11px] font-medium text-green-600 transition-colors hover:bg-green-500/18 disabled:opacity-50"
            >
              批准执行
            </button>
            <button
              type="button"
              disabled={approvalBusy}
              onClick={() => void resolveApproval('reject')}
              className="rounded-md bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
        </div>
      )}
      <ScrollArea className="flex-1 min-h-0">
        <div className="space-y-1 px-3 py-2">
          {steps.map((step) => (
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
      </ScrollArea>
    </div>
  )
}
