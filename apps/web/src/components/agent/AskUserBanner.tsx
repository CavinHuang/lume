import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { MessageCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentPendingInteractiveAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import type { AgentAskUserQuestionRequest } from '@lume/shared'
import { removePendingAskUserQuestion } from '@/hooks/pending-interactive-state'

interface AskUserBannerProps {
  threadId: string
  request: AgentAskUserQuestionRequest
}

export function AskUserBanner({ threadId, request }: AskUserBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const select = (question: string, label: string) => {
    setAnswers((prev) => ({ ...prev, [question]: label }))
  }

  const submit = async () => {
    await sidecarCall('agent:submit-ask-user-question', { threadId, toolUseId: request.toolUseId, answers })
    setPending((prev) => {
      const next = { ...prev }
      return removePendingAskUserQuestion(next, threadId, request.toolUseId)
    })
  }

  const allAnswered = request.questions.every((q) => answers[q.question])

  return (
    <div className="animate-in slide-in-from-bottom-2 duration-200 mx-4 mb-3 rounded-xl border bg-card shadow-lg">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <MessageCircle size={14} className="text-foreground/50" />
        <span className="text-[13px] font-medium text-foreground">需要你的输入</span>
        {request.subagentRunId && (
          <span className="text-[11px] text-foreground/45">Subagent {request.subagentRunId}</span>
        )}
      </div>
      <div className="px-3 pb-3 space-y-3">
        {request.questions.map((q) => (
          <div key={q.question}>
            <p className="text-[12px] text-foreground/70 mb-1.5">{q.question}</p>
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt) => (
                <button
                  key={opt.label}
                  onClick={() => select(q.question, opt.label)}
                  className={cn(
                    'px-2.5 py-1 rounded-lg text-[12px] border transition-colors',
                    answers[q.question] === opt.label
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border/50 text-foreground/70 hover:bg-muted/50'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button
          onClick={submit}
          disabled={!allAnswered}
          className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-[12px] font-medium hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          提交
        </button>
      </div>
    </div>
  )
}
