import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Check, ChevronRight } from 'lucide-react'
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
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const subagentDisplayLabel = getSubagentDisplayLabel(request)

  useEffect(() => {
    setAnswers({})
    setActiveQuestionIndex(0)
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
  const activeQuestion = request.questions[activeQuestionIndex]

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
      title="帮 Lume 做一个选择"
      compact
      meta={subagentDisplayLabel ? `来自 ${subagentDisplayLabel}` : 'AskUserQuestion'}
      progress={{
        current: activeQuestionIndex + 1,
        total: request.questions.length,
        onPrevious: activeQuestionIndex > 0 ? () => setActiveQuestionIndex((index) => index - 1) : undefined,
        onNext: activeQuestionIndex < request.questions.length - 1 ? () => setActiveQuestionIndex((index) => index + 1) : undefined,
      }}
      busy={busy}
      submitDisabled={submitDisabled}
      submitLabel="提交回答"
      onIgnore={() => setHidden(true)}
      onSubmit={() => void submit()}
    >
      <div className="space-y-2.5">
        {activeQuestion ? (
          <>
            <div className="px-1">
              <p className="text-[11px] font-medium text-[#9b9b9b]">{activeQuestion.header || `问题 ${activeQuestionIndex + 1}`}</p>
              <p className="mt-0.5 text-[15px] font-semibold leading-6 text-[#f4f4f4]">{activeQuestion.question}</p>
            </div>
            <div className="space-y-1.5" role="radiogroup" aria-label={activeQuestion.header || activeQuestion.question}>
              {activeQuestion.options.map((opt, optionIndex) => {
                const selected = answers[activeQuestion.question] === opt.label
                return (
                  <Button
                    variant="ghost"
                    key={opt.label}
                    type="button"
                    data-enter-submits
                    role="radio"
                    aria-checked={selected}
                    onClick={() => select(activeQuestion.question, opt.label)}
                    className={cn(
                      'group flex min-h-10 w-full items-center gap-2.5 rounded-full border px-2.5 py-1.5 text-left transition-colors',
                      selected
                        ? 'border-white/[0.10] bg-[#373737] text-[#f5f5f5]'
                        : 'border-transparent text-[#9b9b9b] hover:bg-[#333] hover:text-[#e5e5e5]',
                    )}
                  >
                    <span className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full border text-[12px] font-medium',
                      selected ? 'border-white/[0.18] bg-[#4a4a4a] text-white' : 'border-white/[0.10] bg-[#333] text-[#aaa]',
                    )}>
                      {optionIndex + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{opt.label}</span>
                    {opt.description && opt.description !== opt.label && (
                      <span className="min-w-0 truncate text-[12px] text-[#8c8c8c]">{opt.description}</span>
                    )}
                    {selected ? <Check size={15} className="shrink-0 text-[#ededed]" /> : <ChevronRight size={15} className="shrink-0 text-[#777] opacity-0 transition-opacity group-hover:opacity-100" />}
                  </Button>
                )
              })}
            </div>
          </>
        ) : (
          <p className="px-1 text-[13px] text-[#aaa]">暂无问题</p>
        )}
        <p className="px-1 text-[11px] text-[#858585]">
          已完成 {Object.keys(answers).length} / {request.questions.length} 项
        </p>
        {error && (
          <p className="px-1 pt-1 text-[12px] text-[#ff9b9b]">{error}</p>
        )}
      </div>
    </InteractiveOverlayFrame>
  )
}
