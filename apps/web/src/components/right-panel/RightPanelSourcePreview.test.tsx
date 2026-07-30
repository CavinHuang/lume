import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

const { RightPanelSourcePreview } = await import('./RightPanelSourcePreview')

describe('RightPanelSourcePreview line navigation', () => {
  test('delegates source rendering and selection to the Pierre container', () => {
    const markup = renderToStaticMarkup(
      <RightPanelSourcePreview
        content={'one\ntwo\nthree'}
        filePath="src/app.ts"
        lineSelection={{ start: 2, end: 3 }}
        navigationRevision={7}
      />,
    )

    expect(markup).toContain('<diffs-container')
    expect(markup).not.toContain('data-line-number=')
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
    expect(markup).toContain('<diffs-container')
  })

  test('parses .diff and .patch source files with Pierre FileDiff', () => {
    const markup = renderToStaticMarkup(
      <RightPanelSourcePreview
        content={'--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n'}
        filePath="changes.patch"
      />,
    )

    expect(markup).toContain('<diffs-container')
    expect(markup).toContain('max-h-[70vh]')
  })
})
