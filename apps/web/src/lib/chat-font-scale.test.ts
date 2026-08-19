import { describe, expect, test } from 'bun:test'
import { isChatFontScale } from './chat-font-scale'

describe('isChatFontScale', () => {
  test('接受三个合法档位', () => {
    expect(isChatFontScale('sm')).toBe(true)
    expect(isChatFontScale('md')).toBe(true)
    expect(isChatFontScale('lg')).toBe(true)
  })

  test('拒绝非法值与缺失', () => {
    expect(isChatFontScale('xl')).toBe(false)
    expect(isChatFontScale(undefined)).toBe(false)
    expect(isChatFontScale(15)).toBe(false)
  })
})
