import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RuntimeMessageView } from './runtime-message-view'

mock.module('@lume/ui', () => ({
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({
    children,
    streaming,
  }: {
    children: React.ReactNode
    streaming?: {
      hasNextChunk?: boolean
      enableAnimation?: boolean
      tail?: boolean
    }
  }) => (
    <article
      data-x-markdown="true"
      data-has-next-chunk={String(streaming?.hasNextChunk)}
      data-enable-animation={String(streaming?.enableAnimation)}
      data-tail={String(streaming?.tail)}
    >
      {children}
    </article>
  ),
}))

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  getThreadMessageVersions: async () => ({ messages: [] }),
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const { RuntimeEventContentBlock } = await import('./RuntimeEventContentBlock')

function renderAssistantText(options: {
  messageStatus: RuntimeMessageView['status']
  streaming?: boolean
}): string {
  const message: RuntimeMessageView = {
    id: 'assistant-1',
    type: 'assistant',
    text: 'hello',
    thinking: '',
    status: options.messageStatus,
    toolCalls: [],
    blocks: [
      {
        type: 'text',
        id: 'text-1',
        text: 'hello',
      },
    ],
  }

  return renderToStaticMarkup(
    <RuntimeEventContentBlock
      message={message}
      streaming={options.streaming}
      threadId="thread-1"
    />,
  )
}

describe('RuntimeEventContentBlock markdown streaming config', () => {
  test('does not enable streaming animation for completed history messages', () => {
    const markup = renderAssistantText({ messageStatus: 'completed' })

    expect(markup).toContain('data-has-next-chunk="false"')
    expect(markup).toContain('data-enable-animation="false"')
    expect(markup).toContain('data-tail="false"')
  })

  test('enables XMarkdown streaming only for active streaming messages', () => {
    const markup = renderAssistantText({ messageStatus: 'streaming', streaming: true })

    expect(markup).toContain('data-has-next-chunk="true"')
    expect(markup).toContain('data-enable-animation="true"')
    expect(markup).toContain('data-tail="true"')
  })
})
