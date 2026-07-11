import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SubagentCoordinator } from './subagent-coordinator'
import { SubagentWorkStore } from './subagent-work-store'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

function createCoordinator() {
  const directory = mkdtempSync(join(tmpdir(), 'lume-subagent-coordinator-'))
  directories.push(directory)
  return new SubagentCoordinator(new SubagentWorkStore(join(directory, 'subagent-runs.json')))
}

function baseInput(coordinator: SubagentCoordinator, subagentId?: string) {
  return {
    parentThreadId: 'parent', parentRunId: 'parent-run', parentToolUseId: crypto.randomUUID(), prompt: 'inspect the implementation', description: 'Inspect', subagentId,
    createSession: ({ subagentId }: { subagentId: string }) => ({ threadId: `child:${subagentId}` }),
    execute: async ({ run }: any) => { coordinator.submitReport({ runId: run.runId, report: { status: 'submitted', summary: run.instruction } }); return {} },
  }
}

describe('SubagentCoordinator', () => {
  test('keeps submitted work awaiting review until the parent accepts it', async () => {
    const coordinator = createCoordinator()
    const result = await coordinator.runAgentTask(baseInput(coordinator))
    const work = coordinator.list('parent')
    expect(result.report.status).toBe('submitted')
    expect(work.runs[0]).toMatchObject({ status: 'completed' })
    expect(work.tasks[0]).toMatchObject({ status: 'awaiting_review' })
    coordinator.finishTask({ taskId: result.taskId, resolution: 'accepted', reason: 'verified' })
    expect(coordinator.list('parent').tasks[0]).toMatchObject({ status: 'accepted' })
  })

  test('serializes one Session while separate Sessions overlap', async () => {
    const coordinator = createCoordinator()
    let active = 0; let maxActive = 0; const order: string[] = []
    const makeInput = (subagentId: string) => ({ ...baseInput(coordinator, subagentId), execute: async ({ run }: any) => {
      active += 1; maxActive = Math.max(maxActive, active); order.push(`start:${run.runId}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
      coordinator.submitReport({ runId: run.runId, report: { status: 'submitted', summary: 'done' } })
      order.push(`end:${run.runId}`); active -= 1; return {}
    } })
    await Promise.all([coordinator.runAgentTask(makeInput('same')), coordinator.runAgentTask(makeInput('same')), coordinator.runAgentTask(makeInput('other'))])
    expect(maxActive).toBe(2)
    expect(order[0]?.startsWith('start:')).toBeTrue()
    expect(order[1]?.startsWith('start:')).toBeTrue()
    expect(order.filter((item) => item.startsWith('end:')).length).toBe(3)
  })

  test('blocks parent completion while a task awaits review and keeps an idle session reusable', async () => {
    const coordinator = createCoordinator()
    const result = await coordinator.runAgentTask(baseInput(coordinator, 'developer-01'))
    expect(coordinator.getCompletionBlocker('parent', 'parent-run')).toContain(result.taskId)
    expect(coordinator.list('parent').sessions[0]).toMatchObject({ status: 'idle' })
    coordinator.finishTask({ taskId: result.taskId, resolution: 'accepted', reason: 'done' })
    expect(coordinator.getCompletionBlocker('parent', 'parent-run')).toBeUndefined()
    expect(coordinator.retireSession({ subagentId: result.subagentId, reason: 'done' })).toMatchObject({ status: 'retired' })
  })

  test('keeps unresolved work blocking later parent runs', async () => {
    const coordinator = createCoordinator()
    const result = await coordinator.runAgentTask(baseInput(coordinator))

    expect(coordinator.getCompletionBlocker('parent', 'later-parent-run')).toContain(result.taskId)
  })

  test('persists ordered runtime attempts for one logical run', async () => {
    const coordinator = createCoordinator()
    const result = await coordinator.runAgentTask({
      ...baseInput(coordinator),
      execute: async ({ run }: any) => {
        coordinator.bindRuntimeRun(run.runId, 'runtime-attempt-1')
        coordinator.bindRuntimeRun(run.runId, 'runtime-attempt-1')
        coordinator.bindRuntimeRun(run.runId, 'runtime-attempt-2')
        coordinator.submitReport({ runId: run.runId, report: { status: 'submitted', summary: 'done' } })
        return {}
      },
    })

    expect(coordinator.list('parent').runs.find((run) => run.runId === result.runId)?.runtimeRunIds).toEqual([
      'runtime-attempt-1',
      'runtime-attempt-2',
    ])
  })

  test('blocks a running child from completing until it submits TaskReport', async () => {
    const coordinator = createCoordinator()
    let blockerBeforeReport: string | undefined
    let blockerAfterReport: string | undefined

    await coordinator.runAgentTask({
      ...baseInput(coordinator),
      execute: async ({ run }: any) => {
        blockerBeforeReport = coordinator.getRunCompletionBlocker(run.runId)
        coordinator.submitReport({ runId: run.runId, report: { status: 'submitted', summary: 'done' } })
        blockerAfterReport = coordinator.getRunCompletionBlocker(run.runId)
        return {}
      },
    })

    expect(blockerBeforeReport).toContain('TaskReport')
    expect(blockerAfterReport).toBeUndefined()
  })

  test('uses completed child output when the model ends without an explicit TaskReport', async () => {
    const coordinator = createCoordinator()

    const result = await coordinator.runAgentTask({
      ...baseInput(coordinator),
      execute: async () => ({ status: 'completed', completionSummary: 'implemented and verified the requested change' }),
    })

    expect(result.report).toEqual({
      status: 'submitted',
      summary: 'implemented and verified the requested change',
    })
    const run = coordinator.list('parent').runs[0]
    expect(run).toMatchObject({
      status: 'completed',
      report: result.report,
    })
    expect(run?.error).toBeUndefined()
  })

  test('keeps an explicit TaskReport instead of replacing it with completed child output', async () => {
    const coordinator = createCoordinator()

    const result = await coordinator.runAgentTask({
      ...baseInput(coordinator),
      execute: async ({ run }: any) => {
        coordinator.submitReport({
          runId: run.runId,
          report: { status: 'submitted', summary: 'explicit report', artifacts: [{ path: 'result.txt' }] },
        })
        return { status: 'completed', completionSummary: 'raw child output' }
      },
    })

    expect(result.report).toMatchObject({
      status: 'submitted',
      summary: 'explicit report',
      artifacts: [{ path: 'result.txt' }],
    })
  })

  test('persists continuation feedback and marks repeated reports stalled', async () => {
    const coordinator = createCoordinator()
    const first = await coordinator.runAgentTask(baseInput(coordinator, 'developer-01'))
    const second = await coordinator.runAgentTask({
      ...baseInput(coordinator, 'developer-01'),
      taskId: first.taskId,
      prompt: 'use a different verification strategy',
      execute: async ({ run }: any) => {
        coordinator.submitReport({ runId: run.runId, report: { status: 'submitted', summary: 'inspect the implementation' } })
        return {}
      },
    })
    const work = coordinator.list('parent')
    expect(work.feedback).toContainEqual(expect.objectContaining({ taskId: first.taskId, instruction: 'use a different verification strategy' }))
    expect(work.tasks.find((task) => task.taskId === second.taskId)).toMatchObject({ stalled: true, attemptCount: 2 })
  })
})
