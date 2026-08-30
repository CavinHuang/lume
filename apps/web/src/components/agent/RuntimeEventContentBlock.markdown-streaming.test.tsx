import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { LumeRuntimeEvent } from '@lume/shared'
import type { RuntimeMessageView } from './runtime-message-view'

mock.module('@lume/ui', () => ({
  CodeBlock: ({ children }: { children: React.ReactNode }) => <section data-code-block="true">{children}</section>,
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
  MermaidBlock: ({ code }: { code: string }) => <section data-mermaid-block="true">{code}</section>,
  CODEX_LIGHT_THEME_NAME: 'lume-codex-light',
  CODEX_DARK_THEME_NAME: 'lume-codex-dark',
  CODEX_LIGHT_THEME: { name: 'lume-codex-light', type: 'light', colors: {}, tokenColors: [] },
  CODEX_DARK_THEME: { name: 'lume-codex-dark', type: 'dark', colors: {}, tokenColors: [] },
  useCodeTheme: () => ({ name: 'lume-codex-light', type: 'light' }),
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ children, streaming }: {
    children: React.ReactNode
    streaming?: {
      hasNextChunk?: boolean
      enableAnimation?: boolean
      tail?: boolean
    }
  }) => {
    return (
      <article
        data-x-markdown="true"
        data-has-next-chunk={String(streaming?.hasNextChunk)}
        data-enable-animation={String(streaming?.enableAnimation)}
        data-tail={String(streaming?.tail)}
      >
        {children}
      </article>
    )
  },
}))

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  checkDesktopUpdate: async () => undefined,
  savePathAs: async () => ({ path: null }),
  saveBinaryFileDialog: async () => ({ path: null }),
  downloadDesktopUpdate: async () => undefined,
  getThreadMessageVersions: async () => ({ messages: [] }),
  getThreadMessages: async () => [],
  getThreadRuntimeEvents: async () => [],
  healthcheck: async () => undefined,
  installDesktopUpdateAndRelaunch: async () => undefined,
  localFilePreviewUrl: (path: string) => `asset://${path}`,
  openExternal: async () => undefined,
  openFileDialog: async () => undefined,
  openFileRefInSystem: async () => undefined,
  openGuardedFileRefInSystem: async () => undefined,
  openFolderDialog: async () => undefined,
  openInSystem: async () => undefined,
  revealFileRefInSystem: async () => undefined,
  revealGuardedFileRefInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  createFilePreviewScope: async () => ({ token: 'preview', url: 'lume-file://preview', expiresAt: 0 }),
  createGuardedFilePreviewScope: async () => ({ token: 'guarded-preview', url: 'lume-file://preview', expiresAt: 0 }),
  revokeFilePreviewScope: async () => undefined,
  saveFilePathDialog: async () => undefined,
  saveGuardedFileRefAs: async () => ({ path: null }),
  saveTextFileDialog: async () => undefined,
  sidecarHealthcheck: async () => undefined,
  sidecarCall: async () => undefined,
  undoMemoryMutation: async () => undefined,
  statFilePaths: async () => ({ files: [] }),
  getMcpConfig: async () => ({ mcpServers: {} }),
  getMcpStatus: async () => ({ servers: [] }),
  writeClipboardImage: async () => undefined,
  writeClipboardText: async () => undefined,
  isDesktopRuntime: () => true,
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const { MarkdownPre, RuntimeEventContentBlock } = await import('./RuntimeEventContentBlock')

