import { describe, expect, test } from 'bun:test'
import { getTemplate, parseSyntax } from '@antv/infographic'
import {
  INFOGRAPHIC_MAX_SYNTAX_BYTES,
  InfographicSyntaxError,
  LUME_INFOGRAPHIC_FONT_FAMILY,
  prepareInfographic,
  repairInfographicSyntax,
} from './infographic-syntax'

const runtime = { parseSyntax, getTemplate }

describe('prepareInfographic', () => {
  test('accepts registered templates and enables only generic final icon queries', () => {
    const prepared = prepareInfographic(`
infographic list-row-horizontal-icon-arrow
data
  title Delivery
  items
    - label Discover
      desc Clarify the problem
      icon search
    - label Ship
      icon product rocket
theme light
`, runtime, { enableIcons: true })

    expect(prepared.options.template).toBe('list-row-horizontal-icon-arrow')
    expect(prepared.title).toBe('Delivery')
    expect(prepared.options.data?.items?.map((item) => item.icon)).toEqual(['search', 'product rocket'])
    expect(prepared.options.themeConfig?.base?.text?.['font-family']).toBe(LUME_INFOGRAPHIC_FONT_FAMILY)
  })

  test('removes icon queries during streaming without using labels as fallback', () => {
    const prepared = prepareInfographic(`
infographic sequence-timeline-simple
data
  sequences
    - label Confidential customer name
      icon calendar
`, runtime, { enableIcons: false })

    expect(prepared.options.data?.sequences?.[0]?.label).toBe('Confidential customer name')
    expect(prepared.options.data?.sequences?.[0]?.icon).toBeUndefined()
  })

  test('accepts safe incomplete data during streaming preparation', () => {
    const prepared = prepareInfographic(`
infographic list-row-horizontal-icon-arrow
data
  title Customer Growth Engine
`, runtime, { enableIcons: false, allowIncomplete: true })

    expect(prepared.options.template).toBe('list-row-horizontal-icon-arrow')
    expect(prepared.options.data?.title).toBe('Customer Growth Engine')
    expect(prepared.options.data?.items).toBeUndefined()
  })

  test('repairs YAML-style hierarchy fields and lost children indentation', () => {
    const source = `infographic hierarchy-mindmap-level-gradient-compact-card
data
  root
    id: root
    label: AI 合同助手
    children:
- id: arch
  label: 五层架构
  children:
  - id: l1
    label: 页面层
  - id: l2
    label: Flow 编排层
- id: review
  label: 合同审查`
    const repaired = repairInfographicSyntax(source)
    expect(repaired).toContain('    id root')
    expect(repaired).toContain('      - id arch')
    expect(repaired).toContain('          - id l1')
    expect(repaired).toContain('      - id review')

    const prepared = prepareInfographic(source, runtime, { enableIcons: false })
    expect(prepared.options.data?.root?.children).toHaveLength(2)
    expect(prepared.options.data?.root?.children?.[0]?.children).toHaveLength(2)
    expect(prepared.warnings).toContain('已自动修复 YAML 风格字段和列表缩进')
  })

  test('rejects unknown templates and custom design', () => {
    expect(() => prepareInfographic('infographic unknown-template\ndata\n  items\n    - label A', runtime, { enableIcons: true }))
      .toThrow(InfographicSyntaxError)
    expect(() => prepareInfographic(`
infographic list-grid-badge-card
design
  item custom
data
  items
    - label A
`, runtime, { enableIcons: true })).toThrow('v1 不允许自定义 design')
  })

  test('rejects remote, inline, object and illustration resources', () => {
    for (const resource of ['https://example.com/icon.svg', 'data:image/svg+xml;base64,PHN2Zz4=', 'ref:shared', '<svg></svg>']) {
      expect(() => prepareInfographic(`
infographic list-grid-badge-card
data
  items
    - label A
      icon ${resource}
`, runtime, { enableIcons: true })).toThrow('不允许 URL、data URI、ref 或 SVG')
    }

    expect(() => prepareInfographic(`
infographic list-grid-badge-card
data
  items
    - label A
      icon
        source remote
        data https://example.com/icon.svg
`, runtime, { enableIcons: true })).toThrow('只允许通用英文关键词')

    expect(() => prepareInfographic(`
infographic list-grid-badge-card
data
  items
    - label A
      illus image
`, runtime, { enableIcons: true })).toThrow('illus 不受支持')
  })

  test('rejects unsafe theme values and oversized syntax', () => {
    expect(() => prepareInfographic(`
infographic list-grid-badge-card
data
  items
    - label A
theme
  colorPrimary url(https://example.com/a.svg)
`, runtime, { enableIcons: true })).toThrow()

    const oversized = `infographic list-grid-badge-card\ndata\n  items\n    - label ${'x'.repeat(INFOGRAPHIC_MAX_SYNTAX_BYTES)}`
    expect(() => prepareInfographic(oversized, runtime, { enableIcons: true })).toThrow('超过 64 KiB')
  })

  test('supports representative hierarchy, relation and chart data', () => {
    const hierarchy = prepareInfographic(`
infographic hierarchy-tree-curved-line-rounded-rect-node
data
  root
    label Root
    children
      - label Child
`, runtime, { enableIcons: true })
    expect(hierarchy.options.data?.root?.children?.[0]?.label).toBe('Child')

    const relation = prepareInfographic(`
infographic relation-dagre-flow-tb-badge-card
data
  nodes
    - id source
      label Source
    - id target
      label Target
  relations
    - from source
      to target
`, runtime, { enableIcons: true })
    expect(relation.options.data?.relations).toHaveLength(1)

    const chart = prepareInfographic(`
infographic chart-column-simple
data
  values
    - label A
      value 42
`, runtime, { enableIcons: true })
    expect(chart.options.data?.values?.[0]?.value).toBe(42)
  })
})
