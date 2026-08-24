import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { BrowserWorkspaceStore, type BrowserWorkspaceLogEvent } from './browser-workspace-store'
import type { BrowserTabDescriptor } from '@lume/shared'

function makeTab(tabId: string, url = 'https://example.test/'): BrowserTabDescriptor {
  return {
    tabId,
    ownerThreadId: 'thread-1',
    profileKind: 'user',
    url,
    title: `Tab ${tabId}`,
    navigationEntries: [url],
    navigationIndex: 0,
    zoomFactor: 1,
    lastOpenedAt: new Date().toISOString(),
  } as unknown as BrowserTabDescriptor
}

function createStore(): { store: BrowserWorkspaceStore; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'lume-workspace-'))
  return { store: new BrowserWorkspaceStore(() => directory), directory }
}

function readTabs(directory: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(directory, 'browser', 'workspaces.json'), 'utf8')).tabs
}

test('#129 recentlyClosed 淘汰条目的 tabs 记录被同步删除', () => {
  const { store, directory } = createStore()
  for (let index = 0; index < 11; index++) store.close(makeTab(`tab-${index}`))
  const tabs = readTabs(directory)
  // 第 1 个关闭的 tab 被 slice(0,10) 淘汰,其 tabs 记录不再保留
  expect(tabs['tab-0']).toBeUndefined()
  expect(tabs['tab-1']).toBeDefined()
  expect(tabs['tab-10']).toBeDefined()
})

test('#129 restoreClosed 恢复后 tabs 记录保留(是打开中 tab 的活跃数据)', () => {
  const { store, directory } = createStore()
  store.close(makeTab('tab-a'))
  const restored = store.restoreClosed('thread-1')
  expect(restored?.tabId).toBe('tab-a')
  expect(readTabs(directory)['tab-a']).toBeDefined()
})

test('#129 跨 workspace 仍引用的被淘汰条目不删(move 场景)', () => {
  const { store, directory } = createStore()
  // thread-1 关闭 shared 后把它 move 到 thread-2(orderedTabIds 持有引用)
  store.close(makeTab('shared'))
  store.move(makeTab('shared', 'https://example.test/2'), 'thread-2')
  // thread-1 再关 11 个 tab,把 shared 与 tab-0 一起挤出 recentlyClosed
  for (let index = 0; index < 11; index++) store.close(makeTab(`tab-${index}`))
  const tabs = readTabs(directory)
  expect(tabs['shared']).toBeDefined()
  expect(tabs['tab-0']).toBeUndefined()
})

test('#129 close→restore→close 交错:记录重写不误删', () => {
  const { store, directory } = createStore()
  store.close(makeTab('tab-a'))
  expect(store.restoreClosed('thread-1')?.tabId).toBe('tab-a')
  store.close(makeTab('tab-a'))
  expect(readTabs(directory)['tab-a']).toBeDefined()
  expect(store.get('thread-1').recentlyClosed.map((closed) => closed.tabId)).toEqual(['tab-a'])
})

test('#129 启动时回收存量无引用的死数据记录', () => {
  const { store, directory } = createStore()
  for (let index = 0; index < 11; index++) store.close(makeTab(`tab-${index}`))
  expect(existsSync(join(directory, 'browser', 'workspaces.json'))).toBe(true)
  // 模拟历史积累:塞一条格式合法但无任何引用的死记录
  const path = join(directory, 'browser', 'workspaces.json')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  raw.tabs['orphan-tab'] = { ...raw.tabs['tab-10'], tabId: 'orphan-tab' }
  writeFileSync(path, JSON.stringify(raw))
  void new BrowserWorkspaceStore(() => directory)
  const tabs = readTabs(directory)
  expect(tabs['orphan-tab']).toBeUndefined()
  expect(tabs['tab-10']).toBeDefined()
})

test('reports tab_closed/tab_moved/imported via onEvent', () => {
  const events: BrowserWorkspaceLogEvent[] = []
  const directory = mkdtempSync(join(tmpdir(), 'lume-workspace-'))
  const store = new BrowserWorkspaceStore(() => directory, (event) => events.push(event))
  store.rememberTab(makeTab('tab-m'))
  store.move(makeTab('tab-m'), 'thread-2')
  store.close({ ...makeTab('tab-m'), ownerThreadId: 'thread-2' } as unknown as BrowserTabDescriptor)
  store.importLegacy('thread-9', [
    { id: 'browser:x', url: 'https://example.test/x' },
    { id: 'browser:y' },
    'junk',
    { id: 'browser:x', url: 'https://example.test/dup' },
  ], undefined)
  expect(events.map((event) => event.event)).toEqual([
    'browser.workspace.tab_moved',
    'browser.workspace.tab_closed',
    'browser.workspace.imported',
  ])
  expect(events[0]?.level).toBe('info')
  expect(events[0]?.data).toMatchObject({ tabId: 'tab-m', fromOwnerThreadId: 'thread-1', toOwnerThreadId: 'thread-2' })
  expect(events[1]?.data).toMatchObject({ ownerThreadId: 'thread-2', tabId: 'tab-m' })
  expect(events[2]?.data?.importedTabCount).toBe(2)
})
