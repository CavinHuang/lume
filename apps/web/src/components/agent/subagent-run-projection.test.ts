import { describe, expect, test } from 'bun:test'
import type { LumeRuntimeEvent } from '@lume/shared'
import { selectSubagentRunEvents, summarizeSubagentRunActivity } from './subagent-run-projection'

function event(
  id: string,
  type: LumeRuntimeEvent['type'],
  runId: string,
  fields: Record<string, unknown>,
): LumeRuntimeEvent {
  return {
    id,
    type,
    runId,
    threadId: 'child-thread',
    createdAt: `2026-01-01T00:00:0${id}.000Z`,
    ...fields,
  } as LumeRuntimeEvent
}

describe('subagent run projection', () => {
  test('selects every physical attempt in original event order', () => {
    const events = [
      event('1', 'message.user.submitted', 'runtime-1', { text: 'bound task' }),
      event('2', 'assistant.thinking_delta', 'runtime-1', { delta: 'inspect' }),
      event('3', 'tool.started', 'runtime-1', { toolCallId: 'tool-1', toolName: 'Read' }),
      event('4', 'assistant.delta', 'runtime-2', { delta: 'final work' }),
      event('5', 'assistant.delta', 'other-runtime', { delta: 'exclude me' }),
    ]

    expect(selectSubagentRunEvents(events, {
      runId: 'logical-run',
      runtimeRunIds: ['runtime-1', 'runtime-2'],
    }).map((item) => item.id)).toEqual(['1', '2', '3', '4'])
  })

  test('falls back to the logical run id for historical work', () => {
    const events = [
      event('1', 'assistant.delta', 'logical-run', { delta: 'keep' }),
      event('2', 'assistant.delta', 'other-runtime', { delta: 'exclude' }),
    ]

    expect(selectSubagentRunEvents(events, { runId: 'logical-run' })).toEqual([events[0]])
  })

  test('summarizes the latest activity without removing earlier events', () => {
    const events = [
      event('1', 'assistant.final', 'runtime-1', { blocks: [{ type: 'text', text: 'first answer' }] }),
      event('2', 'tool.started', 'runtime-1', { toolCallId: 'tool-1', toolName: 'Read' }),
    ]

    expect(summarizeSubagentRunActivity(events)).toEqual({ toolName: 'Read' })
    expect(events.map((item) => item.id)).toEqual(['1', '2'])
  })
})
