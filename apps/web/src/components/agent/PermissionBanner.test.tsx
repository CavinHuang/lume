import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentToolPermissionRequest } from '@lume/shared'

mock.module('@/lib/desktop-api', () => ({
  sidecarCall: async () => undefined,
  submitTaskApproval: async () => ({ ok: true }),
}))

const { PermissionBanner } = await import('./PermissionBanner')

const request: AgentToolPermissionRequest = {
  threadId: 'thread-1',
  requestId: 'tool-1',
  toolUseId: 'tool-1',
  toolName: 'Bash',
  risk: 'high',
  reason: '需要运行命令',
  input: { command: 'git status' },
}

describe('PermissionBanner', () => {
  test('renders tool permission with the same overlay frame language as plan approval', () => {
    const markup = renderToStaticMarkup(
      <PermissionBanner threadId="thread-1" request={request} />,
    )

    expect(markup).toContain('data-interactive-overlay="tool-permission"')
    expect(markup).toContain('确认工具执行?')
    expect(markup).toContain('Bash')
    expect(markup).toContain('需要运行命令')
    expect(markup).toContain('允许一次')
    expect(markup).toContain('始终允许')
    expect(markup).toContain('拒绝')
    expect(markup).toContain('忽略')
    expect(markup).toContain('ESC')
    expect(markup).toContain('提交')
  })
})
