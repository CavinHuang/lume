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

  test('does not merge main assistant deltas with subagent-owned deltas', () => {
    const withMainDelta = appendRuntimeEvent({}, runtimeEvent({
      id: 'main-delta',
      type: 'assistant.delta',
      delta: 'main text',
    }))
    const withSubagentDelta = appendRuntimeEvent(withMainDelta, runtimeEvent({
      id: 'subagent-delta',
      type: 'assistant.delta',
      delta: 'subagent text',
      parentToolUseId: 'agent-tool-1',
      subagentRunId: 'subagent-run-1',
    }))

    expect(withSubagentDelta['thread-1']?.events).toEqual([
      expect.objectContaining({ id: 'main-delta', delta: 'main text' }),
      expect.objectContaining({
        id: 'subagent-delta',
        delta: 'subagent text',
        parentToolUseId: 'agent-tool-1',
        subagentRunId: 'subagent-run-1',
      }),
    ])
    expect(withSubagentDelta['thread-1']?.events[0]?.parentToolUseId).toBeUndefined()
  })

  test('keeps live RuntimeEvents in semantic order when final assistant content arrives after tool start', () => {
    const timestamp = '2026-05-11T00:00:00.000Z'
    const withTool = appendRuntimeEvent({}, runtimeEvent({
      id: 'tool-start',
      type: 'tool.started',
      createdAt: timestamp,
      toolCallId: 'agent-tool-1',
      toolName: 'Agent',
      inputPreview: { description: 'write article' },
    }))
    const withLateFinal = appendRuntimeEvent(withTool, runtimeEvent({
      id: 'assistant-final',
      type: 'assistant.final',
      createdAt: timestamp,
      blocks: [{ type: 'text', text: 'handoff first' }],
    }))

    expect(withLateFinal['thread-1']?.events.map((event) => event.id)).toEqual([
      'assistant-final',
      'tool-start',
    ])
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

  test('hydrates persisted RuntimeEvents into empty thread state', () => {
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
  })

  test('hydrates memory context events before terminal events with the same timestamp', () => {
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: [
        runtimeEvent({ type: 'run.completed' }),
        runtimeEvent({
          type: 'memory.context.used',
          items: [{
            id: 'mem_1',
            kind: 'decision',
            scope: 'workspace',
            status: 'active',
            citation: '/tmp/memory/entries/mem_1.md',
            reason: 'matched memory entry',
          }],
          hidden: true,
        }),
      ],
    }

    const hydrated = hydrateRuntimeEvents({}, result)

    expect(hydrated['thread-1']?.events.map((event) => event.type)).toEqual([
      'memory.context.used',
      'run.completed',
    ])
  })

  test('keeps existing state when hydrated RuntimeEvents are structurally unchanged', () => {
    const events = [
      runtimeEvent({ id: 'user-1', type: 'message.user.submitted', text: 'hi' }),
      runtimeEvent({ id: 'done-1', type: 'run.completed' }),
    ]
    const prev = {
      'thread-1': {
        events,
        terminalStatus: 'completed' as const,
        updatedAt: 123,
      },
    }
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: events.map((event) => ({ ...event })),
    }

    expect(hydrateRuntimeEvents(prev, result)).toBe(prev)
  })

  test('hydrates missing persisted user events into existing live state', () => {
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: [
        runtimeEvent({ id: 'persisted-run', type: 'run.started' }),
        runtimeEvent({
          id: 'persisted-user',
          type: 'message.user.submitted',
          text: '帮我看看 download 目录下的文件',
          messageId: 'message-1',
          versionGroupId: 'group-1',
        }),
        runtimeEvent({ id: 'persisted-completed', type: 'run.completed' }),
      ],
    }
    const withLive = appendRuntimeEvent({}, runtimeEvent({ type: 'assistant.delta', delta: 'live' }))
    const hydrated = hydrateRuntimeEvents(withLive, result)

    expect(hydrated['thread-1']?.events.map((event) => event.type)).toEqual([
      'run.started',
      'message.user.submitted',
      'assistant.delta',
      'run.completed',
    ])
    expect(hydrated['thread-1']?.events[1]).toMatchObject({
      type: 'message.user.submitted',
      text: '帮我看看 download 目录下的文件',
      messageId: 'message-1',
      versionGroupId: 'group-1',
    })
    expect(hydrated['thread-1']?.terminalStatus).toBe('completed')
  })
})
