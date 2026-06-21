import type { AgentThreadRuntimeEventsResult, LumeRuntimeEvent } from '@lume/shared'

export interface ThreadRuntimeEventState {
  events: LumeRuntimeEvent[]
  terminalStatus?: 'completed' | 'failed' | 'cancelled'
  updatedAt: number
}

export type RuntimeEventState = Record<string, ThreadRuntimeEventState>

const MAX_EVENTS_PER_THREAD = 100

export function appendRuntimeEvent(
  prev: RuntimeEventState,
  event: LumeRuntimeEvent,
): RuntimeEventState {
  const current = prev[event.threadId]
  if (isDuplicateUserSubmit(current?.events.at(-1), event)) {
    return prev
  }
  const events = trimRuntimeEvents(orderedAppend(current?.events ?? [], event))
  return {
    ...prev,
    [event.threadId]: {
      events,
      terminalStatus: getTerminalStatus(event) ?? current?.terminalStatus,
      updatedAt: Date.now(),
    },
  }
}

export function appendRuntimeEvents(
  prev: RuntimeEventState,
  events: LumeRuntimeEvent[],
): RuntimeEventState {
  if (events.length === 0) return prev
  let next = prev
  // 按线程分组，每组复用 orderedAppend（尾部短路），最后仅对该组做一次 trim
  const byThread = new Map<string, LumeRuntimeEvent[]>()
  for (const event of events) {
    const list = byThread.get(event.threadId) ?? []
    list.push(event)
    byThread.set(event.threadId, list)
  }
  for (const [threadId, list] of byThread) {
    const current = next[threadId]
    let acc = current?.events ?? []
    for (const event of list) {
      if (isDuplicateUserSubmit(acc.at(-1), event)) continue
      acc = orderedAppend(acc, event)
    }
    const trimmed = trimRuntimeEvents(acc)
    const terminal = list.reduce<ThreadRuntimeEventState['terminalStatus'] | undefined>(
      (status, event) => getTerminalStatus(event) ?? status,
      current?.terminalStatus,
    )
    next = {
      ...next,
      [threadId]: { events: trimmed, terminalStatus: terminal, updatedAt: Date.now() },
    }
  }
  return next
}

export function hydrateRuntimeEvents(
  prev: RuntimeEventState,
  result: AgentThreadRuntimeEventsResult,
): RuntimeEventState {
  const current = prev[result.threadId]
  if (result.events.length === 0) {
    return prev
  }
  const events = mergeHydratedRuntimeEvents(result.events, current?.events ?? [])
  if (current && sameRuntimeEvents(current.events, events)) {
    return prev
  }
  return {
    ...prev,
    [result.threadId]: {
      events,
      terminalStatus: events.reduce<ThreadRuntimeEventState['terminalStatus']>(
        (status, event) => getTerminalStatus(event) ?? status,
        current?.terminalStatus,
      ),
      updatedAt: Date.now(),
    },
  }
}

function mergeHydratedRuntimeEvents(
  persistedEvents: LumeRuntimeEvent[],
  liveEvents: LumeRuntimeEvent[],
): LumeRuntimeEvent[] {
  const merged: LumeRuntimeEvent[] = []
  const seenIds = new Set<string>()
  for (const event of [...persistedEvents, ...liveEvents]) {
    if (seenIds.has(event.id)) continue
    if (isDuplicateSubmittedUserEvent(merged, event)) continue
    seenIds.add(event.id)
    merged.push(event)
  }
  return sortRuntimeEvents(merged)
}

function compareRuntimeEvents(a: LumeRuntimeEvent, b: LumeRuntimeEvent): number {
  const timeOrder = a.createdAt.localeCompare(b.createdAt)
  if (timeOrder !== 0) return timeOrder
  const semanticOrder = runtimeEventOrder(a) - runtimeEventOrder(b)
  if (semanticOrder !== 0) return semanticOrder
  if (typeof a.sequence === 'number' && typeof b.sequence === 'number') {
    return a.sequence - b.sequence
  }
  return 0
}

function sortRuntimeEvents(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  return [...events].sort(compareRuntimeEvents)
}

/** 追加/合并后，若尾部仍保持全局有序则无需全量排序（流式 delta 几乎总是命中）。 */
function isTailOrdered(events: LumeRuntimeEvent[]): boolean {
  if (events.length < 2) return true
  const n = events.length
  return compareRuntimeEvents(events[n - 2], events[n - 1]) <= 0
}

