import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeMessageView } from './runtime-message-view'

mock.module('@lume/ui', () => ({
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
  MermaidBlock: ({ code }: { code: string }) => <section data-mermaid-block="true">{code}</section>,
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children }: { children: React.ReactNode }) => <div data-markdown="true">{children}</div>,
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

const { RuntimeEventContentBlock } = await import('./RuntimeEventContentBlock')

function renderAssistantText(text: string): string {
  const message: RuntimeMessageView = {
    id: 'assistant-1',
    type: 'assistant',
    text,
    thinking: '',
    blocks: [{ type: 'text', id: 'text-1', text }],
    status: 'completed',
    toolCalls: [],
  }

  return renderToStaticMarkup(
    <RuntimeEventContentBlock
      message={message}
      threadId="thread-1"
    />,
  )
}

describe('RuntimeEventContentBlock afterglow', () => {
  test('renders afterglow as a separate non-copy text layer', () => {
    const markup = renderAssistantText('正文\n\n⟡ 这个风险先别忽略\n\n结尾')

    expect(markup).toContain('data-afterglow="true"')
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('data-afterglow-text="⟡ 这个风险先别忽略"')
    expect(markup).toContain('正文')
    expect(markup).toContain('结尾')
  })

  test('keeps markers inside fenced code as markdown', () => {
    const markup = renderAssistantText('```md\n⟡ keep this code\n```')

    expect(markup).not.toContain('data-afterglow="true"')
    expect(markup).toContain('⟡ keep this code')
  })
})
