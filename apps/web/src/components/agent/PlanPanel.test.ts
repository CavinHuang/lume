import { describe, expect, test } from 'bun:test'
import { canContinueStructuredPlan, canRetryStructuredPlan, canSkipStructuredPlan, shouldShowPlanEmptyState } from './PlanPanel'

describe('PlanPanel', () => {
  test('detects whether a structured plan can be continued', () => {
    expect(canContinueStructuredPlan({
      id: 'plan-1',
      runId: 'run-1',
      threadId: 'thread-1',
      goal: '修复计划审批',
      summary: '中断后继续',
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: 'step-1',
        title: '失败步骤',
        description: '失败步骤',
        type: 'edit',
        status: 'failed',
      }],
      expectedChanges: {},
      status: 'failed',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    })).toBe(true)
  })

  test('does not show the empty state for a pending no-step plan approval', () => {
    expect(shouldShowPlanEmptyState(undefined, {
      planId: 'plan-1',
      stepCount: 0,
    })).toBe(false)
  })

  test('detects retry and skip controls for failed structured plans', () => {
    const plan = {
      id: 'plan-1',
      runId: 'run-1',
      threadId: 'thread-1',
      goal: '修复计划审批',
      summary: '失败后恢复',
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: 'step-1',
        title: '失败步骤',
        description: '失败步骤',
        type: 'edit' as const,
        status: 'failed' as const,
        attemptCount: 1,
        error: 'boom',
      }],
      expectedChanges: {},
      status: 'failed' as const,
      currentStepId: 'step-1',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    }

    expect(canRetryStructuredPlan(plan)).toBe(true)
    expect(canSkipStructuredPlan(plan)).toBe(true)
  })
})
