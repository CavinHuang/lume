import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'
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
  revealPathInSystem: async () => undefined,
  revealFileRefInSystem: async () => undefined,
  revealGuardedFileRefInSystem: async () => undefined,
  readTextFile: async () => '',
  saveFilePathDialog: async () => undefined,
  saveTextFileDialog: async () => undefined,
  saveGuardedFileRefAs: async () => ({ path: null }),
  sidecarCall: async () => undefined,
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
const { generalSettingsAtom } = await import('@/atoms')

function renderMessage(el: React.ReactElement) {
  const store = createStore()
  store.set(generalSettingsAtom, {
    ...GENERAL_SETTINGS_DEFAULTS,
    agentMessageDisplayMode: 'minimal',
  })
  return renderToStaticMarkup(<Provider store={store}>{el}</Provider>)
}

describe('MinimalAssistantContent', () => {
  test('renders text inline and collapses consecutive tool calls behind a process line', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-1',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [
        { type: 'text', id: 'text-1', text: '前面的话' },
        {
          type: 'tool_call',
          id: 'tool:bash-1',
          toolCall: {
            id: 'bash-1',
            toolName: 'Bash',
            input: { command: 'echo hi' },
            status: 'completed',
            output: JSON.stringify({ output: 'hi' }),
          },
        },
        {
          type: 'tool_call',
          id: 'tool:read-1',
          toolCall: {
            id: 'read-1',
            toolName: 'Read',
            input: { file_path: '/a/b.md' },
            status: 'completed',
            output: JSON.stringify({ content: 'b' }),
          },
        },
        { type: 'text', id: 'text-2', text: '后面的话' },
      ],
    }

    const markup = renderMessage(
      <RuntimeEventContentBlock message={message} threadId="thread-1" />,
    )

    // Inline text blocks are rendered.
    expect(markup).toContain('前面的话')
    expect(markup).toContain('后面的话')

    // Process line summary present, collapsed (no tool result markers rendered).
    expect(markup).toContain('2 个工具调用')
    expect(markup).not.toContain('data-tool-result-renderer="Bash"')
    expect(markup).not.toContain('data-tool-result-renderer="Read"')
  })

  test('shows a running-tool process line while streaming', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-2',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'streaming',
      toolCalls: [],
      blocks: [
        {
          type: 'tool_call',
          id: 'tool:bash-run',
          toolCall: {
            id: 'bash-run',
            toolName: 'Bash',
            input: { command: 'sleep 1' },
            status: 'running',
          },
        },
      ],
    }

    const markup = renderMessage(
      <RuntimeEventContentBlock message={message} streaming={true} threadId="thread-2" />,
    )

    expect(markup).toContain('正在执行')
    // No total-style X/Y step counter rendered.
    expect(markup).not.toMatch(/步 \/ 总/)
  })

  test('shows image generation as persistent media instead of a collapsed tool row', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-images',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'streaming',
      toolCalls: [],
      blocks: [
        {
          type: 'tool_call',
          id: 'tool:image-running',
          toolCall: {
            id: 'image-running',
            toolName: 'image_gen',
            input: { prompt: 'loading' },
            status: 'running',
          },
        },
        {
          type: 'tool_call',
          id: 'tool:image-completed',
          toolCall: {
            id: 'image-completed',
            toolName: 'image_gen',
            input: { prompt: 'done' },
            status: 'completed',
            output: JSON.stringify({ images: [{ threadPath: 'done.png' }] }),
          },
        },
      ],
    }

    const markup = renderMessage(
      <RuntimeEventContentBlock message={message} streaming={true} threadId="thread-images" />,
    )

    expect(markup).toContain('data-image-generation-group="2"')
    expect(markup).toContain('data-image-generation-loading="true"')
    expect(markup).toContain('data-tool-result-renderer="image_gen"')
    expect(markup).not.toContain('2 个工具调用')
  })

  test('shows a completed Wiki proposal without expanding the process line', () => {
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

    const markup = renderMessage(
      <RuntimeEventContentBlock message={message} threadId="thread-wiki" />,
    )

    expect(markup).toContain('data-wiki-proposal-result="true"')
    expect(markup).toContain('data-tool-result-renderer="wiki.propose_changes"')
    expect(markup).not.toContain('1 个工具调用')
  })

  test('completed group shows frozen duration and no running clock', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-done',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [
        {
          type: 'tool_call',
          id: 'tool:bash-done',
          toolCall: {
            id: 'bash-done',
            toolName: 'Bash',
            input: { command: 'echo hi' },
            status: 'completed',
            durationMs: 1500,
            output: JSON.stringify({ output: 'hi' }),
          },
        },
      ],
    }

    const markup = renderMessage(
      <RuntimeEventContentBlock message={message} threadId="thread-done" />,
    )

    // 完成态时长定格，1 位小数
    expect(markup).toContain('1 个工具调用 1.5s')
    // 完成态不挂运行态时钟
    expect(markup).not.toContain('data-running-clock')
  })

  test('streaming group mounts RunningDurationClock and shows running action', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-run',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'streaming',
      toolCalls: [],
      blocks: [
        {
          type: 'tool_call',
          id: 'tool:bash-run-clock',
          toolCall: {
            id: 'bash-run-clock',
            toolName: 'Bash',
            input: { command: 'sleep 2' },
            status: 'running',
            // 很久以前 → SSR 下 elapsed 巨大 → text 非空 → 时钟渲染
            startedAt: '2020-01-01T00:00:00.000Z',
          },
        },
      ],
    }

    const markup = renderMessage(
      <RuntimeEventContentBlock message={message} streaming={true} threadId="thread-run" />,
    )

    // 运行态挂载时钟组件（跳动行为靠手动验证，SSR 只断言组件存在）
    expect(markup).toContain('data-running-clock')
    expect(markup).toContain('正在执行')
  })

  test('completed group splits duration by tool category', () => {
    const message: RuntimeMessageView = {
      id: 'assistant-multi',
      type: 'assistant',
      text: '',
      thinking: '',
      status: 'completed',
      toolCalls: [],
      blocks: [
        { type: 'thinking', id: 'think-1', text: '想一想' },
        {
          type: 'tool_call',
          id: 'tool:read-multi',
          toolCall: {
            id: 'read-multi',
            toolName: 'Read',
            input: { file_path: '/a/b.md' },
            status: 'completed',
            durationMs: 2300,
          },
        },
        {
          type: 'tool_call',
          id: 'tool:agent-multi',
          toolCall: {
            id: 'agent-multi',
            toolName: 'Agent',
            input: { description: '探索' },
            status: 'completed',
            durationMs: 4200,
          },
        },
      ],
    }

    const markup = renderMessage(
      <RuntimeEventContentBlock message={message} threadId="thread-multi" />,
    )

    // 完成态分类时长：非 Agent 工具 / Agent 子代理各自求和（守护项 C 变量替换）
    expect(markup).toContain('思考 1 次')
    expect(markup).toContain('1 个工具调用 2.3s')
    expect(markup).toContain('1 子代理 4.2s')
    expect(markup).not.toContain('data-running-clock')
  })
})
