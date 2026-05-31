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
  openInSystem: async () => undefined,
  saveTextFileDialog: async () => undefined,
  sidecarCall: async () => undefined,
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

  test('renders assistant token usage as a hover-only footer', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-1',
      type: 'assistant',
      text: 'hello',
      thinking: '',
      status: 'completed',
      tokenCount: 42,
      toolCalls: [],
      blocks: [
        {
          type: 'text',
          id: 'text-1',
          text: 'hello',
        },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        threadId="thread-1"
      />,
    )

    expect(markup).toContain('估算输出 42 tokens')
    expect(markup).toContain('↓')
    expect(markup).toContain('group-hover/agent-message:opacity-100')
  })

  test('renders provider token usage with input output and context percent metrics', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-1',
      type: 'assistant',
      text: 'hello',
      thinking: '',
      status: 'completed',
      tokenCount: 42,
      tokenCountSource: 'provider',
      tokenUsage: {
        inputTokens: 37680,
        outputTokens: 233,
        cacheReadInputTokens: 1200,
        cacheCreationInputTokens: 300,
        cachedTokens: 1500,
        contextPercent: 0,
      },
      toolCalls: [],
      blocks: [
        {
          type: 'text',
          id: 'text-1',
          text: 'hello',
        },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        threadId="thread-1"
      />,
    )

    expect(markup).toContain('输入 37,680 tokens')
    expect(markup).toContain('输出 233 tokens')
    expect(markup).toContain('缓存 1,500 tokens')
    expect(markup).toContain('上下文 0%')
    expect(markup).toContain('↑')
    expect(markup).toContain('↓')
    expect(markup).toContain('↺')
    expect(markup).not.toContain('本轮输出')
    expect(markup).not.toContain('本条约 42 tokens')
  })

  test('renders assistant fork action, download formats, and completion time in the footer', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-1',
      type: 'assistant',
      text: 'hello',
      thinking: '',
      status: 'completed',
      messageId: 'assistant-message-1',
      completedAt: '2026-05-11T07:23:00',
      toolCalls: [],
      blocks: [
        {
          type: 'text',
          id: 'text-1',
          text: 'hello',
        },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        threadId="thread-1"
      />,
    )

    expect(markup).toContain('创建分支')
    expect(markup).toContain('下载')
    expect(markup).toContain('下载 HTML')
    expect(markup).toContain('下载 TXT')
    expect(markup).not.toContain('下载 PDF')
    expect(markup).toContain('7:23')
  })

  test('renders weak IM delivery status for assistant messages', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-1',
      type: 'assistant',
      text: 'hello',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      imDelivery: {
        status: 'sent',
        provider: 'weixin',
        peerKind: 'dm',
        peerId: 'user-1',
      },
      blocks: [
        {
          type: 'text',
          id: 'text-1',
          text: 'hello',
        },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        threadId="thread-1"
      />,
    )

    expect(markup).toContain('已发送到微信')
  })
})
