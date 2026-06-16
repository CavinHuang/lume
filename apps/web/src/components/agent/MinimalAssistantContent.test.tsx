import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { createStore, Provider } from 'jotai'
import { renderToStaticMarkup } from 'react-dom/server'
import { GENERAL_SETTINGS_DEFAULTS } from '@lume/shared'
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
  localFilePreviewUrl: (path: string) => `asset://${path}`,
  openInSystem: async () => undefined,
  openExternal: async () => undefined,
  openFileDialog: async () => undefined,
  openFolderDialog: async () => undefined,
  revealPathInSystem: async () => undefined,
  readTextFile: async () => '',
  saveFilePathDialog: async () => undefined,
  saveTextFileDialog: async () => undefined,
  sidecarCall: async () => undefined,
  sidecarHealthcheck: async () => undefined,
  statFilePaths: async () => ({ files: [] }),
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
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => <div data-tool-result-renderer="true">heavy result</div>,
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
    expect(markup).toContain('🔧 2 操作')
    expect(markup).not.toContain('data-tool-result-renderer="true"')
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
})
