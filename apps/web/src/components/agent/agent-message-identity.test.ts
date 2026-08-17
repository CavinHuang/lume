import { describe, expect, test } from 'bun:test'
import { haveSameMessageIdentities } from './agent-message-state'
import type { RuntimeMessageView } from './runtime-message-view'

function msg(id: string): RuntimeMessageView {
  return { id, type: 'user', text: id } as unknown as RuntimeMessageView
}

describe('haveSameMessageIdentities', () => {
  test('引用完全相同时为 true(快路径)', () => {
    const messages = [msg('a'), msg('b')]
    expect(haveSameMessageIdentities(messages, messages)).toBe(true)
  })

  test('流式 token 帧:活跃消息新引用但 id 不变,视为结构相同', () => {
    const previous = [msg('a'), msg('active')]
    const next = [previous[0]!, { ...msg('active'), text: 'streaming partial' }]
    expect(haveSameMessageIdentities(previous, next)).toBe(true)
  })

  test('新增消息(长度变化)为 false', () => {
    const previous = [msg('a')]
    const next = [msg('a'), msg('b')]
    expect(haveSameMessageIdentities(previous, next)).toBe(false)
  })

  test('同位置 id 变化为 false(如切换会话)', () => {
    const previous = [msg('a'), msg('b')]
    const next = [msg('a'), msg('c')]
    expect(haveSameMessageIdentities(previous, next)).toBe(false)
  })
})
