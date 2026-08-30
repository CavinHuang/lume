import { describe, expect, test } from 'bun:test'
import { buildRightPanelTabItems, closeAllTabsMenuItem, getRightPanelCloseFallback, shouldCloseRightPanelFunctionMenuForTarget, shouldCloseTabForMouseButton } from './RightPanelTabBar'
import { createThreadFileWorkspace, openFileTab } from './right-panel-files-state'
import { createRightPanelTab, type RightPanelTab } from './right-panel-state'

const fileTab = (id: string, relativePath: string) => ({
  ...openFileTab(
    createThreadFileWorkspace({}),
    { source: 'session' as const, scopeId: 'one', relativePath },
  ).openTabs[0]!,
  id,
})

const functionTabs = (...types: Array<RightPanelTab['type']>): RightPanelTab[] => types.map(createRightPanelTab)

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

  test('places the runtime review tab before the unified tabs', () => {
    expect(buildRightPanelTabItems(
      functionTabs('files'),
      [],
      true,
    ).map((item) => item.id)).toEqual(['review', 'files'])
  })

  test('keeps file child tabs after their files host in the unified order', () => {
    const items = buildRightPanelTabItems(
      functionTabs('browser', 'files', 'git'),
      [
        fileTab('file-a', 'src/a.ts'),
        fileTab('file-b', 'src/b.ts'),
      ],
    )
    // 文件子 tab 紧随 files 宿主;统一 tab 按用户排列序
    expect(items.map((item) => item.id)).toEqual(['browser', 'files', 'file-a', 'file-b', 'git'])

    // files 关闭时,文件子 tab 殿后仍可见
    const withoutFiles = buildRightPanelTabItems(
      functionTabs('git'),
      [fileTab('file-a', 'src/a.ts')],
    )
    expect(withoutFiles.map((item) => item.id)).toEqual(['git', 'file-a'])
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
      functionTabs('files'),
      [
        fileTab('file-a', 'src/a.ts'),
        fileTab('file-b', 'src/b.ts'),
      ],
      true,
    )

    expect(getRightPanelCloseFallback(items, 'review')?.id).toBe('files')
    expect(getRightPanelCloseFallback(items, 'files')?.id).toBe('file-a')
    expect(getRightPanelCloseFallback(items, 'file-a')?.id).toBe('file-b')
    expect(getRightPanelCloseFallback(items, 'file-b')?.id).toBe('file-a')
  })
})
