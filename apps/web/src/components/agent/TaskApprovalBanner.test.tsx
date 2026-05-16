import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AgentTaskApprovalRequest } from '@lume/shared'

mock.module('@/lib/desktop-api', () => ({
  submitTaskApproval: async () => ({ ok: true }),
}))

const { PlanApprovalOverlay, buildPlanApprovalSubmission } = await import('./PlanApprovalOverlay')

const request: AgentTaskApprovalRequest = {
  threadId: 'thread-1',
  requestId: 'task_approval:plan-1',
  contractId: 'plan-1',
  title: '审阅计划',
  message: '审阅任务计划',
  summary: 'Ship the runtime plan',
  stepCount: 2,
  planFilePath: 'plans/plan-1.md',
  planVerified: true,
}

describe('PlanApprovalOverlay', () => {
  test('renders Codex-style approval choices over the composer', () => {
    const markup = renderToStaticMarkup(
      <PlanApprovalOverlay threadId="thread-1" request={request} />,
    )

    expect(markup).toContain('实施此计划?')
    expect(markup).toContain('是，实施此计划')
    expect(markup).toContain('否，请告知 Lume 如何调整')
    expect(markup).toContain('忽略')
    expect(markup).toContain('ESC')
    expect(markup).toContain('提交')
  })

  test('builds approve submissions with execute=true', () => {
    expect(buildPlanApprovalSubmission({
      threadId: 'thread-1',
      contractId: 'plan-1',
      choice: 'approve',
      feedback: '',
    })).toEqual({
      threadId: 'thread-1',
      contractId: 'plan-1',
      decision: 'approve',
      execute: true,
    })
  })

  test('requires feedback for reject submissions', () => {
    expect(buildPlanApprovalSubmission({
      threadId: 'thread-1',
      contractId: 'plan-1',
      choice: 'revise',
      feedback: '   ',
    })).toBeNull()

    expect(buildPlanApprovalSubmission({
      threadId: 'thread-1',
      contractId: 'plan-1',
      choice: 'revise',
      feedback: '请缩小范围',
    })).toEqual({
      threadId: 'thread-1',
      contractId: 'plan-1',
      decision: 'reject',
      feedback: '请缩小范围',
    })
  })
})
