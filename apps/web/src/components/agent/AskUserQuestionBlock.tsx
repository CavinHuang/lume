import { useState } from 'react'
import { Check, ChevronDown, CircleHelp, Clock3, ListChecks } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnimatedCollapsiblePanel, useDeferredUnmount } from './AnimatedCollapsiblePanel'
import type { RuntimeToolCallView } from './runtime-message-view'

import { Button } from '@/components/ui/button'

interface AskUserQuestionBlockProps {
  toolCall: RuntimeToolCallView
}

interface AskQuestionHistory {
  header: string
  question: string
  options: Array<{ label: string; description: string }>
  multiSelect: boolean
}

export function AskUserQuestionBlock({ toolCall }: AskUserQuestionBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const shouldRenderDetails = useDeferredUnmount(expanded)
  const input = asRecord(toolCall.input)
  const output = parseOutput(toolCall.output)
  const outputRecord = asRecord(output)
  const questions = normalizeQuestions(outputRecord.questions ?? input.questions)
  const answers = asRecord(outputRecord.answers ?? input.answers)
  const status = getAskStatus(toolCall, outputRecord)
  const summary = questions.length > 0
    ? questions.map((question) => question.header || question.question).join(' · ')
    : '用户输入'

  return (
    <div data-ask-user-question-result="true" className="w-full max-w-[560px]">
      <Button
        variant="ghost"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex h-auto w-full items-center gap-2 rounded-[12px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-3 py-2.5 text-left text-[12px] text-[var(--lume-text-secondary)] shadow-[0_1px_2px_hsl(var(--lume-shadow-panel)/0.06)] transition-colors hover:bg-[var(--lume-accent-soft)]"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[9px] bg-[var(--lume-accent-soft)] text-[var(--lume-accent)]">
          <CircleHelp size={15} />
        </span>
        <span className="shrink-0 font-mono font-semibold text-[var(--lume-text-primary)]">AskUserQuestion</span>
        <span className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
          status === '已回答' ? 'bg-emerald-500/10 text-emerald-700' : status === '等待回答' ? 'bg-amber-500/10 text-amber-700' : 'bg-foreground/[0.06] text-foreground/50',
        )}>
          {status}
        </span>
        <span className="min-w-0 flex-1 truncate text-[var(--lume-text-muted)]">{summary}</span>
        <ChevronDown size={15} className={cn('shrink-0 text-[var(--lume-text-muted)] transition-transform', expanded && 'rotate-180')} />
      </Button>

      {shouldRenderDetails && (
        <AnimatedCollapsiblePanel open={expanded}>
          <div className="mt-2 space-y-3 rounded-[14px] border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-3">
            {questions.length > 0 ? questions.map((question, index) => {
              const answer = getAnswer(answers, question.question)
              const selectedLabels = new Set(answer.split(',').map((item) => item.trim()).filter(Boolean))
              return (
                <div key={`${question.question}-${index}`} className="rounded-[11px] border border-[var(--lume-border-subtle)] bg-foreground/[0.025] p-3">
                  <div className="flex items-start gap-2">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--lume-accent-soft)] text-[10px] font-bold text-[var(--lume-accent)]">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--lume-text-muted)]">{question.header || `问题 ${index + 1}`}</p>
                      <p className="mt-0.5 text-[13px] font-semibold leading-5 text-[var(--lume-text-primary)]">{question.question}</p>
                    </div>
                  </div>

                  <div className="mt-3 rounded-[9px] border border-emerald-500/20 bg-emerald-500/[0.06] px-2.5 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700/70">用户回答</p>
                    <p className="mt-0.5 break-words text-[12px] font-medium text-emerald-800">{answer || '尚未回答'}</p>
                  </div>

                  <div className="mt-3">
                    <p className="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--lume-text-muted)]">
                      <ListChecks size={12} />
                      历史选项{question.multiSelect ? ' · 可多选' : ''}
                    </p>
                    <div className="space-y-1">
                      {question.options.map((option) => {
                        const selected = selectedLabels.has(option.label)
                        return (
                          <div key={option.label} className={cn(
                            'flex items-start gap-2 rounded-[8px] px-2 py-1.5 text-[12px]',
                            selected ? 'bg-[var(--lume-accent-soft)] text-[var(--lume-text-primary)]' : 'text-[var(--lume-text-muted)]',
                          )}>
                            <span className={cn(
                              'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                              selected ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-[var(--lume-border-strong)]',
                            )}>
                              {selected && <Check size={9} strokeWidth={3} />}
                            </span>
                            <span className="min-w-0">
                              <span className="font-medium">{option.label}</span>
                              {option.description && option.description !== option.label && (
                                <span className="ml-1 text-[11px] text-[var(--lume-text-muted)]">— {option.description}</span>
                              )}
                            </span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            }) : (
              <p className="text-[12px] text-[var(--lume-text-muted)]">暂无问题详情</p>
            )}
            <div className="flex items-center gap-1.5 px-1 text-[10px] text-[var(--lume-text-muted)]">
              <Clock3 size={12} />
              {status === '已回答' ? '回答已写入工具结果' : '等待用户完成回答'}
            </div>
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
}

function normalizeQuestions(value: unknown): AskQuestionHistory[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    const record = asRecord(item)
    const question = typeof record.question === 'string' ? record.question : ''
    if (!question) return []
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
        if (typeof option === 'string') return [{ label: option, description: option }]
        const optionRecord = asRecord(option)
        const label = typeof optionRecord.label === 'string' ? optionRecord.label : ''
        return label ? [{ label, description: typeof optionRecord.description === 'string' ? optionRecord.description : label }] : []
      })
      : []
    return [{
      header: typeof record.header === 'string' ? record.header : `问题 ${index + 1}`,
      question,
      options,
      multiSelect: record.multiSelect === true,
    }]
  })
}

function getAnswer(answers: Record<string, unknown>, question: string): string {
  const answer = answers[question]
  if (typeof answer === 'string') return answer
  if (Array.isArray(answer)) return answer.filter((item): item is string => typeof item === 'string').join(', ')
  return ''
}

function getAskStatus(toolCall: RuntimeToolCallView, output: Record<string, unknown>): string {
  if (toolCall.status === 'running') return '等待回答'
  if (toolCall.status === 'failed') return '已取消'
  return output.status === 'canceled' ? '已取消' : '已回答'
}

function parseOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output
  try {
    return JSON.parse(output)
  } catch {
    return output
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
