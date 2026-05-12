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
  const events = trimRuntimeEvents(appendOrMergeRuntimeEvent(current?.events ?? [], event))
  return {
    ...prev,
    [event.threadId]: {
      events,
      terminalStatus: getTerminalStatus(event) ?? current?.terminalStatus,
      updatedAt: Date.now(),
    },
  }
}

export function hydrateRuntimeEvents(
  prev: RuntimeEventState,
  result: AgentThreadRuntimeEventsResult,
): RuntimeEventState {
  const current = prev[result.threadId]
  if ((current?.events.length ?? 0) > 0 || result.events.length === 0) {
    return prev
  }
  return {
    ...prev,
    [result.threadId]: {
      events: result.events,
      terminalStatus: result.events.reduce<ThreadRuntimeEventState['terminalStatus']>(
        (status, event) => getTerminalStatus(event) ?? status,
        undefined,
      ),
      updatedAt: Date.now(),
    },
  }
}

function appendOrMergeRuntimeEvent(events: LumeRuntimeEvent[], event: LumeRuntimeEvent): LumeRuntimeEvent[] {
  const last = events.at(-1)
  if (last?.type === 'assistant.delta' && event.type === 'assistant.delta') {
    return [...events.slice(0, -1), { ...last, delta: last.delta + event.delta }]
  }
  if (last?.type === 'assistant.thinking_delta' && event.type === 'assistant.thinking_delta') {
    return [...events.slice(0, -1), { ...last, delta: last.delta + event.delta }]
  }
  return [...events, event]
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
