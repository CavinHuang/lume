import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { BrowserWorkspaceStore } from './browser-workspace-store'
import type { BrowserTabDescriptor } from '../../../packages/shared/src/types/browser-runtime'

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
