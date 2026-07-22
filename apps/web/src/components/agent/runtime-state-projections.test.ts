import { describe, expect, test } from 'bun:test'
import {
  buildContextWindowProgress,
  buildLiveRuntimeEventRows,
  buildRunRows,
  buildTraceRows,
  getDefaultRunId,
} from './runtime-state-projections'
import type { AgentRunTrace, AgentRunStateSummary, LumeRuntimeEvent } from '@lume/shared'

function usageUpdatedEvent(input: {
  id: string
  threadId?: string
  runId?: string
  createdAt?: string
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  totalTokens?: number
  estimatedTailTokens?: number
  contextWindow: number
  costUSD?: number
  scope?: 'main' | 'subagent' | 'background'
  records?: Array<{
    callerLabel: string
    model?: string
    turn?: number
    inputTokens: number
    outputTokens: number
    cachedTokens?: number
    costUSD?: number
  }>
}): Extract<LumeRuntimeEvent, { type: 'usage.updated' }> {
  const cachedTokens = input.cachedTokens ?? 0
  const totalTokens = input.totalTokens ?? input.inputTokens + input.outputTokens + cachedTokens
  const records = input.records?.map((record) => ({
    callerLabel: record.callerLabel,
    callerKind: 'conversation',
    ...(record.model ? { model: record.model } : {}),
    ...(typeof record.turn === 'number' ? { turn: record.turn } : {}),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedTokens: record.cachedTokens ?? 0,
    totalTokens: record.inputTokens + record.outputTokens + (record.cachedTokens ?? 0),
    ...(typeof record.costUSD === 'number' ? { costUSD: record.costUSD } : {}),
  })) ?? []
  return {
    id: input.id,
    type: 'usage.updated',
    threadId: input.threadId ?? 'thread-1',
    runId: input.runId ?? 'run-1',
    createdAt: input.createdAt ?? '2026-05-11T00:00:00.000Z',
    scope: input.scope ?? 'main',
    context: {
      source: 'provider',
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedTokens,
      totalTokens,
      estimatedTailTokens: input.estimatedTailTokens ?? 0,
      contextWindow: input.contextWindow,
      contextWindowSource: 'model',
    },
    billing: {
      cumulative: {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedTokens,
        totalTokens,
      },
      ...(records[0] ? { latestRecord: records[0] } : {}),
      records,
      totalCostUSD: input.costUSD ?? 0,
    },
  }
}

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
      usageUpdatedEvent({ ...base, id: 'event-usage', inputTokens: 10, outputTokens: 5, totalTokens: 15, contextWindow: 100, costUSD: 0.01 }),
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
      usageUpdatedEvent({
        ...base,
        id: 'usage',
        inputTokens: 720,
        outputTokens: 80,
        cachedTokens: 40,
        totalTokens: 800,
        contextWindow: 1000,
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
          },
        ],
      }),
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
            cacheHitRate: 5,
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

  test('keeps the selected model context window when historical runtime events use an older value', () => {
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
          provider: 'zai',
          modelId: 'glm-5.2',
          contextWindow: 200_000,
        },
      },
      usageUpdatedEvent({
        ...base,
        id: 'usage',
        inputTokens: 90_000,
        outputTokens: 15_531,
        totalTokens: 105_531,
        contextWindow: 200_000,
      }),
    ] satisfies LumeRuntimeEvent[], { contextWindow: 1_000_000 })).toMatchObject({
      usedTokens: 105_531,
      contextWindow: 1_000_000,
      percent: 11,
      detail: '105.5K / 1M tokens',
    })
  })

  test('estimates opened thread context from loaded history messages when runtime usage is absent', () => {
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
          contextWindow: 100,
        },
      },
      {
        ...base,
        id: 'run-completed',
        type: 'run.completed',
        finalOutput: 'done',
      },
    ] satisfies LumeRuntimeEvent[], {
      messages: [
        { role: 'user', content: '12345678' },
        { role: 'assistant', content: 'abcdefghijkl' },
      ],
    })).toMatchObject({
      usedTokens: 5,
      contextWindow: 100,
      remainingTokens: 95,
      percent: 5,
      tone: 'active',
      sections: [
        { id: 'input', label: '输入', tokens: 2, percent: 2 },
        { id: 'output', label: '输出', tokens: 3, percent: 3 },
      ],
    })
  })

  test('estimates live context progress while the assistant is streaming before runtime usage arrives', () => {
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
          contextWindow: 100,
        },
      },
      {
        ...base,
        id: 'user-submitted',
        type: 'message.user.submitted',
        text: '12345678',
      },
      {
        ...base,
        id: 'assistant-delta',
        type: 'assistant.delta',
        delta: 'abcdefghijkl',
      },
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 5,
      contextWindow: 100,
      remainingTokens: 95,
      percent: 5,
      tone: 'active',
      detail: '5 / 100 tokens',
      sections: [
        { id: 'input', label: '输入', tokens: 2, percent: 2 },
        { id: 'output', label: '输出', tokens: 3, percent: 3 },
      ],
    })
  })

  test('does not undercount CJK live text while runtime usage is pending', () => {
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
          contextWindow: 100,
        },
      },
      {
        ...base,
        id: 'user-submitted',
        type: 'message.user.submitted',
        text: '你好世界',
      },
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 4,
      contextWindow: 100,
      remainingTokens: 96,
      percent: 4,
      sections: [
        { id: 'input', label: '输入', tokens: 4, percent: 4 },
      ],
    })
  })

  test('estimates completed tool output as live input context before runtime usage arrives', () => {
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
          contextWindow: 100,
        },
      },
      {
        ...base,
        id: 'user-submitted',
        type: 'message.user.submitted',
        text: '12345678',
      },
      {
        ...base,
        id: 'tool-completed',
        type: 'tool.completed',
        toolCallId: 'tool-1',
        toolName: 'Bash',
        resultPreview: 'abcdefghijkl',
      },
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 5,
      contextWindow: 100,
      remainingTokens: 95,
      percent: 5,
      sections: [
        { id: 'input', label: '输入', tokens: 5, percent: 5 },
      ],
    })
  })

  test('continues live estimate from latest provider context when a new run starts', () => {
    const base = {
      threadId: 'thread-1',
      createdAt: '2026-05-11T00:00:00.000Z',
    }

    expect(buildContextWindowProgress([
      usageUpdatedEvent({ ...base, id: 'previous-usage', runId: 'run-1', inputTokens: 70, outputTokens: 10, totalTokens: 80, contextWindow: 100 }),
      {
        ...base,
        id: 'run-started',
        runId: 'run-2',
        type: 'run.started',
        model: {
          provider: 'openai',
          modelId: 'gpt-test',
        },
      },
      {
        ...base,
        id: 'user-submitted',
        runId: 'run-2',
        type: 'message.user.submitted',
        text: '1234',
      },
      {
        ...base,
        id: 'assistant-delta',
        runId: 'run-2',
        type: 'assistant.delta',
        delta: '12345678',
      },
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 83,
      contextWindow: 100,
      remainingTokens: 17,
      percent: 83,
      detail: '83 / 100 tokens',
      sections: [
        { id: 'input', label: '输入', tokens: 71, percent: 71 },
        { id: 'output', label: '输出', tokens: 12, percent: 12 },
      ],
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
      usageUpdatedEvent({ ...base, id: 'usage', inputTokens: 120, outputTokens: 30, totalTokens: 150, contextWindow: 0 }),
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 150,
      contextWindow: 200_000,
      percent: 0,
      detail: '150 / 200K tokens',
    })
  })

  test('ignores subagent usage for the main context window', () => {
    const base = {
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-05-11T00:00:00.000Z',
    }

    expect(buildContextWindowProgress([
      usageUpdatedEvent({ ...base, id: 'main-usage', inputTokens: 70, outputTokens: 10, totalTokens: 80, contextWindow: 1000 }),
      usageUpdatedEvent({ ...base, id: 'subagent-usage', scope: 'subagent', inputTokens: 900, outputTokens: 50, totalTokens: 950, contextWindow: 1000 }),
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 80,
      contextWindow: 1000,
      detail: '80 / 1K tokens',
    })
  })

  test('splits provider input and estimated tail tokens into separate context sections', () => {
    const base = {
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-05-11T00:00:00.000Z',
    }

    expect(buildContextWindowProgress([
      usageUpdatedEvent({
        ...base,
        id: 'usage',
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 5,
        totalTokens: 115,
        estimatedTailTokens: 7,
        contextWindow: 200,
      }),
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      usedTokens: 115,
      sections: [
        { id: 'input', label: '输入', tokens: 93, percent: 47 },
        { id: 'estimatedTail', label: '实时估算', tokens: 7, percent: 4 },
        { id: 'cached', label: '缓存命中', tokens: 5, percent: 3 },
        { id: 'output', label: '输出', tokens: 10, percent: 5 },
      ],
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

  test('exposes current compaction state to the context indicator model', () => {
    const base = {
      threadId: 'thread-1',
      runId: 'run-1',
      createdAt: '2026-05-11T00:00:00.000Z',
    }

    expect(buildContextWindowProgress([
      {
        ...base,
        id: 'compact-started',
        type: 'context.compaction.started',
        trigger: 'auto',
        preTokens: 850,
        contextWindow: 1000,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
      },
      {
        ...base,
        id: 'compact-progress',
        type: 'context.compaction.progress',
        trigger: 'auto',
        preTokens: 850,
        contextWindow: 1000,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
        stage: 'summarizing',
        progress: 45,
        message: '正在生成上下文摘要',
      },
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      compaction: {
        status: 'compacting',
        trigger: 'auto',
        preTokens: 850,
        stage: 'summarizing',
        progress: 45,
        message: '正在生成上下文摘要',
      },
    })

    expect(buildContextWindowProgress([
      {
        ...base,
        id: 'compact-completed',
        type: 'context.compaction.completed',
        trigger: 'auto',
        preTokens: 850,
        postTokens: 320,
        contextWindow: 1000,
        policy: 'kernel-v1',
        source: 'agent-runtime-kernel',
        summary: 'kept important context',
      },
    ] satisfies LumeRuntimeEvent[])).toMatchObject({
      compaction: {
        status: 'completed',
        trigger: 'auto',
        preTokens: 850,
        postTokens: 320,
        summary: 'kept important context',
      },
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
