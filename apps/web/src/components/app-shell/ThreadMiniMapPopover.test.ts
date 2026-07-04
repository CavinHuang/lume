import { describe, expect, test } from 'bun:test'
import { summarizeMessageForPreview } from './ThreadMiniMapPopover'

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
