// TDD tests for styleSnapshotDeclarations (Task 52).
// browser-guest-preload.ts imports 'electron' at module load。
// 注册共享 superset stub（bun:test 默认共享模式下 mock.module 首写胜出，所有
// desktop 测试必须注册同一 stub，详见 scripts/test-electron-mock.ts）。
import { describe, expect, test, mock } from 'bun:test'
import { electronMockStub } from '../scripts/test-electron-mock'
await mock.module('electron', () => electronMockStub)

const { styleSnapshotDeclarations } = await import('./browser-guest-preload')

describe('styleSnapshotDeclarations', () => {
  test('输出 21 字段 declarations，previousValue === value', () => {
    const el = document.createElement('div')
    el.textContent = 'hi'

    // stub getComputedStyle：仅 color 返回 'red'，其余空
    const orig = window.getComputedStyle
    window.getComputedStyle = (() => ({
      getPropertyValue: (k: string) => (k === 'color' ? 'red' : ''),
    })) as unknown as typeof window.getComputedStyle
    try {
      const decls = styleSnapshotDeclarations(el, window)
      // 20 个 CSS 字段 + textContent = 21
      expect(decls).toHaveLength(21)

      const color = decls.find((d) => d.property === 'color')
      expect(color).toEqual({ property: 'color', value: 'red', previousValue: 'red' })

      const text = decls.find((d) => d.property === 'textContent')
      expect(text).toEqual({ property: 'textContent', value: 'hi', previousValue: 'hi' })

      // 所有声明 previousValue === value（baseline 模式）
      for (const decl of decls) {
        expect(decl.previousValue).toBe(decl.value)
      }
    } finally {
      window.getComputedStyle = orig
    }
  })

  test('textContent 为空时不计入 declarations', () => {
    const el = document.createElement('div')
    const orig = window.getComputedStyle
    window.getComputedStyle = (() => ({
      getPropertyValue: () => '',
    })) as unknown as typeof window.getComputedStyle
    try {
      const decls = styleSnapshotDeclarations(el, window)
      // 无 textContent，仅 20 个 CSS 字段
      expect(decls).toHaveLength(20)
      expect(decls.find((d) => d.property === 'textContent')).toBeUndefined()
    } finally {
      window.getComputedStyle = orig
    }
  })

  test('字段集与 styleSnapshot 一致（20 CSS keys 顺序固定）', () => {
    const el = document.createElement('div')
    el.textContent = 'x'
    const orig = window.getComputedStyle
    window.getComputedStyle = (() => ({ getPropertyValue: () => '' })) as unknown as typeof window.getComputedStyle
    try {
      const decls = styleSnapshotDeclarations(el, window)
      const expected = [
        'color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight',
        'borderRadius', 'borderWidth', 'borderStyle', 'borderColor',
        'width', 'height', 'display', 'flexDirection', 'justifyContent',
        'alignItems', 'gap', 'rowGap', 'columnGap', 'padding', 'margin',
      ]
      expect(decls.map((d) => d.property).slice(0, 20)).toEqual(expected)
    } finally {
      window.getComputedStyle = orig
    }
  })
})
