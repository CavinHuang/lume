import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

const { ExternalDirsSection } = await import('./ExternalDirsSection')

// dirs 经 props 注入（sidecarCall 挂载在 UnifiedFileTree 层），纯静态渲染无需 mock
const scopeInput = (scope: 'thread' | 'workspace') =>
  scope === 'thread'
    ? { kind: 'thread' as const, workspaceSlug: 'ws', threadId: 't1' }
    : { kind: 'workspace' as const, workspaceSlug: 'ws' }
describe('ExternalDirsSection 附加目录迷你树（双作用域纯渲染）', () => {
  test('双作用域清单渲染：会话与工作区·共享小节 + 根行绝对路径 + ✕ + 共享 badge', () => {
    const markup = renderToStaticMarkup(
      <ExternalDirsSection
        dirs={{
          thread: [{ absolutePath: 'D:\\refs\\a', attachedAt: '2026-08-16T00:00:00Z', available: true }],
          workspace: [{ absolutePath: 'E:\\shared\\b', attachedAt: '2026-08-16T00:00:00Z', available: true }],
        }}
        onRemove={() => {}}
        getScopeInput={scopeInput}
      />,
    )
    expect(markup).toContain('附加目录（会话）')
    expect(markup).toContain('附加目录（工作区·共享）')
    expect(markup).toContain('共享')
    expect(markup).toContain('D:\\refs\\a')
    expect(markup).toContain('E:\\shared\\b')
    // mock 无关断言（61fde147 先例）：全量套件下 @/components/ui/button 被先行 mock 丢 title，
    // 移除入口的存在性改断言 X 图标的 lucide 默认 class
    expect(markup).toContain('lucide-x')
  })

  test('不可用目录渲染「路径不可用」且保留移除入口', () => {
    const markup = renderToStaticMarkup(
      <ExternalDirsSection
        dirs={{ thread: [{ absolutePath: 'D:\\gone', attachedAt: '2026-08-16T00:00:00Z', available: false }], workspace: [] }}
        onRemove={() => {}}
        getScopeInput={scopeInput}
      />,
    )
    expect(markup).toContain('路径不可用')
    expect(markup).toContain('D:\\gone')
    expect(markup).toContain('lucide-x')
  })

  test('双作用域皆空时不渲染任何小节', () => {
    const markup = renderToStaticMarkup(
      <ExternalDirsSection dirs={{ thread: [], workspace: [] }} onRemove={() => {}} getScopeInput={scopeInput} />,
    )
    // mock 无关：空态语义 = 不含任何小节标题（toBE('') 在全局 mock 污染下不稳）
    expect(markup).not.toContain('附加目录')
  })
})
