import { describe, expect, test } from 'bun:test'
import { buildRightPanelTabItems, closeAllTabsMenuItem, getRightPanelCloseFallback, shouldCloseRightPanelFunctionMenuForTarget, shouldCloseTabForMouseButton } from './RightPanelTabBar'
import { createThreadFileWorkspace, openFileTab } from './right-panel-files-state'

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
      { tabs: { files: { type: 'files' } } },
      [
        fileTab('file-a', 'src/a.ts'),
        fileTab('file-b', 'src/b.ts'),
      ],
      true,
    )

    expect(getRightPanelCloseFallback(items, 'review')?.id).toBe('function:files')
    expect(getRightPanelCloseFallback(items, 'function:files')?.id).toBe('file-a')
    expect(getRightPanelCloseFallback(items, 'file-a')?.id).toBe('file-b')
    expect(getRightPanelCloseFallback(items, 'file-b')?.id).toBe('file-a')
  })
})
