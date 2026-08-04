import { describe, expect, test } from 'bun:test'
import type { AgentMessageQueueSnapshot } from '@lume/shared'
import {
  applyOrderByIds,
  createEmptyAgentMessageQueueSnapshot,
  reorderQueuedMessages,
  startEditingQueuedMessage,
  upsertAgentMessageQueueSnapshot,
} from './agent-message-queue-state'

function createSnapshot(): AgentMessageQueueSnapshot {
  return {
    threadId: 'thread-a',
    revision: 3,
    queuedMessages: [
      { id: 'queued-1', threadId: 'thread-a', text: 'first', createdAt: 1, revision: 3, status: 'queued' },
      { id: 'queued-2', threadId: 'thread-a', text: 'second', createdAt: 2, revision: 3, status: 'queued' },
      { id: 'queued-3', threadId: 'thread-a', text: 'third', createdAt: 3, revision: 3, status: 'queued' },
    ],
    pendingGuidance: [],
  }
}

describe('agent message queue state', () => {
  test('creates an empty snapshot for a thread', () => {
    expect(createEmptyAgentMessageQueueSnapshot('thread-a')).toEqual({
      threadId: 'thread-a',
      revision: 0,
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

  test('moves an earlier item before a later target', () => {
    const reordered = reorderQueuedMessages(createSnapshot(), 'queued-1', 'queued-3', 'before')

    expect(reordered.queuedMessages.map((item) => item.id)).toEqual([
      'queued-2',
      'queued-1',
      'queued-3',
    ])
  })

  test('moves an item after the drop target', () => {
    const reordered = reorderQueuedMessages(createSnapshot(), 'queued-1', 'queued-2', 'after')

    expect(reordered.queuedMessages.map((item) => item.id)).toEqual([
      'queued-2',
      'queued-1',
      'queued-3',
    ])
  })

  test('keeps snapshot unchanged when ids are missing', () => {
    const snapshot = createSnapshot()

    expect(reorderQueuedMessages(snapshot, 'missing', 'queued-1')).toBe(snapshot)
    expect(reorderQueuedMessages(snapshot, 'queued-1', 'missing')).toBe(snapshot)
  })

  test('starts editing without removing the queued message', () => {
    const result = startEditingQueuedMessage(createSnapshot(), 'queued-2')

    expect(result?.draftText).toBe('second')
    expect(result?.snapshot.queuedMessages.map((item) => item.id)).toEqual([
      'queued-1',
      'queued-2',
      'queued-3',
    ])
  })

  test('returns null when starting edit for a missing queued message', () => {
    expect(startEditingQueuedMessage(createSnapshot(), 'missing')).toBeNull()
  })
})

describe('applyOrderByIds', () => {
  const snap = (items: Array<{ id: string; internal?: boolean }>): AgentMessageQueueSnapshot => ({
    threadId: 't1', revision: 1,
    queuedMessages: items.map((it) => ({ id: it.id, threadId: 't1', text: '', createdAt: 1, revision: 0, status: 'queued', internal: it.internal } as never)),
    pendingGuidance: [],
  })

  test('按 orderedIds 重排 visible 项', () => {
    const out = applyOrderByIds(snap([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), ['c', 'a', 'b'])
    expect(out.queuedMessages.map((m) => m.id)).toEqual(['c', 'a', 'b'])
  })

  test('保留 internal 项原相对位置', () => {
    const out = applyOrderByIds(snap([{ id: 'a' }, { id: 'i1', internal: true }, { id: 'b' }]), ['b', 'a'])
    expect(out.queuedMessages.map((m) => m.id)).toEqual(['b', 'i1', 'a'])
  })

  test('orderedIds 不变时返回等价顺序', () => {
    const s = snap([{ id: 'a' }, { id: 'b' }])
    const out = applyOrderByIds(s, ['a', 'b'])
    expect(out.queuedMessages.map((m) => m.id)).toEqual(['a', 'b'])
  })

  test('未知 id 安全忽略', () => {
    const out = applyOrderByIds(snap([{ id: 'a' }, { id: 'b' }]), ['a', 'x', 'b'])
    expect(out.queuedMessages.map((m) => m.id)).toEqual(['a', 'b'])
  })
})
