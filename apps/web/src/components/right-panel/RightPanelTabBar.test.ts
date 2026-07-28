import { describe, expect, test } from 'bun:test'
import { buildRightPanelTabItems, closeAllTabsMenuItem, getRightPanelCloseFallback, shouldCloseRightPanelFunctionMenuForTarget, shouldCloseTabForMouseButton } from './RightPanelTabBar'

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

  test('places file tabs immediately after Files while preserving file order', () => {
    expect(buildRightPanelTabItems(
      { tabs: { browser: { type: 'browser', url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false }, files: { type: 'files' } } },
      [
        { id: 'file-a', ref: { source: 'session', scopeId: 'one', relativePath: 'src/a.ts' } },
        { id: 'file-b', ref: { source: 'session', scopeId: 'one', relativePath: 'test/a.ts' } },
      ],
    ).map((item) => item.id)).toEqual(['function:browser', 'function:files', 'file-a', 'file-b'])
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

  test('chooses the tab on the right after closing, then falls back to the left', () => {
    const items = buildRightPanelTabItems(
      {
        tabs: {
          browser: { type: 'browser', url: '', addressInput: '', zoom: 1, deviceToolbarVisible: false },
          files: { type: 'files' },
        },
      },
      [
        { id: 'file-a', ref: { source: 'session', scopeId: 'one', relativePath: 'src/a.ts' }, navigationRevision: 1 },
        { id: 'file-b', ref: { source: 'session', scopeId: 'one', relativePath: 'src/b.ts' }, navigationRevision: 1 },
      ],
      true,
    )

    expect(getRightPanelCloseFallback(items, 'review')?.id).toBe('function:browser')
    expect(getRightPanelCloseFallback(items, 'function:files')?.id).toBe('file-a')
    expect(getRightPanelCloseFallback(items, 'file-a')?.id).toBe('file-b')
    expect(getRightPanelCloseFallback(items, 'file-b')?.id).toBe('file-a')
  })
})
