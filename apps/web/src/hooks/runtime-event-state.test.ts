import { describe, expect, test } from 'bun:test'
import * as runtimeEventState from './runtime-event-state'
import { appendRuntimeEvent, hydrateRuntimeEvents } from './runtime-event-state'
import type { AgentThreadRuntimeEventsResult, LumeRuntimeEvent } from '@lume/shared'

// appendRuntimeEvents 将在 Task 3 实现；此处通过命名空间动态访问，
// 使批量用例在函数缺失时单独失败（TDD 红灯），而不阻塞其余 characterization 用例的模块加载。
const appendRuntimeEvents = (runtimeEventState as any).appendRuntimeEvents as
  | ((prev: Record<string, { events: LumeRuntimeEvent[] }>, events: LumeRuntimeEvent[]) => Record<string, { events: LumeRuntimeEvent[] }>)
  | undefined

function runtimeEvent(event: Partial<LumeRuntimeEvent> & Pick<LumeRuntimeEvent, 'type'>): LumeRuntimeEvent {
  return {
    id: `event:${event.type}`,
    type: event.type,
    threadId: 'thread-1',
    runId: 'run-1',
    createdAt: '2026-05-11T00:00:00.000Z',
    ...event,
  } as LumeRuntimeEvent
}

function deltaEvent(
  id: string,
  seq: number,
  text: string,
  createdAt: string,
  messageId = 'msg-1',
): LumeRuntimeEvent {
  return {
    id,
    type: 'assistant.delta',
    threadId: 't1',
    runId: 'run-1',
    messageId,
    sequence: seq,
    createdAt,
    delta: text,
  } as LumeRuntimeEvent
}

