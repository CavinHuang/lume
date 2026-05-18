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

export interface ContextWindowProgress {
  usedTokens: number
  contextWindow: number
  remainingTokens: number
  percent: number
  tone: 'neutral' | 'active' | 'warning' | 'danger'
  label: string
  detail: string
  sections: ContextWindowProgressSection[]
  usage?: ContextWindowUsageSummary
}

export interface ContextWindowProgressSection {
  id: string
  label: string
  tokens: number
  percent: number
}

export interface ContextWindowUsageSummary {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  costUSD?: number
  records?: ContextWindowUsageRecord[]
}

export interface ContextWindowUsageRecord {
  callerLabel: string
  model?: string
  turn?: number
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheHitRate: number | null
  costUSD?: number
}

const DEFAULT_CONTEXT_WINDOW = 200_000

export function buildLiveRuntimeEventRows(events: LumeRuntimeEvent[]): LiveRuntimeEventRow[] {
  return events.slice(-8).map((event, index) => ({
    id: `${event.id}:${index}`,
    ...formatRuntimeEvent(event),
  }))
}

export function buildContextWindowProgress(
  events: LumeRuntimeEvent[],
  fallback: { contextWindow?: number } = {},
): ContextWindowProgress {
  const fallbackWindow = typeof fallback.contextWindow === 'number' && fallback.contextWindow > 0
    ? fallback.contextWindow
    : DEFAULT_CONTEXT_WINDOW
  let contextWindow = fallbackWindow
  let usedTokens = 0
  let sections: ContextWindowProgressSection[] = []
  let usage: ContextWindowUsageSummary | undefined

  for (const event of events) {
    if (event.type === 'run.started' && isPositiveTokenCount(event.model?.contextWindow)) {
      contextWindow = event.model.contextWindow
      sections = []
    }
    if (event.type === 'context.compaction.started') {
      if (isPositiveTokenCount(event.contextWindow)) {
        contextWindow = event.contextWindow
      }
      usedTokens = event.preTokens
      sections = buildBudgetSections(event.budget, contextWindow)
    }
    if (event.type === 'context.compaction.completed') {
      if (isPositiveTokenCount(event.contextWindow)) {
        contextWindow = event.contextWindow
      }
      usedTokens = event.postTokens ?? event.preTokens
      sections = buildBudgetSections(event.budget, contextWindow)
    }
    if (event.type === 'usage.updated') {
      if (isPositiveTokenCount(event.contextWindow)) {
        contextWindow = event.contextWindow
      }
      usedTokens = event.totalTokens
      usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        cachedTokens: event.cachedTokens ?? 0,
        ...(typeof event.costUSD === 'number' ? { costUSD: event.costUSD } : {}),
        ...buildUsageRecords(event.usageRecords),
      }
      sections = sections.length > 0
        ? sections
        : buildUsageSections(event.inputTokens, event.outputTokens, event.cachedTokens ?? 0, contextWindow)
    }
  }

  const clampedUsedTokens = Math.max(0, usedTokens)
  const percent = Math.min(100, Math.round((clampedUsedTokens / contextWindow) * 100))
  const remainingTokens = Math.max(0, contextWindow - clampedUsedTokens)
  return {
    usedTokens: clampedUsedTokens,
    contextWindow,
    remainingTokens,
    percent,
    tone: percent >= 90 ? 'danger' : percent >= 75 ? 'warning' : percent > 0 ? 'active' : 'neutral',
    label: 'Context window',
    detail: `${formatTokenCount(clampedUsedTokens)} / ${formatTokenCount(contextWindow)} tokens`,
    sections,
    ...(usage ? { usage } : {}),
  }
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
  if (event.type === 'context.compaction.started') {
    return {
      label: 'Context compacting',
      detail: `${event.trigger} · ${event.preTokens} tokens`,
      tone: 'active',
    }
  }
  if (event.type === 'context.compaction.completed') {
    const post = event.postTokens === undefined ? '?' : event.postTokens
    return {
      label: 'Context compacted',
      detail: `${event.trigger} · ${event.preTokens} -> ${post}`,
      tone: 'success',
    }
  }
  if (event.type === 'usage.updated') {
    return {
      label: 'Usage updated',
      detail: typeof event.contextWindow === 'number'
        ? `${formatTokenCount(event.totalTokens)} / ${formatTokenCount(event.contextWindow)} tokens`
        : `${event.totalTokens} tokens`,
      tone: 'neutral',
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

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`
  }
  return String(value)
}

function isPositiveTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function buildUsageSections(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  contextWindow: number,
): ContextWindowProgressSection[] {
  return [
    { id: 'input', label: '输入', tokens: inputTokens, percent: sectionPercent(inputTokens, contextWindow) },
    { id: 'cached', label: '缓存命中', tokens: cachedTokens, percent: sectionPercent(cachedTokens, contextWindow) },
    { id: 'output', label: '输出', tokens: outputTokens, percent: sectionPercent(outputTokens, contextWindow) },
  ].filter((section) => section.tokens > 0)
}

function buildUsageRecords(
  records: Extract<LumeRuntimeEvent, { type: 'usage.updated' }>['usageRecords'],
): Pick<ContextWindowUsageSummary, 'records'> | {} {
  if (!records?.length) return {}
  return {
    records: records
      .map((record) => {
        const cachedTokens = record.cachedTokens ?? 0
        return {
          callerLabel: record.callerLabel,
          ...(typeof record.model === 'string' ? { model: record.model } : {}),
          ...(typeof record.turn === 'number' ? { turn: record.turn } : {}),
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cachedTokens,
          cacheHitRate: record.inputTokens > 0
            ? Math.round((cachedTokens / record.inputTokens) * 100)
            : null,
          ...(typeof record.costUSD === 'number' ? { costUSD: record.costUSD } : {}),
        }
      })
      .filter((record) => record.inputTokens > 0 || record.outputTokens > 0 || record.cachedTokens > 0),
  }
}

function buildBudgetSections(
  budget: Extract<LumeRuntimeEvent, { type: 'context.compaction.started' }>['budget'] | undefined,
  contextWindow: number,
): ContextWindowProgressSection[] {
  if (!budget?.sections) return []
  const entries: Array<{ id: keyof typeof budget.sections; label: string }> = [
    { id: 'system', label: '系统' },
    { id: 'memory', label: '记忆' },
    { id: 'session', label: '会话' },
    { id: 'toolSchemas', label: '工具 Schema' },
    { id: 'reservedOutput', label: '输出预留' },
  ]
  return entries
    .map(({ id, label }) => {
      const tokens = budget.sections[id] ?? 0
      return { id, label, tokens, percent: sectionPercent(tokens, contextWindow) }
    })
    .filter((section) => section.tokens > 0)
}

function sectionPercent(tokens: number, contextWindow: number): number {
  if (contextWindow <= 0) return 0
  return Math.min(100, Math.round((tokens / contextWindow) * 100))
}
