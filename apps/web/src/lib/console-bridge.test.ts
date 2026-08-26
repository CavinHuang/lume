import { describe, expect, test, beforeEach, afterAll } from 'bun:test'
import { installConsoleBridge, resetConsoleBridgeForTest, waitForDroppedSummaryForTest } from './console-bridge'
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
    // 确定性等待：summary 写入队列的同一调用栈内 resolve，微任务续跑必然
    // 抢在 logger flush（宏任务定时器）把队列 splice 搬空之前。
    const done = waitForDroppedSummaryForTest()
    for (let i = 0; i < 35; i++) console.warn(`w${i}`)
    await done
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

  test('对象参数经键分类脱敏后再进 message（评审 H6）', () => {
    installConsoleBridge()
    console.error('fail', { password: 'hunter2', ok: 1 })
    const last = readRendererQueueForTest().at(-1)
    expect(String(last?.message)).toContain('"ok":1')
    expect(String(last?.message)).not.toContain('hunter2')
    expect(String(last?.message)).toContain('[redacted]')
  })

  test('resetConsoleBridgeForTest 还原原始 console（不再入队）', () => {
    installConsoleBridge()
    resetConsoleBridgeForTest()
    const before = readRendererQueueForTest().length
    console.error('after-reset')
    expect(readRendererQueueForTest().length).toBe(before)
  })
})
