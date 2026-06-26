import { describe, expect, test } from 'bun:test'
import {
  AGENT_INPUT_HISTORY_LIMIT,
  isEmptyDraft,
  prependHistory,
  removeDraft,
  removeHistory,
  upsertDraft,
  type AgentInputDraftJSON,
} from './agent-input-draft-state'

const p = (text: string): AgentInputDraftJSON => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined }],
})

describe('agent-input-draft-state', () => {
  test('upsertDraft 写入并保留其它 thread', () => {
    const state = upsertDraft({}, 't1', p('a'))
    expect(state.t1).toEqual(p('a'))
    const state2 = upsertDraft(state, 't2', p('b'))
    expect(state2.t1).toEqual(p('a'))
    expect(state2.t2).toEqual(p('b'))
  })

  test('removeDraft 仅删指定 thread，不存在时原样返回', () => {
    const state = upsertDraft(upsertDraft({}, 't1', p('a')), 't2', p('b'))
    const removed = removeDraft(state, 't1')
    expect(removed.t1).toBeUndefined()
    expect(removed.t2).toEqual(p('b'))
    expect(removeDraft(removed, 't1')).toBe(removed) // 不存在同引用
  })

  test('prependHistory 队首插入', () => {
    const state = prependHistory({}, 't1', p('a'))
    const state2 = prependHistory(state, 't1', p('b'))
    expect(state2.t1?.map((n) => n.content?.[0]?.content?.[0]?.text)).toEqual(['b', 'a'])
  })

  test('prependHistory 超过上限裁剪到 AGENT_INPUT_HISTORY_LIMIT', () => {
    let state: Record<string, AgentInputDraftJSON[]> = {}
    for (let i = 0; i < AGENT_INPUT_HISTORY_LIMIT + 5; i++) {
      state = prependHistory(state, 't1', p(`m${i}`))
    }
    expect(state.t1).toHaveLength(AGENT_INPUT_HISTORY_LIMIT)
    // 最新插入的在队首
    expect(state.t1[0].content?.[0]?.content?.[0]?.text).toBe(`m${AGENT_INPUT_HISTORY_LIMIT + 4}`)
  })

  test('prependHistory 不同 thread 互不影响', () => {
    const s1 = prependHistory({}, 't1', p('a'))
    const s2 = prependHistory(s1, 't2', p('b'))
    expect(s2.t1).toHaveLength(1)
    expect(s2.t2).toHaveLength(1)
  })

  test('removeHistory 仅删指定 thread', () => {
    const state = prependHistory(prependHistory({}, 't1', p('a')), 't2', p('b'))
    const removed = removeHistory(state, 't1')
    expect(removed.t1).toBeUndefined()
    expect(removed.t2).toHaveLength(1)
  })

  test('isEmptyDraft 判定空草稿', () => {
    expect(isEmptyDraft(undefined)).toBe(true)
    expect(isEmptyDraft(p(''))).toBe(true)
    expect(isEmptyDraft(p('   '))).toBe(true)
    expect(isEmptyDraft(p('hello'))).toBe(false)
  })
})
