import { beforeEach, describe, expect, test } from 'bun:test'
import { appendRuntimeEvent, appendRuntimeEvents, hydrateRuntimeEvents, removeRuntimeEvents, resetHydrateFingerprints } from './runtime-event-state'
import type { AgentThreadRuntimeEventsResult, LumeRuntimeEvent } from '@lume/shared'

// hydrate 入口指纹是模块级 Map，测试间共享会让同序列 persisted 的用例互相短路
beforeEach(() => {
  resetHydrateFingerprints()
})

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
      id: 'optimistic:thread-1:t0', runId: 'optimistic:thread-1:t0',
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
      expect.objectContaining({ id: 'persisted', type: 'message.user.submitted', text: 'hello' }),
    ])
  })

  test('deduplicates raw and model-expanded user events by messageId', () => {
    const state = appendRuntimeEvents({}, [
      runtimeEvent({
        id: 'raw',
        type: 'message.user.submitted',
        text: '继续',
        messageId: 'message-continue',
      }),
      runtimeEvent({
        id: 'runtime',
        type: 'message.user.submitted',
        text: '请继续完成上一轮未完成的原始任务。\n\n用户发送的继续指令：继续',
        messageId: 'message-continue',
        createdAt: '2026-05-11T00:00:01.000Z',
      }),
    ])

    expect(state['thread-1']?.events.filter((event) => event.type === 'message.user.submitted')).toEqual([
      expect.objectContaining({ id: 'raw', text: '继续', messageId: 'message-continue' }),
    ])
  })

  test('appendRuntimeEvent 全局去重 user submit：中间隔 delta 也不重复', () => {
    // 乐观追加后，后端先推 assistant.delta（使 acc.at(-1) 不再是 user submit），
    // 再推真实 user submit → 必须按全局去重，不能因 at(-1) 已变而重复。
    const first = appendRuntimeEvent({}, runtimeEvent({
      id: 'optimistic:thread-1:t0', runId: 'optimistic:thread-1:t0',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:00.000Z',
    }))
    const withDelta = appendRuntimeEvent(first, runtimeEvent({
      id: 'delta-1',
      type: 'assistant.delta',
      delta: 'response',
      createdAt: '2026-05-11T00:00:00.500Z',
    }))
    const next = appendRuntimeEvent(withDelta, runtimeEvent({
      id: 'persisted',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:01.000Z',
    }))

    const userSubmits = next['thread-1']?.events.filter((e) => e.type === 'message.user.submitted') ?? []
    expect(userSubmits).toHaveLength(1)
    expect(userSubmits[0]?.id).toBe('persisted')
  })

  test('appendRuntimeEvents 全局去重 user submit：批量内含 delta 也不重复', () => {
    // 乐观追加已在 atom，后端 rAF 批量推送 [assistant.delta, 真实 user submit]
    // → 必须按 acc 全局去重（真实路径：RUNTIME_EVENT 批量 flush）。
    const first = appendRuntimeEvent({}, runtimeEvent({
      id: 'optimistic:thread-1:t0', runId: 'optimistic:thread-1:t0',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:00.000Z',
    }))
    const next = appendRuntimeEvents(first, [
      runtimeEvent({ id: 'delta-1', type: 'assistant.delta', delta: 'response', createdAt: '2026-05-11T00:00:00.500Z' }),
      runtimeEvent({ id: 'persisted', type: 'message.user.submitted', text: 'hello', createdAt: '2026-05-11T00:00:01.000Z' }),
    ])

    const userSubmits = next['thread-1']?.events.filter((e) => e.type === 'message.user.submitted') ?? []
    expect(userSubmits).toHaveLength(1)
    expect(userSubmits[0]?.id).toBe('persisted')
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

  test('hydrate 同样受 MAX_EVENTS_PER_THREAD 上限约束', () => {
    // 重开超长线程：sidecar 返回全量持久化事件，hydrate 后也必须 ≤ MAX，
    // 与 append 路径上限一致（否则内存驻留无界，直到下一条 append 才触发 trim）。
    const events: LumeRuntimeEvent[] = [
      {
        id: 'u0',
        type: 'message.user.submitted',
        threadId: 'thread-1',
        runId: 'run-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        text: 'hi',
      } as LumeRuntimeEvent,
    ]
    for (let i = 1; i <= 2500; i++) {
      events.push({
        id: `d${i}`,
        type: 'assistant.delta',
        threadId: 'thread-1',
        runId: 'run-1',
        messageId: `msg-${i}`,
        sequence: i,
        createdAt: '2026-06-21T00:00:00.000Z',
        delta: `c${i}`,
      } as LumeRuntimeEvent)
    }
    const hydrated = hydrateRuntimeEvents({}, { threadId: 'thread-1', events })

    expect(hydrated['thread-1']?.events.length).toBeLessThanOrEqual(2000)
    expect(hydrated['thread-1']?.events[0]?.type).toBe('message.user.submitted')
  })

  test('hydrate 先合并相邻同流 delta 再 trim：同一条消息的分片回放不触发上限、正文完整', () => {
    // 回放路径没有 assistant.final，正文完全靠 delta 累积；若不先按 live 规则合并，
    // 逐 chunk 的回放计数会膨胀到上限，trim 丢头部 delta = 该 turn 渲染为空泡。
    const events: LumeRuntimeEvent[] = [
      {
        id: 'u0',
        type: 'message.user.submitted',
        threadId: 'thread-1',
        runId: 'run-1',
        createdAt: '2026-06-21T00:00:00.000Z',
        text: 'hi',
      } as LumeRuntimeEvent,
    ]
    let full = ''
    for (let i = 1; i <= 2500; i++) {
      events.push({
        id: `d${i}`,
        type: 'assistant.delta',
        threadId: 'thread-1',
        runId: 'run-1',
        messageId: 'msg-1',
        sequence: i,
        createdAt: '2026-06-21T00:00:00.000Z',
        delta: `c${i};`,
      } as LumeRuntimeEvent)
      full += `c${i};`
    }
    const hydrated = hydrateRuntimeEvents({}, { threadId: 'thread-1', events })

    const hydratedEvents = hydrated['thread-1']?.events ?? []
    expect(hydratedEvents.length).toBe(2)
    expect(hydratedEvents[1]?.type).toBe('assistant.delta')
    expect(hydratedEvents[1]?.delta).toBe(full)
    // 重开幂等：同样的回放再次 hydrate 不改变结果
    expect(hydrateRuntimeEvents(hydrated, { threadId: 'thread-1', events })).toBe(hydrated)
  })

  test('removeRuntimeEvents 删除线程条目；条目不存在时返回原引用', () => {
    const prev = appendRuntimeEvent({}, runtimeEvent({ type: 'run.completed' }))
    const next = removeRuntimeEvents(prev, 'thread-1')

    expect(next['thread-1']).toBeUndefined()
    expect(removeRuntimeEvents(next, 'thread-1')).toBe(next)
    expect(removeRuntimeEvents(next, 'other-thread')).toBe(next)
  })

  test('hydrate 入口指纹：同 persisted 重复拉取短路返回 prev 引用', () => {
    const events = [
      runtimeEvent({ id: 'p1', type: 'run.started' }),
      runtimeEvent({ id: 'p2', type: 'run.completed' }),
    ]
    const first = hydrateRuntimeEvents({}, { threadId: 'thread-1', events })
    expect(first['thread-1']?.events).toHaveLength(2)
    // 同 persisted 再拉（MESSAGE_APPENDED 每条消息都会触发）：直接短路
    expect(hydrateRuntimeEvents(first, { threadId: 'thread-1', events: events.map((e) => ({ ...e })) })).toBe(first)
  })

  test('hydrate 入口指纹：persisted 变化（追加）不被短路', () => {
    const first = hydrateRuntimeEvents({}, {
      threadId: 'thread-1',
      events: [runtimeEvent({ id: 'p1', type: 'run.started' })],
    })
    const second = hydrateRuntimeEvents(first, {
      threadId: 'thread-1',
      events: [
        runtimeEvent({ id: 'p1', type: 'run.started' }),
        runtimeEvent({ id: 'p2', type: 'run.completed' }),
      ],
    })
    expect(second).not.toBe(first)
    expect(second['thread-1']?.events).toHaveLength(2)
    expect(second['thread-1']?.terminalStatus).toBe('completed')
  })

  test('hydrate 入口指纹：removeRuntimeEvents 后同 persisted 重建，不被残留指纹短路', () => {
    const events = [runtimeEvent({ id: 'p1', type: 'run.started' })]
    const first = hydrateRuntimeEvents({}, { threadId: 'thread-1', events })
    const cleared = removeRuntimeEvents(first, 'thread-1')
    expect(cleared['thread-1']).toBeUndefined()

    const rebuilt = hydrateRuntimeEvents(cleared, { threadId: 'thread-1', events })
    expect(rebuilt).not.toBe(cleared)
    expect(rebuilt['thread-1']?.events).toHaveLength(1)
  })

  test('hydrate 入口指纹不破坏乐观 user → 投影 user 的等量替换语义', () => {
    // live 乐观 user（id=optimistic:*,假 runId）先在;persisted 投影 user(同 text)
    // 到达时必须替换为带 messageId/versionGroupId 的投影版——指纹只对 persisted 生效，
    // 首次到达必然 miss，替换照常发生。
    const optimistic = appendRuntimeEvent({}, runtimeEvent({
      id: 'optimistic:t1:1',
      runId: 'optimistic:t1:1',
      type: 'message.user.submitted',
      text: '帮我看看 download 目录',
      createdAt: '2026-05-11T00:10:00.000Z',
    }))
    const result: AgentThreadRuntimeEventsResult = {
      threadId: 'thread-1',
      events: [
        runtimeEvent({ id: 'run-1:message.user.submitted', type: 'run.started' }),
        runtimeEvent({
          id: 'run-1:user',
          type: 'message.user.submitted',
          text: '帮我看看 download 目录',
          messageId: 'message-1',
          versionGroupId: 'group-1',
          createdAt: '2026-05-11T00:10:01.000Z',
        }),
      ],
    }
    const hydrated = hydrateRuntimeEvents(optimistic, result)
    const userEvents = hydrated['thread-1']?.events.filter((event) => event.type === 'message.user.submitted') ?? []
    expect(userEvents).toHaveLength(1)
    expect(userEvents[0]).toMatchObject({ id: 'run-1:user', messageId: 'message-1', versionGroupId: 'group-1' })
    // 替换完成后同 persisted 再拉：短路
    expect(hydrateRuntimeEvents(hydrated, result)).toBe(hydrated)
  })

  test('超过 MAX_EVENTS_PER_THREAD 时优先丢头部 delta，保留结构事件与 user 提交', () => {
    let state: Record<string, { events: LumeRuntimeEvent[] }> = {}
    const u0 = {
      id: 'u0',
      type: 'message.user.submitted',
      threadId: 't1',
      runId: 'run-1',
      createdAt: '2026-06-21T00:00:00.000Z',
      text: 'hi',
    } as LumeRuntimeEvent
    state = appendRuntimeEvent(state, u0)
    // MAX+5 条 distinct owner 的 assistant.delta（不同 messageId → 不合并 → 独立事件）。
    // 用相同 createdAt + 递增 sequence 保证尾部有序，避免每次 append 触发全量 sort。
    const over = 2005
    for (let i = 1; i <= over; i++) {
      state = appendRuntimeEvent(
        state,
        deltaEvent(`d${i}`, i, `chunk${i}`, '2026-06-21T00:00:00.000Z', `msg-${i}`),
      )
    }
    // 1 + over 条事件 > MAX(2000) → trimRuntimeEvents 从头部丢 overflow 个 delta（可由 final 重建），
    // 结构事件全保留 → [u0, ...1999 deltas]，u0 仍在头部
    expect(state.t1.events.length).toBeLessThanOrEqual(2000)
    expect(state.t1.events[0].type).toBe('message.user.submitted')
    expect((state.t1.events[0] as any).text).toBe('hi')
  })

  test('结构事件超过 MAX 时尾部截断并 rescue 最近一条 user 提交', () => {
    // 无足够 delta 可丢时回退到尾部截断 + rescue：保留尾部 MAX 结构事件，
    // 并把截断点前最近的 user submit 提到头部作为会话起点锚点。
    let state: Record<string, { events: LumeRuntimeEvent[] }> = {}
    const u0 = {
      id: 'u0',
      type: 'message.user.submitted',
      threadId: 't1',
      runId: 'run-1',
      createdAt: '2026-06-21T00:00:00.000Z',
      text: 'hi',
    } as LumeRuntimeEvent
    state = appendRuntimeEvent(state, u0)
    // 2005 个结构事件（tool.started，不同 toolCallId，无 delta 可丢）→ 触发 rescue 分支
    for (let i = 1; i <= 2005; i++) {
      state = appendRuntimeEvent(state, runtimeEvent({
        id: `tool-${i}`,
        type: 'tool.started',
        threadId: 't1',
        toolCallId: `tc-${i}`,
        toolName: 'Read',
        createdAt: '2026-06-21T00:00:00.000Z',
      }))
    }
    expect(state.t1.events.length).toBeLessThanOrEqual(2000)
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

  test('批量也去重 optimistic 与 sidecar 的重复 user submit', () => {
    const optimistic = runtimeEvent({
      id: 'optimistic:thread-1:t0', runId: 'optimistic:thread-1:t0',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:00.000Z',
    })
    const persisted = runtimeEvent({
      id: 'persisted',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-05-11T00:00:01.000Z',
    })

    const batched = appendRuntimeEvents({}, [optimistic, persisted])

    let sequential: ReturnType<typeof appendRuntimeEvent> = {}
    sequential = appendRuntimeEvent(sequential, optimistic)
    sequential = appendRuntimeEvent(sequential, persisted)

    expect(batched['thread-1']?.events).toEqual([
      expect.objectContaining({ id: 'persisted', type: 'message.user.submitted', text: 'hello' }),
    ])
    expect(batched['thread-1']?.events.length).toBe(sequential['thread-1']?.events.length)
  })

  test('batch 内 user submit 被 delta 打断时与逐个追加一致（不误去重）', () => {
    const userA = runtimeEvent({
      id: 'u1',
      threadId: 't1',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-06-21T00:00:00.001Z',
    })
    const delta1 = deltaEvent('d1', 1, 'x', '2026-06-21T00:00:00.002Z')
    const userApersisted = runtimeEvent({
      id: 'u2',
      threadId: 't1',
      type: 'message.user.submitted',
      text: 'hello',
      createdAt: '2026-06-21T00:00:00.003Z',
    })

    const batched = appendRuntimeEvents({}, [userA, delta1, userApersisted])

    let sequential: ReturnType<typeof appendRuntimeEvent> = {}
    sequential = appendRuntimeEvent(sequential, userA)
    sequential = appendRuntimeEvent(sequential, delta1)
    sequential = appendRuntimeEvent(sequential, userApersisted)

    expect(batched.t1.events.length).toBe(sequential.t1.events.length)
  })
})

describe('runtime-event-state #414 同文本快速重发', () => {
  // 生产形态：乐观事件无 messageId；权威事件 id 为 `${runId}:message.user.submitted`
  function optimisticSubmit(text: string, createdAt: string, seq: number): LumeRuntimeEvent {
    return {
      id: `optimistic:thread-1:${createdAt}`,
      type: 'message.user.submitted',
      threadId: 'thread-1',
      runId: `optimistic:thread-1:${createdAt}`,
      createdAt,
      text,
    } as LumeRuntimeEvent
  }
  function persistedSubmit(text: string, createdAt: string, seq: number): LumeRuntimeEvent {
    return {
      id: `run-${seq}:message.user.submitted`,
      type: 'message.user.submitted',
      threadId: 'thread-1',
      runId: `run-${seq}`,
      createdAt,
      text,
    } as LumeRuntimeEvent
  }

  test('30 秒内重发同文本：第二条乐观与第二条权威都存活', () => {
    let state = appendRuntimeEvent({}, optimisticSubmit('继续', '2026-05-11T00:00:00.000Z', 0))
    state = appendRuntimeEvent(state, persistedSubmit('继续', '2026-05-11T00:00:01.000Z', 1))
    state = appendRuntimeEvent(state, optimisticSubmit('继续', '2026-05-11T00:00:10.000Z', 0))
    state = appendRuntimeEvent(state, persistedSubmit('继续', '2026-05-11T00:00:11.000Z', 2))

    const submits = state['thread-1']?.events.filter((e) => e.type === 'message.user.submitted') ?? []
    expect(submits.map((e) => e.id)).toEqual([
      'run-1:message.user.submitted',
      'run-2:message.user.submitted',
    ])
  })

  test('权威未到达前两次乐观同文本都保留', () => {
    let state = appendRuntimeEvent({}, optimisticSubmit('继续', '2026-05-11T00:00:00.000Z', 0))
    state = appendRuntimeEvent(state, optimisticSubmit('继续', '2026-05-11T00:00:10.000Z', 0))

    const submits = state['thread-1']?.events.filter((e) => e.type === 'message.user.submitted') ?? []
    expect(submits.length).toBe(2)
  })

  test('乐观后到且权威已在窗口内同文本 → 乐观跳过', () => {
    let state = appendRuntimeEvent({}, persistedSubmit('继续', '2026-05-11T00:00:01.000Z', 1))
    state = appendRuntimeEvent(state, optimisticSubmit('继续', '2026-05-11T00:00:00.000Z', 0))

    const submits = state['thread-1']?.events.filter((e) => e.type === 'message.user.submitted') ?? []
    expect(submits.map((e) => e.id)).toEqual(['run-1:message.user.submitted'])
  })

  test('hydrate 合并：持久层双权威 + live 双乐观 → 只剩权威两条', () => {
    const persisted = [
      persistedSubmit('继续', '2026-05-11T00:00:01.000Z', 1),
      persistedSubmit('继续', '2026-05-11T00:00:11.000Z', 2),
    ]
    const live = [
      optimisticSubmit('继续', '2026-05-11T00:00:00.000Z', 0),
      optimisticSubmit('继续', '2026-05-11T00:00:10.000Z', 0),
    ]
    const state = hydrateRuntimeEvents({}, { threadId: 'thread-1', events: persisted } as AgentThreadRuntimeEventsResult)
    const merged = hydrateRuntimeEvents(state, { threadId: 'thread-1', events: persisted } as AgentThreadRuntimeEventsResult)

    // live 乐观经 append 进入后与 persisted 权威合并
    let withLive = appendRuntimeEvent(merged, live[0])
    withLive = appendRuntimeEvent(withLive, live[1])
    const submits = withLive['thread-1']?.events.filter((e) => e.type === 'message.user.submitted') ?? []
    expect(submits.map((e) => e.id)).toEqual([
      'run-1:message.user.submitted',
      'run-2:message.user.submitted',
    ])
  })
})

describe('runtime-event-state tool.output 快照替换', () => {
  function toolOutput(id: string, chunk: string, createdAt: string): LumeRuntimeEvent {
    return runtimeEvent({ id, type: 'tool.output', toolCallId: 'toolu_1', chunk, createdAt }) as LumeRuntimeEvent
  }

  test('同一稳定 id 的连续快照原地替换，数组长度恒为 1', () => {
    let state = appendRuntimeEvent({}, toolOutput('run-1:tool-output:toolu_1', 'tail v1', '2026-05-11T00:00:01.000Z'))
    state = appendRuntimeEvent(state, toolOutput('run-1:tool-output:toolu_1', 'tail v2', '2026-05-11T00:00:02.000Z'))
    state = appendRuntimeEvent(state, toolOutput('run-1:tool-output:toolu_1', 'tail v3', '2026-05-11T00:00:03.000Z'))

    const events = state['thread-1']?.events ?? []
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'tool.output', chunk: 'tail v3' })
  })

  test('其他事件插队后仍能命中替换（非 tail-only），不同 toolCallId 不互串', () => {
    let state = appendRuntimeEvent({}, toolOutput('run-1:tool-output:toolu_1', 'v1', '2026-05-11T00:00:01.000Z'))
    state = appendRuntimeEvent(state, runtimeEvent({
      id: 'progress-1', type: 'task.progress', taskId: 'bg-1', progress: {},
      createdAt: '2026-05-11T00:00:02.000Z',
    }) as LumeRuntimeEvent)
    // 第二个工具调用的快照独立成条
    state = appendRuntimeEvent(state, toolOutput('run-1:tool-output:toolu_2', 'other v1', '2026-05-11T00:00:03.000Z'))
    state = appendRuntimeEvent(state, toolOutput('run-1:tool-output:toolu_1', 'v2', '2026-05-11T00:00:04.000Z'))

    const events = state['thread-1']?.events ?? []
    const outputs = events.filter((e) => e.type === 'tool.output')
    expect(outputs).toHaveLength(2)
    expect(outputs.map((e) => (e as Extract<LumeRuntimeEvent, { type: 'tool.output' }>).chunk)).toEqual(['v2', 'other v1'])
  })
})
