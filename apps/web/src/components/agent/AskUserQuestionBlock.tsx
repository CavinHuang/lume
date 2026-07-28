import { useState } from 'react'
import { Check, ChevronDown, CircleHelp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AnimatedCollapsiblePanel, useDeferredUnmount } from './AnimatedCollapsiblePanel'
import type { RuntimeToolCallView } from './runtime-message-view'

import { Button } from '@/components/ui/button'

interface AskUserQuestionBlockProps {
  toolCall: RuntimeToolCallView
}

interface AskQuestionHistory {
  question: string
  options: Array<{ label: string; description: string }>
}

export function AskUserQuestionBlock({ toolCall }: AskUserQuestionBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const shouldRenderDetails = useDeferredUnmount(expanded)
  const input = asRecord(toolCall.input)
  const output = parseOutput(toolCall.output)
  const outputRecord = asRecord(output)
  const questions = normalizeQuestions(outputRecord.questions ?? input.questions)
  const structuredAnswers = asRecord(outputRecord.answers ?? input.answers)
  const answers = Object.keys(structuredAnswers).length > 0
    ? structuredAnswers
    : parseLegacyAnswers(toolCall.output)
  const summary = `${toolCall.status === 'running' ? '正在询问' : '已询问'} ${questions.length} 个问题`

  return (
    <div data-ask-user-question-result="true" className="w-full max-w-[560px]">
      <Button
        variant="ghost"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group flex h-7 w-fit items-center gap-2 rounded-lg px-1.5 text-left text-[13px] font-medium text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-[var(--lume-text-secondary)]"
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-[var(--lume-text-muted)]">
          <CircleHelp size={15} />
        </span>
        <span className="shrink-0">{summary}</span>
        <ChevronDown
          size={14}
          className={cn(
            'shrink-0 text-[var(--lume-text-muted)] transition-opacity',
            expanded ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        />
      </Button>

      {shouldRenderDetails && (
        <AnimatedCollapsiblePanel open={expanded}>
          <div className="mt-3 space-y-4 px-1.5 pb-1">
            {questions.length > 0 ? questions.map((question, index) => {
              const answer = getAnswer(answers, question.question)
              const selectedLabels = new Set(answer.split(',').map((item) => item.trim()).filter(Boolean))
              return (
                <div key={`${question.question}-${index}`}>
                  <p className="text-[13px] font-medium leading-5 text-[var(--lume-text-secondary)]">{question.question}</p>
                  {question.options.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] leading-5">
                      {question.options.map((option) => {
                        const selected = selectedLabels.has(option.label)
                        return (
                          <span
                            key={option.label}
                            title={option.description}
                            className={cn(
                              'inline-flex items-center gap-0.5',
                              selected
                                ? 'font-medium text-[var(--lume-text-secondary)]'
                                : 'text-[var(--lume-text-muted)]',
                            )}
                          >
                            {selected && <Check size={11} />}
                            {option.label}
                          </span>
                        )
                      })}
                    </div>
                  )}
                  <p className="mt-1 break-words text-[12.5px] leading-5 text-[var(--lume-text-muted)]">
                    {answer ? `已选：${answer}` : '尚未回答'}
                  </p>
                </div>
              )
            }) : (
              <p className="text-[12px] text-[var(--lume-text-muted)]">暂无问题详情</p>
            )}
          </div>
        </AnimatedCollapsiblePanel>
      )}
    </div>
  )
}

function normalizeQuestions(value: unknown): AskQuestionHistory[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = asRecord(item)
    const question = typeof record.question === 'string' ? record.question : ''
    if (!question) return []
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
        if (typeof option === 'string') return [{ label: option, description: option }]
        const optionRecord = asRecord(option)
        const label = typeof optionRecord.label === 'string' ? optionRecord.label : ''
        if (!label) return []
        return [{
          label,
          description: typeof optionRecord.description === 'string'
            ? optionRecord.description
            : label,
        }]
      })
      : []
    return [{ question, options }]
  })
}

function getAnswer(answers: Record<string, unknown>, question: string): string {
  const answer = answers[question]
  if (typeof answer === 'string') return answer
  if (Array.isArray(answer)) return answer.filter((item): item is string => typeof item === 'string').join(', ')
  return ''
}

function parseLegacyAnswers(output: unknown): Record<string, string> {
  if (typeof output !== 'string') return {}
  const answers: Record<string, string> = {}
  for (const match of output.matchAll(/"([^"]+)"="([^"]*)"/g)) {
    const question = match[1]
    const answer = match[2]
    if (question && answer !== undefined) answers[question] = answer
  }
  return answers
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
