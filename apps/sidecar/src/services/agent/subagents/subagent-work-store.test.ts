import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SubagentWorkStore } from './subagent-work-store'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

function createStore(): { store: SubagentWorkStore; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'lume-subagent-work-'))
  directories.push(directory)
  const path = join(directory, 'subagent-runs.json')
  return { store: new SubagentWorkStore(path), path }
}

describe('SubagentWorkStore', () => {
  test('starts empty and persists a v2 snapshot atomically', () => {
    const { store } = createStore()
    expect(store.snapshot()).toEqual({ version: 2, sessions: [], tasks: [], feedback: [], runs: [] })
    store.replace({ version: 2, sessions: [{ subagentId: 'agent-1', threadId: 'child-1', parentThreadId: 'parent-1', agentType: 'Explore', title: 'Explore', status: 'idle', createdAt: 1, lastUsedAt: 1 }], tasks: [], feedback: [], runs: [] })
    expect(store.snapshot().sessions[0]?.subagentId).toBe('agent-1')
  })

  test('migrates legacy completed records to an accepted task', () => {
    const { store, path } = createStore()
    writeFileSync(path, JSON.stringify({ version: 1, runs: [{ runId: 'old-run', parentThreadId: 'parent', childThreadId: 'child', task: 'inspect', status: 'completed', createdAt: 1, updatedAt: 2 }] }), 'utf8')
    const snapshot = store.snapshot()
    expect(snapshot.version).toBe(2)
    expect(snapshot.tasks[0]).toMatchObject({ status: 'accepted', attemptCount: 1 })
    expect(snapshot.runs[0]).toMatchObject({ status: 'completed', report: { status: 'submitted' } })
  })

  test('marks active persisted runs errored on restart and leaves their tasks reviewable', () => {
    const { store, path } = createStore()
    store.replace({ version: 2, sessions: [{ subagentId: 'agent-1', threadId: 'child-1', parentThreadId: 'parent', agentType: 'Explore', title: 'Explore', status: 'busy', currentRunId: 'run-1', currentTaskId: 'task-1', createdAt: 1, lastUsedAt: 1 }], tasks: [{ taskId: 'task-1', subagentId: 'agent-1', parentThreadId: 'parent', parentRunId: 'parent-run', objective: 'inspect', acceptanceCriteria: [], status: 'running', attemptCount: 1, createdAt: 1, updatedAt: 1 }], feedback: [], runs: [{ runId: 'run-1', taskId: 'task-1', subagentId: 'agent-1', childThreadId: 'child-1', parentThreadId: 'parent', parentRunId: 'parent-run', parentToolUseId: 'tool-1', attempt: 1, instruction: 'inspect', status: 'running', createdAt: 1, updatedAt: 1 }] })
    const snapshot = new SubagentWorkStore(path).snapshot()
    expect(snapshot.runs[0]).toMatchObject({ status: 'errored' })
    expect(snapshot.tasks[0]).toMatchObject({ status: 'awaiting_review' })
    expect(snapshot.sessions[0]).toMatchObject({ status: 'idle' })
  })
})
