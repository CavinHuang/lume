import { beforeEach, describe, expect, mock, test } from 'bun:test'

const invokeMock = mock(async () => undefined)

mock.module('@/lib/desktop-runtime/core', () => ({
  invoke: invokeMock,
  isDesktopRuntime: () => true,
}))

const logger = await import('./logger')

/** normalizeClip 单字符串上限 8_192 字符，用多键拼出目标体积。 */
function bigData(kb: number): Record<string, unknown> {
  const keys = Math.ceil((kb * 1024) / 8_192)
  const data: Record<string, unknown> = {}
  for (let i = 0; i < keys; i++) data[`k${i}`] = 'x'.repeat(8_192)
  return data
}

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

function write(level: Level, kb: number, label: string): void {
  logger.writeWebLogEvent({
    level,
    kind: 'log',
    context: 'test',
    event: 'log.message',
    message: label,
    data: bigData(kb),
  })
}

describe('renderer log queue gates (#754)', () => {
  beforeEach(() => {
    logger.clearRendererQueueForTest()
    invokeMock.mockClear()
    invokeMock.mockImplementation(async () => undefined)
  })

  test('byte gate drops incoming info when queue holds only non-evictable events', () => {
    for (let i = 0; i < 5; i++) write('info', 96, `m${i}`)
    expect(logger.readRendererQueueForTest()).toHaveLength(5)
    // 再塞 ~96KB 越过 512KB 字节门：无可驱逐的 trace/debug，新事件被弃。
    write('info', 96, 'overflow')
    expect(logger.readRendererQueueForTest()).toHaveLength(5)
  })

  test('byte gate evicts trace/debug before dropping incoming event', () => {
    for (let i = 0; i < 4; i++) write('info', 96, `m${i}`)
    write('trace', 96, 'noise')
    write('info', 96, 'overflow')
    const queue = logger.readRendererQueueForTest()
    expect(queue).toHaveLength(5)
    expect(queue.some((e) => e.level === 'trace')).toBe(false)
    expect(queue.map((e) => e.message)).toEqual(['m0', 'm1', 'm2', 'm3', 'overflow'])
  })

  test('protected level shifts oldest under byte pressure', () => {
    for (let i = 0; i < 5; i++) write('info', 96, `m${i}`)
    write('error', 60, 'boom')
    const queue = logger.readRendererQueueForTest()
    expect(queue).toHaveLength(5)
    expect(queue.at(-1)?.level).toBe('error')
    expect(queue[0]?.message).toBe('m1')
  })

  test('single event over byte gate is never enqueued', () => {
    write('fatal', 600, 'huge')
    expect(logger.readRendererQueueForTest()).toHaveLength(0)
  })

  test('flush failure requeues batch instead of dropping it', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('ipc down')
    })
    for (let i = 0; i < 3; i++) write('info', 1, `m${i}`)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(logger.readRendererQueueForTest()).toHaveLength(3)
  })
})
