// 恢复存储(createRecoveryStore)测试:临时目录读写往返、过滤、pageState、
// 损坏文件回空、7 天清理、shell 封顶、跨实例持久化。
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecoveryStore } from '../recovery-store'
import type { BrowserPageStateSnapshot, BrowserTabShellSnapshot } from '../guest-manager'

let seq = 0

/** 固定时钟:测试壳的 updatedAt 相对它都在 7 天保留期内 */
const NOW = 1_700_000_000_000

function makeStore(configDir: string, overrides: Parameters<typeof createRecoveryStore>[1] = {}) {
  return createRecoveryStore(configDir, { now: () => NOW, ...overrides })
}

function makeShell(overrides: Partial<BrowserTabShellSnapshot> = {}): BrowserTabShellSnapshot {
  seq += 1
  return {
    schemaVersion: 1,
    tabId: `tab-${seq}`,
    windowBindingId: null,
    workspaceKey: 'ws-1',
    sessionId: 'session-1',
    browserId: 'agent-iab',
    browserGeneration: 0,
    origin: 'agent',
    lifecycle: 'active',
    restoreUrl: 'https://example.com/',
    title: `Page ${seq}`,
    faviconUrl: null,
    viewport: null,
    openedAt: NOW,
    lastSelectedAt: null,
    updatedAt: NOW,
    ...overrides,
  }
}

function makePageState(overrides: Partial<BrowserPageStateSnapshot> = {}): BrowserPageStateSnapshot {
  seq += 1
  return {
    schemaVersion: 1,
    tabId: `tab-${seq}`,
    entries: [{ url: 'https://example.com/', title: 'Example' }],
    activeIndex: 0,
    updatedAt: NOW,
    ...overrides,
  }
}

function withTempStore(run: (configDir: string, filePath: string) => Promise<void>) {
  const configDir = mkdtempSync(join(tmpdir(), 'lume-recovery-store-'))
  const filePath = join(configDir, 'browser-recovery', 'store.json')
  return run(configDir, filePath).finally(() => {
    try { rmSync(configDir, { recursive: true, force: true, maxRetries: 5 }) } catch { /* 临时目录清理失败可忽略 */ }
  })
}

describe('shell 往返与过滤', () => {
  test('upsert → listShells → remove;remove 同时清 pageState', async () => {
    await withTempStore(async (configDir) => {
      const store = makeStore(configDir)
      const shell = makeShell()
      const pageState = makePageState({ tabId: shell.tabId })
      await store.upsert(shell)
      await store.upsertPageState(pageState)
      expect((await store.listShells({ workspaceKey: 'ws-1' })).map(item => item.tabId)).toEqual([shell.tabId])
      await store.remove(shell.tabId)
      expect(await store.listShells({ workspaceKey: 'ws-1' })).toEqual([])
      expect(await store.getPageState(shell.tabId)).toBeUndefined()
      await store.whenIdle()
    })
  })

  test('listShells 按 workspaceKey/remoteSessionId/sessionId 过滤', async () => {
    await withTempStore(async (configDir) => {
      const store = makeStore(configDir)
      await store.upsert(makeShell({ tabId: 'local' }))
      await store.upsert(makeShell({ tabId: 'remote-a', remoteSessionId: 'remote-a' }))
      await store.upsert(makeShell({ tabId: 'remote-b', remoteSessionId: 'remote-b' }))
      await store.upsert(makeShell({ tabId: 'other-ws', workspaceKey: 'ws-2' }))
      expect((await store.listShells({ workspaceKey: 'ws-1' })).map(item => item.tabId)).toEqual(['local'])
      expect((await store.listShells({ workspaceKey: 'ws-1', remoteSessionId: 'remote-a' })).map(item => item.tabId)).toEqual(['remote-a'])
      expect((await store.listShells({ workspaceKey: 'ws-1', sessionId: 'session-1' })).map(item => item.tabId)).toEqual(['local'])
      expect((await store.listShells({ workspaceKey: 'ws-1', remoteSessionId: 'remote-b', sessionId: 'session-1' })).map(item => item.tabId)).toEqual(['remote-b'])
      expect(await store.listShells({ workspaceKey: 'ws-3' })).toEqual([])
    })
  })

  test('listShells 按 updatedAt 降序(最近活跃优先)', async () => {
    await withTempStore(async (configDir) => {
      const store = makeStore(configDir)
      await store.upsert(makeShell({ tabId: 'old', updatedAt: NOW - 2000 }))
      await store.upsert(makeShell({ tabId: 'new', updatedAt: NOW - 1000 }))
      expect((await store.listShells({ workspaceKey: 'ws-1' })).map(item => item.tabId)).toEqual(['new', 'old'])
    })
  })
})

