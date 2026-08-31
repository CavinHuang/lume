// 文本右键菜单模板单测(ZCode Pve):选中态复制项/canCopy 门控/无选中空模板。
import { describe, expect, test } from 'bun:test'

import { buildTextContextMenuTemplate } from '../core/text-context-menu'

describe('buildTextContextMenuTemplate', () => {
  test('selection with copy allowed yields enabled copy item', () => {
    expect(buildTextContextMenuTemplate({
      selectionText: ' hello ',
      editFlags: { canCopy: true },
      x: 10,
      y: 20,
    })).toEqual([{ role: 'copy', enabled: true }])
  })

  test('empty or whitespace-only selection yields no items', () => {
    expect(buildTextContextMenuTemplate({ selectionText: '', x: 0, y: 0 })).toEqual([])
    expect(buildTextContextMenuTemplate({ selectionText: '   ', x: 0, y: 0 })).toEqual([])
    expect(buildTextContextMenuTemplate({ x: 0, y: 0 })).toEqual([])
  })

  test('copy disabled when editFlags deny', () => {
    expect(buildTextContextMenuTemplate({ selectionText: 'abc', editFlags: { canCopy: false }, x: 0, y: 0 })).toEqual([
      { role: 'copy', enabled: false },
    ])
  })
})
