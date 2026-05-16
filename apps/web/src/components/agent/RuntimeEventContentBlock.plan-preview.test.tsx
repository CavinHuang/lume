import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

mock.module('@lume/ui', () => ({
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children }: { children: React.ReactNode }) => (
    <article data-x-markdown="true">{children}</article>
  ),
}))

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  getThreadMessageVersions: async () => ({ messages: [] }),
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const { PlanPreviewCard } = await import('./RuntimeEventContentBlock')

describe('PlanPreviewCard', () => {
  test('renders a collapsed Markdown plan preview with file and expand controls', () => {
    const markup = renderToStaticMarkup(
      <PlanPreviewCard
        preview={{
          contractId: 'plan-1',
          title: 'Ship runtime',
          summary: 'Review before executing',
          markdown: '# Ship runtime\n\n## Steps\n1. Inspect',
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
    expect(markup).toContain('# Ship runtime')
    expect(markup).toContain('展开计划')
    expect(markup).toContain('复制计划')
    expect(markup).toContain('打开计划文件')
  })
})
