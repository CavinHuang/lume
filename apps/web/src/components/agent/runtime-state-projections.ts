import type {
  AgentRunStateSummary,
  AgentRunTrace,
  AgentRunTraceSpan,
  LumeRuntimeEvent,
} from '@lume/shared'

export interface TraceRow {
  id: string
  label: string
  type: string
  status: string
  duration: string
  detail: string | null
  depth: number
  hasChildren: boolean
}

export interface RunRow {
  id: string
  label: string
  status: string
  detail: string
  createdAt: string
}

export interface LiveRuntimeEventRow {
  id: string
  label: string
  detail: string
  tone: 'neutral' | 'active' | 'success' | 'danger'
}

export function buildLiveRuntimeEventRows(events: LumeRuntimeEvent[]): LiveRuntimeEventRow[] {
  return events.slice(-8).map((event, index) => ({
    id: `${event.id}:${index}`,
    ...formatRuntimeEvent(event),
  }))
}

export function getDefaultRunId(runs: AgentRunStateSummary[]): string | null {
  return sortRunsLatestFirst(runs)[0]?.runId ?? null
}

function formatRuntimeEvent(event: LumeRuntimeEvent): Omit<LiveRuntimeEventRow, 'id'> {
  if (event.type === 'message.user.submitted') {
    return { label: 'User message', detail: truncate(event.text), tone: 'neutral' }
  }
  if (event.type === 'assistant.delta') {
    return { label: 'Assistant delta', detail: truncate(event.delta), tone: 'neutral' }
  }
  if (event.type === 'assistant.thinking_delta') {
    return { label: 'Thinking delta', detail: truncate(event.delta), tone: 'neutral' }
  }
  if (event.type === 'assistant.final') {
    return {
      label: 'Assistant final',
      detail: truncate(event.blocks.map((block) => block.text).join(' ')),
      tone: 'success',
    }
  }
  if (event.type === 'tool.started') {
    return { label: 'Tool started', detail: event.toolName, tone: 'active' }
  }
  if (event.type === 'tool.completed') {
    return {
      label: 'Tool completed',
      detail: event.toolName ?? event.toolCallId,
      tone: 'success',
    }
  }
  if (event.type === 'tool.failed') {
    return {
      label: 'Tool failed',
      detail: event.toolName ?? event.error.message,
      tone: 'danger',
    }
  }
  if (event.type === 'task.progress') {
    return {
      label: 'Task progress',
      detail: event.message ?? event.status,
      tone: event.status === 'failed'
        ? 'danger'
        : event.status === 'completed'
          ? 'success'
          : 'active',
    }
  }
  if (event.type === 'run.completed' || event.type === 'run.turn_limited') {
    return { label: 'Run completed', detail: event.type === 'run.turn_limited' ? 'turn limited' : (event.finalOutput ?? 'completed'), tone: 'success' }
  }
  if (event.type === 'run.started') {
    return { label: 'Run started', detail: event.model?.modelId ?? event.runId, tone: 'active' }
  }
  if (event.type === 'run.cancelled') {
    return { label: 'Run cancelled', detail: event.reason ?? 'cancelled', tone: 'neutral' }
  }
  if (event.type === 'run.failed') {
    return { label: 'Run failed', detail: event.error.message, tone: 'danger' }
  }
  return { label: 'Runtime event', detail: '', tone: 'neutral' }
}

export function buildRunRows(runs: AgentRunStateSummary[]): RunRow[] {
  return sortRunsLatestFirst(runs).map((run) => ({
    id: run.runId,
    label: run.runId,
    status: run.status,
    detail: formatRunDetail(run),
    createdAt: formatIsoMinute(run.createdAt),
  }))
}

function sortRunsLatestFirst(runs: AgentRunStateSummary[]): AgentRunStateSummary[] {
  return [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

function formatRunDetail(run: AgentRunStateSummary): string {
  const parts = [run.model.modelId]
  if (run.pendingInterruptionCount > 0) {
    parts.push(`${run.pendingInterruptionCount} pending`)
  } else {
    parts.push(`${run.generatedItemCount} items`)
  }
  if (run.continuation?.checkpoint.step) {
    parts.push(run.continuation.checkpoint.step)
  }
  return parts.join(' · ')
}

function formatIsoMinute(value: string): string {
  return value.slice(0, 16).replace('T', ' ')
}

export function buildTraceRows(trace: AgentRunTrace | null): TraceRow[] {
  if (!trace) return []
  const childrenByParent = new Map<string, AgentRunTraceSpan[]>()
  const spanIds = new Set(trace.spans.map((span) => span.id))
  const roots: AgentRunTraceSpan[] = []

  for (const span of trace.spans) {
    if (span.parentId && spanIds.has(span.parentId)) {
      const children = childrenByParent.get(span.parentId) ?? []
      children.push(span)
      childrenByParent.set(span.parentId, children)
    } else {
      roots.push(span)
    }
  }

  const rows: TraceRow[] = []
  const visit = (span: AgentRunTraceSpan, depth: number) => {
    const children = childrenByParent.get(span.id) ?? []
    rows.push({
      id: span.id,
      label: span.name || span.type,
      type: span.type,
      status: span.status,
      duration: formatDuration(span),
      detail: formatTraceDetail(span),
      depth,
      hasChildren: children.length > 0,
    })
    for (const child of children) visit(child, depth + 1)
  }

  for (const root of roots) visit(root, 0)
  return rows
}

function formatDuration(span: AgentRunTraceSpan): string {
  if (typeof span.durationMs === 'number') return `${span.durationMs}ms`
  if (!span.endedAt) return 'running'
  const duration = Date.parse(span.endedAt) - Date.parse(span.startedAt)
  return Number.isFinite(duration) ? `${Math.max(0, duration)}ms` : ''
}

function formatTraceDetail(span: AgentRunTraceSpan): string | null {
  const payload = span.input !== undefined && span.input !== '[REDACTED_PAYLOAD]'
    ? span.input
    : span.output !== undefined && span.output !== '[REDACTED_PAYLOAD]'
      ? span.output
      : null
  if (payload === null) return null
  if (typeof payload === 'string') return truncate(payload)
  try {
    return truncate(JSON.stringify(payload))
  } catch {
    return String(payload)
  }
}

function truncate(value: string): string {
  return value.length > 180 ? `${value.slice(0, 180)}...` : value
}
