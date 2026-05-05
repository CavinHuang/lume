import { describe, expect, test } from 'bun:test'
import { canContinueTaskContract, canRetryTaskContract, canSkipTaskContract, shouldShowTaskEmptyState } from './TaskProgressPanel'

describe('TaskProgressPanel', () => {
  test('detects whether a task contract can be continued', () => {
    expect(canContinueTaskContract({
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
        title: '失败任务',
        description: '失败任务',
        type: 'edit',
        status: 'failed',
      }],
      expectedChanges: {},
      status: 'failed',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    })).toBe(true)
  })

  test('does not show the empty state for a pending empty task approval', () => {
    expect(shouldShowTaskEmptyState(undefined, {
      contractId: 'plan-1',
      stepCount: 0,
    })).toBe(false)
  })

  test('detects retry and skip controls for failed task contracts', () => {
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
        title: '失败任务',
        description: '失败任务',
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

    expect(canRetryTaskContract(plan)).toBe(true)
    expect(canSkipTaskContract(plan)).toBe(true)
  })
})
