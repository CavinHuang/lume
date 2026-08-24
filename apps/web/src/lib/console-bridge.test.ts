import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { installConsoleBridge, resetConsoleBridgeForTest } from './console-bridge'
import { readRendererQueueForTest, clearRendererQueueForTest } from './desktop-api/logger'

describe('console bridge', () => {
  beforeEach(() => {
    resetConsoleBridgeForTest()
    clearRendererQueueForTest()
  })

  afterAll(() => resetConsoleBridgeForTest())

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

  test('限流：新窗口内 35 条 warn 恰好转发 30 条', () => {
    installConsoleBridge()
    for (let i = 0; i < 35; i++) console.warn(`w${i}`)
    const queue = readRendererQueueForTest()
    const bridged = queue.filter((e: { context: string }) => e.context === 'console')
    expect(bridged.length).toBe(30)
  })

  test('窗口结束时补发 console.dropped 汇总', async () => {
    installConsoleBridge({ windowMs: 30 })
    for (let i = 0; i < 35; i++) console.warn(`w${i}`)
    // 等 dropTimer(~30ms) 触发但抢在 logger flush(50ms) 搬空队列之前读取。
    await new Promise((resolve) => setTimeout(resolve, 40))
    const summary = readRendererQueueForTest().find(
      (e: { context: string; event: string }) => e.context === 'console.bridge' && e.event === 'console.dropped',
    )
    expect(summary).toBeDefined()
    expect(summary?.data?.dropped).toBe(5)
  })

  test('Error 入参带 stack', () => {
    installConsoleBridge()
    console.error(new Error('with-stack'))
    const last = readRendererQueueForTest().at(-1)
    expect(String(last?.data?.stack)).toContain('Error: with-stack')
  })

  test('resetConsoleBridgeForTest 还原原始 console（不再入队）', () => {
    installConsoleBridge()
    resetConsoleBridgeForTest()
    const before = readRendererQueueForTest().length
    console.error('after-reset')
    expect(readRendererQueueForTest().length).toBe(before)
  })
})
