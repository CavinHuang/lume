import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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

const { PlanPreviewCard } = await import('./RuntimeEventContentBlock')

describe('PlanPreviewCard', () => {
  test('renders collapsed plan metadata without mounting the Markdown body', () => {
    const markup = renderToStaticMarkup(
      <PlanPreviewCard
        preview={{
          contractId: 'plan-1',
          title: 'Ship runtime',
          summary: 'Review before executing',
          markdown: '# Ship runtime\n\n## Steps\n1. Inspect\n\nHidden expensive body',
          planFilePath: 'plans/plan-1.md',
          planVerified: true,
          stepCount: 1,
        }}
        onOpenThreadFile={() => undefined}
      />,
    )

    expect(markup).toContain('data-plan-preview-card="true"')
    expect(markup).toContain('data-state="collapsed"')
    expect(markup).toContain('Ship runtime')
    expect(markup).toContain('Review before executing')
    expect(markup).toContain('plans/plan-1.md')
    expect(markup).not.toContain('data-x-markdown="true"')
    expect(markup).not.toContain('Hidden expensive body')
    expect(markup).toContain('展开计划')
    expect(markup).toContain('复制计划')
    expect(markup).toContain('打开计划文件')
  })
})
