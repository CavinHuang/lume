import { describe, expect, test } from 'bun:test'
import type { LumeRuntimeEvent } from '@lume/shared'
import { canContinueTaskProgress, canRetryTaskProgress, canSkipTaskProgress, formatProgressItemTitle, getTaskProgressItems, shouldShowTaskEmptyState } from './TaskProgressPanel'

type TaskProgressEvent = Extract<LumeRuntimeEvent, { type: 'task.progress' }>

function progress(input: Partial<TaskProgressEvent> = {}): TaskProgressEvent {
  return {
    id: 'task.progress:taskrun-1',
    type: 'task.progress',
    threadId: 'thread-1',
    runId: 'run-1',
    taskRunId: 'taskrun-plan-1',
    contractId: 'plan-1',
    status: 'running',
    currentTaskId: 'step-1',
    tasks: [{
      id: 'step-1',
      title: '执行任务',
      description: '执行任务',
      status: 'running',
      attemptCount: 1,
    }],
    createdAt: '2026-05-01T00:00:00.000Z',
    ...input,
  }
}

describe('TaskProgressPanel', () => {
  test('detects whether runtime task progress can be continued', () => {
    expect(canContinueTaskProgress(progress({ status: 'running' }))).toBe(true)
    expect(canContinueTaskProgress(progress({ status: 'pending' }))).toBe(true)
    expect(canContinueTaskProgress(progress({ status: 'failed' }))).toBe(true)
    expect(canContinueTaskProgress(progress({ status: 'completed' }))).toBe(false)
  })

  test('shows empty state when no task progress event exists', () => {
    expect(shouldShowTaskEmptyState(undefined)).toBe(true)
    expect(getTaskProgressItems(undefined)).toEqual([])
  })

  test('detects retry and skip controls from failed task progress', () => {
    const failed = progress({
      status: 'failed',
      tasks: [{
        id: 'step-1',
        title: '失败任务',
        description: '失败任务',
        status: 'failed',
        attemptCount: 1,
        error: 'boom',
      }],
    })

    expect(canRetryTaskProgress(failed)).toBe(true)
    expect(canSkipTaskProgress(failed)).toBe(true)
  })

  test('uses runtime progress tasks as the only task item source', () => {
    const event = progress({
      tasks: [{
        id: 'step-1',
        title: '运行期任务',
        description: '来自 task.progress',
        status: 'completed',
        attemptCount: 1,
      }],
    })

    expect(getTaskProgressItems(event)).toEqual(event.tasks)
  })

  test('formats task progress items as title only', () => {
    expect(formatProgressItemTitle({
      id: 'step-1',
      title: '公司背景与团队',
      description: '很长的描述不应该直接显示在任务列表里',
      status: 'completed',
      attemptCount: 1,
      result: '完成后生成的大段 Markdown 内容也不应该拼到标题里',
    })).toBe('公司背景与团队')
  })
})
