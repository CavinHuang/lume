import { describe, expect, test } from 'bun:test'
import {
  activateBrowserTab,
  applyBrowserDescriptor,
  browserTabFromDescriptor,
  closeBrowserTab,
  duplicateBrowserTab,
  findThreadBrowserTabByUrl,
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
          viewport: {
            enabled: true,
            width: 393,
            height: 852,
            deviceScaleFactor: 3,
            mobile: true,
            touch: true,
            preset: 'iphone-15-pro',
            displayScale: 0.75,
          },
        },
      ],
      recentlyClosed: [],
    })
    expect(restored.tabs.map((tab) => tab.id)).toEqual(['browser:valid'])
    expect(restored.activeTabId).toBe('browser:valid')
    expect(restored.tabs[0]?.viewport).toMatchObject({ preset: 'iphone-15-pro', displayScale: 0.75 })
  })

  test('keeps task-isolated agent tabs whose runtime ids are UUIDs', () => {
    const tab = browserTabFromDescriptor({
      tabId: 'bba6ab3e-57e4-4463-9b07-4d645584dfce',
      ownerThreadId: 'thread-1',
      profileKind: 'agent',
      backend: 'iab',
      generation: 2,
      url: 'https://www.baidu.com/',
      title: '百度一下',
      visible: true,
      surface: 'right-panel',
    })

    expect(sanitizeThreadBrowserWorkspace({ tabs: [tab], activeTabId: tab.id, recentlyClosed: [] })).toMatchObject({
      activeTabId: tab.id,
      tabs: [{ id: tab.id, profileKind: 'agent', url: 'https://www.baidu.com/' }],
    })
  })

  test('reflects runtime loading and media state in the tab strip', () => {
    const workspace = openBrowserTab({ tabs: [], recentlyClosed: [] })
    const tabId = workspace.tabs[0]!.id
    const updated = applyBrowserDescriptor(workspace, {
      tabId,
      backend: 'iab',
      generation: 2,
      url: 'https://example.com',
      title: 'Example',
      visible: true,
      surface: 'right-panel',
      isLoading: true,
      mediaState: { audible: true, camera: false, microphone: true },
      lifecycle: 'active',
    })

    expect(updated.tabs[0]).toMatchObject({
      isLoading: true,
      mediaState: { audible: true, camera: false, microphone: true },
      lifecycle: 'active',
    })
  })

  test('normalizes legacy Codex device preset ids while restoring tabs', () => {
    const restored = sanitizeThreadBrowserWorkspace({
      tabs: [{
        id: 'browser:legacy-device',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastOpenedAt: '2026-01-01T00:00:00.000Z',
        viewport: {
          enabled: true,
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
          touch: false,
          preset: 'laptop-large',
        },
      }],
      recentlyClosed: [],
    })

    expect(restored.tabs[0]?.viewport?.preset).toBe('laptop-l')
  })

  test('finds the latest matching live tab only inside the current thread', () => {
    const match = findThreadBrowserTabByUrl([
      { tabId: 'browser:other', ownerThreadId: 'thread-2', backend: 'iab', generation: 1, url: 'https://example.com/', title: 'Other', visible: false, surface: null },
      { tabId: 'browser:old', ownerThreadId: 'thread-1', backend: 'iab', generation: 1, url: 'https://example.com/', title: 'Old', visible: false, surface: null, lastOpenedAt: '2026-01-01T00:00:00.000Z' },
      { tabId: 'browser:new', ownerThreadId: 'thread-1', backend: 'iab', generation: 1, url: 'https://example.com/#result', title: 'New', visible: false, surface: null, lastOpenedAt: '2026-02-01T00:00:00.000Z' },
    ], 'thread-1', 'https://example.com')

    expect(match?.tabId).toBe('browser:new')
    expect(findThreadBrowserTabByUrl([match!], 'thread-1', 'https://example.com。')?.tabId).toBe('browser:new')
    expect(findThreadBrowserTabByUrl([], 'thread-1', 'not-a-url')).toBeUndefined()
  })
})
