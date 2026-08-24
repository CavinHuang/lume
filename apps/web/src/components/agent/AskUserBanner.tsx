import { useEffect, useState } from 'react'
import { useSetAtom } from 'jotai'
import { Check, ChevronRight, Mic, Pencil } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentPendingInteractiveAtom } from '@/atoms'
import { sidecarCall } from '@/lib/desktop-api'
import { AGENT_IPC_CHANNELS, type AgentAskUserQuestionRequest } from '@lume/shared'
import { removePendingAskUserQuestion } from '@/hooks/pending-interactive-state'
import { getSubagentDisplayLabel } from './subagent-label'
import { InteractiveOverlayFrame, shouldSubmitInteractiveOverlayOnEnter } from './InteractiveOverlayFrame'
import { useVoiceDictation } from '@/components/voice-dictation/use-voice-dictation'
import { VolumeBars } from '@/components/voice-dictation/VolumeBars'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
interface AskUserBannerProps {
  threadId: string
  request: AgentAskUserQuestionRequest
}

export function AskUserBanner({ threadId, request }: AskUserBannerProps) {
  const setPending = useSetAtom(agentPendingInteractiveAtom)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0)
  const [customQuestion, setCustomQuestion] = useState<string | null>(null)
  const [customAnswer, setCustomAnswer] = useState('')
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const subagentDisplayLabel = getSubagentDisplayLabel(request)

  useEffect(() => {
    setAnswers({})
    setActiveQuestionIndex(0)
    setCustomQuestion(null)
    setCustomAnswer('')
    setHidden(false)
    setBusy(false)
    setError(null)
  }, [threadId, request.toolUseId])

  const select = (question: string, label: string) => {
    const nextAnswers = { ...answers, [question]: label }
    setAnswers(nextAnswers)
    if (activeQuestionIndex < request.questions.length - 1) {
      setActiveQuestionIndex((index) => index + 1)
      return
    }
    if (request.questions.every((item) => nextAnswers[item.question])) {
      void submit(nextAnswers)
    }
  }

  const submit = async (submittedAnswers = answers) => {
    setBusy(true)
    setError(null)
    try {
      await sidecarCall(AGENT_IPC_CHANNELS.SUBMIT_ASK_USER_QUESTION, { threadId, toolUseId: request.toolUseId, answers: submittedAnswers })
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
  const submitCustomAnswer = () => {
    const answer = customAnswer.trim()
    if (!activeQuestion || !answer) return
    setCustomQuestion(null)
    setCustomAnswer('')
    select(activeQuestion.question, answer)
  }
  // 自定义回答支持口述：听写结果追加到输入框，与手动输入同路径提交。
  const voiceDictation = useVoiceDictation({
    onCommit: (text) => setCustomAnswer((current) => (current && !/\s$/u.test(current) ? `${current} ${text}` : current + text)),
  })

  // 自定义回答行（含迷你麦克风）因任何路径关闭——Esc 清空行、确认提交切题、
  // 卡片整体隐藏——都必须终止进行中的听写：组件仍挂载但指示 UI 已消失，
  // 不主动取消会变成"隐形录音"持续上传音频。
  const customAnswerRowOpen = !hidden && customQuestion !== null && customQuestion === activeQuestion?.question
  useEffect(() => {
    if (!customAnswerRowOpen && voiceDictation.isActive) voiceDictation.cancel()
  }, [customAnswerRowOpen, voiceDictation.cancel, voiceDictation.isActive])

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
      title={activeQuestion?.question || '需要你的选择'}
      compact
      followTheme
      showSubmit={false}
      meta={subagentDisplayLabel ? `来自 ${subagentDisplayLabel}` : undefined}
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
      <div className="space-y-1.5">
        {activeQuestion ? (
          <div
            key={activeQuestion.question}
            className="animate-in fade-in slide-in-from-bottom-1 space-y-1 fill-mode-both duration-300 motion-reduce:animate-none"
            role="radiogroup"
            aria-label={activeQuestion.header || activeQuestion.question}
          >
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
                      'group flex min-h-10 w-full items-center justify-start gap-2.5 rounded-2xl border px-2.5 py-1.5 text-left transition-[background-color,border-color,color,transform] duration-150 active:scale-[0.99] motion-reduce:transition-none',
                      selected
                        ? 'border-[color:color-mix(in_oklab,var(--lume-accent)_28%,var(--lume-border-subtle))] bg-[color:color-mix(in_oklab,var(--lume-accent)_8%,var(--lume-bg-elevated))] text-[var(--lume-text-primary)]'
                        : 'border-transparent text-[var(--lume-text-secondary)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-primary)]',
                    )}
                  >
                    <span className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full border text-ui font-medium tabular-nums',
                      selected
                        ? 'border-[color:color-mix(in_oklab,var(--lume-accent)_40%,var(--lume-border-subtle))] bg-[color:color-mix(in_oklab,var(--lume-accent)_14%,var(--lume-bg-elevated))] text-[var(--lume-text-primary)]'
                        : 'border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] text-[var(--lume-text-muted)]',
                    )}>
                      {optionIndex + 1}
                    </span>
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="shrink-0 text-body font-semibold">{opt.label}</span>
                      {opt.description && opt.description !== opt.label && (
                        <span className="min-w-0 truncate text-ui text-[var(--lume-text-muted)]">{opt.description}</span>
                      )}
                    </span>
                    {selected
                      ? <Check size={14} className="animate-in zoom-in-75 shrink-0 text-[var(--lume-accent)] duration-200 motion-reduce:animate-none" />
                      : <ChevronRight size={14} className="shrink-0 text-[var(--lume-text-muted)] opacity-0 transition-opacity group-hover:opacity-100" />}
                  </Button>
                )
              })}
              {customQuestion === activeQuestion.question ? (
                <div className="animate-in fade-in slide-in-from-top-1 flex min-h-10 items-center gap-2 rounded-2xl border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-2.5 py-1 duration-200 motion-reduce:animate-none">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--lume-border-subtle)] text-[var(--lume-text-muted)]">
                    <Pencil size={13} />
                  </span>
                  <Input
                    autoFocus
                    value={customAnswer}
                    onChange={(event) => setCustomAnswer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') submitCustomAnswer()
                      if (event.key === 'Escape') {
                        event.stopPropagation()
                        setCustomQuestion(null)
                      }
                    }}
                    placeholder="告诉 Lume 应该如何做得不同"
                    className="h-7 border-0 bg-transparent px-0 text-ui shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    onClick={() => {
                      if (voiceDictation.status === 'recording' || voiceDictation.status === 'connecting') void voiceDictation.stop()
                      else if (voiceDictation.status !== 'stopping') void voiceDictation.start()
                    }}
                    title={voiceDictation.isActive ? '结束听写' : '语音输入'}
                    aria-label={voiceDictation.isActive ? '结束听写' : '开始语音输入'}
                    aria-pressed={voiceDictation.isActive}
                    className={cn(
                      'size-6 shrink-0 rounded-md',
                      voiceDictation.isActive
                        ? 'text-[var(--lume-danger)]'
                        : 'text-[var(--lume-text-muted)] hover:text-[var(--lume-text-secondary)]',
                    )}
                  >
                    {voiceDictation.status === 'recording' ? (
                      <VolumeBars
                        volumeRef={voiceDictation.volumeRef}
                        active
                        className="flex h-3 items-center gap-[2px]"
                        barClassName="w-[2px] rounded-full bg-current"
                      />
                    ) : (
                      <Mic size={12} className={cn(voiceDictation.isActive && 'animate-pulse')} />
                    )}
                  </Button>
                  {voiceDictation.transcript && voiceDictation.isActive && (
                    <span className="max-w-32 shrink-0 truncate text-caption text-[var(--lume-text-muted)]" role="status">
                      {voiceDictation.transcript}
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    type="button"
                    disabled={!customAnswer.trim()}
                    onClick={submitCustomAnswer}
                    className="shrink-0 text-[var(--lume-text-secondary)]"
                  >
                    确认
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setCustomQuestion(activeQuestion.question)
                    setCustomAnswer('')
                  }}
                  className="flex min-h-9 w-full items-center justify-start gap-2.5 rounded-2xl px-2.5 py-1 text-left text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-secondary)]"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-[var(--lume-border-subtle)]">
                    <Pencil size={13} />
                  </span>
                  <span className="truncate text-ui">都不合适，告诉 Lume 应该如何做得不同</span>
                </Button>
              )}
            </div>
        ) : (
          <p className="px-1 text-ui text-[var(--lume-text-muted)]">暂无问题</p>
        )}
        {error && (
          <p className="px-1 pt-1 text-caption text-[var(--destructive)]">{error}</p>
        )}
      </div>
    </InteractiveOverlayFrame>
  )
}
