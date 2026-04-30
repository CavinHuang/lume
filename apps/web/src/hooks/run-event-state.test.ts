import { describe, expect, test } from 'bun:test'
import { appendRunEvent, hydrateRunEvents } from './run-event-state'
import type { AgentRunEventNotification } from '@lume/shared'

function event(type: AgentRunEventNotification['event']['type']): AgentRunEventNotification {
  if (type === 'run_failed') {
    return {
      threadId: 'thread-1',
      event: { type, error: { code: 'failed', message: 'boom' } },
    }
  }
  if (type === 'run_completed') {
    return {
      threadId: 'thread-1',
      event: { type, result: { status: 'completed' } },
    }
  }
  return {
    threadId: 'thread-1',
    event: { type: 'assistant_delta', text: 'hello' },
  }
}

describe('run-event-state', () => {
  test('appends events per thread with latest terminal status', () => {
    const first = appendRunEvent({}, event('assistant_delta'))
    const next = appendRunEvent(first, event('run_completed'))

    expect(next['thread-1']).toMatchObject({
      terminalStatus: 'completed',
      events: [
        { type: 'assistant_delta' },
        { type: 'run_completed' },
      ],
    })
  })

  test('deduplicates optimistic and sidecar user submit events', () => {
    const first = appendRunEvent({}, {
      threadId: 't1',
      event: { type: 'user_message_submitted', text: 'hello', createdAt: '2026-04-30T00:00:00.000Z' },
    })
    const next = appendRunEvent(first, {
      threadId: 't1',
      event: { type: 'user_message_submitted', text: 'hello', createdAt: '2026-04-30T00:00:01.000Z' },
    })

    expect(next.t1?.events).toEqual([
      { type: 'user_message_submitted', text: 'hello', createdAt: '2026-04-30T00:00:00.000Z' },
    ])
  })

  test('keeps only the latest events for a thread', () => {
    let state = {}
    for (let index = 0; index < 105; index += 1) {
      state = appendRunEvent(state, {
        threadId: 'thread-1',
        event: {
          type: 'tool_call_started',
          item: {
            type: 'tool_call',
            id: `tool-${index}`,
            toolName: 'Bash',
            input: {},
            parentAgentId: 'runtime-core',
            status: 'running',
            createdAt: '2026-04-30T00:00:00.000Z',
          },
        },
      })
    }

    expect(state['thread-1'].events).toHaveLength(100)
  })

  test('merges streaming deltas so the user message is not pushed out', () => {
    let state = appendRunEvent({}, {
      threadId: 'thread-1',
      event: { type: 'user_message_submitted', text: 'who are you', createdAt: '2026-04-30T00:00:00.000Z' },
    })
    for (let index = 0; index < 150; index += 1) {
      state = appendRunEvent(state, {
        threadId: 'thread-1',
        event: { type: 'assistant_delta', text: `${index},` },
      })
    }

    expect(state['thread-1'].events).toEqual([
      { type: 'user_message_submitted', text: 'who are you', createdAt: '2026-04-30T00:00:00.000Z' },
      { type: 'assistant_delta', text: Array.from({ length: 150 }, (_, index) => `${index},`).join('') },
    ])
  })

  test('preserves the latest user boundary when trimming non-delta events', () => {
    let state = appendRunEvent({}, {
      threadId: 'thread-1',
      event: { type: 'user_message_submitted', text: 'keep me', createdAt: '2026-04-30T00:00:00.000Z' },
    })
    for (let index = 0; index < 105; index += 1) {
      state = appendRunEvent(state, {
        threadId: 'thread-1',
        event: {
          type: 'tool_call_started',
          item: {
            type: 'tool_call',
            id: `tool-${index}`,
            toolName: 'Bash',
            input: {},
            parentAgentId: 'runtime-core',
            status: 'running',
            createdAt: '2026-04-30T00:00:00.000Z',
          },
        },
      })
    }

    expect(state['thread-1'].events[0]).toEqual({
      type: 'user_message_submitted',
      text: 'keep me',
      createdAt: '2026-04-30T00:00:00.000Z',
    })
    expect(state['thread-1'].events).toHaveLength(100)
  })

  test('hydrates persisted events only when live state is empty', () => {
    const hydrated = hydrateRunEvents({}, {
      threadId: 'thread-1',
      events: [
        { type: 'user_message_submitted', text: 'hi', createdAt: '2026-04-30T00:00:00.000Z' },
        { type: 'run_completed', result: { status: 'completed', finalOutput: 'done' } },
      ],
    })

    expect(hydrated['thread-1']?.terminalStatus).toBe('completed')
    expect(hydrated['thread-1']?.events).toHaveLength(2)

    const withLive = appendRunEvent({}, event('assistant_delta'))
    expect(hydrateRunEvents(withLive, {
      threadId: 'thread-1',
      events: [{ type: 'run_completed', result: { status: 'completed' } }],
    })).toBe(withLive)
  })
})
