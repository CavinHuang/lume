import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { SubagentRunRecord } from '@lume/shared'
import {
  agentInputDraftAtom,
  agentInputDraftFamily,
  agentInputHistoryAtom,
  agentInputHistoryFamily,
  agentStreamingStatesAtom,
  agentStreamingStatesFamily,
  agentSubagentRunsAtom,
  agentSubagentRunsFamily,
} from './agent-atoms'
import {
  prependHistory,
  upsertDraft,
  type AgentInputDraftJSON,
} from '@/lib/agent-input-draft-state'

describe('createThreadSliceFamily (per-threadId slice)', () => {
  test('unchanged threadId keeps its value reference → subscriber not notified', () => {
    const store = createStore()
    const runsA: SubagentRunRecord[] = []
    const runsB: SubagentRunRecord[] = []
    store.set(agentSubagentRunsAtom, { A: runsA, B: runsB })

    let calls = 0
    const unsub = store.sub(agentSubagentRunsFamily('A'), () => {
      calls += 1
    })

    // 仅改 B，A 的引用经 spread 保留 → 订阅者不被通知。
    store.set(agentSubagentRunsAtom, { ...store.get(agentSubagentRunsAtom), B: [] })
    expect(calls).toBe(0)

    // A 的切片换为新引用 → 订阅者被通知。
    store.set(agentSubagentRunsAtom, { ...store.get(agentSubagentRunsAtom), A: [] })
    expect(calls).toBe(1)

    unsub()
  })

  test('returns undefined for a threadId with no entry', () => {
    const store = createStore()
    store.set(agentStreamingStatesAtom, { A: 'streaming' })

    expect(store.get(agentStreamingStatesFamily('nope'))).toBeUndefined()
    expect(store.get(agentStreamingStatesFamily('A'))).toBe('streaming')
  })
})

const p = (text: string): AgentInputDraftJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

describe('agentInput draft/history families', () => {
  test('draft family 读切片，未写入时为 undefined', () => {
    const store = createStore()
    store.set(agentInputDraftAtom, {})
    expect(store.get(agentInputDraftFamily('t1'))).toBeUndefined()
    store.set(agentInputDraftAtom, upsertDraft(store.get(agentInputDraftAtom), 't1', p('a')))
    expect(store.get(agentInputDraftFamily('t1'))).toEqual(p('a'))
    expect(store.get(agentInputDraftFamily('t2'))).toBeUndefined()
  })

  test('history family 读切片，未写入时为 undefined', () => {
    const store = createStore()
    store.set(agentInputHistoryAtom, {})
    expect(store.get(agentInputHistoryFamily('t1'))).toBeUndefined()
    store.set(
      agentInputHistoryAtom,
      prependHistory(store.get(agentInputHistoryAtom), 't1', p('a')),
    )
    expect(store.get(agentInputHistoryFamily('t1'))).toHaveLength(1)
  })
})
