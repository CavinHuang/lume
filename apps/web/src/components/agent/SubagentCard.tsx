import { useState } from 'react'
import { ChevronRight, Loader2, CheckCircle, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SubagentRunRecord } from '@lume/shared'

interface SubagentCardProps {
  run: SubagentRunRecord
}

export function SubagentCard({ run }: SubagentCardProps) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = run.status === 'running' || run.status === 'accepted'
  const isError = run.status === 'errored' || run.status === 'timed_out' || run.status === 'aborted'
  const isDone = run.status === 'completed'

  return (
    <div className="rounded-xl border border-border/50 bg-muted/20 overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-200">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-muted/30 transition-colors text-left"
      >
        <ChevronRight size={13} className={cn('text-foreground/40 transition-transform flex-shrink-0', expanded && 'rotate-90')} />
        <span className="flex-1 text-[13px] text-foreground/80 truncate">{run.label ?? run.task}</span>
        {isRunning && <Loader2 size={13} className="animate-spin text-blue-500 flex-shrink-0" />}
        {isDone && <CheckCircle size={13} className="text-green-500 flex-shrink-0" />}
        {isError && <XCircle size={13} className="text-destructive flex-shrink-0" />}
      </button>
      {expanded && run.outcome && (
        <div className="border-t border-border/30 px-3 py-2">
          {run.outcome.output && (
            <p className="text-[12px] text-foreground/60 whitespace-pre-wrap leading-relaxed">{run.outcome.output}</p>
          )}
          {run.outcome.error && (
            <p className="text-[12px] text-destructive whitespace-pre-wrap leading-relaxed">{run.outcome.error}</p>
          )}
        </div>
      )}
    </div>
  )
}
