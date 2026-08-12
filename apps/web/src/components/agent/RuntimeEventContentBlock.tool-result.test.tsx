import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
  XMarkdown: ({ children }: { children: React.ReactNode }) => (
    <article data-x-markdown="true">{children}</article>
  ),
}))

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  getThreadMessageVersions: async () => ({ messages: [] }),
  createFilePreviewScope: async () => ({ token: 'preview', url: 'lume-file://preview', expiresAt: 0 }),
  createGuardedFilePreviewScope: async () => ({ token: 'guarded-preview', url: 'lume-file://preview', expiresAt: 0 }),
  localFilePreviewUrl: (path: string) => `asset://${path}`,
  openFileRefInSystem: async () => undefined,
  openGuardedFileRefInSystem: async () => undefined,
  openInSystem: async () => undefined,
  openExternal: async () => undefined,
  openFileDialog: async () => undefined,
  openFolderDialog: async () => undefined,
  revealGuardedFileRefInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  revealFileRefInSystem: async () => undefined,
  readTextFile: async () => '',
  saveGuardedFileRefAs: async () => ({ path: null }),
  saveFilePathDialog: async () => ({ path: null }),
  saveTextFileDialog: async () => undefined,
  sidecarCall: async () => undefined,
  undoMemoryMutation: async () => undefined,
  sidecarHealthcheck: async () => undefined,
  statFilePaths: async () => ({ files: [] }),
  revokeFilePreviewScope: async () => undefined,
  writeClipboardImage: async () => undefined,
  writeClipboardText: async () => undefined,
  writeBinaryFile: async () => undefined,
  copyFile: async () => undefined,
  healthcheck: async () => undefined,
  checkDesktopUpdate: async () => undefined,
  downloadDesktopUpdate: async () => undefined,
  installDesktopUpdateAndRelaunch: async () => undefined,
  getMcpConfig: async () => ({ mcpServers: {} }),
  getMcpStatus: async () => ({ servers: [] }),
  submitTaskApproval: async () => undefined,
  getThreadMessages: async () => [],
  getThreadRuntimeEvents: async () => [],
  isDesktopRuntime: () => true,
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

  test('renders a completed Wiki proposal immediately outside collapsed tool output', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-wiki',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [{
        type: 'tool_call',
        id: 'tool:wiki-1',
        toolCall: {
          id: 'wiki-1',
          toolName: 'wiki.propose_changes',
          input: { action: 'create' },
          status: 'completed',
          output: JSON.stringify({ data: { id: 'draft-1' } }),
        },
      }],
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock message={message} threadId="thread-wiki" />,
    )

    expect(markup).toContain('data-wiki-proposal-result="true"')
    expect(markup).toContain('data-tool-result-renderer="wiki.propose_changes"')
    expect(markup).not.toContain('1 个工具调用')
  })

  test('renders a compact diff summary card only after a coding turn ends', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-coding',
      type: 'assistant',
      text: '修改完成',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [],
      codingReport: {
        runId: 'run-coding',
        status: 'verified',
        workspaceChanged: true,
        changedFiles: ['src/alpha.ts', 'src/nested/beta.tsx'],
        fileChanges: [
          { path: 'src/alpha.ts', addedLines: 5, removedLines: 1 },
          { path: 'src/nested/beta.tsx', addedLines: 3, removedLines: 2 },
        ],
        externalChangedFiles: [],
        pendingBackground: false,
      },
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock message={message} threadId="thread-coding" />,
    )

    expect(markup).toContain('data-coding-file-changes-summary="true"')
    expect(markup).toContain('2 个文件已修改')
    expect(markup).toContain('src/alpha.ts')
    expect(markup).toContain('src/nested/beta.tsx')
    expect(markup).toContain('+8')
    expect(markup).toContain('-3')
    expect(markup).toContain('+5')
    expect(markup).toContain('-1')
    expect(markup).not.toContain('编码任务执行完成')
  })

  test('does not render the diff summary card for a streaming message', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-coding-streaming',
      type: 'assistant',
      text: '正在修改',
      thinking: '',
      status: 'streaming',
      toolCalls: [],
      blocks: [],
      codingReport: {
        runId: 'run-coding',
        status: 'unverified',
        workspaceChanged: true,
        changedFiles: ['src/alpha.ts'],
        externalChangedFiles: [],
        pendingBackground: false,
      },
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock message={message} threadId="thread-coding" />,
    )

    expect(markup).not.toContain('data-coding-file-changes-summary="true"')
  })

  test('renders terminal coding warnings even when no files changed', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-coding-warning',
      type: 'assistant',
      text: '后台继续验证',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [],
      codingReport: {
        status: 'unverified',
        workspaceChanged: false,
        changedFiles: [],
        externalChangedFiles: [],
        pendingBackground: true,
      },
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock message={message} threadId="thread-coding" />,
    )

    expect(markup).toContain('data-coding-file-changes-summary="true"')
    expect(markup).toContain('后台验证仍在运行')
    expect(markup).not.toContain('个文件已修改')
  })

  test('limits the initial coding file rows', () => {
    const fileChanges = Array.from({ length: 7 }, (_, index) => ({
      path: `src/file-${index + 1}.ts`,
      addedLines: index + 1,
      removedLines: 0,
    }))
    const message: RuntimeMessageView = {
      id: 'assistant-coding-many-files',
      type: 'assistant',
      text: '批量修改完成',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [],
      codingReport: {
        runId: 'run-many-files',
        status: 'verified',
        workspaceChanged: true,
        changedFiles: fileChanges.map((change) => change.path),
        fileChanges,
        externalChangedFiles: [],
        pendingBackground: false,
      },
    }

    const markup = renderToStaticMarkup(
      <RuntimeEventContentBlock message={message} threadId="thread-coding" />,
    )

    expect(markup).toContain('src/file-5.ts')
    expect(markup).not.toContain('src/file-6.ts')
    expect(markup).toContain('再显示 2 个文件')
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
