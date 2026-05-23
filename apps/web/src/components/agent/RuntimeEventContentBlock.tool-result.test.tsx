import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeMessageView } from './runtime-message-view'

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
  ToolResultRenderer: () => <div data-tool-result-renderer="true">heavy result</div>,
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

    expect(markup).toContain('Bash')
    expect(markup).toContain('已完成')
    expect(markup).not.toContain('data-tool-result-renderer="true"')
  })
})
