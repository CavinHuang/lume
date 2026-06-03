import { describe, expect, test } from 'bun:test'
import type { AgentMessageQueueSnapshot } from '@lume/shared'
import {
  createEmptyAgentMessageQueueSnapshot,
  reorderQueuedMessages,
  upsertAgentMessageQueueSnapshot,
} from './agent-message-queue-state'

function createSnapshot(): AgentMessageQueueSnapshot {
  return {
    threadId: 'thread-a',
    queuedMessages: [
      { id: 'queued-1', threadId: 'thread-a', text: 'first', createdAt: 1 },
      { id: 'queued-2', threadId: 'thread-a', text: 'second', createdAt: 2 },
      { id: 'queued-3', threadId: 'thread-a', text: 'third', createdAt: 3 },
    ],
    pendingGuidance: [],
  }
}

describe('agent message queue state', () => {
  test('creates an empty snapshot for a thread', () => {
    expect(createEmptyAgentMessageQueueSnapshot('thread-a')).toEqual({
      threadId: 'thread-a',
      queuedMessages: [],
      pendingGuidance: [],
    })
  })

  test('upserts queue snapshots by thread id', () => {
    const snapshot = createSnapshot()

    expect(upsertAgentMessageQueueSnapshot({}, snapshot)).toEqual({
      'thread-a': snapshot,
    })
  })

  test('reorders queued messages by dragging one item before another', () => {
    const reordered = reorderQueuedMessages(createSnapshot(), 'queued-3', 'queued-1')

    expect(reordered.queuedMessages.map((item) => item.id)).toEqual([
      'queued-3',
      'queued-1',
      'queued-2',
    ])
  })

  test('keeps snapshot unchanged when ids are missing', () => {
    const snapshot = createSnapshot()

    expect(reorderQueuedMessages(snapshot, 'missing', 'queued-1')).toBe(snapshot)
    expect(reorderQueuedMessages(snapshot, 'queued-1', 'missing')).toBe(snapshot)
  })
})
