import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeMessageView } from './runtime-message-view'

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
  localFilePreviewUrl: (path: string) => `asset://${path}`,
  openInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  saveFilePathDialog: async () => ({ path: null }),
  saveTextFileDialog: async () => undefined,
  sidecarCall: async () => undefined,
  statFilePaths: async () => ({ files: [] }),
  writeClipboardText: async () => undefined,
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: ({ toolName }: { toolName: string }) => (
    <div data-tool-result-renderer={toolName}>heavy result</div>
  ),
}))

const { RuntimeEventContentBlock } = await import('./RuntimeEventContentBlock')

describe('RuntimeEventContentBlock tool results', () => {
  test('does not mount completed tool result content while the card is collapsed', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-1',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [
        {
          type: 'tool_call',
          id: 'tool:tool-1',
          toolCall: {
            id: 'tool-1',
            toolName: 'Bash',
            input: { command: 'printf "hello"' },
            status: 'completed',
            output: JSON.stringify({ output: 'hello' }),
          },
        },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        threadId="thread-1"
      />,
    )

    expect(markup).toContain('1 个工具调用')
    expect(markup).not.toContain('data-tool-result-renderer="Bash"')
  })

  test('renders completed image tools immediately without a tool card', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-image',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [
        {
          type: 'tool_call',
          id: 'tool:image-1',
          toolCall: {
            id: 'image-1',
            toolName: 'image_gen',
            input: { prompt: 'first' },
            status: 'completed',
            output: JSON.stringify({ images: [{ threadPath: 'first.png' }] }),
          },
        },
        {
          type: 'tool_call',
          id: 'tool:image-2',
          toolCall: {
            id: 'image-2',
            toolName: 'image_gen',
            input: { prompt: 'second' },
            status: 'completed',
            output: JSON.stringify({ images: [{ threadPath: 'second.png' }] }),
          },
        },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock message={message} threadId="thread-images" />,
    )

    expect(markup).toContain('data-image-generation-group="2"')
    expect(markup.match(/data-tool-result-renderer="image_gen"/g)).toHaveLength(2)
    expect(markup).not.toContain('已完成')
  })
})

describe('RuntimeEventContentBlock user attachments', () => {
  test('renders message attachments above text and routes image clicks separately from file cards', () => {
    const message: RuntimeMessageView = {
      id: 'user-1',
      type: 'user',
      text: '请看附件',
      createdAt: '2026-06-01T00:00:00.000Z',
      attachments: [
        {
          id: 'att-image',
          filename: 'screen.png',
          mediaType: 'image/png',
          size: 1024,
          threadPath: 'screen.png',
        },
        {
          id: 'att-file',
          filename: 'brief.md',
          mediaType: 'text/markdown',
          size: 2048,
          threadPath: 'brief.md',
        },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        threadId="thread-1"
        onOpenThreadFile={() => undefined}
        onOpenThreadImage={() => undefined}
      />,
    )

    expect(markup.indexOf('data-agent-attachment-grid="true"')).toBeGreaterThan(-1)
    expect(markup.indexOf('data-agent-attachment-grid="true"')).toBeLessThan(markup.indexOf('请看附件'))
    expect(markup).toContain('data-agent-attachment-kind="image"')
    expect(markup).toContain('data-agent-attachment-kind="file"')
  })
})

describe('RuntimeEventContentBlock user message editing', () => {
  const message: RuntimeMessageView = {
    id: 'user-editable',
    type: 'user',
    text: '需要修改的消息',
    createdAt: '2026-06-01T00:00:00.000Z',
    messageId: 'persisted-user-message',
  }

  test('disables editing for historical user messages', () => {
    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        threadId="thread-1"
        canEditUserMessage={false}
      />,
    )

    expect(markup).toContain('title="仅支持编辑最后一条消息"')
    expect(markup).toContain('disabled=""')
  })
})
