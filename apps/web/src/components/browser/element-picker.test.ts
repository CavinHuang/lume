// 元素选取器单测(ZCode DTt/OTt/kTt 契约):启动/取消脚本形状 + 结果守卫。
import { describe, expect, test } from 'bun:test'

import {
  buildElementPickerCancelScript,
  buildElementPickerStartScript,
  isElementPickerResult,
  ELEMENT_PICKER_MAX_HTML_CHARS,
} from './element-picker'

describe('element picker', () => {
  test('start script self-invokes the picker main with config', () => {
    const script = buildElementPickerStartScript()
    expect(script).toContain('function elementPickerMain')
    expect(script).toContain(JSON.stringify({ maxHtmlChars: ELEMENT_PICKER_MAX_HTML_CHARS }))
  })

  test('cancel script calls the page-level picker.cancel', () => {
    expect(buildElementPickerCancelScript()).toContain("window.__zcodeWebElementPicker")
    expect(buildElementPickerCancelScript()).toContain("picker.cancel()")
  })

  test('result guard accepts selected/cancelled and rejects malformed', () => {
    expect(isElementPickerResult({ status: 'cancelled' })).toBe(true)
    expect(isElementPickerResult({ status: 'selected', element: { selector: '#a' } })).toBe(true)
    expect(isElementPickerResult({ status: 'selected' })).toBe(false)
    expect(isElementPickerResult({ status: 'boom' })).toBe(false)
    expect(isElementPickerResult(null)).toBe(false)
    expect(isElementPickerResult('selected')).toBe(false)
  })
})