function renderAssistantText(options: {
  messageStatus: RuntimeMessageView['status']
  streaming?: boolean
  text?: string
}): string {
  const text = options.text ?? 'hello'
  const message: RuntimeMessageView = {
    id: 'assistant-1',
    type: 'assistant',
    text,
    thinking: '',
    status: options.messageStatus,
    toolCalls: [],
    blocks: [
      {
        type: 'text',
        id: 'text-1',
        text,
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
  test('renders Mermaid pre blocks through the shared diagram component', () => {
    const markup = renderToStaticMarkup(
      <MarkdownPre
        domNode={{
          name: 'pre',
          children: [{
            name: 'code',
            attribs: { 'data-lang': 'MerMaid theme=neutral' },
            children: [{ type: 'text', data: 'flowchart LR\n  A --> B\n' }],
          }],
        }}
      >
        ignored parsed child
      </MarkdownPre>,
    )

    expect(markup).toContain('data-mermaid-block="true"')
    expect(markup).toContain('flowchart LR')
  })

  test('keeps Mermaid source visible while its fenced block is streaming', () => {
    const markup = renderToStaticMarkup(
      <MarkdownPre
        domNode={{
          name: 'pre',
          children: [{
            name: 'code',
            attribs: { 'data-lang': 'mermaid', 'data-state': 'loading' },
            children: [{ type: 'text', data: 'flowchart LR\n  A --' }],
          }],
        }}
      >
        <code>flowchart LR{`\n`}  A --</code>
      </MarkdownPre>,
    )

    expect(markup).toContain('<pre>')
    expect(markup).toContain('flowchart LR')
    expect(markup).not.toContain('data-mermaid-block')
  })

  test('renders ordinary pre blocks through the shared code block', () => {
    const markup = renderToStaticMarkup(
      <MarkdownPre
        className="language-typescript"
        domNode={{
          name: 'pre',
          children: [{
            name: 'code',
            attribs: { 'data-lang': 'typescript' },
            children: [{ type: 'text', data: 'const answer = 42\n' }],
          }],
        }}
      >
        <code>const answer = 42</code>
      </MarkdownPre>,
    )

    expect(markup).toContain('data-code-block="true"')
    expect(markup).toContain('const answer = 42')
    expect(markup).not.toContain('data-mermaid-block')
  })

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

  test('shows the streaming tail only on the active text block', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-1',
      type: 'assistant',
      text: 'beforeafter',
      thinking: '',
      status: 'streaming',
      toolCalls: [],
      blocks: [
        { type: 'text', id: 'text-1', text: 'before' },
        {
          type: 'tool_call',
          id: 'tool-1',
          toolCall: {
            id: 'tool-1',
            toolName: 'Read',
            input: {},
            status: 'completed',
          },
        },
        { type: 'text', id: 'text-2', text: 'after' },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        streaming
        threadId="thread-1"
      />,
    )

    expect(markup.match(/data-tail="true"/g)?.length ?? 0).toBe(1)
    expect(markup.match(/data-tail="false"/g)?.length ?? 0).toBe(1)
  })

  test('does not keep a markdown tail on old text while task progress is active', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-1',
      type: 'assistant',
      text: 'before',
      thinking: '',
      status: 'streaming',
      toolCalls: [],
      blocks: [
        { type: 'text', id: 'text-1', text: 'before' },
        {
          type: 'task_progress',
          id: 'task-progress-1',
          event: {
            type: 'task.progress',
            taskRunId: 'task-run-1',
            contractId: 'contract-1',
            currentTaskId: 'task-1',
            status: 'running',
            tasks: [{
              id: 'task-1',
              title: '读取文件',
              status: 'running',
              attemptCount: 1,
            }],
            message: '正在执行：读取文件',
            createdAt: '2026-05-01T00:00:00.000Z',
          } as Extract<LumeRuntimeEvent, { type: 'task.progress' }>,
        },
      ],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock
        message={message}
        streaming
        threadId="thread-1"
      />,
    )

    expect(markup.match(/data-tail="true"/g)?.length ?? 0).toBe(0)
    expect(markup.match(/data-tail="false"/g)?.length ?? 0).toBe(1)
    expect(markup).toContain('data-task-progress="running"')
    expect(markup).toContain('已完成 0/1')
    expect(markup).toContain('读取文件')
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
    expect(markup).toContain('title="上下文占用 0%"')
    expect(markup).toContain('assistant-footer-metric-context')
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
