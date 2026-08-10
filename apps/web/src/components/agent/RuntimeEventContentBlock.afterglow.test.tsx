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
  XMarkdown: ({ children }: { children: React.ReactNode }) => <div data-markdown="true">{children}</div>,
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
