import { describe, expect, test } from 'bun:test'
import { shouldSubmitInteractiveOverlayOnEnter } from './InteractiveOverlayFrame'

// 焦点不在按钮/输入框/文本域时，Enter 由覆盖层 keydown 监听统一提交；
// 焦点落在这些控件上则交给原生处理，避免与按钮 Enter→click 重复触发，也不打断文本域换行。
const stubTarget = (matchesSelector: string | null) => ({
  closest: (selector: string) =>
    selector.split(', ').map((s) => s.trim()).includes(matchesSelector ?? '') ? ({} as Element) : null,
}) as unknown as EventTarget

describe('shouldSubmitInteractiveOverlayOnEnter', () => {
  test('submits on Enter when focus is not on an interactive control', () => {
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, null)).toBe(true)
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, stubTarget(null))).toBe(true)
  })

  test('ignores non-Enter keys', () => {
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Escape' }, null)).toBe(false)
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'a' }, null)).toBe(false)
  })

  test('does not double-fire when a button is focused (native click handles it)', () => {
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, stubTarget('button'))).toBe(false)
  })

  test('does not hijack Enter inside an input or textarea', () => {
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, stubTarget('input'))).toBe(false)
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, stubTarget('textarea'))).toBe(false)
  })
})
