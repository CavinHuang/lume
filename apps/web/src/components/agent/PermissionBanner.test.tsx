import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentToolPermissionRequest } from '@lume/shared'

mock.module('@/lib/desktop-api', () => ({
  agentSend: async () => undefined,
  openFileDialog: async () => ({ files: [] }),
  sidecarCall: async () => undefined,
  submitTaskApproval: async () => ({ ok: true }),
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
  test('renders tool permission with the same overlay frame language as plan approval', () => {
    const markup = renderToStaticMarkup(
      <PermissionBanner threadId="thread-1" request={request} />,
    )

    expect(markup).toContain('data-interactive-overlay="tool-permission"')
    expect(markup).toContain('确认工具执行?')
    expect(markup).toContain('Bash')
    expect(markup).toContain('需要运行命令')
    expect(markup).toContain('risk_requires_approval')
    expect(markup).toContain('shell_write_pattern')
    expect(markup).toContain('命令会修改工作区状态')
    expect(markup).toContain('允许一次')
    expect(markup).toContain('始终允许 Bash:git status')
    expect(markup).toContain('拒绝')
    expect(markup).toContain('本线程全部允许')
    expect(markup).toContain('忽略')
    expect(markup).toContain('ESC')
    expect(markup).toContain('提交')
  })

  test('hides allow-always when request policy disables it', () => {
    const markup = renderToStaticMarkup(
      <PermissionBanner threadId="thread-1" request={{ ...request, canAllowAlways: false }} />,
    )

    expect(markup).toContain('允许一次')
    expect(markup).not.toContain('始终允许 Bash:git status')
    expect(markup).not.toContain('本线程全部允许')
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
