import type {
  AgentRunStateSummary,
  AgentRunTrace,
  AgentRunTraceSpan,
  LumeRunEvent,
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

export interface LiveRunEventRow {
  id: string
  label: string
  detail: string
  tone: 'neutral' | 'active' | 'success' | 'danger'
}

export function buildLiveRunEventRows(events: LumeRunEvent[]): LiveRunEventRow[] {
  return events.slice(-8).map((event, index) => ({
    id: `${index}:${event.type}`,
    ...formatRunEvent(event),
  }))
}

export function getDefaultRunId(runs: AgentRunStateSummary[]): string | null {
  return sortRunsLatestFirst(runs)[0]?.runId ?? null
}

function formatRunEvent(event: LumeRunEvent): Omit<LiveRunEventRow, 'id'> {
  if (event.type === 'user_message_submitted') {
    return { label: 'User message', detail: truncate(event.text), tone: 'neutral' }
  }
  if (event.type === 'assistant_delta') {
    return { label: 'Assistant delta', detail: truncate(event.text), tone: 'neutral' }
  }
  if (event.type === 'assistant_thinking_delta') {
    return { label: 'Thinking delta', detail: truncate(event.text), tone: 'neutral' }
  }
  if (event.type === 'assistant_message_final') {
    return {
      label: 'Assistant final',
      detail: truncate(event.blocks.map((block) => block.text).join(' ')),
      tone: 'success',
    }
  }
  if (event.type === 'tool_call_started') {
    return { label: 'Tool started', detail: event.item.toolName, tone: 'active' }
  }
  if (event.type === 'tool_call_completed') {
    return {
      label: 'Tool completed',
      detail: event.item.toolName ?? event.item.toolCallId,
      tone: event.item.isError ? 'danger' : 'success',
    }
  }
  if (event.type === 'interruption_created') {
    return { label: 'Interruption created', detail: 'waiting for input', tone: 'active' }
  }
  if (event.type === 'interruption_resolved') {
    return { label: 'Interruption resolved', detail: 'resolved', tone: 'success' }
  }
  if (event.type === 'subagent_updated') {
    return {
      label: 'Subagent',
      detail: `${event.item.status}: ${truncate(event.item.task)}`,
      tone: event.item.status === 'failed' || event.item.status === 'cancelled'
        ? 'danger'
        : event.item.status === 'completed'
          ? 'success'
          : 'active',
    }
  }
  if (event.type === 'handoff_updated') {
    return {
      label: 'Handoff',
      detail: `${event.item.status}: ${event.item.fromAgentId} -> ${event.item.toAgentId}`,
      tone: event.item.status === 'failed' || event.item.status === 'cancelled'
        ? 'danger'
        : event.item.status === 'completed'
          ? 'success'
          : 'active',
    }
  }
  if (event.type === 'run_completed') {
    return { label: 'Run completed', detail: event.result.finalOutput ?? 'completed', tone: 'success' }
  }
  if (event.type === 'task_progress') {
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
  return { label: 'Run failed', detail: event.error.message, tone: 'danger' }
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
