import { describe, expect, test } from 'bun:test'
import { summarizeMessageForPreview, computeHoverBridge } from './ThreadMiniMapPopover'

describe('summarizeMessageForPreview', () => {
  test('截断超长文本到 220 字符', () => {
    const long = 'x'.repeat(300)
    expect(summarizeMessageForPreview(long).length).toBe(220)
  })

  test('空文本返回空字符串', () => {
    expect(summarizeMessageForPreview('   ')).toBe('')
  })

  test('合并多行/连续空白为单空格', () => {
    expect(summarizeMessageForPreview('a\n\n  b\t\tc')).toBe('a b c')
  })

  test('保留短文本不变（去除首尾空白）', () => {
    expect(summarizeMessageForPreview('  hello world  ')).toBe('hello world')
  })

  test('空字符串返回空字符串', () => {
    expect(summarizeMessageForPreview('')).toBe('')
  })

  test('边界：恰好 220 字符不截断', () => {
    const exact = 'y'.repeat(220)
    expect(summarizeMessageForPreview(exact)).toBe(exact)
    expect(summarizeMessageForPreview(exact).length).toBe(220)
  })

  test('先合并空白再截断（顺序：trim+replace 在 slice 前）', () => {
    // 合并后变 5 字符 'a b c'，不会因原始长度 < 220 而受影响
    expect(summarizeMessageForPreview('a   b   c')).toBe('a b c')
  })
})

describe('computeHoverBridge', () => {
  // 默认分支：面板在锚点右侧，桥接填补 [anchor.right, panel.left]，垂直覆盖二者并集
  test('面板在右侧时，桥接水平填补锚点右边缘到面板左边缘', () => {
    const bridge = computeHoverBridge(
      { top: 100, bottom: 128, left: 0, right: 286 },
      { top: 50, left: 294, width: 318, height: 300 },
    )
    expect(bridge).toEqual({ top: 50, left: 286, width: 8, height: 300 })
  })

  // 窄屏翻转分支：面板在锚点左侧，桥接填补 [panel.right, anchor.left]
  test('面板在左侧时，桥接水平填补面板右边缘到锚点左边缘', () => {
    const bridge = computeHoverBridge(
      { top: 100, bottom: 128, left: 400, right: 680 },
      { top: 50, left: 8, width: 318, height: 300 },
    )
    // panel.right = 326，anchor.left = 400 → 桥接 left=326 width=74
    expect(bridge).toEqual({ top: 50, left: 326, width: 74, height: 300 })
  })

  // 锚点远高于面板：垂直并集覆盖斜向穿越路径（鼠标从锚点斜向移入面板）
  test('锚点与面板垂直分离时，桥接垂直覆盖二者并集', () => {
    const bridge = computeHoverBridge(
      { top: 10, bottom: 30, left: 0, right: 286 },
      { top: 100, left: 294, width: 318, height: 200 },
    )
    // top = min(10, 100) = 10；bottom = max(30, 300) = 300；height = 290
    expect(bridge).toEqual({ top: 10, left: 286, width: 8, height: 290 })
  })

  test('面板与锚点水平重叠（窄屏 clamp）时返回 null', () => {
    const bridge = computeHoverBridge(
      { top: 100, bottom: 128, left: 0, right: 300 },
      { top: 50, left: 100, width: 318, height: 300 },
    )
    expect(bridge).toBeNull()
  })

  test('零宽间隙（面板紧贴锚点）时返回 null', () => {
    const bridge = computeHoverBridge(
      { top: 100, bottom: 128, left: 0, right: 286 },
      { top: 50, left: 286, width: 318, height: 300 },
    )
    expect(bridge).toBeNull()
  })
})
