import { describe, expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@lume/ui', () => ({
  highlightCode: async () => undefined,
  highlightToTokens: () => null,
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
  MermaidBlock: () => null,
}))

const { RightPanelSourcePreview } = await import('./RightPanelSourcePreview')

describe('RightPanelSourcePreview line navigation', () => {
  test('renders stable one-based line ids and highlights the requested range', () => {
    const markup = renderToStaticMarkup(
      <RightPanelSourcePreview
        content={'one\ntwo\nthree'}
        filePath="src/app.ts"
        lineSelection={{ start: 2, end: 3 }}
        navigationRevision={7}
      />,
    )

    expect(markup).toContain('data-line-number="1"')
    expect(markup).toContain('data-line-number="2"')
    expect(markup.match(/color-mix\(in oklab, var\(--lume-accent\) 14%, transparent\)/g)).toHaveLength(2)
  })

  test('reports an out-of-readable-range anchor without highlighting a fallback line', () => {
    const markup = renderToStaticMarkup(
      <RightPanelSourcePreview
        content={'one\ntwo'}
        filePath="README.md"
        lineSelection={{ start: 8, end: 9 }}
        navigationRevision={8}
      />,
    )

    expect(markup).toContain('无法定位 L8–L9')
    expect(markup).toContain('当前可读内容只有 2 行')
    expect(markup).not.toContain('color-mix(in oklab, var(--lume-accent) 14%, transparent)')
  })
})
