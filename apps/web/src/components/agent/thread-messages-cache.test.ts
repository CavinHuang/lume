import { describe, expect, test } from 'bun:test'
import { ThreadMessagesCache } from './thread-messages-cache'
import type { AgentMessage } from '@lume/shared'

function msg(id: string): AgentMessage {
  return { id } as AgentMessage
}

describe('ThreadMessagesCache', () => {
  test('set / get / has round-trips the stored messages', () => {
    const cache = new ThreadMessagesCache(8)
    expect(cache.has('t1')).toBe(false)
    cache.set('t1', [msg('m1')])
    expect(cache.has('t1')).toBe(true)
    expect(cache.get('t1')).toEqual([msg('m1')])
  })

  test('get on a missing thread returns undefined', () => {
    const cache = new ThreadMessagesCache(8)
    expect(cache.get('missing')).toBeUndefined()
  })

  test('evicts the least-recently-used entry when exceeding capacity', () => {
    const cache = new ThreadMessagesCache(2)
    cache.set('t1', [msg('m1')])
    cache.set('t2', [msg('m2')])
    cache.set('t3', [msg('m3')])
    expect(cache.has('t1')).toBe(false)
    expect(cache.has('t2')).toBe(true)
    expect(cache.has('t3')).toBe(true)
  })

  test('get promotes the entry to most-recently-used', () => {
    const cache = new ThreadMessagesCache(2)
    cache.set('t1', [msg('m1')])
    cache.set('t2', [msg('m2')])
    cache.get('t1') // t1 提到最新，t2 变最旧
    cache.set('t3', [msg('m3')])
    expect(cache.has('t1')).toBe(true)
    expect(cache.has('t2')).toBe(false)
    expect(cache.has('t3')).toBe(true)
  })

  test('set on an existing thread updates value and recency', () => {
    const cache = new ThreadMessagesCache(2)
    cache.set('t1', [msg('m1')])
    cache.set('t2', [msg('m2')])
    cache.set('t1', [msg('m1-updated')]) // t1 提到最新
    cache.set('t3', [msg('m3')]) // 淘汰 t2
    expect(cache.get('t1')).toEqual([msg('m1-updated')])
    expect(cache.has('t2')).toBe(false)
  })

  test('invalidate removes the entry', () => {
    const cache = new ThreadMessagesCache(8)
    cache.set('t1', [msg('m1')])
    cache.invalidate('t1')
    expect(cache.has('t1')).toBe(false)
    expect(cache.get('t1')).toBeUndefined()
  })
})
