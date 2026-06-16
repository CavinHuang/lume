import { describe, expect, test } from 'bun:test'
import { shouldCloseRightPanelFunctionMenuForTarget } from './RightPanelTabBar'

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
})
