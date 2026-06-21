import { describe, expect, test } from 'bun:test'
import { shouldFlush } from './useSmoothStream'

describe('shouldFlush', () => {
  const base = { lastFlushTime: 0, flushInterval: 50 }

  test('距上次 flush 不足间隔且队列非空 → 不 flush', () => {
    expect(shouldFlush({ ...base, currentTime: 30, queueLength: 10, streamDone: false })).toBe(false)
  })

  test('达到 flush 间隔 → flush', () => {
    expect(shouldFlush({ ...base, currentTime: 50, queueLength: 5, streamDone: false })).toBe(true)
  })

  test('流结束且队列已空 → 即使未到间隔也 flush（保证最终内容落盘）', () => {
    expect(shouldFlush({ ...base, currentTime: 1, queueLength: 0, streamDone: true })).toBe(true)
  })

  test('流结束但队列还有内容 → 不立即 flush（让 renderLoop 继续消费）', () => {
    expect(shouldFlush({ ...base, currentTime: 1, queueLength: 3, streamDone: true })).toBe(false)
  })
})
