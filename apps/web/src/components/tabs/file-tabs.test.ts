import { describe, expect, test } from 'bun:test'
import { buildFileTab, upsertTab } from './file-tabs'
import { normalizeUrl } from './BrowserTabView'
import type { Tab } from '@/atoms'

describe('file-tabs', () => {
  test('buildFileTab uses basename as title and keeps local tabs stable by sourcePath', () => {
    const tab = buildFileTab({
      filePath: 'docs/release/desktop-release.md',
      fileSource: 'local',
      sourcePath: '/tmp/docs/release/desktop-release.md',
    })

    expect(tab.title).toBe('desktop-release.md')
    expect(tab.id).toBe('file:local:/tmp/docs/release/desktop-release.md')
  })

  test('upsertTab replaces an existing tab in place', () => {
    const tabs: Tab[] = [
      { id: 'a', type: 'welcome', title: '新会话' },
      { id: 'b', type: 'file', title: 'old.md', filePath: 'old.md', fileSource: 'workspace' },
    ]

    expect(upsertTab(tabs, { id: 'b', type: 'file', title: 'new.md', filePath: 'new.md', fileSource: 'workspace' })).toEqual([
      tabs[0],
      { id: 'b', type: 'file', title: 'new.md', filePath: 'new.md', fileSource: 'workspace' },
    ])
  })
})

describe('normalizeUrl', () => {
  test('prefers http for localhost-style addresses and https for external hosts', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173')
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('https://openai.com')).toBe('https://openai.com')
  })
})
