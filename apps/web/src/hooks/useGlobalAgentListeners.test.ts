import { describe, expect, test } from 'bun:test'
import type { SubagentRunRecord } from '@lume/shared'
import * as listenerModule from './useGlobalAgentListeners'

function createRun(runId: string, parentThreadId: string): SubagentRunRecord {
  return {
    runId,
    parentThreadId,
    rootThreadId: parentThreadId,
    depth: 1,
    childThreadId: `child-${runId}`,
    task: runId,
    status: 'completed',
    cleanup: 'keep',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('useGlobalAgentListeners subagent run hydration', () => {
  test('冷启动时按父会话分组持久化的 subagent runs', () => {
    const hydrate = (listenerModule as {
      hydrateSubagentRuns?: (
        current: Record<string, SubagentRunRecord[]>,
        runs: SubagentRunRecord[],
      ) => Record<string, SubagentRunRecord[]>
    }).hydrateSubagentRuns
    expect(hydrate).toBeFunction()

    const result = hydrate!({}, [
      createRun('run-a1', 'parent-a'),
      createRun('run-b1', 'parent-b'),
      createRun('run-a2', 'parent-a'),
    ])

    expect(result['parent-a']?.map((run) => run.runId)).toEqual(['run-a1', 'run-a2'])
    expect(result['parent-b']?.map((run) => run.runId)).toEqual(['run-b1'])
  })
})
