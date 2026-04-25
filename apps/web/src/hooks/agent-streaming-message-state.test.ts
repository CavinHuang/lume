import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@lume/shared'
import { replaceStreamingMessage, type StreamingRef } from './useGlobalAgentListeners'

describe('agent streaming message state', () => {
  test('replaceStreamingMessage keeps the streaming uuid stable when final assistant arrives', () => {
    const threadId = 'thread-a'
    const ref: StreamingRef = {
      uuid: 'streaming:thread-a:1',
      text: 'hello',
      thinking: '',
    }
    const finalAssistant = {
      type: 'assistant',
      uuid: 'final-assistant-message',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    } as unknown as SDKMessage
    const prev = {
      [threadId]: [{
        type: 'assistant',
        uuid: ref.uuid,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: ref.text }],
        },
      } as unknown as SDKMessage],
    }

    const next = replaceStreamingMessage(prev, threadId, ref, finalAssistant)

    expect(next[threadId]).toHaveLength(1)
    expect((next[threadId]?.[0] as { uuid?: string }).uuid).toBe(ref.uuid)
    expect(next[threadId]?.[0]).not.toBe(prev[threadId]?.[0])
  })
})
