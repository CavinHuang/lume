// TDD tests for deriveSectionGroups（纯函数：扁平 declarations → SectionGroup[]）。
// 字段命名遵循 5a styleSnapshotDeclarations 的 camelCase 约定（gap/rowGap/columnGap、
// marginTop/paddingTop 等），而非 Codex 原版的 kebab-case。
import { describe, test, expect } from 'bun:test'
import { deriveSectionGroups } from './sectionGroups'
import type { AgentBrowserDesignDeclaration } from '@lume/shared'

const d = (property: string, value = 'v', previousValue = 'p'): AgentBrowserDesignDeclaration => ({ property, value, previousValue })

describe('deriveSectionGroups', () => {
  test('width+height → dimensions section', () => {
    const groups = deriveSectionGroups([d('width'), d('height'), d('color')])
    const dims = groups.find((g) => g.kind === 'dimensions')
    expect(dims).toEqual({ kind: 'dimensions', width: d('width'), height: d('height') })
    expect(groups.filter((g) => g.kind === 'declaration').length).toBe(1)
  })

  test('margin* → spacing section（property=margin，4 边）', () => {
    const groups = deriveSectionGroups([d('marginTop'), d('marginBottom'), d('marginLeft'), d('marginRight')])
    const sp = groups.find((g) => g.kind === 'spacing')
    expect(sp?.kind).toBe('spacing')
    expect(sp?.property).toBe('margin')
    expect((sp as { top?: unknown }).top).toEqual(d('marginTop'))
    expect((sp as { right?: unknown }).right).toEqual(d('marginRight'))
    expect((sp as { bottom?: unknown }).bottom).toEqual(d('marginBottom'))
    expect((sp as { left?: unknown }).left).toEqual(d('marginLeft'))
  })

  test('padding* → spacing（property=padding）', () => {
    const groups = deriveSectionGroups([d('paddingTop'), d('paddingLeft')])
    expect(groups.find((g) => g.kind === 'spacing')?.property).toBe('padding')
  })

  test('rowGap + columnGap → flex-spacing', () => {
    const groups = deriveSectionGroups([d('rowGap'), d('columnGap')])
    const fs = groups.find((g) => g.kind === 'flex-spacing')
    expect(fs?.kind).toBe('flex-spacing')
    expect((fs as { rowGap?: unknown }).rowGap).toEqual(d('rowGap'))
    expect((fs as { columnGap?: unknown }).columnGap).toEqual(d('columnGap'))
  })

  test('gap 单字段 → flex-spacing（适配 Lume styleSnapshot 的 gap 字段）', () => {
    const groups = deriveSectionGroups([d('gap')])
    const fs = groups.find((g) => g.kind === 'flex-spacing')
    expect(fs?.kind).toBe('flex-spacing')
    expect((fs as { gap?: unknown }).gap).toEqual(d('gap'))
  })

  test('gap + rowGap + columnGap 同组（合并为一个 flex-spacing）', () => {
    const groups = deriveSectionGroups([d('gap'), d('rowGap'), d('columnGap')])
    const fsCount = groups.filter((g) => g.kind === 'flex-spacing').length
    expect(fsCount).toBe(1)
  })

  test('其他（color/fontSize）→ declaration section', () => {
    const groups = deriveSectionGroups([d('color'), d('fontSize')])
    expect(groups.length).toBe(2)
    expect(groups.every((g) => g.kind === 'declaration')).toBe(true)
  })

  test('保持输入顺序（已处理 property 不重复）', () => {
    const groups = deriveSectionGroups([d('color'), d('width'), d('height'), d('fontSize')])
    expect(groups.map((g) => g.kind)).toEqual(['declaration', 'dimensions', 'declaration'])
  })

  test('空数组 → 空结果', () => {
    expect(deriveSectionGroups([])).toEqual([])
  })

  test('width 单独出现（无 height）→ dimensions 仅 width', () => {
    const groups = deriveSectionGroups([d('width'), d('color')])
    const dims = groups.find((g) => g.kind === 'dimensions')
    expect(dims).toEqual({ kind: 'dimensions', width: d('width'), height: undefined })
  })

  test('同一 base 的长手属性只产生一个 spacing group（不重复分组）', () => {
    // 两次 marginTop 在实际场景不会出现（snapshot 输出唯一 property）；此处仅验证
    // 不会产生两个 spacing group，而非规定首次/末次胜出（Map 行为是末次胜出）。
    const groups = deriveSectionGroups([d('marginTop'), d('marginLeft')])
    expect(groups.filter((g) => g.kind === 'spacing').length).toBe(1)
  })
})
