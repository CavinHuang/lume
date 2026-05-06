import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { ClipboardCheck, FileText, Send, X } from 'lucide-react'
import { agentPendingInteractiveAtom } from '@/atoms'
import { submitTaskApproval } from '@/lib/desktop-api'
import { removePendingTaskApproval } from '@/hooks/pending-interactive-state'
import type { AgentTaskApprovalRequest } from '@lume/shared'

interface TaskApprovalBannerProps {
  threadId: string
  request: AgentTaskApprovalRequest
}

export function TaskApprovalBanner({ threadId, request }: TaskApprovalBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)

  const respond = async (decision: 'approve' | 'reject', feedbackText?: string) => {
    setBusy(true)
    try {
      const result = await submitTaskApproval({
        threadId,
        contractId: request.contractId,
        decision,
        execute: decision === 'approve',
        ...(feedbackText ? { feedback: feedbackText } : {}),
      })
      if (result.ok) {
        setPending((prev) => removePendingTaskApproval(prev, threadId, request.contractId))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleSubmitFeedback = () => {
    if (!feedback.trim()) return
    void respond('reject', feedback.trim())
  }

  return (
    <div className="mx-4 mb-3 animate-in rounded-xl border border-amber-500/24 bg-amber-500/[0.06] shadow-lg slide-in-from-bottom-2 duration-200">
      <div className="flex items-start gap-3 p-3">
        <ClipboardCheck size={16} className="mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground">{request.title}</p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/60">
            {request.summary || request.message}
          </p>
          <p className="mt-1 text-[11px] text-foreground/45">
            {request.stepCount} 个任务等待批准
          </p>
        </div>
      </div>

      {showFeedback && (
        <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border/60 bg-background/80 px-2.5 py-2">
          <input
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmitFeedback()
              if (e.key === 'Escape') { setShowFeedback(false); setFeedback('') }
            }}
            placeholder="输入拒绝原因和修改建议..."
            className="flex-1 bg-transparent text-[12px] text-foreground outline-none placeholder:text-foreground/35"
            autoFocus
          />
          <button
            type="button"
            onClick={handleSubmitFeedback}
            disabled={!feedback.trim() || busy}
            className="flex size-6 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
          >
            <Send size={12} />
          </button>
          <button
            type="button"
            onClick={() => { setShowFeedback(false); setFeedback('') }}
            className="flex size-6 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 px-3 pb-3">
        {request.planFilePath && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[12px] text-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
            title={request.planFilePath}
          >
            <FileText size={12} />
            查看计划
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => setShowFeedback(true)}
          disabled={busy}
          className="rounded-lg px-3 py-1.5 text-[12px] text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
        >
          拒绝
        </button>
        <button
          type="button"
          onClick={() => void respond('approve')}
          disabled={busy}
          className="rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          批准并执行
        </button>
      </div>
    </div>
  )
}
