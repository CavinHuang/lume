import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Check, CornerDownLeft, Loader2 } from 'lucide-react'
import { agentPendingInteractiveAtom } from '@/atoms'
import { submitTaskApproval } from '@/lib/desktop-api'
import { removePendingTaskApproval } from '@/hooks/pending-interactive-state'
import { cn } from '@/lib/utils'
import type { AgentTaskApprovalRequest, AgentTaskApprovalResponseInput } from '@lume/shared'

type PlanApprovalChoice = 'approve' | 'revise'

interface PlanApprovalOverlayProps {
  threadId: string
  request: AgentTaskApprovalRequest
  onVisibilityChange?: (visible: boolean) => void
}

export function buildPlanApprovalSubmission(input: {
  threadId: string
  contractId: string
  choice: PlanApprovalChoice
  feedback: string
}): AgentTaskApprovalResponseInput | null {
  if (input.choice === 'approve') {
    return {
      threadId: input.threadId,
      contractId: input.contractId,
      decision: 'approve',
      execute: true,
    }
  }

  const feedback = input.feedback.trim()
  if (!feedback) return null
  return {
    threadId: input.threadId,
    contractId: input.contractId,
    decision: 'reject',
    feedback,
  }
}

export function PlanApprovalOverlay({ threadId, request, onVisibilityChange }: PlanApprovalOverlayProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [choice, setChoice] = useState<PlanApprovalChoice>('approve')
  const [feedback, setFeedback] = useState('')
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedbackRequired, setFeedbackRequired] = useState(false)

  useEffect(() => {
    setChoice('approve')
    setFeedback('')
    setHidden(false)
    setFeedbackRequired(false)
    onVisibilityChange?.(true)
  }, [threadId, request.contractId])

  useEffect(() => {
    onVisibilityChange?.(!hidden)
  }, [hidden, onVisibilityChange])

  useEffect(() => {
    if (hidden || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setHidden(true)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hidden])

  const submit = async () => {
    const payload = buildPlanApprovalSubmission({
      threadId,
      contractId: request.contractId,
      choice,
      feedback,
    })
    if (!payload) {
      setFeedbackRequired(true)
      setChoice('revise')
      return
    }

    setBusy(true)
    try {
      const result = await submitTaskApproval(payload)
      if (result.ok) {
        setPending((prev) => removePendingTaskApproval(prev, threadId, request.contractId))
      }
    } finally {
      setBusy(false)
    }
  }

  if (hidden) return null

  return (
    <div className="px-4 pb-3 sm:px-8">
      <section className="mx-auto max-w-[960px] rounded-[28px] border border-black/10 bg-white p-4 shadow-[0_20px_80px_rgba(15,23,42,0.18)]">
        <h3 className="px-1 pb-4 text-[18px] font-semibold leading-7 text-[#1f232b]">实施此计划?</h3>

        <div className="space-y-1.5">
          <button
            type="button"
            onClick={() => {
              setChoice('approve')
              setFeedbackRequired(false)
            }}
            className={cn(
              'flex min-h-12 w-full items-center rounded-[14px] px-3 text-left text-[15px] transition-colors',
              choice === 'approve' ? 'bg-[#f1f1f3] text-[#1f232b]' : 'text-[#8a8f98] hover:bg-[#f6f6f7]',
            )}
          >
            <span className="w-9 shrink-0 text-[16px] text-[#8a8f98]">1.</span>
            <span className="flex min-w-0 flex-1 items-center gap-2 font-semibold">
              是，实施此计划
              {choice === 'approve' && <Check size={16} className="text-[#5f9cff]" />}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setChoice('revise')}
            className={cn(
              'flex min-h-12 w-full items-center rounded-[14px] px-3 text-left text-[15px] transition-colors',
              choice === 'revise' ? 'bg-[#f1f1f3] text-[#1f232b]' : 'text-[#8a8f98] hover:bg-[#f6f6f7]',
            )}
          >
            <span className="w-9 shrink-0 text-[16px] text-[#b0b4bc]">2.</span>
            <span className="min-w-0 flex-1 font-semibold">否，请告知 Lume 如何调整</span>
          </button>

          {choice === 'revise' && (
            <div className="pl-12 pr-1 pt-2">
              <textarea
                value={feedback}
                onChange={(event) => {
                  setFeedback(event.target.value)
                  setFeedbackRequired(false)
                }}
                placeholder="写下你希望 Lume 调整的方向"
                className={cn(
                  'min-h-24 w-full resize-y rounded-[14px] border bg-white px-3 py-2 text-[14px] leading-6 text-[#1f232b] outline-none transition-colors placeholder:text-[#a2a7b0]',
                  feedbackRequired ? 'border-destructive/60' : 'border-[#d9dce3] focus:border-[#5f9cff]',
                )}
                autoFocus
              />
              {feedbackRequired && (
                <p className="mt-1 text-[12px] text-destructive">请先写一点调整意见。</p>
              )}
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setHidden(true)}
            className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-[14px] font-semibold text-[#8a8f98] transition-colors hover:bg-[#f4f4f5] hover:text-[#1f232b]"
          >
            忽略 <kbd className="rounded-lg bg-[#f0f0f2] px-2 py-1 font-mono text-[13px] text-[#5c626d]">ESC</kbd>
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy}
            className="inline-flex h-10 min-w-[92px] items-center justify-center gap-2 rounded-[18px] bg-[#5f9cff] px-4 text-[16px] font-semibold text-white shadow-[0_10px_22px_rgba(95,156,255,0.35)] transition-colors hover:bg-[#4b8cf0] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? <Loader2 size={17} className="animate-spin" /> : null}
            提交
            {!busy && <CornerDownLeft size={17} />}
          </button>
        </div>
      </section>
    </div>
  )
}
