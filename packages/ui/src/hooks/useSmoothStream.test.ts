import { describe, expect, test } from 'bun:test'
import { pickChunkCount, shouldFlush } from './useSmoothStream'

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

describe('pickChunkCount', () => {
  test('流式态用更深缓冲（/8），结束态加速排空（/4）', () => {
    expect(pickChunkCount(16, false)).toBe(2)
    expect(pickChunkCount(16, true)).toBe(4)
  })

  test('结束态单帧取出数 > 流式态，消除"停止后还在慢慢蹦字"的拖尾', () => {
    expect(pickChunkCount(40, false)).toBeLessThan(pickChunkCount(40, true))
  })

  test('每帧至少取 1 个字符', () => {
    expect(pickChunkCount(0, false)).toBe(1)
    expect(pickChunkCount(1, true)).toBe(1)
  })
})
