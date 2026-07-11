import { describe, expect, test } from 'bun:test'
import type { AgentToolResult, SubagentRun, SubagentTask, SubagentTaskReport } from './agent'

describe('persistent subagent work contracts', () => {
  test('keeps run completion separate from task acceptance', () => {
    const report: SubagentTaskReport = { status: 'submitted', summary: 'implementation and tests are ready' }
    const run: SubagentRun = {
      runId: 'run-1', taskId: 'task-1', subagentId: 'developer-01', childThreadId: 'child-1',
      parentThreadId: 'parent-1', parentRunId: 'parent-run-1', parentToolUseId: 'tool-1',
      attempt: 1, instruction: 'implement it', status: 'completed', report, createdAt: 1, updatedAt: 2,
    }
    const task: SubagentTask = {
      taskId: 'task-1', subagentId: 'developer-01', parentThreadId: 'parent-1', parentRunId: 'parent-run-1',
      objective: 'implement it', acceptanceCriteria: ['tests pass'], status: 'awaiting_review', attemptCount: 1,
      createdAt: 1, updatedAt: 2,
    }
    const result: AgentToolResult = { subagentId: run.subagentId, childThreadId: run.childThreadId, taskId: run.taskId, runId: run.runId, attempt: run.attempt, report }

    expect(run.status).toBe('completed')
    expect(task.status).toBe('awaiting_review')
    expect(result.report.status).toBe('submitted')
  })
})