/** 合并新事件后，尾部有序则短路返回，否则回退全量 sort；行为等价于 sortRuntimeEvents(appendOrMergeRuntimeEvent(...))。 */
function orderedAppend(events: LumeRuntimeEvent[], event: LumeRuntimeEvent): LumeRuntimeEvent[] {
  const merged = appendOrMergeRuntimeEvent(events, event)
  return isTailOrdered(merged) ? merged : sortRuntimeEvents(merged)
}

function sameRuntimeEvents(a: LumeRuntimeEvent[], b: LumeRuntimeEvent[]): boolean {
  return a.length === b.length && a.every((event, index) => sameRuntimeEvent(event, b[index]))
}

function sameRuntimeEvent(a: LumeRuntimeEvent, b: LumeRuntimeEvent | undefined): boolean {
  if (a === b) return true
  if (!b) return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function isDuplicateSubmittedUserEvent(
  events: LumeRuntimeEvent[],
  next: LumeRuntimeEvent,
): boolean {
  if (next.type !== 'message.user.submitted') return false
  return events.some((event) => (
    event.type === 'message.user.submitted'
    && event.threadId === next.threadId
    && event.text === next.text
    && Math.abs(Date.parse(event.createdAt) - Date.parse(next.createdAt)) < 30_000
  ))
}

function runtimeEventOrder(event: LumeRuntimeEvent): number {
  if (event.type === 'run.started') return 0
  if (event.type === 'message.user.submitted') return 1
  if (event.type === 'assistant.thinking_delta') return 2
  if (event.type === 'assistant.delta') return 2
  if (event.type === 'assistant.final') return 3
  if (event.type === 'tool.started') return 4
  if (event.type === 'tool.completed') return 5
  if (event.type === 'tool.failed') return 5
  if (event.type === 'tool.permission_timeout') return 5
  if (event.type === 'plan.preview') return 6
  if (event.type === 'im.delivery') return 7
  if (event.type === 'memory.context.used') return 8
  if (event.type === 'task.progress') return 9
  if (event.type.startsWith('context.compaction.')) return 10
  if (event.type === 'usage.updated') return 10
  if (event.type.startsWith('run.')) return 11
  return 9
}

function appendOrMergeRuntimeEvent(events: LumeRuntimeEvent[], event: LumeRuntimeEvent): LumeRuntimeEvent[] {
  const last = events.at(-1)
  if (last?.type === 'assistant.delta' && event.type === 'assistant.delta' && hasSameAssistantStreamOwner(last, event)) {
    return [...events.slice(0, -1), { ...last, delta: last.delta + event.delta }]
  }
  if (
    last?.type === 'assistant.thinking_delta'
    && event.type === 'assistant.thinking_delta'
    && hasSameAssistantStreamOwner(last, event)
  ) {
    return [...events.slice(0, -1), { ...last, delta: last.delta + event.delta }]
  }
  return [...events, event]
}

function hasSameAssistantStreamOwner(a: LumeRuntimeEvent, b: LumeRuntimeEvent): boolean {
  return a.runId === b.runId
    && a.parentToolUseId === b.parentToolUseId
    && a.subagentRunId === b.subagentRunId
    && getAssistantMessageId(a) === getAssistantMessageId(b)
}

function getAssistantMessageId(event: LumeRuntimeEvent): string | undefined {
  if (event.type === 'assistant.delta' || event.type === 'assistant.thinking_delta') {
    return event.messageId
  }
  return undefined
}

function trimRuntimeEvents(events: LumeRuntimeEvent[]): LumeRuntimeEvent[] {
  if (events.length <= MAX_EVENTS_PER_THREAD) return events
  const tail = events.slice(-MAX_EVENTS_PER_THREAD)
  if (tail.some((event) => event.type === 'message.user.submitted')) {
    return tail
  }
  const latestUserBeforeTail = [...events.slice(0, -MAX_EVENTS_PER_THREAD)]
    .reverse()
    .find((event) => event.type === 'message.user.submitted')
  return latestUserBeforeTail ? [latestUserBeforeTail, ...tail.slice(1)] : tail
}

function isDuplicateUserSubmit(previous: LumeRuntimeEvent | undefined, next: LumeRuntimeEvent): boolean {
  return previous?.type === 'message.user.submitted'
    && next.type === 'message.user.submitted'
    && previous.text === next.text
}

function getTerminalStatus(event: LumeRuntimeEvent): ThreadRuntimeEventState['terminalStatus'] | undefined {
  if (event.type === 'run.completed') return 'completed'
  if (event.type === 'run.turn_limited') return 'completed'
  if (event.type === 'run.failed') return 'failed'
  if (event.type === 'run.cancelled') return 'cancelled'
  return undefined
}
