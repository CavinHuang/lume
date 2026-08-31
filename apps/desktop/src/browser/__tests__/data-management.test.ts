// 数据清除单测(ZCode W1):mode 分支的清除面/非法模式/失败归一。
import { describe, expect, test } from 'bun:test'

import { clearEmbeddedBrowserData, isEmbeddedBrowserClearMode } from '../data-management'

const makeSession = () => {
  const calls: string[] = []
  return {
    calls,
    session: {
      clearCache: async () => { calls.push('clearCache') },
      clearStorageData: async (options?: { storages?: string[] }) => { calls.push(`storage:${options ? (options.storages ?? []).join('+') : 'all'}`) },
    } as never,
  }
}

const logger = { info: () => {}, warn: () => {} }

describe('clearEmbeddedBrowserData', () => {
  test('cache mode clears cache and partial storages', async () => {
    const { session, calls } = makeSession()
    const result = await clearEmbeddedBrowserData(session, 'cache', logger)
    expect(result).toEqual({ success: true })
    expect(calls).toEqual(['clearCache', 'storage:shadercache+serviceworkers+cachestorage'])
  })

  test('all mode clears everything including login state', async () => {
    const { session, calls } = makeSession()
    const result = await clearEmbeddedBrowserData(session, 'all', logger)
    expect(result).toEqual({ success: true })
    expect(calls).toEqual(['clearCache', 'storage:all'])
  })

  test('failures normalize to embedded_browser_clear_failed', async () => {
    const session = {
      clearCache: async () => { throw new Error('boom') },
      clearStorageData: async () => {},
    } as never
    const result = await clearEmbeddedBrowserData(session, 'all', logger)
    expect(result).toEqual({ success: false, error: 'embedded_browser_clear_failed' })
  })

  test('mode guard matches ZCode invalid_clear_mode rejection', () => {
    expect(isEmbeddedBrowserClearMode('cache')).toBe(true)
    expect(isEmbeddedBrowserClearMode('all')).toBe(true)
    expect(isEmbeddedBrowserClearMode('everything')).toBe(false)
  })
})