describe('runtime-event-state', () => {
  test('appends RuntimeEvent per thread with latest terminal status', () => {
    const first = appendRuntimeEvent({}, runtimeEvent({ type: 'assistant.delta', delta: 'hello' }))
    const next = appendRuntimeEvent(first, runtimeEvent({ type: 'run.completed' }))

    expect(next['thread-1']).toMatchObject({
      terminalStatus: 'completed',
      events: [
        { type: 'assistant.delta' },
        { type: 'run.completed' },
      ],
    })
  })

  test('does not merge main assistant deltas with subagent-owned deltas', () => {
    const withMainDelta = appendRuntimeEvent({}, runtimeEvent({
      id: 'main-delta',
      type: 'assistant.delta',
      delta: 'main text',
    }))
    const withSubagentDelta = appendRuntimeEvent(withMainDelta, runtimeEvent({
      id: 'subagent-delta',
      type: 'assistant.delta',
      delta: 'subagent text',
      parentToolUseId: 'agent-tool-1',
      subagentRunId: 'subagent-run-1',
    }))

    expect(withSubagentDelta['thread-1']?.events).toEqual([
      expect.objectContaining({ id: 'main-delta', delta: 'main text' }),
      expect.objectContaining({
        id: 'subagent-delta',
        delta: 'subagent text',
        parentToolUseId: 'agent-tool-1',
        subagentRunId: 'subagent-run-1',
      }),
    ])
    expect(withSubagentDelta['thread-1']?.events[0]?.parentToolUseId).toBeUndefined()
  })

  test('连续同 owner 的 assistant.delta 合并为一条（正向）', () => {
    const first = appendRuntimeEvent({}, deltaEvent('d1', 1, 'hello', '2026-06-21T00:00:00.001Z'))
    const merged = appendRuntimeEvent(first, deltaEvent('d2', 2, ' world', '2026-06-21T00:00:00.002Z'))
    expect(merged.t1.events).toHaveLength(1)
    expect((merged.t1.events[0] as any).delta).toBe('hello world')
  })

  test('keeps live RuntimeEvents in semantic order when final assistant content arrives after tool start', () => {
    const timestamp = '2026-05-11T00:00:00.000Z'
    const withTool = appendRuntimeEvent({}, runtimeEvent({
      id: 'tool-start',
      type: 'tool.started',
      createdAt: timestamp,
      toolCallId: 'agent-tool-1',
      toolName: 'Agent',
      inputPreview: { description: 'write article' },
    }))
    const withLateFinal = appendRuntimeEvent(withTool, runtimeEvent({
      id: 'assistant-final',
      type: 'assistant.final',
      createdAt: timestamp,
      blocks: [{ type: 'text', text: 'handoff first' }],
    }))

    expect(withLateFinal['thread-1']?.events.map((event) => event.id)).toEqual([
      'assistant-final',
      'tool-start',
    ])
  })

  test('treats turn-limited RuntimeEvents as completed for UI state', () => {
    const state = appendRuntimeEvent({}, runtimeEvent({ type: 'run.turn_limited', reason: 'max turns' }))

    expect(state['thread-1']?.terminalStatus).toBe('completed')
  })

  test('deduplicates optimistic and sidecar submitted user RuntimeEvents', () => {
    const first = appendRuntimeEvent({}, runtimeEvent({
      id: 'optimistic',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:00.000Z',
    }))
    const next = appendRuntimeEvent(first, runtimeEvent({
      id: 'persisted',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:01.000Z',
    }))

    expect(next['thread-1']?.events).toEqual([
      expect.objectContaining({ id: 'optimistic', type: 'message.user.submitted', text: 'hello' }),
    ])
  })

  test('hydrates persisted RuntimeEvents into empty thread state', () => {
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: [
        runtimeEvent({ type: 'message.user.submitted', text: 'hi' }),
        runtimeEvent({ type: 'run.completed' }),
      ],
    }
    const hydrated = hydrateRuntimeEvents({}, result)

    expect(hydrated['thread-1']?.terminalStatus).toBe('completed')
    expect(hydrated['thread-1']?.events).toHaveLength(2)
  })

  test('hydrates memory context events before terminal events with the same timestamp', () => {
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: [
        runtimeEvent({ type: 'run.completed' }),
        runtimeEvent({
          type: 'memory.context.used',
          items: [{
            id: 'mem_1',
            kind: 'decision',
            scope: 'workspace',
            status: 'active',
            citation: '/tmp/memory/entries/mem_1.md',
            reason: 'matched memory entry',
          }],
          hidden: true,
        }),
      ],
    }

    const hydrated = hydrateRuntimeEvents({}, result)

    expect(hydrated['thread-1']?.events.map((event) => event.type)).toEqual([
      'memory.context.used',
      'run.completed',
    ])
  })

  test('keeps existing state when hydrated RuntimeEvents are structurally unchanged', () => {
    const events = [
      runtimeEvent({ id: 'user-1', type: 'message.user.submitted', text: 'hi' }),
      runtimeEvent({ id: 'done-1', type: 'run.completed' }),
    ]
    const prev = {
      'thread-1': {
        events,
        terminalStatus: 'completed' as const,
        updatedAt: 123,
      },
    }
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: events.map((event) => ({ ...event })),
    }

    expect(hydrateRuntimeEvents(prev, result)).toBe(prev)
  })

  test('hydrates missing persisted user events into existing live state', () => {
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: [
        runtimeEvent({ id: 'persisted-run', type: 'run.started' }),
        runtimeEvent({
          id: 'persisted-user',
          type: 'message.user.submitted',
          text: '帮我看看 download 目录下的文件',
          messageId: 'message-1',
          versionGroupId: 'group-1',
        }),
        runtimeEvent({ id: 'persisted-completed', type: 'run.completed' }),
      ],
    }
    const withLive = appendRuntimeEvent({}, runtimeEvent({ type: 'assistant.delta', delta: 'live' }))
    const hydrated = hydrateRuntimeEvents(withLive, result)

    expect(hydrated['thread-1']?.events.map((event) => event.type)).toEqual([
      'run.started',
      'message.user.submitted',
      'assistant.delta',
      'run.completed',
    ])
    expect(hydrated['thread-1']?.events[1]).toMatchObject({
      type: 'message.user.submitted',
      text: '帮我看看 download 目录下的文件',
      messageId: 'message-1',
      versionGroupId: 'group-1',
    })
    expect(hydrated['thread-1']?.terminalStatus).toBe('completed')
  })

  test('超过 MAX_EVENTS_PER_THREAD(100) 时裁剪到尾部并 rescue 最近一条 user 提交', () => {
    let state: Record<string, { events: LumeRuntimeEvent[] }> = {}
    // u0 必须与后续 deltas 同线程（t1），否则 rescue 分支无法被触发
    const u0 = {
      id: 'u0',
      type: 'message.user.submitted',
      threadId: 't1',
      runId: 'run-1',
      createdAt: '2026-06-21T00:00:00.000Z',
      text: 'hi',
    } as LumeRuntimeEvent
    state = appendRuntimeEvent(state, u0)
    // 120 条 distinct owner 的 assistant.delta（不同 messageId → 不合并 → 120 条独立事件）
    for (let i = 1; i <= 120; i++) {
      state = appendRuntimeEvent(
        state,
        deltaEvent(`d${i}`, i, `chunk${i}`, `2026-06-21T00:00:${String(i).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`, `msg-${i}`),
      )
    }
    // 121 事件 > 100 → trimRuntimeEvents 取 tail=slice(-100)（全部是 delta），
    // tail 内无 user submit → latestUserBeforeTail rescue 分支把 u0 提到头部 → [u0, ...99 deltas]
    expect(state.t1.events.length).toBeLessThanOrEqual(100)
    expect(state.t1.events[0].type).toBe('message.user.submitted')
    expect((state.t1.events[0] as any).text).toBe('hi')
  })
})

describe('appendRuntimeEvents (批量)', () => {
  test('批量追加的结果与逐个追加一致', () => {
    const batch = [
      deltaEvent('d1', 1, 'A', '2026-06-21T00:00:00.001Z'),
      deltaEvent('d2', 2, 'B', '2026-06-21T00:00:00.002Z'),
      deltaEvent('d3', 3, 'C', '2026-06-21T00:00:00.003Z'),
    ]
    const batched = appendRuntimeEvents({}, batch)
    let sequential: Record<string, { events: LumeRuntimeEvent[] }> = {}
    for (const e of batch) sequential = appendRuntimeEvent(sequential, e)
    expect((batched.t1.events[0] as any).delta).toBe('ABC')
    expect(batched.t1.events.length).toBe(sequential.t1.events.length)
    expect(batched.t1.terminalStatus).toBe(sequential.t1.terminalStatus)
  })
})
