import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import type { SubagentRunRecord } from '@lume/shared'
import {
  agentStreamingStatesAtom,
  agentStreamingStatesFamily,
  agentSubagentRunsAtom,
  agentSubagentRunsFamily,
} from './agent-atoms'

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
