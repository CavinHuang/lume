import { describe, expect, test } from 'bun:test'
import { buildRightPanelTabItems, closeAllTabsMenuItem, getRightPanelCloseFallback, shouldCloseRightPanelFunctionMenuForTarget, shouldCloseTabForMouseButton } from './RightPanelTabBar'
import { createThreadFileWorkspace, openFileTab } from './right-panel-files-state'
import { createBrowserTab } from './right-panel-browser-state'

const fileTab = (id: string, relativePath: string) => ({
  ...openFileTab(
    createThreadFileWorkspace({}),
    { source: 'session' as const, scopeId: 'one', relativePath },
  ).openTabs[0]!,
  id,
})

describe('RightPanelTabBar', () => {
  test('keeps the function menu open for inside pointer targets only', () => {
    const menu = {
      contains(target: unknown) {
        return target === 'inside-target'
      },
    } as Pick<Node, 'contains'>

    expect(shouldCloseRightPanelFunctionMenuForTarget(menu, 'inside-target' as unknown as Node)).toBe(false)
    expect(shouldCloseRightPanelFunctionMenuForTarget(menu, 'outside-target' as unknown as Node)).toBe(true)
  })

  test('places browser tabs before Files while preserving file order', () => {
    const browser = createBrowserTab({ title: 'Example', url: 'https://example.com' })
    expect(buildRightPanelTabItems(
      { tabs: { browser: { type: 'browser', url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false }, files: { type: 'files' } } },
      [
        fileTab('file-a', 'src/a.ts'),
        fileTab('file-b', 'test/a.ts'),
      ],
      false,
      [browser],
    ).map((item) => item.id)).toEqual([browser.id, 'function:files', 'file-a', 'file-b'])
  })

  test('places the runtime review tab before persisted functions', () => {
    expect(buildRightPanelTabItems(
      { tabs: { files: { type: 'files' } } },
      [],
      true,
    ).map((item) => item.id)).toEqual(['review', 'function:files'])
  })

  test('middle click closes a tab but primary click does not', () => {
    expect(shouldCloseTabForMouseButton(1)).toBe(true)
    expect(shouldCloseTabForMouseButton(0)).toBe(false)
  })

  test('closing an all-tabs item prevents its parent activation path', () => {
    const calls: string[] = []
    const event = {
      preventDefault: () => calls.push('prevent'),
      stopPropagation: () => calls.push('stop'),
    }
    closeAllTabsMenuItem(event, () => calls.push('close'))

    expect(calls).toEqual(['prevent', 'stop', 'close'])
  })

  test('appends the preview tab after file tabs with a disambiguated label', () => {
    const previewTab = {
      ...fileTab('preview:src-b-ts', 'src/b.ts'),
    }
    const items = buildRightPanelTabItems(
      { tabs: { files: { type: 'files' } } },
      [fileTab('file-a', 'src/a.ts')],
      false,
      [],
      previewTab,
    )

    expect(items.map((item) => item.kind)).toEqual(['function', 'file', 'file-preview'])
    const previewItem = items[2]!
    expect(previewItem.kind === 'file-preview' && previewItem.id).toBe('preview:src-b-ts')
    expect(previewItem.kind === 'file-preview' && previewItem.label).toBe('b.ts')
  })

  test('disambiguates the preview label against formal file tabs with the same basename', () => {
    const previewTab = fileTab('preview:test-a-ts', 'test/a.ts')
    const items = buildRightPanelTabItems(
      { tabs: { files: { type: 'files' } } },
      [fileTab('file-a', 'src/a.ts')],
      false,
      [],
      previewTab,
    )

    expect(items[1]!.label).toBe('a.ts — src')
    expect(items[2]!.label).toBe('a.ts — test')
  })

  test('appends the preview tab even without the files function open', () => {
    const items = buildRightPanelTabItems(
      { tabs: {} },
      [fileTab('file-a', 'src/a.ts')],
      false,
      [],
      fileTab('preview:src-b-ts', 'src/b.ts'),
    )

    expect(items.map((item) => item.id)).toEqual(['file-a', 'preview:src-b-ts'])
  })

  test('omits the preview item when previewTab is null', () => {
    const items = buildRightPanelTabItems(
      { tabs: { files: { type: 'files' } } },
      [fileTab('file-a', 'src/a.ts')],
      false,
      [],
      null,
    )

    expect(items.map((item) => item.kind)).toEqual(['function', 'file'])
  })

  test('chooses the tab on the right after closing, then falls back to the left', () => {
    const browser = createBrowserTab({ title: 'Example', url: 'https://example.com' })
    const items = buildRightPanelTabItems(
      {
        tabs: {
          browser: { type: 'browser', url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false },
          files: { type: 'files' },
        },
      },
      [
        fileTab('file-a', 'src/a.ts'),
        fileTab('file-b', 'src/b.ts'),
      ],
      true,
      [browser],
    )

    expect(getRightPanelCloseFallback(items, 'review')?.id).toBe(browser.id)
    expect(getRightPanelCloseFallback(items, 'function:files')?.id).toBe('file-a')
    expect(getRightPanelCloseFallback(items, 'file-a')?.id).toBe('file-b')
    expect(getRightPanelCloseFallback(items, 'file-b')?.id).toBe('file-a')
  })
})
