import { describe, expect, test } from 'bun:test'
import { shouldSubmitInteractiveOverlayOnEnter } from './InteractiveOverlayFrame'

// 焦点不在交互控件上时，Enter 由覆盖层 keydown 监听统一提交；
// 焦点落在输入框/文本域则交给原生（保留换行）；落在「提交/忽略/开关」按钮上也交给原生
// （原生 Enter→click 即可，避免重复触发）；唯有标记 data-enter-submits 的选项按钮
// 由覆盖层提交——其原生 Enter→click 仅会重复选中，无法提交。
const stubTarget = (matchesSelectors: string[]) => ({
  closest: (selector: string) =>
    selector
      .split(',')
      .map((s) => s.trim())
      .some((s) => matchesSelectors.includes(s))
      ? ({} as Element)
      : null,
}) as unknown as EventTarget

describe('shouldSubmitInteractiveOverlayOnEnter', () => {
  test('submits on Enter when focus is not on an interactive control', () => {
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, null)).toBe(true)
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, stubTarget([]))).toBe(true)
  })

  test('ignores non-Enter keys', () => {
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Escape' }, null)).toBe(false)
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'a' }, null)).toBe(false)
  })

  test('does not double-fire when a submit/ignore button is focused (native click handles it)', () => {
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, stubTarget(['button']))).toBe(false)
  })

  test('submits when a choice button (data-enter-submits) is focused', () => {
    const choiceButton = stubTarget(['button', '[data-enter-submits]'])
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, choiceButton)).toBe(true)
  })

  test('does not hijack Enter inside an input or textarea', () => {
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, stubTarget(['input']))).toBe(false)
    expect(shouldSubmitInteractiveOverlayOnEnter({ key: 'Enter' }, stubTarget(['textarea']))).toBe(false)
  })
})