describe('pageState', () => {
  test('upsert → getPageState → removePageState', async () => {
    await withTempStore(async (configDir) => {
      const store = makeStore(configDir)
      const pageState = makePageState()
      await store.upsertPageState(pageState)
      const read = await store.getPageState(pageState.tabId)
      expect(read?.activeIndex).toBe(0)
      expect(read?.entries[0]?.url).toBe('https://example.com/')
      // 返回克隆:改写不影响存储
      read!.activeIndex = 9
      expect((await store.getPageState(pageState.tabId))?.activeIndex).toBe(0)
      await store.removePageState(pageState.tabId)
      expect(await store.getPageState(pageState.tabId)).toBeUndefined()
    })
  })

  test('upsertPageState 同 tabId 覆盖', async () => {
    await withTempStore(async (configDir) => {
      const store = makeStore(configDir)
      const pageState = makePageState()
      await store.upsertPageState(pageState)
      await store.upsertPageState({ ...pageState, activeIndex: 1 })
      expect((await store.getPageState(pageState.tabId))?.activeIndex).toBe(1)
    })
  })
})

describe('持久化', () => {
  test('whenIdle 落盘;新实例读回;文件为 schemaVersion:1 形状', async () => {
    await withTempStore(async (configDir, filePath) => {
      const store = makeStore(configDir)
      const shell = makeShell()
      await store.upsert(shell)
      await store.upsertPageState(makePageState({ tabId: shell.tabId }))
      await store.whenIdle()
      expect(existsSync(filePath)).toBe(true)
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { schemaVersion: number; shells: unknown[]; pageStates: unknown[] }
      expect(raw.schemaVersion).toBe(1)
      expect(raw.shells).toHaveLength(1)
      expect(raw.pageStates).toHaveLength(1)

      const reopened = makeStore(configDir)
      expect((await reopened.listShells({ workspaceKey: 'ws-1' })).map(item => item.tabId)).toEqual([shell.tabId])
      expect((await reopened.getPageState(shell.tabId))?.activeIndex).toBe(0)
    })
  })

  test('损坏文件 → 空存储且可继续写入', async () => {
    await withTempStore(async (configDir, filePath) => {
      mkdirSync(join(configDir, 'browser-recovery'), { recursive: true })
      writeFileSync(filePath, '{not json at all', 'utf8')
      const store = makeStore(configDir)
      expect(await store.listShells({ workspaceKey: 'ws-1' })).toEqual([])
      const shell = makeShell()
      await store.upsert(shell)
      await store.whenIdle()
      const reopened = makeStore(configDir)
      expect((await reopened.listShells({ workspaceKey: 'ws-1' })).map(item => item.tabId)).toEqual([shell.tabId])
    })
  })

  test('schema 不符 → 空存储', async () => {
    await withTempStore(async (configDir, filePath) => {
      mkdirSync(join(configDir, 'browser-recovery'), { recursive: true })
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 99, shells: [makeShell()], pageStates: [] }), 'utf8')
      const store = makeStore(configDir)
      expect(await store.listShells({ workspaceKey: 'ws-1' })).toEqual([])
    })
  })
})

describe('清理策略', () => {
  test('加载时清除超过 7 天的条目', async () => {
    await withTempStore(async (configDir, filePath) => {
      mkdirSync(join(configDir, 'browser-recovery'), { recursive: true })
      const now = 10_000_000
      const fresh = makeShell({ tabId: 'fresh', updatedAt: now })
      const stale = makeShell({ tabId: 'stale', updatedAt: now - 8 * 24 * 60 * 60 * 1000 })
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          shells: [fresh, stale],
          pageStates: [makePageState({ tabId: 'stale', updatedAt: stale.updatedAt })],
        }),
        'utf8',
      )
      const store = makeStore(configDir, { now: () => now })
      expect((await store.listShells({ workspaceKey: 'ws-1' })).map(item => item.tabId)).toEqual(['fresh'])
      expect(await store.getPageState('stale')).toBeUndefined()
    })
  })

  test('shell 封顶:超出按 updatedAt 保留最新,被裁 pageState 一并清除', async () => {
    await withTempStore(async (configDir) => {
      const store = makeStore(configDir, { maxShells: 2 })
      await store.upsert(makeShell({ tabId: 'a', updatedAt: NOW - 3000 }))
      await store.upsert(makeShell({ tabId: 'b', updatedAt: NOW - 2000 }))
      await store.upsertPageState(makePageState({ tabId: 'a', updatedAt: NOW - 3000 }))
      await store.upsert(makeShell({ tabId: 'c', updatedAt: NOW - 1000 }))
      const remaining = (await store.listShells({ workspaceKey: 'ws-1' })).map(item => item.tabId)
      expect(remaining).toEqual(['c', 'b'])
      expect(await store.getPageState('a')).toBeUndefined()
    })
  })
})
