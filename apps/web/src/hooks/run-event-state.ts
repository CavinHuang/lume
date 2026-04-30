import type { AgentRunEventNotification, AgentThreadRunEventsResult, LumeRunEvent } from '@lume/shared'

export interface ThreadRunEventState {
  events: LumeRunEvent[]
  terminalStatus?: 'completed' | 'failed'
  updatedAt: number
}

export type RunEventState = Record<string, ThreadRunEventState>

const MAX_EVENTS_PER_THREAD = 100

export function appendRunEvent(
  prev: RunEventState,
  notification: AgentRunEventNotification,
): RunEventState {
  const current = prev[notification.threadId]
  if (isDuplicateUserSubmit(current?.events.at(-1), notification.event)) {
    return prev
  }
  const events = trimRunEvents(appendOrMergeEvent(current?.events ?? [], notification.event))
  return {
    ...prev,
    [notification.threadId]: {
      events,
      terminalStatus: getTerminalStatus(notification.event) ?? current?.terminalStatus,
      updatedAt: Date.now(),
    },
  }
}

function appendOrMergeEvent(events: LumeRunEvent[], event: LumeRunEvent): LumeRunEvent[] {
  const last = events.at(-1)
  if (last?.type === 'assistant_delta' && event.type === 'assistant_delta') {
    return [...events.slice(0, -1), { ...last, text: last.text + event.text }]
  }
  if (last?.type === 'assistant_thinking_delta' && event.type === 'assistant_thinking_delta') {
    return [...events.slice(0, -1), { ...last, text: last.text + event.text }]
  }
  return [...events, event]
}

function trimRunEvents(events: LumeRunEvent[]): LumeRunEvent[] {
  if (events.length <= MAX_EVENTS_PER_THREAD) return events
  const tail = events.slice(-MAX_EVENTS_PER_THREAD)
  if (tail.some((event) => event.type === 'user_message_submitted')) {
    return tail
  }
  const latestUserBeforeTail = [...events.slice(0, -MAX_EVENTS_PER_THREAD)]
    .reverse()
    .find((event) => event.type === 'user_message_submitted')
  return latestUserBeforeTail ? [latestUserBeforeTail, ...tail.slice(1)] : tail
}

function isDuplicateUserSubmit(previous: LumeRunEvent | undefined, next: LumeRunEvent): boolean {
  return previous?.type === 'user_message_submitted'
    && next.type === 'user_message_submitted'
    && previous.text === next.text
}

export function hydrateRunEvents(
  prev: RunEventState,
  result: AgentThreadRunEventsResult,
): RunEventState {
  const current = prev[result.threadId]
  if ((current?.events.length ?? 0) > 0 || result.events.length === 0) {
    return prev
  }
  return {
    ...prev,
    [result.threadId]: {
      events: result.events,
      terminalStatus: result.events.reduce<ThreadRunEventState['terminalStatus']>(
        (status, event) => getTerminalStatus(event) ?? status,
        undefined
      ),
      updatedAt: Date.now(),
    },
  }
}

function getTerminalStatus(event: LumeRunEvent): ThreadRunEventState['terminalStatus'] | undefined {
  if (event.type === 'run_completed') return 'completed'
  if (event.type === 'run_failed') return 'failed'
  return undefined
}
