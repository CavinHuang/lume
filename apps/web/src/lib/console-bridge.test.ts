import { describe, expect, test, beforeEach } from 'bun:test'
import { installConsoleBridge, resetConsoleBridgeForTest } from './console-bridge'
import { readRendererQueueForTest, clearRendererQueueForTest } from './desktop-api/logger'

describe('console bridge', () => {
  beforeEach(() => {
    resetConsoleBridgeForTest()
    clearRendererQueueForTest()
  })

  test('console.error 转发为 renderer/console.error 事件', () => {
    installConsoleBridge()
    console.error('boom', { code: 42 })
    const queue = readRendererQueueForTest()
    const last = queue[queue.length - 1]
    expect(last.context).toBe('console')
    expect(last.event).toBe('console.error')
    expect(last.level).toBe('error')
    expect(last.message).toContain('boom')
  })

  test('限流：窗口内超过 30 条丢弃并计数', () => {
    installConsoleBridge()
    for (let i = 0; i < 35; i++) console.warn(`w${i}`)
    const queue = readRendererQueueForTest()
    const bridged = queue.filter((e: { context: string }) => e.context === 'console')
    expect(bridged.length).toBeLessThanOrEqual(30)
  })

  test('Error 入参带 stack', () => {
    installConsoleBridge()
    console.error(new Error('with-stack'))
    const last = readRendererQueueForTest().at(-1)
    expect(String(last?.data?.stack)).toContain('Error: with-stack')
  })
})
