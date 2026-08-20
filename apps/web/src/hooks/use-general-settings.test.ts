import { describe, expect, test } from 'bun:test'
import type { LumeRuntimeEvent } from '@lume/shared'
import { getLatestPersonalizeUiCompletionId } from './use-general-settings'

function completed(id: string, toolName: string): LumeRuntimeEvent {
  return {
    id,
    type: 'tool.completed',
    threadId: 'thread-1',
    runId: 'run-1',
    toolCallId: `call-${id}`,
    toolName,
    createdAt: `2026-07-17T00:00:0${id}.000Z`,
  }
}

describe('getLatestPersonalizeUiCompletionId', () => {
  test('returns only the latest completed personalize_ui event', () => {
    expect(getLatestPersonalizeUiCompletionId([
      completed('1', 'personalize_ui'),
      completed('2', 'Bash'),
      completed('3', 'personalize_ui'),
    ])).toBe('3')
  })

  test('returns null when personalize_ui has not completed', () => {
    expect(getLatestPersonalizeUiCompletionId([completed('1', 'Bash')])).toBeNull()
  })
})
