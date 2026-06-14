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
  openInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  saveTextFileDialog: async () => undefined,
  saveFilePathDialog: async () => undefined,
  copyFile: async () => undefined,
  sidecarCall: async () => undefined,
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const contentBlockModule = await import('./RuntimeEventContentBlock')
const { MarkdownCode } = contentBlockModule
const normalizeMarkdownCodeProps = (contentBlockModule as typeof contentBlockModule & {
  normalizeMarkdownCodeProps?: (props: Record<string, unknown>) => Record<string, unknown>
}).normalizeMarkdownCodeProps

function renderFileLink(path: string): string {
  return renderToStaticMarkup(
    <MarkdownCode
      onOpenThreadFile={() => undefined}
    >
      {path}
    </MarkdownCode>,
  )
}

describe('RuntimeEventContentBlock markdown file links', () => {
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

  test('normalizes markdown code class attributes without React DOM warnings', () => {
    const consoleErrors: string[] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '))
    }

    try {
      const markup = renderToStaticMarkup(
        <MarkdownCode {...({ class: 'language-ts' } as Record<string, unknown>)}>
          {'const answer = 42'}
        </MarkdownCode>,
      )

      expect(markup).toContain('class="language-ts"')
      expect(consoleErrors.join('\n')).not.toContain('Invalid DOM property `class`')
    } finally {
      console.error = originalConsoleError
    }
  })

  test('strips raw class props before spreading code attributes', () => {
    expect(typeof normalizeMarkdownCodeProps).toBe('function')

    const codeProps = normalizeMarkdownCodeProps?.({
      class: 'language-ts',
      className: 'existing-code-class',
      title: 'code title',
    })

    expect(codeProps).toEqual({
      className: 'language-ts existing-code-class',
      title: 'code title',
    })
    expect(codeProps).not.toHaveProperty('class')
  })
})
