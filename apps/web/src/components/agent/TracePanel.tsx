import { useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import { Activity, CircleAlert, Clock3, ShieldCheck } from 'lucide-react'
import { agentRuntimeEventsFamily } from '@/atoms'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getAgentRunTrace, listAgentRunStates } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import {
  buildLiveRuntimeEventRows,
  buildRunRows,
  buildTraceRows,
  getDefaultRunId,
  type LiveRuntimeEventRow,
  type RunRow,
  type TraceRow,
} from './runtime-state-projections'
import type { AgentTraceRedactionLevel } from '@lume/shared'

interface TracePanelProps {
  threadId: string
}

const statusStyle: Record<string, string> = {
  running: 'text-blue-500',
  completed: 'text-green-500',
  failed: 'text-destructive',
  cancelled: 'text-foreground/40',
}

export function TracePanel({ threadId }: TracePanelProps) {
  const liveRuntimeEvents = useAtomValue(agentRuntimeEventsFamily(threadId))?.events ?? []
  const [runRows, setRunRows] = useState<RunRow[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [rows, setRows] = useState<TraceRow[]>([])
  const [redactionLevel, setRedactionLevel] = useState<AgentTraceRedactionLevel>('safe_summary')
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void listAgentRunStates({ threadId })
      .then(async (runResult) => {
        if (cancelled) return
        const nextRunRows = buildRunRows(runResult.runs)
        const nextRunId = selectedRunId && nextRunRows.some((row) => row.id === selectedRunId)
          ? selectedRunId
          : getDefaultRunId(runResult.runs)
        setRunRows(nextRunRows)
        setSelectedRunId(nextRunId)
        const result = await getAgentRunTrace({
          threadId,
          runId: nextRunId ?? undefined,
          redactionLevel,
        })
        if (cancelled) return
        const nextRows = buildTraceRows(result.trace)
        setRows(nextRows)
        setState(nextRows.length ? 'ready' : 'empty')
      })
      .catch((error) => {
        console.error('[TracePanel] 加载 Trace 失败:', error)
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [redactionLevel, selectedRunId, threadId])

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-border/50 px-3 py-2.5 text-[12px] font-medium text-foreground/60">
        <ShieldCheck size={13} className="shrink-0" />
        <span className="min-w-0 flex-1">Trace</span>
        <TraceRedactionTabs value={redactionLevel} onChange={setRedactionLevel} />
      </div>
      {runRows.length > 0 && (
        <div className="border-b border-border/40 px-3 py-2">
          <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-foreground/30">
            Runs
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-0.5">
            {runRows.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={cn(
                  'min-w-[132px] rounded-lg border px-2 py-1.5 text-left transition-colors',
                  selectedRunId === run.id
                    ? 'border-foreground/20 bg-foreground/[0.055]'
                    : 'border-border/40 bg-transparent hover:bg-foreground/[0.03]',
                )}
              >
                <div className="flex items-center gap-1.5">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', runStatusDotClass(run.status))} />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/65">
                    {run.label}
                  </span>
                </div>
                <div className="mt-1 truncate text-[10px] text-foreground/35">{run.detail}</div>
                <div className="mt-0.5 text-[10px] text-foreground/25">{run.createdAt}</div>
              </button>
            ))}
          </div>
        </div>
      )}
      <LiveRuntimeEvents rows={buildLiveRuntimeEventRows(liveRuntimeEvents)} />
      <TraceContent state={state} rows={rows} />
    </div>
  )
}

function LiveRuntimeEvents({ rows }: { rows: LiveRuntimeEventRow[] }) {
  if (rows.length === 0) return null

  return (
    <div className="border-b border-border/40 px-3 py-2">
      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-foreground/30">
        Live events
      </div>
      <div className="space-y-1">
        {rows.slice(-4).map((row) => (
          <div key={row.id} className="flex items-center gap-2 rounded-md bg-foreground/[0.025] px-2 py-1">
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', eventToneClass(row.tone))} />
            <span className="shrink-0 text-[10px] font-medium text-foreground/55">{row.label}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-foreground/35">{row.detail}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TraceContent({
  state,
  rows,
}: {
  state: 'loading' | 'ready' | 'empty' | 'error'
  rows: TraceRow[]
}) {
  if (state === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-foreground/35">
        <Clock3 size={14} />
        正在加载 Trace
      </div>
    )
  }

  if (state === 'empty') {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-foreground/30">
        暂无 Trace
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-destructive/70">
        <CircleAlert size={14} />
        Trace 加载失败
      </div>
    )
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-1 px-3 py-2">
        {rows.map((row) => (
          <div
            key={row.id}
            className="rounded-lg border border-border/40 bg-foreground/[0.015] px-2.5 py-2"
            style={{ marginLeft: row.depth * 14 }}
          >
            <div className="flex items-center gap-2">
              <Activity size={13} className={cn('shrink-0', statusStyle[row.status] ?? 'text-foreground/40')} />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/75">
                {row.label}
              </span>
              <span className="text-[10px] text-foreground/35">{row.duration}</span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-foreground/40">
              <span>{row.type}</span>
              <span>·</span>
              <span>{row.status}</span>
              {row.hasChildren && (
                <>
                  <span>·</span>
                  <span>parent span</span>
                </>
              )}
            </div>
            {row.detail && (
              <p className="mt-1.5 break-words rounded-md bg-foreground/[0.035] px-2 py-1 text-[10px] leading-4 text-foreground/45">
                {row.detail}
              </p>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}

function runStatusDotClass(status: string): string {
  if (status === 'completed') return 'bg-green-500'
  if (status === 'failed') return 'bg-destructive'
  if (status === 'waiting_for_approval' || status === 'waiting_for_user') return 'bg-amber-500'
  if (status === 'running' || status === 'created' || status === 'paused') return 'bg-blue-500'
  return 'bg-foreground/25'
}

function eventToneClass(tone: LiveRuntimeEventRow['tone']): string {
  if (tone === 'active') return 'bg-blue-500'
  if (tone === 'success') return 'bg-green-500'
  if (tone === 'danger') return 'bg-destructive'
  return 'bg-foreground/30'
}

function TraceRedactionTabs({
  value,
  onChange,
}: {
  value: AgentTraceRedactionLevel
  onChange: (value: AgentTraceRedactionLevel) => void
}) {
  const options: Array<{ value: AgentTraceRedactionLevel; label: string }> = [
    { value: 'safe_summary', label: 'Safe' },
    { value: 'diagnostic', label: 'Diag' },
  ]

  return (
    <div className="flex rounded-md bg-foreground/[0.04] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
            value === option.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-foreground/45 hover:text-foreground/70',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
