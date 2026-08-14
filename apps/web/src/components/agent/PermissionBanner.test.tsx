import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentToolPermissionRequest } from '@lume/shared'

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  openFileDialog: async () => ({ files: [] }),
  sidecarCall: async () => undefined,
}))

const { PermissionBanner, buildToolPermissionSubmission } = await import('./PermissionBanner')

const request: AgentToolPermissionRequest = {
  threadId: 'thread-1',
  requestId: 'tool-1',
  toolUseId: 'tool-1',
  toolName: 'Bash',
  risk: 'high',
  reason: '需要运行命令',
  reasonCode: 'risk_requires_approval',
  classification: {
    riskLevel: 'high',
    reasonCode: 'shell_write_pattern',
    explanation: '命令会修改工作区状态',
    shouldAsk: true,
  },
  grantSuggestion: {
    fingerprint: 'Bash:git status',
    label: 'Bash:git status',
  },
  input: { command: 'git status' },
}

describe('PermissionBanner', () => {
  test('renders tool permission with the redesigned security decision frame', () => {
    const markup = renderToStaticMarkup(
      <PermissionBanner threadId="thread-1" request={request} />,
    )

    expect(markup).toContain('data-interactive-overlay="tool-permission"')
    expect(markup).toContain('Lume 想要执行一项操作')
    expect(markup).toContain('Bash')
    expect(markup).toContain('请求工具')
    expect(markup).toContain('请求来源')
    expect(markup).toContain('主 Agent')
    expect(markup).toContain('运行命令')
    expect(markup).toContain('需要运行命令')
    expect(markup).toContain('risk_requires_approval')
    expect(markup).toContain('shell_write_pattern')
    expect(markup).toContain('命令会修改工作区状态')
    expect(markup).toContain('仅这一次')
    expect(markup).toContain('始终允许')
    expect(markup).toContain('git status')
    expect(markup).toContain('拒绝')
    expect(markup).toContain('本线程内自动执行')
    expect(markup).toContain('跳过')
    expect(markup).toContain('ESC')
    expect(markup).toContain('确认执行')
  })

  test('hides allow-always when request policy disables it', () => {
    const markup = renderToStaticMarkup(
      <PermissionBanner threadId="thread-1" request={{ ...request, canAllowAlways: false }} />,
    )

    expect(markup).toContain('仅这一次')
    expect(markup).not.toContain('始终允许')
    expect(markup).not.toContain('本线程内自动允许')
    expect(markup).toContain('拒绝')
  })

  test('builds thread allow-all submissions as bypass permission mode', () => {
    expect(buildToolPermissionSubmission({
      threadId: 'thread-1',
      requestId: 'tool-1',
      decision: 'allow_once',
      allowAllInThread: true,
    })).toEqual({
      threadId: 'thread-1',
      requestId: 'tool-1',
      decision: 'allow_once',
      threadPermissionMode: 'bypassPermissions',
    })
  })
})
