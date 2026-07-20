import { describe, expect, test } from 'bun:test'
import { getTemplate, parseSyntax } from '@antv/infographic'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  InfographicBlock,
  copyInfographicDsl,
  configureInfographicRuntime,
  dataUrlToBase64,
  renderInfographic,
  sanitizeInfographicFilename,
  svgDataUrlToText,
  type InfographicInstance,
} from './InfographicBlock'

describe('InfographicBlock export helpers', () => {
  test('renders directly into a measurable AntV container without flashing DSL source', () => {
    const html = renderToStaticMarkup(createElement(InfographicBlock, {
      code: 'infographic list-grid-badge-card',
      streaming: true,
    }))

    expect(html).toContain('aria-label="信息图预览"')
    expect(html).toContain('aria-hidden="false" class="overflow-auto')
    expect(html).not.toContain('<pre')
    expect(html).not.toContain(' hidden=""')
  })

  test('creates safe deterministic filenames', () => {
    expect(sanitizeInfographicFilename('  Q3: Product / Plan  ')).toBe('Q3-Product-Plan')
    expect(sanitizeInfographicFilename('***')).toBe('lume-infographic')
    expect(sanitizeInfographicFilename('CON')).toBe('lume-CON')
  })

  test('decodes percent and base64 SVG exports', () => {
    expect(svgDataUrlToText('data:image/svg+xml,%3Csvg%3Eok%3C%2Fsvg%3E')).toBe('<svg>ok</svg>')
    expect(svgDataUrlToText('data:image/svg+xml;base64,PHN2Zz5vazwvc3ZnPg==')).toBe('<svg>ok</svg>')
  })

  test('extracts PNG base64 and rejects other data URLs', () => {
    expect(dataUrlToBase64('data:image/png;base64,aGVsbG8=')).toBe('aGVsbG8=')
    expect(() => dataUrlToBase64('data:image/svg+xml;base64,aGVsbG8=')).toThrow('无效的 PNG')
  })

  test('reuses AntV render(options) for streaming updates', () => {
    let renderedOptions: Partial<import('@antv/infographic').InfographicOptions> | string | undefined
    const previous = {
      rendered: true,
      render: (options?: string | Partial<import('@antv/infographic').InfographicOptions>) => { renderedOptions = options },
      destroy: () => {},
    } as InfographicInstance
    class MockInfographic implements InfographicInstance {
      rendered = false
      render() { this.rendered = true }
      async toDataURL() { return 'data:image/svg+xml,%3Csvg%2F%3E' }
      destroy() {}
    }

    const result = renderInfographic({
      runtime: { parseSyntax, getTemplate, Infographic: MockInfographic },
      code: 'infographic list-grid-badge-card\ndata\n  items\n    - label A\n      icon search',
      streaming: true,
      container: {} as Element,
      previous,
    })

    expect(result.instance.rendered).toBeTrue()
    expect(result.instance).toBe(previous)
    expect(((renderedOptions as { data?: { items?: Array<{ icon?: string }> } }).data?.items?.[0]?.icon)).toBeUndefined()
  })

  test('destroys an initial instance that cannot render', () => {
    let failedDestroyed = false
    class FailedInfographic implements InfographicInstance {
      rendered = false
      render() {}
      async toDataURL() { return '' }
      destroy() { failedDestroyed = true }
    }

    expect(() => renderInfographic({
      runtime: { parseSyntax, getTemplate, Infographic: FailedInfographic },
      code: 'infographic list-grid-badge-card\ndata\n  items\n    - label A',
      streaming: false,
      container: {} as Element,
    })).toThrow('暂时无法渲染')
    expect(failedDestroyed).toBeTrue()
  })

  test('does not touch the previous SVG when a streaming chunk is incomplete', () => {
    let renderCalled = false
    const previous = {
      rendered: true,
      render: () => { renderCalled = true },
      destroy: () => {},
    } as InfographicInstance

    expect(() => renderInfographic({
      runtime: { parseSyntax, getTemplate, Infographic: class {} as never },
      code: 'infographic list-grid-badge-card\ndata\n  items',
      streaming: true,
      container: {} as Element,
      previous,
    })).toThrow()
    expect(renderCalled).toBeFalse()
  })

  test('copies DSL through the supplied desktop writer', async () => {
    const calls: string[] = []
    await copyInfographicDsl('infographic chart-column-simple', async (text) => { calls.push(text) })
    expect(calls).toEqual(['infographic chart-column-simple'])
  })

  test('uses bundled Lume typography without AntV remote stylesheets', () => {
    const registered: import('@antv/infographic').Font[] = []
    let defaultFont = ''
    configureInfographicRuntime({
      getFonts: () => [{
        fontFamily: '"Alibaba PuHuiTi"',
        name: 'Alibaba PuHuiTi',
        baseUrl: 'https://assets.antv.antgroup.com',
        fontWeight: { regular: 'AlibabaPuHuiTi-Regular/result.css' },
      }],
      registerFont: (font) => {
        registered.push(font)
        return font
      },
      setDefaultFont: (font) => { defaultFont = font },
    })

    expect(registered).toEqual([expect.objectContaining({
      fontFamily: 'Alibaba PuHuiTi',
      baseUrl: '',
      fontWeight: {},
    })])
    expect(defaultFont).toContain('Geist Variable')
    expect(defaultFont).toContain('Microsoft YaHei')
  })
})
