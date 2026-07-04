import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { ClipboardCheck, FileText } from 'lucide-react'
import { agentPendingInteractiveAtom } from '@/atoms'
import { submitTaskApproval } from '@/lib/desktop-api'
import { removePendingTaskApproval } from '@/hooks/pending-interactive-state'
import type { AgentTaskApprovalRequest } from '@lume/shared'

import { Button } from '@/components/ui/button'
interface TaskApprovalBannerProps {
  threadId: string
  request: AgentTaskApprovalRequest
  onOpenPlan?: () => void
}

export function TaskApprovalBanner({ threadId, request, onOpenPlan }: TaskApprovalBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [busy, setBusy] = useState(false)

  const approveAndExecute = async () => {
    setBusy(true)
    try {
      const result = await submitTaskApproval({
        threadId,
        contractId: request.contractId,
        decision: 'approve',
        execute: true,
      })
      if (result.ok) {
        setPending((prev) => removePendingTaskApproval(prev, threadId, request.contractId))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-4 mb-3 animate-in rounded-xl border border-amber-500/24 bg-amber-500/[0.06] shadow-lg slide-in-from-bottom-2 duration-200">
      <div className="flex items-start gap-3 p-3">
        <ClipboardCheck size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">等待审阅计划</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/60">
            {request.summary || request.message}
          </p>
          <p className="mt-1 text-[11px] text-foreground/45">
            计划等待审阅；修改意见可直接发到聊天框
          </p>
          {request.planFilePath && (
            <p className="mt-1 truncate text-[11px] text-foreground/50">
              计划文件：<span className="font-mono">{request.planFilePath}</span>
              {request.planVerified ? <span className="ml-1 text-emerald-600">已验证</span> : null}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 pb-3">
        {request.planFilePath && (
          <Button
                variant="ghost"
            type="button"
            onClick={onOpenPlan}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
            title={request.planFilePath}
          >
            <FileText size={12} />
            查看计划
          </Button>
        )}
        <div className="flex-1" />
        <Button
                variant="ghost"
          type="button"
          onClick={() => void approveAndExecute()}
          disabled={busy}
          className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          继续执行
        </Button>
      </div>
    </div>
  )
}
