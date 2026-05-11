import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@lume/ui', () => ({
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ components }: { components: { code: React.ComponentType<{ children: React.ReactNode }> } }) => {
    const Code = components.code
    return <Code>plans/deepseek-open-source-research.md</Code>
  },
}))

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  getThreadMessageVersions: async () => ({ messages: [] }),
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const { MarkdownCode } = await import('./RunEventContentBlock')

function renderFileLink(path: string): string {
  return renderToStaticMarkup(
    <MarkdownCode
      onOpenThreadFile={() => undefined}
    >
      {path}
    </MarkdownCode>,
  )
}

describe('RunEventContentBlock markdown file links', () => {
  test('renders thread file paths with an icon and highlighted link treatment', () => {
    const markup = renderFileLink('plans/deepseek-open-source-research.md')

    expect(markup).toContain('data-thread-file-link="true"')
    expect(markup).toContain('data-file-link-icon="true"')
    expect(markup).toContain('data-file-link-highlight="true"')
    expect(markup).toContain('aria-label="在右侧预览文件 plans/deepseek-open-source-research.md"')
  })

  test('uses the icon that matches the file extension', () => {
    expect(renderFileLink('plans/research.md')).toContain('lucide-file-text')
    expect(renderFileLink('src/App.tsx')).toContain('lucide-file-code')
    expect(renderFileLink('data/config.json')).toContain('lucide-file-braces')
    expect(renderFileLink('images/diagram.png')).toContain('lucide-file-image')
  })
})
