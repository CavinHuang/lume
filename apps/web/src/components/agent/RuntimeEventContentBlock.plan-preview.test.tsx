import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@lume/ui', () => ({
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
  MermaidBlock: ({ code }: { code: string }) => <section data-mermaid-block="true">{code}</section>,
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children }: { children: React.ReactNode }) => (
    <article data-x-markdown="true">{children}</article>
  ),
}))

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  copyFile: async () => undefined,
  getThreadMessageVersions: async () => ({ messages: [] }),
  openInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  saveFilePathDialog: async () => undefined,
  saveTextFileDialog: async () => undefined,
  sidecarCall: async () => undefined,
  writeClipboardText: async () => undefined,
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const { PlanPreviewCard } = await import('./RuntimeEventContentBlock')

describe('PlanPreviewCard', () => {
  test('renders collapsed plan metadata without mounting the Markdown body', () => {
    const markup = renderToStaticMarkup(
      <PlanPreviewCard
        preview={{
          contractId: 'plan-1',
          title: 'Ship runtime',
          summary: 'Review before executing',
          markdown: '# Ship runtime\n\n## Steps\n1. Inspect\n\nHidden expensive body',
          planFilePath: 'plans/plan-1.md',
          planVerified: true,
          stepCount: 1,
        }}
        onOpenThreadFile={() => undefined}
      />,
    )

    expect(markup).toContain('data-plan-preview-card="true"')
    expect(markup).toContain('data-state="collapsed"')
    expect(markup).toContain('Ship runtime')
    expect(markup).toContain('Review before executing')
    expect(markup).toContain('plans/plan-1.md')
    expect(markup).not.toContain('data-x-markdown="true"')
    expect(markup).not.toContain('Hidden expensive body')
    expect(markup).toContain('展开计划')
    expect(markup).toContain('复制计划')
    expect(markup).toContain('打开计划文件')
  })
})
