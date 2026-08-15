import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

const { ExternalDirsSection } = await import('./ExternalDirsSection')

// dirs 经 props 注入（sidecarCall 挂载在 UnifiedFileTree 层），纯静态渲染无需 mock
describe('ExternalDirsSection 附加目录迷你树（双作用域纯渲染）', () => {
  test('双作用域清单渲染：会话与工作区·共享小节 + 根行绝对路径 + ✕ + 共享 badge', () => {
    const markup = renderToStaticMarkup(
      <ExternalDirsSection
        dirs={{
          thread: [{ absolutePath: 'D:\\refs\\a', attachedAt: '2026-08-16T00:00:00Z', available: true }],
          workspace: [{ absolutePath: 'E:\\shared\\b', attachedAt: '2026-08-16T00:00:00Z', available: true }],
        }}
        onRemove={() => {}}
      />,
    )
    expect(markup).toContain('附加目录（会话）')
    expect(markup).toContain('附加目录（工作区·共享）')
    expect(markup).toContain('共享')
    expect(markup).toContain('D:\\refs\\a')
    expect(markup).toContain('E:\\shared\\b')
    expect(markup).toContain('移除附加')
  })

  test('不可用目录渲染「路径不可用」且保留移除入口', () => {
    const markup = renderToStaticMarkup(
      <ExternalDirsSection
        dirs={{ thread: [{ absolutePath: 'D:\\gone', attachedAt: '2026-08-16T00:00:00Z', available: false }], workspace: [] }}
        onRemove={() => {}}
      />,
    )
    expect(markup).toContain('路径不可用')
    expect(markup).toContain('D:\\gone')
    expect(markup).toContain('移除附加')
  })

  test('双作用域皆空时不渲染任何小节', () => {
    const markup = renderToStaticMarkup(
      <ExternalDirsSection dirs={{ thread: [], workspace: [] }} onRemove={() => {}} />,
    )
    expect(markup).toBe('')
  })
})
