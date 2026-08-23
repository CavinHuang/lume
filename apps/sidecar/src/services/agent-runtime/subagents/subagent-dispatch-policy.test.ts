import { describe, expect, test } from 'bun:test'
import type { SubagentTask } from '@lume/shared'
import { buildSubagentWorkContext, resolveSubagentDispatchPolicy } from './subagent-dispatch-policy'

const unresolvedTask: SubagentTask = {
  taskId: 'task-1',
  subagentId: 'agent-1',
  parentThreadId: 'parent',
  parentRunId: 'previous-parent-run',
  objective: '修复消息路由',
  acceptanceCriteria: [],
  status: 'awaiting_review',
  attemptCount: 1,
  createdAt: 1,
  updatedAt: 2,
}

describe('subagent dispatch policy', () => {
  test('rejects an unscoped dispatch while unresolved work exists', () => {
    expect(resolveSubagentDispatchPolicy({ prompt: '继续', unresolvedTasks: [unresolvedTask] })).toMatchObject({
      allowed: false,
      reason: 'target_required',
    })
  })

  test('rejects continuation-only text even when task_id is present', () => {
    expect(resolveSubagentDispatchPolicy({ prompt: '继续', taskId: 'task-1', unresolvedTasks: [unresolvedTask] })).toMatchObject({
      allowed: false,
      reason: 'explicit_instruction_required',
    })
  })

  test('allows concrete feedback only for an existing task target', () => {
    expect(resolveSubagentDispatchPolicy({ prompt: '补充验证消息去重并报告结果', taskId: 'task-1', unresolvedTasks: [unresolvedTask] })).toEqual({
      allowed: true,
      mode: 'continue_task',
    })
  })

  test('requires an explicit new_task marker before creating independent work', () => {
    expect(resolveSubagentDispatchPolicy({ prompt: '检查另一个独立模块', unresolvedTasks: [] })).toMatchObject({
      allowed: false,
      reason: 'new_task_required',
    })
    expect(resolveSubagentDispatchPolicy({ prompt: '检查另一个独立模块', newTask: true, unresolvedTasks: [] })).toEqual({
      allowed: true,
      mode: 'new_task',
    })
  })

  test('exposes unresolved work to the main agent without including user text', () => {
    const context = buildSubagentWorkContext([unresolvedTask])
    expect(context).toContain('task-1')
    expect(context).toContain('agent-1')
    expect(context).toContain('修复消息路由')
    expect(context).not.toContain('继续')
  })
})
