import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Check } from 'lucide-react'
import { agentPendingInteractiveAtom, agentPlanModePhaseAtom } from '@/atoms'
import { submitTaskApproval } from '@/lib/desktop-api'
import { removePendingTaskApproval } from '@/hooks/pending-interactive-state'
import { cn } from '@/lib/utils'
import { InteractiveOverlayFrame, shouldSubmitInteractiveOverlayOnEnter } from './InteractiveOverlayFrame'
import type { AgentTaskApprovalRequest, AgentTaskApprovalResponseInput, AgentTaskApprovalResponseResult } from '@lume/shared'

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

export function shouldSwitchToAgentModeAfterTaskApproval(input: {
  submission: AgentTaskApprovalResponseInput
  result: AgentTaskApprovalResponseResult
}): boolean {
  return input.result.ok === true
    && input.submission.decision === 'approve'
    && input.submission.execute === true
}

export function PlanApprovalOverlay({ threadId, request, onVisibilityChange }: PlanApprovalOverlayProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const setPlanModePhase = useSetAtom(agentPlanModePhaseAtom)
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
        if (shouldSwitchToAgentModeAfterTaskApproval({ submission: payload, result })) {
          setPlanModePhase((prev) => ({
            ...prev,
            [threadId]: {
              threadId,
              phase: 'executing',
            },
          }))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (hidden || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHidden(true)
        return
      }
      if (shouldSubmitInteractiveOverlayOnEnter(event, event.target) && !busy) {
        void submit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hidden, busy, submit])

  if (hidden) return null

  return (
    <InteractiveOverlayFrame
      kind="plan-approval"
      title="实施此计划?"
      busy={busy}
      onIgnore={() => setHidden(true)}
      onSubmit={() => void submit()}
    >
      <div className="space-y-1">
          <button
            type="button"
            onClick={() => {
              setChoice('approve')
              setFeedbackRequired(false)
            }}
            className={cn(
              'flex min-h-10 w-full items-center rounded-[12px] px-2.5 text-left text-[14px] transition-colors',
              choice === 'approve' ? 'bg-[#f1f1f3] text-[#1f232b]' : 'text-[#8a8f98] hover:bg-[#f6f6f7]',
            )}
          >
            <span className="w-7 shrink-0 text-[14px] text-[#8a8f98]">1.</span>
            <span className="flex min-w-0 flex-1 items-center gap-2 font-semibold">
              是，实施此计划
              {choice === 'approve' && <Check size={15} className="text-[#5f9cff]" />}
            </span>
          </button>

          <div
            onClick={() => setChoice('revise')}
            className={cn(
              'rounded-[12px] px-2.5 py-2 transition-colors',
              choice === 'revise' ? 'bg-[#f1f1f3] text-[#1f232b]' : 'text-[#8a8f98] hover:bg-[#f6f6f7]',
            )}
          >
            <div className="flex items-center text-[14px]">
              <span className="w-7 shrink-0 text-[#b0b4bc]">2.</span>
              <span className="min-w-0 flex-1 font-semibold">否，请告知 Lume 如何调整</span>
            </div>
            <textarea
              value={feedback}
              onFocus={() => setChoice('revise')}
              onChange={(event) => {
                setChoice('revise')
                setFeedback(event.target.value)
                setFeedbackRequired(false)
              }}
              placeholder="写下你希望 Lume 调整的方向"
              className={cn(
                'mt-1.5 min-h-16 w-full resize-y rounded-[11px] border bg-white px-2.5 py-1.5 text-[13px] leading-5 text-[#1f232b] outline-none transition-colors placeholder:text-[#a2a7b0]',
                feedbackRequired ? 'border-destructive/60' : 'border-[#d9dce3] focus:border-[#5f9cff]',
              )}
            />
            {feedbackRequired && (
              <p className="mt-1 text-[11px] text-destructive">请先写一点调整意见。</p>
            )}
          </div>
      </div>
    </InteractiveOverlayFrame>
  )
}
