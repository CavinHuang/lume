import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiffAwareMarkdownPre } from './DiffAwareMarkdownPre'

describe('DiffAwareMarkdownPre', () => {
  test('renders complete diff fences with Pierre', () => {
    const markup = renderToStaticMarkup(
      <DiffAwareMarkdownPre>
        <code className="language-diff">{'--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n'}</code>
      </DiffAwareMarkdownPre>,
    )
    expect(markup).toContain('<diffs-container')
  })

  test('shows loading for an incomplete streaming fence', () => {
    const markup = renderToStaticMarkup(
      <DiffAwareMarkdownPre streamStatus="loading">
        <code className="language-patch">not a patch yet</code>
      </DiffAwareMarkdownPre>,
    )
    expect(markup).toContain('正在接收 Diff')
  })

  test('shows a copyable parse error after streaming completes', () => {
    const markup = renderToStaticMarkup(
      <DiffAwareMarkdownPre>
        <code className="language-udiff">not a patch</code>
      </DiffAwareMarkdownPre>,
    )
    expect(markup).toContain('unified diff')
    expect(markup).toContain('复制原文')
  })
})
