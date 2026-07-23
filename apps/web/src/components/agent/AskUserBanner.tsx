import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Check, CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentPendingInteractiveAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentAskUserQuestionRequest } from '@lume/shared'
import { removePendingAskUserQuestion } from '@/hooks/pending-interactive-state'
import { getSubagentDisplayLabel } from './subagent-label'
import { InteractiveOverlayFrame, shouldSubmitInteractiveOverlayOnEnter } from './InteractiveOverlayFrame'

import { Button } from '@/components/ui/button'
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
      eyebrow="Ask"
      icon={<CircleHelp size={18} />}
      title="帮 Lume 做一个选择"
      busy={busy}
      submitDisabled={submitDisabled}
      submitLabel="提交回答"
      onIgnore={() => setHidden(true)}
      onSubmit={() => void submit()}
    >
      <div className="space-y-4">
        {subagentDisplayLabel && (
          <div className="flex items-center gap-2 rounded-[11px] border border-[#e8edf5] bg-[#f8fafc] px-3 py-2 text-[12px] leading-5 text-[#6f7b8d]">
            <span className="size-1.5 rounded-full bg-[#5f9cff]" />
            {subagentDisplayLabel}
          </div>
        )}
        {request.questions.map((q, questionIndex) => (
          <div key={q.question} className="rounded-[15px] border border-[#e7ebf1] bg-[#fbfcfe] p-3">
            <div className="mb-2.5 flex items-start gap-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#eaf2ff] text-[11px] font-bold text-[#4c8df6]">
                {questionIndex + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8290a4]">{q.header}</p>
                <p className="mt-0.5 text-[14px] font-semibold leading-5 text-[#1f232b]">{q.question}</p>
              </div>
            </div>
            <div className="space-y-1.5" role="radiogroup" aria-label={q.header || q.question}>
              {q.options.map((opt) => (
                <Button
                variant="ghost"
                  key={opt.label}
                  type="button"
                  data-enter-submits
                  role="radio"
                  aria-checked={answers[q.question] === opt.label}
                  onClick={() => select(q.question, opt.label)}
                  className={cn(
                    'flex min-h-11 w-full items-center rounded-[11px] border px-3 text-left text-[13px] transition-colors',
                    answers[q.question] === opt.label
                      ? 'border-[#9fc4ff] bg-[#f2f7ff] text-[#1f232b] shadow-[0_2px_8px_rgba(95,156,255,0.08)]'
                      : 'border-transparent bg-white text-[#5f6876] hover:border-[#dce5f2] hover:bg-white'
                  )}
                >
                  <span className={cn(
                    'mr-2.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                    answers[q.question] === opt.label ? 'border-[#5f9cff] bg-[#5f9cff] text-white' : 'border-[#cbd3df] bg-white',
                  )}>
                    {answers[q.question] === opt.label && <Check size={10} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 font-semibold">{opt.label}</span>
                  {opt.description && opt.description !== opt.label && (
                    <span className="ml-3 min-w-0 truncate text-[11px] font-medium text-[#96a0af]">{opt.description}</span>
                  )}
                </Button>
              ))}
            </div>
          </div>
        ))}
        <p className="px-1 text-[11px] text-[#929cab]">
          已完成 {Object.keys(answers).length} / {request.questions.length} 项 · 选择后按 Enter 提交
        </p>
        {error && (
          <p className="px-1 pt-1 text-[12px] leading-5 text-destructive">{error}</p>
        )}
      </div>
    </InteractiveOverlayFrame>
  )
}
