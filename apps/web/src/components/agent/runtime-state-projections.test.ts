import { describe, expect, test } from 'bun:test'
import {
  buildLiveRuntimeEventRows,
  buildRunRows,
  buildTraceRows,
  getDefaultRunId,
} from './runtime-state-projections'
import type { AgentRunTrace, AgentRunStateSummary, LumeRuntimeEvent } from '@lume/shared'

describe('runtime-state projections', () => {
  test('maps live runtime events into readable rows', () => {
    const base = {
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-05-11T00:00:00.000Z',
    }
    expect(buildLiveRuntimeEventRows([
      { ...base, id: 'event-1', type: 'tool.started', toolCallId: 'tool-1', toolName: 'Bash' },
      {
        ...base,
        id: 'event-2',
        type: 'task.progress',
        taskRunId: 'taskrun-1',
        contractId: 'contract-1',
        status: 'running',
        tasks: [],
        message: '开始执行：Patch',
      },
      { ...base, id: 'event-3', type: 'run.failed', error: { code: 'failed', message: 'boom' } },
    ] satisfies LumeRuntimeEvent[])).toEqual([
      { id: 'event-1:0', label: 'Tool started', detail: 'Bash', tone: 'active' },
      { id: 'event-2:1', label: 'Task progress', detail: '开始执行：Patch', tone: 'active' },
      { id: 'event-3:2', label: 'Run failed', detail: 'boom', tone: 'danger' },
    ])
  })

  test('maps run summaries into latest-first run rows', () => {
    const runs: AgentRunStateSummary[] = [
      {
        runId: 'run-1',
        threadId: 'thread-1',
        status: 'completed',
        traceId: 'trace-1',
        model: { provider: 'openai', modelId: 'gpt-old' },
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        pendingInterruptionCount: 0,
        generatedItemCount: 4,
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt: '2026-04-30T00:01:00.000Z',
        completedAt: '2026-04-30T00:01:00.000Z',
      },
      {
        runId: 'run-2',
        threadId: 'thread-1',
        status: 'waiting_for_approval',
        traceId: 'trace-2',
        model: { provider: 'openai', modelId: 'gpt-new' },
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        pendingInterruptionCount: 1,
        generatedItemCount: 2,
        continuation: {
          status: 'waiting_for_interruption',
          checkpoint: { step: 'waiting_for_tool_result', toolName: 'Bash' },
          updatedAt: '2026-04-30T00:03:00.000Z',
        },
        createdAt: '2026-04-30T00:02:00.000Z',
        updatedAt: '2026-04-30T00:03:00.000Z',
      },
    ]

    expect(getDefaultRunId(runs)).toBe('run-2')
    expect(buildRunRows(runs)).toEqual([
      {
        id: 'run-2',
        label: 'run-2',
        status: 'waiting_for_approval',
        detail: 'gpt-new · 1 pending · waiting_for_tool_result',
        createdAt: '2026-04-30 00:02',
      },
      {
        id: 'run-1',
        label: 'run-1',
        status: 'completed',
        detail: 'gpt-old · 4 items',
        createdAt: '2026-04-30 00:00',
      },
    ])
  })

  test('maps redacted trace spans into compact rows', () => {
    const trace: AgentRunTrace = {
      id: 'trace-1',
      threadId: 'thread-1',
      runId: 'run-1',
      name: 'Run',
      status: 'completed',
      startedAt: '2026-04-30T00:00:00.000Z',
      spans: [{
        id: 'span-1',
        traceId: 'trace-1',
        type: 'tool_call',
        name: 'Bash',
        status: 'completed',
        startedAt: '2026-04-30T00:00:00.000Z',
        durationMs: 42,
        input: '[REDACTED_PAYLOAD]',
      }],
    }

    expect(buildTraceRows(trace)).toEqual([{
      id: 'span-1',
      label: 'Bash',
      type: 'tool_call',
      status: 'completed',
      duration: '42ms',
      detail: null,
      depth: 0,
      hasChildren: false,
    }])
  })

  test('includes diagnostic payload preview when trace payload is available', () => {
    const trace: AgentRunTrace = {
      id: 'trace-1',
      threadId: 'thread-1',
      runId: 'run-1',
      name: 'Run',
      status: 'completed',
      startedAt: '2026-04-30T00:00:00.000Z',
      spans: [{
        id: 'span-1',
        traceId: 'trace-1',
        type: 'handoff',
        name: 'root -> reviewer',
        status: 'completed',
        startedAt: '2026-04-30T00:00:00.000Z',
        input: { reason: 'needs review' },
      }],
    }

    expect(buildTraceRows(trace)[0]).toMatchObject({
      label: 'root -> reviewer',
      type: 'handoff',
      detail: '{"reason":"needs review"}',
    })
  })

  test('orders trace spans as a parent-child tree', () => {
    const trace: AgentRunTrace = {
      id: 'trace-1',
      threadId: 'thread-1',
      runId: 'run-1',
      name: 'Run',
      status: 'completed',
      startedAt: '2026-04-30T00:00:00.000Z',
      spans: [
        {
          id: 'child-1',
          traceId: 'trace-1',
          parentId: 'root-1',
          type: 'tool_call',
          name: 'Bash',
          status: 'completed',
          startedAt: '2026-04-30T00:00:01.000Z',
          durationMs: 12,
        },
        {
          id: 'root-1',
          traceId: 'trace-1',
          type: 'run',
          name: 'Runtime run',
          status: 'completed',
          startedAt: '2026-04-30T00:00:00.000Z',
          durationMs: 30,
        },
        {
          id: 'orphan-1',
          traceId: 'trace-1',
          parentId: 'missing-parent',
          type: 'approval',
          name: 'Approval',
          status: 'completed',
          startedAt: '2026-04-30T00:00:02.000Z',
          durationMs: 3,
        },
      ],
    }

    expect(buildTraceRows(trace).map((row) => ({
      id: row.id,
      depth: row.depth,
      hasChildren: row.hasChildren,
    }))).toEqual([
      { id: 'root-1', depth: 0, hasChildren: true },
      { id: 'child-1', depth: 1, hasChildren: false },
      { id: 'orphan-1', depth: 0, hasChildren: false },
    ])
  })
})
