import { useSetAtom } from 'jotai'
import { ClipboardCheck } from 'lucide-react'
import { agentPendingInteractiveAtom } from '@/atoms'
import { submitPlanApproval } from '@/lib/desktop-api'
import { removePendingPlanApproval } from '@/hooks/pending-interactive-state'
import type { AgentPlanApprovalRequest } from '@lume/shared'

interface PlanApprovalBannerProps {
  threadId: string
  request: AgentPlanApprovalRequest
}

export function PlanApprovalBanner({ threadId, request }: PlanApprovalBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)

  const respond = async (decision: 'approve' | 'reject') => {
    const result = await submitPlanApproval({
      threadId,
      planId: request.planId,
      decision,
      execute: decision === 'approve',
    })
    if (result.ok) {
      setPending((prev) => removePendingPlanApproval(prev, threadId, request.planId))
    }
  }

  return (
    <div className="mx-4 mb-3 animate-in rounded-xl border border-amber-500/24 bg-amber-500/[0.06] shadow-lg slide-in-from-bottom-2 duration-200">
      <div className="flex items-start gap-3 p-3">
        <ClipboardCheck size={16} className="mt-0.5 flex-shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{request.title}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/60">
            {request.summary || request.message}
          </p>
          <p className="mt-1 text-[11px] text-foreground/45">
            {request.stepCount} 个步骤等待批准
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-3">
        <button
          type="button"
          onClick={() => void respond('approve')}
          className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          批准并执行
        </button>
        <button
          type="button"
          onClick={() => void respond('reject')}
          className="rounded-lg px-3 py-1.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10"
        >
          拒绝
        </button>
      </div>
    </div>
  )
}
