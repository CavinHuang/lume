import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentUserMessagePart } from '@lume/shared'

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
  browserRuntime: async () => [],
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
  savePathAs: async () => ({ path: null }),
  saveBinaryFileDialog: async () => ({ path: null }),
  healthcheck: async () => undefined,
  checkDesktopUpdate: async () => undefined,
  downloadDesktopUpdate: async () => undefined,
  installDesktopUpdateAndRelaunch: async () => undefined,
  getMcpConfig: async () => ({ mcpServers: {} }),
  getMcpStatus: async () => ({ servers: [] }),
  getThreadMessages: async () => [],
  getThreadRuntimeEvents: async () => [],
  isDesktopRuntime: () => true,
}))

mock.module('./tool-result-renderers', () => ({
  ToolResultRenderer: () => null,
}))

const {
  UserAgentRoleInvocationContent,
  parseAgentRoleInstructionMessage,
} = await import('./RuntimeEventContentBlock') as typeof import('./RuntimeEventContentBlock') & {
  UserAgentRoleInvocationContent: React.ComponentType<{ text: string; messageParts?: AgentUserMessagePart[] }>
}

describe('user agent role invocation messages', () => {
  test('parses the internal agent invocation instruction into display data', () => {
    const parsed = parseAgentRoleInstructionMessage(
      '请调用 Agent 工具，并将 subagent_type 设置为 "writer" 来处理这个任务：\n让它写',
    )

    expect(parsed?.role.id).toBe('writer')
    expect(parsed?.role.displayName).toBe('江岚')
    expect(parsed?.role.title).toBe('作家')
    expect(parsed?.task).toBe('让它写')
  })

  test('renders the agent avatar and name instead of leaking the internal instruction', () => {
    const markup = renderToStaticMarkup(
      <UserAgentRoleInvocationContent text={'请调用 Agent 工具，并将 subagent_type 设置为 "writer" 来处理这个任务：\n让它写'} />,
    )

    expect(markup).toContain('data-agent-role-message="writer"')
    expect(markup).toContain('writer')
    expect(markup).toContain('江岚')
    expect(markup).toContain('作家')
    expect(markup).toContain('让它写')
    expect(markup).not.toContain('请调用 Agent 工具')
    expect(markup).not.toContain('subagent_type')
  })

  test('renders quoted context without exposing the quoted XML twice', () => {
    const quotedBlock = '<quoted_context source="agent-history" label="历史消息" message_id="m1" role="assistant">\n引用内容\n</quoted_context>\n\n'
    const markup = renderToStaticMarkup(
      <UserAgentRoleInvocationContent
        text={`${quotedBlock}请检查 @Gmail · work`}
        messageParts={[
          { type: 'text', text: quotedBlock },
          { type: 'text', text: '请检查 @Gmail · work' },
        ]}
      />,
    )

    expect(markup).toContain('历史消息')
    expect(markup).toContain('@Gmail · work')
    expect(markup).not.toContain('quoted_context')
  })
})
