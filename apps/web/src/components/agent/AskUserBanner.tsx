import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentPendingInteractiveAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentAskUserQuestionRequest } from '@lume/shared'
import { removePendingAskUserQuestion } from '@/hooks/pending-interactive-state'
import { getSubagentDisplayLabel } from './subagent-label'
import { InteractiveOverlayFrame, shouldSubmitInteractiveOverlayOnEnter } from './InteractiveOverlayFrame'

interface AskUserBannerProps {
  threadId: string
  request: AgentAskUserQuestionRequest
}

export function AskUserBanner({ threadId, request }: AskUserBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const subagentDisplayLabel = getSubagentDisplayLabel(request)

  useEffect(() => {
    setAnswers({})
    setHidden(false)
    setBusy(false)
    setError(null)
  }, [threadId, request.toolUseId])

  const select = (question: string, label: string) => {
    setAnswers((prev) => ({ ...prev, [question]: label }))
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION, { threadId, toolUseId: request.toolUseId, answers })
      dismiss()
    } catch (err) {
      // Release 构建无 DevTools，把提交失败直接显示在卡片上，便于定位。
      console.error('[AskUserBanner] submit failed', err)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const dismiss = () => {
    setPending((prev) => {
      const next = { ...prev }
      return removePendingAskUserQuestion(next, threadId, request.toolUseId)
    })
  }

  const allAnswered = request.questions.every((q) => answers[q.question])
  const submitDisabled = !allAnswered

  useEffect(() => {
    if (hidden || typeof window === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setHidden(true)
        return
      }
      if (shouldSubmitInteractiveOverlayOnEnter(event, event.target) && !busy && !submitDisabled) {
        void submit()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [hidden, busy, submitDisabled, submit])

  if (hidden) return null

  return (
    <InteractiveOverlayFrame
      kind="ask-user"
      title="需要你的输入"
      busy={busy}
      submitDisabled={submitDisabled}
      onIgnore={() => setHidden(true)}
      onSubmit={() => void submit()}
    >
      <div className="space-y-3">
        {subagentDisplayLabel && (
          <p className="px-1 text-[12px] leading-5 text-[#8a8f98]">{subagentDisplayLabel}</p>
        )}
        {request.questions.map((q) => (
          <div key={q.question}>
            <p className="mb-1.5 px-1 text-[13px] font-semibold leading-5 text-[#1f232b]">{q.question}</p>
            <div className="space-y-1">
              {q.options.map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  data-enter-submits
                  onClick={() => select(q.question, opt.label)}
                  className={cn(
                    'flex min-h-10 w-full items-center rounded-[12px] px-2.5 text-left text-[14px] transition-colors',
                    answers[q.question] === opt.label
                      ? 'bg-[#f1f1f3] text-[#1f232b]'
                      : 'text-[#8a8f98] hover:bg-[#f6f6f7]'
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2 font-semibold">
                    {opt.label}
                    {answers[q.question] === opt.label && <Check size={15} className="text-[#5f9cff]" />}
                  </span>
                  {opt.description && opt.description !== opt.label && (
                    <span className="ml-3 max-w-[45%] truncate text-[12px] font-medium text-[#9aa0aa]">{opt.description}</span>
                  )}
                </button>
              ))}
            </div>
          </div>
        ))}
        {error && (
          <p className="px-1 pt-1 text-[12px] leading-5 text-destructive">{error}</p>
        )}
      </div>
    </InteractiveOverlayFrame>
  )
}
