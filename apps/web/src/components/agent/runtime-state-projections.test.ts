import { describe, expect, test } from 'bun:test'
import {
  buildContextWindowProgress,
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
      {
        ...base,
        id: 'event-compact',
        type: 'context.compaction.completed',
        trigger: 'auto',
        preTokens: 900,
        postTokens: 300,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
        summary: 'kept the important decisions',
      },
      {
        ...base,
        id: 'event-usage',
        type: 'usage.updated',
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        contextWindow: 100,
        costUSD: 0.01,
      },
      { ...base, id: 'event-3', type: 'run.failed', error: { code: 'failed', message: 'boom' } },
    ] satisfies LumeRuntimeEvent[])).toEqual([
      { id: 'event-1:0', label: 'Tool started', detail: 'Bash', tone: 'active' },
      { id: 'event-2:1', label: 'Task progress', detail: '开始执行：Patch', tone: 'active' },
      { id: 'event-compact:2', label: 'Context compacted', detail: 'auto · 900 -> 300', tone: 'success' },
      { id: 'event-usage:3', label: 'Usage updated', detail: '15 / 100 tokens', tone: 'neutral' },
      { id: 'event-3:4', label: 'Run failed', detail: 'boom', tone: 'danger' },
    ])
  })

  test('builds current context window progress from runtime events', () => {
    const base = {
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-05-11T00:00:00.000Z',
    }

    expect(buildContextWindowProgress([
      {
        ...base,
        id: 'run-started',
        type: 'run.started',
        model: {
          provider: 'openai',
          modelId: 'gpt-test',
          contextWindow: 1000,
        },
      },
      {
        ...base,
        id: 'usage',
        type: 'usage.updated',
        inputTokens: 720,
        outputTokens: 80,
        cachedTokens: 40,
        totalTokens: 800,
        contextWindow: 1000,
        costUSD: 0.0123,
        usageRecords: [
          {
            callerLabel: 'gpt-test',
            model: 'gpt-4o-mini',
            turn: 1,
            inputTokens: 720,
            cachedTokens: 40,
            outputTokens: 80,
            costUSD: 0.0123,
          },
        ],
      },
    ] satisfies LumeRuntimeEvent[])).toEqual({
      usedTokens: 800,
      contextWindow: 1000,
      remainingTokens: 200,
      percent: 80,
      tone: 'warning',
      label: 'Context window',
      detail: '800 / 1K tokens',
      sections: [
        { id: 'input', label: '输入', tokens: 720, percent: 72 },
        { id: 'cached', label: '缓存命中', tokens: 40, percent: 4 },
        { id: 'output', label: '输出', tokens: 80, percent: 8 },
      ],
      usage: {
        inputTokens: 720,
        outputTokens: 80,
        cachedTokens: 40,
        costUSD: 0.0123,
        records: [
          {
            callerLabel: 'gpt-test',
            model: 'gpt-4o-mini',
            turn: 1,
            inputTokens: 720,
            cachedTokens: 40,
            outputTokens: 80,
            costUSD: 0.0123,
            cacheHitRate: 6,
          },
        ],
      },
    })
  })

  test('shows an empty context window from the selected model before runtime usage arrives', () => {
    expect(buildContextWindowProgress([], { contextWindow: 200_000 })).toEqual({
      usedTokens: 0,
      contextWindow: 200_000,
      remainingTokens: 200_000,
      percent: 0,
      tone: 'neutral',
      label: 'Context window',
      detail: '0 / 200K tokens',
      sections: [],
    })
  })

  test('keeps a default context window when model selection data temporarily disappears', () => {
    expect(buildContextWindowProgress([])).toMatchObject({
      usedTokens: 0,
      contextWindow: 200_000,
      percent: 0,
      tone: 'neutral',
    })
  })

  test('ignores invalid runtime context windows so the indicator stays mounted', () => {
    const base = {
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-05-11T00:00:00.000Z',
    }

    expect(buildContextWindowProgress([
      {
        ...base,
        id: 'run-started',
        type: 'run.started',
        model: {
          provider: 'openai',
          modelId: 'unknown',
          contextWindow: 0,
        },
      },
      {
        ...base,
        id: 'usage',
        type: 'usage.updated',
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        contextWindow: 0,
      },
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 150,
      contextWindow: 200_000,
      percent: 0,
      detail: '150 / 200K tokens',
    })
  })

  test('keeps compaction budget sections for context occupancy details', () => {
    const base = {
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-05-11T00:00:00.000Z',
    }

    expect(buildContextWindowProgress([
      {
        ...base,
        id: 'compact',
        type: 'context.compaction.completed',
        trigger: 'auto',
        preTokens: 850,
        postTokens: 320,
        contextWindow: 1000,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
        budget: {
          totalTokens: 1000,
          usedTokens: 850,
          remainingTokens: 150,
          sections: {
            system: 110,
            memory: 90,
            session: 580,
            toolSchemas: 40,
            reservedOutput: 50,
          },
        },
      },
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 320,
      sections: [
        { id: 'system', label: '系统', tokens: 110, percent: 11 },
        { id: 'memory', label: '记忆', tokens: 90, percent: 9 },
        { id: 'session', label: '会话', tokens: 580, percent: 58 },
        { id: 'toolSchemas', label: '工具 Schema', tokens: 40, percent: 4 },
        { id: 'reservedOutput', label: '输出预留', tokens: 50, percent: 5 },
      ],
    })
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
