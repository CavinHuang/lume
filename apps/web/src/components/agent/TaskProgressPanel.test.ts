import { describe, expect, test } from 'bun:test'
import { canContinueTaskContract, canRetryTaskContract, canSkipTaskContract, formatProgressItemTitle, getTaskProgressItems, shouldShowTaskEmptyState } from './TaskProgressPanel'

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

  test('shows empty state when no contract is provided', () => {
    expect(shouldShowTaskEmptyState(undefined)).toBe(true)
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

  test('does not render pending approval contract steps as task progress', () => {
    const plan = {
      id: 'plan-1',
      runId: 'run-1',
      threadId: 'thread-1',
      goal: '审阅计划',
      summary: '等待用户审阅',
      assumptions: [],
      questions: [],
      risks: [],
      steps: [{
        id: 'step-1',
        title: '不应提前显示的任务',
        description: '不应提前显示的任务',
        type: 'edit' as const,
        status: 'pending' as const,
      }],
      expectedChanges: {},
      status: 'needs_approval' as const,
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    }

    expect(getTaskProgressItems(plan, undefined)).toEqual([])
  })

  test('formats task progress items as title only', () => {
    expect(formatProgressItemTitle({
      id: 'step-1',
      title: '公司背景与团队',
      description: '很长的描述不应该直接显示在任务列表里',
      status: 'completed',
      result: '完成后生成的大段 Markdown 内容也不应该拼到标题里',
    })).toBe('公司背景与团队')
  })
})
