import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentToolPermissionGrantRecord } from '@lume/shared'

mock.module('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}))

const { ToolPermissionGrantsCard, describeToolGrantScope } = await import('./ToolPermissionGrantsCard')

function record(overrides: Partial<AgentToolPermissionGrantRecord> = {}): AgentToolPermissionGrantRecord {
  return {
    id: 'g1',
    workspaceSlug: 'ws-a',
    scope: 'command',
    toolName: 'Bash',
    fingerprints: ['bash:npm run build', '>bash:npm run build'],
    createdAt: '2026-08-27T02:00:00.000Z',
    ...overrides,
  }
}

describe('ToolPermissionGrantsCard (#775)', () => {
  test('空列表渲染占位文案', () => {
    const html = renderToStaticMarkup(
      <ToolPermissionGrantsCard grants={[]} />
    )
    expect(html).toContain('暂无已授予的工具权限')
  })

  test('command 档展示命令摘要与前缀徽标', () => {
    const html = renderToStaticMarkup(
      <ToolPermissionGrantsCard grants={[record()]} />
    )
    expect(html).toContain('npm run build')
    expect(html).toContain(describeToolGrantScope('command'))
    // 展示摘要不得泄漏宽指纹前缀标记
    expect(html).toContain('Bash')
    expect(html).not.toContain('&gt;bash:npm')
  })

  test('tool 档以高危徽标标注全部调用授权', () => {
    const html = renderToStaticMarkup(
      <ToolPermissionGrantsCard
        grants={[record({
          id: 'g2',
          scope: 'tool',
          fingerprints: ['bash:npm run build', '*bash'],
        })]}
      />,
    )
    expect(html).toContain(describeToolGrantScope('tool'))
    // 高危档必须带红色 tone（GRANT_SCOPE_META.tool）
    expect(html).toMatch(/red-600|red-500/)
  })

  test('携带撤销动作与作用域清空入口', () => {
    const html = renderToStaticMarkup(
      <ToolPermissionGrantsCard
        grants={[record()]}
        workspaceSlug="ws-a"
        onRevokeGrant={() => undefined}
        onClearWorkspace={() => undefined}
      />,
    )
    expect(html).toContain('aria-label="撤销此授权"')
    expect(html).toContain('aria-label="清空当前工作区授权"')
  })

  test('未选工作区时不出清空入口（避免跨区误删）', () => {
    const html = renderToStaticMarkup(
      <ToolPermissionGrantsCard grants={[record()]} onRevokeGrant={() => undefined} />,
    )
    expect(html).not.toContain('清空当前工作区授权')
  })
})
