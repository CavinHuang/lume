import { describe, expect, test } from 'bun:test'
import {
  activateBrowserTab,
  closeBrowserTab,
  duplicateBrowserTab,
  openBrowserTab,
  restoreClosedBrowserTab,
  sanitizeThreadBrowserWorkspace,
} from './right-panel-browser-state'

describe('right panel browser workspace', () => {
  test('opens independent tabs and activates the requested tab', () => {
    const first = openBrowserTab({ tabs: [], recentlyClosed: [] }, { url: 'https://example.com' })
    const second = openBrowserTab(first, { url: 'https://openai.com' })
    expect(second.tabs).toHaveLength(2)
    expect(second.activeTabId).toBe(second.tabs[1]!.id)

    const activated = activateBrowserTab(second, second.tabs[0]!.id)
    expect(activated.activeTabId).toBe(second.tabs[0]!.id)
  })

  test('duplicates next to the source and uses a nearby close fallback', () => {
    const initial = openBrowserTab({ tabs: [], recentlyClosed: [] }, { url: 'https://example.com', title: 'Example' })
    const duplicated = duplicateBrowserTab(initial, initial.tabs[0]!.id)
    expect(duplicated.tabs.map((tab) => tab.url)).toEqual(['https://example.com', 'https://example.com'])
    expect(duplicated.activeTabId).toBe(duplicated.tabs[1]!.id)

    const closed = closeBrowserTab(duplicated, duplicated.tabs[1]!.id)
    expect(closed.activeTabId).toBe(closed.tabs[0]!.id)
    expect(closed.recentlyClosed[0]?.title).toBe('Example')
  })

  test('restores closed tabs with a fresh runtime identity', () => {
    const initial = openBrowserTab({ tabs: [], recentlyClosed: [] }, { url: 'https://example.com' })
    const originalId = initial.tabs[0]!.id
    const restored = restoreClosedBrowserTab(closeBrowserTab(initial, originalId))
    expect(restored.tabs[0]?.url).toBe('https://example.com')
    expect(restored.tabs[0]?.id).not.toBe(originalId)
  })

  test('sanitizes persisted state and rejects non-browser tab ids', () => {
    const restored = sanitizeThreadBrowserWorkspace({
      activeTabId: 'not-browser',
      tabs: [
        { id: 'not-browser', url: 'https://invalid.test' },
        {
          id: 'browser:valid',
          url: 'https://example.com',
          title: 'Example',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastOpenedAt: '2026-01-01T00:00:00.000Z',
          zoomFactor: 1,
        },
      ],
      recentlyClosed: [],
    })
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['browser:valid'])
    expect(restored.activeTabId).toBe('browser:valid')
  })
})
