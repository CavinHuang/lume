import { describe, expect, test } from 'bun:test'
import { appendRuntimeEvent, hydrateRuntimeEvents } from './runtime-event-state'
import type { AgentThreadRuntimeEventsResult, LumeRuntimeEvent } from '@lume/shared'

function runtimeEvent(event: Partial<LumeRuntimeEvent> & Pick<LumeRuntimeEvent, 'type'>): LumeRuntimeEvent {
  return {
    id: `event:${event.type}`,
    type: event.type,
    threadId: 'thread-1',
    runId: 'run-1',
    createdAt: '2026-05-11T00:00:00.000Z',
    ...event,
  } as LumeRuntimeEvent
}

describe('runtime-event-state', () => {
  test('appends RuntimeEvent per thread with latest terminal status', () => {
    const first = appendRuntimeEvent({}, runtimeEvent({ type: 'assistant.delta', delta: 'hello' }))
    const next = appendRuntimeEvent(first, runtimeEvent({ type: 'run.completed' }))

    expect(next['thread-1']).toMatchObject({
      terminalStatus: 'completed',
      events: [
        { type: 'assistant.delta' },
        { type: 'run.completed' },
      ],
    })
  })

  test('treats turn-limited RuntimeEvents as completed for UI state', () => {
    const state = appendRuntimeEvent({}, runtimeEvent({ type: 'run.turn_limited', reason: 'max turns' }))

    expect(state['thread-1']?.terminalStatus).toBe('completed')
  })

  test('deduplicates optimistic and sidecar submitted user RuntimeEvents', () => {
    const first = appendRuntimeEvent({}, runtimeEvent({
      id: 'optimistic',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:00.000Z',
    }))
    const next = appendRuntimeEvent(first, runtimeEvent({
      id: 'persisted',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:01.000Z',
    }))

    expect(next['thread-1']?.events).toEqual([
      expect.objectContaining({ id: 'optimistic', type: 'message.user.submitted', text: 'hello' }),
    ])
  })

  test('hydrates persisted RuntimeEvents only when live state is empty', () => {
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: [
        runtimeEvent({ type: 'message.user.submitted', text: 'hi' }),
        runtimeEvent({ type: 'run.completed' }),
      ],
    }
    const hydrated = hydrateRuntimeEvents({}, result)

    expect(hydrated['thread-1']?.terminalStatus).toBe('completed')
    expect(hydrated['thread-1']?.events).toHaveLength(2)

    const withLive = appendRuntimeEvent({}, runtimeEvent({ type: 'assistant.delta', delta: 'live' }))
    expect(hydrateRuntimeEvents(withLive, result)).toBe(withLive)
  })
})
