import { describe, expect, test } from 'bun:test'
import {
  buildLiveRunEventRows,
  buildRunRows,
  buildStructuredPlanSteps,
  buildTraceRows,
  getDefaultRunId,
} from './runtime-state-projections'
import type { AgentStructuredPlan, AgentRunTrace, AgentRunStateSummary } from '@lume/shared'

describe('runtime-state projections', () => {
  test('maps live run events into readable rows', () => {
    expect(buildLiveRunEventRows([
      { type: 'assistant_delta', text: 'hello' },
      { type: 'assistant_thinking_delta', text: 'thinking' },
      {
        type: 'tool_call_started',
        item: {
          type: 'tool_call',
          id: 'tool-1',
          toolName: 'Bash',
          input: {},
          parentAgentId: 'root',
          status: 'running',
          createdAt: '2026-04-30T00:00:00.000Z',
        },
      },
      {
        type: 'subagent_updated',
        item: {
          type: 'subagent',
          id: 'subagent-item-1',
          runId: 'subagent-run-1',
          task: 'Review runtime boundaries',
          status: 'running',
          childThreadId: 'child-thread',
          createdAt: '2026-04-30T00:00:00.000Z',
        },
      },
      {
        type: 'handoff_updated',
        item: {
          type: 'handoff',
          id: 'handoff-1',
          fromAgentId: 'root',
          toAgentId: 'reviewer',
          status: 'completed',
          createdAt: '2026-04-30T00:00:00.000Z',
        },
      },
      { type: 'run_failed', error: { code: 'failed', message: 'boom' } },
    ])).toEqual([
      { id: '0:assistant_delta', label: 'Assistant delta', detail: 'hello', tone: 'neutral' },
      { id: '1:assistant_thinking_delta', label: 'Thinking delta', detail: 'thinking', tone: 'neutral' },
      { id: '2:tool_call_started', label: 'Tool started', detail: 'Bash', tone: 'active' },
      { id: '3:subagent_updated', label: 'Subagent', detail: 'running: Review runtime boundaries', tone: 'active' },
      { id: '4:handoff_updated', label: 'Handoff', detail: 'completed: root -> reviewer', tone: 'success' },
      { id: '5:run_failed', label: 'Run failed', detail: 'boom', tone: 'danger' },
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

  test('maps structured plan steps into existing plan panel rows', () => {
    const plans: AgentStructuredPlan[] = [{
      id: 'plan-1',
      runId: 'run-1',
      threadId: 'thread-1',
      goal: 'Ship runtime',
      summary: 'Finish runtime work',
      assumptions: [],
      questions: [],
      risks: [],
      steps: [
        { id: 'step-1', title: 'Read code', description: 'Read code', type: 'read', status: 'completed', result: 'Final result' },
        { id: 'step-2', title: 'Patch', description: 'Patch runtime', type: 'edit', status: 'running' },
      ],
      expectedChanges: {},
      status: 'executing',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:01:00.000Z',
    }]

    expect(buildStructuredPlanSteps(plans)).toEqual([
      { id: 'step-1', text: 'Read code\nFinal result', status: 'completed', failCount: 0, lastError: null },
      { id: 'step-2', text: 'Patch', status: 'in_progress', failCount: 0, lastError: null },
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
