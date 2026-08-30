import { beforeEach, describe, expect, test } from 'bun:test'
import type { BrowserPanelTab } from './useBrowserPanel'
import {
  BROWSER_WORKSPACE_STORE_LIMIT,
  addStoredBrowserTab,
  emptyBrowserWorkspaceSnapshot,
  findStoredBrowserTab,
  hasStoredBrowserTab,
  patchStoredBrowserTab,
  readBrowserWorkspaceSnapshot,
  removeStoredBrowserTab,
  resetBrowserWorkspaceStore,
  saveBrowserWorkspaceSnapshot,
} from './browser-workspace-state'

function makeTab(overrides: Partial<BrowserPanelTab> & { tabId: string }): BrowserPanelTab {
  return {
    workspaceKey: 'ws-a',
    sessionId: 'user',
    browserId: 'unclaimed-iab',
    browserGeneration: 0,
    origin: 'user',
    residency: 'resident',
    guestState: 'unmounted',
    title: null,
    url: null,
    faviconUrl: null,
    loading: false,
    operationUntil: 0,
    guestGeneration: 0,
    errorMessage: null,
    ...overrides,
  }
}

beforeEach(() => resetBrowserWorkspaceStore())

describe('browser workspace state store', () => {
  test('read on empty store returns an empty snapshot', () => {
    expect(readBrowserWorkspaceSnapshot('missing')).toEqual(emptyBrowserWorkspaceSnapshot())
  })

  test('save/read roundtrip returns a deep copy the caller can mutate safely', () => {
    const tab = makeTab({ tabId: 't1', url: 'https://example.com' })
    saveBrowserWorkspaceSnapshot('ws-a', { tabs: [tab], activeTabId: 't1', collapsed: true })

    const restored = readBrowserWorkspaceSnapshot('ws-a')
    expect(restored.activeTabId).toBe('t1')
    expect(restored.collapsed).toBe(true)
    expect(restored.tabs).toEqual([tab])

    restored.tabs[0]!.title = 'mutated'
    restored.browserUrls.t1 = 'https://mutated.example'
    expect(readBrowserWorkspaceSnapshot('ws-a').tabs[0]?.title).toBeNull()
    expect(readBrowserWorkspaceSnapshot('ws-a').browserUrls.t1).toBe('https://example.com')
  })

  test('read backfills blank tab urls from browserUrls (restore semantics)', () => {
    saveBrowserWorkspaceSnapshot('ws-a', {
      tabs: [makeTab({ tabId: 't1', url: 'about:blank', residency: 'suspended' })],
      activeTabId: 't1',
      collapsed: false,
    })
    patchStoredBrowserTab('t1', { url: 'https://example.com/page' })
    // 模拟挂起壳丢失 url 的场景:落库时 tab.url 为空白 → 由既有 browserUrls 回填。
    saveBrowserWorkspaceSnapshot('ws-a', {
      tabs: [makeTab({ tabId: 't1', url: null, residency: 'suspended' })],
      activeTabId: 't1',
      collapsed: false,
    })

    expect(readBrowserWorkspaceSnapshot('ws-a').tabs[0]?.url).toBe('https://example.com/page')
  })

  test('save derives browserUrls from real tab urls only and prunes closed tabs', () => {
    saveBrowserWorkspaceSnapshot('ws-a', {
      tabs: [
        makeTab({ tabId: 't1', url: 'https://example.com' }),
        makeTab({ tabId: 't2', url: 'about:blank' }),
      ],
      activeTabId: 't1',
      collapsed: false,
    })
    saveBrowserWorkspaceSnapshot('ws-a', {
      tabs: [makeTab({ tabId: 't1', url: 'https://example.com/next' })],
      activeTabId: 't1',
      collapsed: false,
    })

    expect(readBrowserWorkspaceSnapshot('ws-a').browserUrls).toEqual({ t1: 'https://example.com/next' })
  })

  test('patch routes by tabId across workspaces and keeps browserUrls fresh', () => {
    saveBrowserWorkspaceSnapshot('ws-a', { tabs: [makeTab({ tabId: 't1', workspaceKey: 'ws-a' })], activeTabId: 't1', collapsed: false })
    saveBrowserWorkspaceSnapshot('ws-b', { tabs: [makeTab({ tabId: 't1', workspaceKey: 'ws-b' })], activeTabId: 't1', collapsed: false })

    patchStoredBrowserTab('t1', { title: 'Example', faviconUrl: 'https://example.com/f.ico', url: 'https://example.com' })

    for (const key of ['ws-a', 'ws-b']) {
      const snapshot = readBrowserWorkspaceSnapshot(key)
      expect(snapshot.tabs[0]?.title).toBe('Example')
      expect(snapshot.tabs[0]?.faviconUrl).toBe('https://example.com/f.ico')
      expect(snapshot.browserUrls.t1).toBe('https://example.com')
    }
  })

  test('find/has stored tab expose scope fields for background mounting', () => {
    expect(hasStoredBrowserTab('t1')).toBe(false)
    saveBrowserWorkspaceSnapshot('ws-a', { tabs: [makeTab({ tabId: 't1', sessionId: 'agent-1' })], activeTabId: 't1', collapsed: false })

    expect(hasStoredBrowserTab('t1')).toBe(true)
    expect(findStoredBrowserTab('t1')?.sessionId).toBe('agent-1')
    expect(findStoredBrowserTab('nope')).toBeNull()
  })

  test('addStoredBrowserTab appends to the bucket and ignores duplicate ids', () => {
    addStoredBrowserTab('ws-a', makeTab({ tabId: 't1' }))
    addStoredBrowserTab('ws-a', makeTab({ tabId: 't1', title: 'dup' }))
    addStoredBrowserTab('ws-a', makeTab({ tabId: 't2' }))

    const tabs = readBrowserWorkspaceSnapshot('ws-a').tabs
    expect(tabs.map((tab) => tab.tabId)).toEqual(['t1', 't2'])
  })

  test('removeStoredBrowserTab prunes urls and falls back to the neighbour active tab', () => {
    saveBrowserWorkspaceSnapshot('ws-a', {
      tabs: [makeTab({ tabId: 't1', url: 'https://a.example' }), makeTab({ tabId: 't2', url: 'https://b.example' }), makeTab({ tabId: 't3', url: 'https://c.example' })],
      activeTabId: 't2',
      collapsed: false,
    })

    removeStoredBrowserTab('t2')
    let snapshot = readBrowserWorkspaceSnapshot('ws-a')
    expect(snapshot.tabs.map((tab) => tab.tabId)).toEqual(['t1', 't3'])
    expect(snapshot.activeTabId).toBe('t3')
    expect(snapshot.browserUrls.t2).toBeUndefined()

    removeStoredBrowserTab('t3')
    snapshot = readBrowserWorkspaceSnapshot('ws-a')
    expect(snapshot.activeTabId).toBe('t1')
  })

  test('store evicts the least recently written workspace beyond the 50-entry cap', () => {
    expect(BROWSER_WORKSPACE_STORE_LIMIT).toBe(50)
    for (let index = 0; index < BROWSER_WORKSPACE_STORE_LIMIT; index += 1) {
      saveBrowserWorkspaceSnapshot(`ws-${index}`, { tabs: [], activeTabId: null, collapsed: false })
    }
    // 读不刷序:访问 ws-0 后再写 ws-50,被淘汰的仍是最早写入的 ws-0。
    readBrowserWorkspaceSnapshot('ws-0')
    saveBrowserWorkspaceSnapshot('ws-50', { tabs: [], activeTabId: null, collapsed: false })

    expect(hasStoredBrowserTab('t1')).toBe(false)
    expect(readBrowserWorkspaceSnapshot('ws-0')).toEqual(emptyBrowserWorkspaceSnapshot())
    expect(readBrowserWorkspaceSnapshot('ws-1').tabs).toEqual([])

    // 重写 ws-1 刷新插入序,再写入时淘汰下一个(ws-2)而不是 ws-1。
    saveBrowserWorkspaceSnapshot('ws-1', { tabs: [], activeTabId: null, collapsed: false })
    saveBrowserWorkspaceSnapshot('ws-51', { tabs: [], activeTabId: null, collapsed: false })
    expect(readBrowserWorkspaceSnapshot('ws-1').tabs).toEqual([])
    expect(readBrowserWorkspaceSnapshot('ws-2')).toEqual(emptyBrowserWorkspaceSnapshot())
    expect(readBrowserWorkspaceSnapshot('ws-51').tabs).toEqual([])
  })
})
