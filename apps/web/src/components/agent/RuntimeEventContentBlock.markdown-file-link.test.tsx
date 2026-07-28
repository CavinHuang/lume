import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageFileReferenceBindingProvider, ThreadFileEnvProvider } from './thread-file-env'

mock.module('@lume/ui', () => ({
  useSmoothStream: ({ content }: { content: string }) => ({ displayedContent: content }),
  MermaidBlock: ({ code }: { code: string }) => <section data-mermaid-block="true">{code}</section>,
  highlightCode: async () => undefined,
  highlightToTokens: () => null,
}))

mock.module('@ant-design/x-markdown', () => ({
  XMarkdown: ({ components }: { components: { code: React.ComponentType<{ children: React.ReactNode }> } }) => {
    const Code = components.code
    return <Code>plans/deepseek-open-source-research.md</Code>
  },
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
  saveTextFileDialog: async () => undefined,
  saveFilePathDialog: async () => undefined,
  saveGuardedFileRefAs: async () => undefined,
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
  ToolResultRenderer: () => null,
}))

const contentBlockModule = await import('./RuntimeEventContentBlock')
const { MarkdownAnchor, MarkdownCode } = contentBlockModule
const normalizeMarkdownCodeProps = (contentBlockModule as typeof contentBlockModule & {
  normalizeMarkdownCodeProps?: (props: Record<string, unknown>) => Record<string, unknown>
}).normalizeMarkdownCodeProps

function renderFileLink(path: string): string {
  return renderToStaticMarkup(
    <MarkdownCode
      onOpenThreadFile={() => undefined}
    >
      {path}
    </MarkdownCode>,
  )
}

describe('RuntimeEventContentBlock markdown file links', () => {
  test('renders thread file paths with an icon and highlighted link treatment', () => {
    const markup = renderFileLink('plans/deepseek-open-source-research.md')

    expect(markup).toContain('data-thread-file-link="true"')
    expect(markup).toContain('data-file-link-icon="true"')
    expect(markup).toContain('data-file-link-highlight="true"')
    expect(markup).toContain('aria-label="旧版会话：plans/deepseek-open-source-research.md"')
  })

  test('uses the icon that matches the file extension', () => {
    expect(renderFileLink('plans/research.md')).toContain('lucide-file-text')
    expect(renderFileLink('src/App.tsx')).toContain('lucide-file-code')
    expect(renderFileLink('data/config.json')).toContain('lucide-file-braces')
    expect(renderFileLink('images/diagram.png')).toContain('lucide-file-image')
  })

  test('renders strict project references with compact paths and separate line labels', () => {
    const markup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: 'thread-1', workspaceSlug: 'demo', fileContextId: 'context-1' }}>
        <MessageFileReferenceBindingProvider value={{ workspaceSlug: 'demo', projectRootFingerprint: 'a'.repeat(64), fileContextId: 'context-1' }} protocolVersion={1}>
          <MarkdownCode onOpenThreadFile={() => 'opened'}>
            @project/very/long/nested/component/folder/Component.tsx#L42-L48
          </MarkdownCode>
        </MessageFileReferenceBindingProvider>
      </ThreadFileEnvProvider>,
    )

    expect(markup).toContain('data-agent-file-reference="true"')
    expect(markup).toContain('data-file-reference-copy-text="项目/very/long/nested/component/folder/Component.tsx#L42-L48"')
    expect(markup).toContain('…/folder/Component.tsx')
    expect(markup).toContain('L42–48')
    expect(markup).not.toContain('&gt;@project/')
  })

  test('supports encoded explicit markdown targets and directory icons', () => {
    const linkMarkup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: 'thread-1', fileContextId: 'context-1' }}>
        <MessageFileReferenceBindingProvider value={{ fileContextId: 'context-1' }} protocolVersion={1}>
          <MarkdownAnchor href="@session/output/config%20file.json" onOpenThreadFile={() => 'opened'}>config</MarkdownAnchor>
        </MessageFileReferenceBindingProvider>
      </ThreadFileEnvProvider>,
    )
    expect(linkMarkup).toContain('data-file-reference-copy-text="会话/output/config file.json"')
    expect(linkMarkup).toContain('config file.json')

    const directoryMarkup = renderToStaticMarkup(
      <MessageFileReferenceBindingProvider value={{ fileContextId: 'context-1' }} protocolVersion={1}>
        <MarkdownCode onOpenThreadFile={() => 'opened'}>@project/src/components/</MarkdownCode>
      </MessageFileReferenceBindingProvider>,
    )
    expect(directoryMarkup).toContain('lucide-folder')
    expect(directoryMarkup).toContain('data-invalid="true"')
  })

  test('fails closed for unsupported future protocol versions', () => {
    const markup = renderToStaticMarkup(
      <MessageFileReferenceBindingProvider
        value={{ workspaceSlug: 'demo', projectRootFingerprint: 'a'.repeat(64), fileContextId: 'context-1' }}
        protocolVersion={2}
      >
        <MarkdownCode onOpenThreadFile={() => 'opened'}>@project/src/app.ts</MarkdownCode>
      </MessageFileReferenceBindingProvider>,
    )
    expect(markup).toContain('@project/src/app.ts')
    expect(markup).not.toContain('data-agent-file-reference="true"')
  })

  test('marks inherited session references unavailable in a fork without touching legacy links', () => {
    const markup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: 'fork', fileContextId: 'fork-context' }}>
        <MessageFileReferenceBindingProvider value={{ fileContextId: 'source-context' }}>
          <MarkdownCode onOpenThreadFile={() => 'opened'}>@session/files/brief.md</MarkdownCode>
        </MessageFileReferenceBindingProvider>
      </ThreadFileEnvProvider>,
    )
    expect(markup).toContain('data-invalid="true"')
    expect(markup).toContain('来自原会话，当前分叉不可用')
    expect(renderFileLink('plans/legacy.md')).not.toContain('data-invalid="true"')
  })

  test('normalizes markdown code class attributes without React DOM warnings', () => {
    const consoleErrors: string[] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '))
    }

    try {
      const markup = renderToStaticMarkup(
        <MarkdownCode {...({ class: 'language-ts' } as Record<string, unknown>)}>
          {'const answer = 42'}
        </MarkdownCode>,
      )

      expect(markup).toContain('class="language-ts"')
      expect(consoleErrors.join('\n')).not.toContain('Invalid DOM property `class`')
    } finally {
      console.error = originalConsoleError
    }
  })

  test('strips raw class props before spreading code attributes', () => {
    expect(typeof normalizeMarkdownCodeProps).toBe('function')

    const codeProps = normalizeMarkdownCodeProps?.({
      class: 'language-ts',
      className: 'existing-code-class',
      title: 'code title',
    })

    expect(codeProps).toEqual({
      className: 'language-ts existing-code-class',
      title: 'code title',
    })
    expect(codeProps).not.toHaveProperty('class')
  })
})
