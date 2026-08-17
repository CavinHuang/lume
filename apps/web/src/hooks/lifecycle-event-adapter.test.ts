import { test, expect } from 'bun:test'
import type { LumeRuntimeEvent, SdkLifecycleDetail, SdkEventEnvelope } from '@lume/shared'
import {
  adaptLifecycleEvent,
  consumeBusEnvelope,
  createLifecycleAdapterState,
  type BusEnvelopeConsumerContext,
} from './lifecycle-event-adapter'

const TS = 1_723_680_000_000

function envelope(
  seq: number,
  kind: SdkEventEnvelope['kind'],
  phase: SdkEventEnvelope['phase'],
  turnId: string | null,
  detail: SdkLifecycleDetail,
): SdkEventEnvelope {
  return { v: 1, seq, threadId: 't1', runId: 'r1', turnId, ts: TS + seq, kind, phase, detail }
}

function messageStart(seq: number) {
  return envelope(seq, 'message', 'start', 'turn-1', { type: 'message.start' })
}

function messageUpdate(seq: number, text: string) {
  return envelope(seq, 'message', 'update', 'turn-1', {
    type: 'message.update',
    delta: null,
    partial: { text, toolUses: [] },
  })
}

function messageEnd(seq: number, content: unknown[]) {
  return envelope(seq, 'message', 'end', 'turn-1', {
    type: 'message.end',
    message: { role: 'assistant', content },
  })
}

function runEnd(seq: number, detail: Partial<Extract<SdkLifecycleDetail, { type: 'run.end' }>>) {
  return envelope(seq, 'run', 'end', null, {
    type: 'run.end',
    stopReason: null,
    isError: false,
    numTurns: 1,
    ...detail,
  })
}

function toolStart(seq: number) {
  return envelope(seq, 'tool', 'start', 'turn-1', {
    type: 'tool.start',
    toolCallId: 'call-1',
    toolName: 'Bash',
    input: { command: 'ls' },
  })
}

function toolEnd(seq: number, detail: Partial<Extract<SdkLifecycleDetail, { type: 'tool.end' }>> = {}) {
  return envelope(seq, 'tool', 'end', 'turn-1', {
    type: 'tool.end',
    toolCallId: 'call-1',
    toolName: 'Bash',
    isError: false,
    output: 'done',
    ...detail,
  })
}

test('message.update 求差:he → hello 只投增量 llo', () => {
  const state = createLifecycleAdapterState()
  adaptLifecycleEvent(messageStart(1), state)

  const first = adaptLifecycleEvent(messageUpdate(2, 'he'), state)
  expect(first).toEqual([{
    id: 'lifecycle:2:assistant.delta',
    type: 'assistant.delta',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 2).toISOString(),
    delta: 'he',
  }])

  const second = adaptLifecycleEvent(messageUpdate(3, 'hello'), state)
  expect(second[0]?.type).toBe('assistant.delta')
  expect((second[0] as { delta: string }).delta).toBe('llo')

  // 文本无变化时不产事件
  expect(adaptLifecycleEvent(messageUpdate(4, 'hello'), state)).toEqual([])
})

test('message.end 映射 assistant.final:仅保留非空 text/thinking 块', () => {
  const state = createLifecycleAdapterState()
  adaptLifecycleEvent(messageStart(1), state)
  adaptLifecycleEvent(messageUpdate(2, 'hi'), state)

  const events = adaptLifecycleEvent(messageEnd(3, [
    { type: 'text', text: 'hi' },
    { type: 'thinking', thinking: 'let me think' },
    { type: 'text', text: '   ' },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} },
  ]), state)

  expect(events).toEqual([{
    id: 'lifecycle:3:assistant.final',
    type: 'assistant.final',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 3).toISOString(),
    blocks: [
      { type: 'text', text: 'hi' },
      { type: 'thinking', text: 'let me think' },
    ],
  }])

  // 无可渲染块时不产事件
  expect(adaptLifecycleEvent(messageEnd(4, [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }]), state)).toEqual([])
})

test('run.end 三分支:isError → failed;max_turns → turn_limited;正常 → completed', () => {
  const state = createLifecycleAdapterState()

  const failed = adaptLifecycleEvent(runEnd(1, { stopReason: 'error_during_execution', isError: true }), state)
  expect(failed).toEqual([{
    id: 'lifecycle:1:run.failed',
    type: 'run.failed',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 1).toISOString(),
    error: { code: 'runtime_error', message: 'error_during_execution' },
  }])

  // max_turns 优先于 isError(error_max_turns 前缀使 isError 为 true)
  const limited = adaptLifecycleEvent(runEnd(2, { stopReason: 'error_max_turns', isError: true, numTurns: 50 }), state)
  expect(limited[0]?.type).toBe('run.turn_limited')

  const completed = adaptLifecycleEvent(runEnd(3, { stopReason: 'end_turn' }), state)
  expect(completed).toEqual([{
    id: 'lifecycle:3:run.completed',
    type: 'run.completed',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 3).toISOString(),
  }])
})

test('run.end stopReason=aborted 不产事件(中止由旧路 run.cancelled 承担,避免双终态)', () => {
  const state = createLifecycleAdapterState()
  expect(adaptLifecycleEvent(runEnd(1, { stopReason: 'aborted' }), state)).toEqual([])
})

test('tool.start 映射 tool.started:字段对齐旧路(inputPreview=input,riskLevel 省略)', () => {
  const state = createLifecycleAdapterState()
  const events = adaptLifecycleEvent(toolStart(2), state)
  expect(events).toEqual([{
    id: 'lifecycle:2:tool.started',
    type: 'tool.started',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 2).toISOString(),
    toolCallId: 'call-1',
    toolName: 'Bash',
    inputPreview: { command: 'ls' },
  }])
})

test('tool.end 成功 → tool.completed(resultPreview=output;execution/resultRef 减配批次2.1)', () => {
  const state = createLifecycleAdapterState()
  const events = adaptLifecycleEvent(toolEnd(3), state)
  expect(events).toEqual([{
    id: 'lifecycle:3:tool.completed',
    type: 'tool.completed',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 3).toISOString(),
    toolCallId: 'call-1',
    toolName: 'Bash',
    resultPreview: 'done',
  }])
})

test('tool.end 失败 → tool.failed(error.code=tool_error,message=output)', () => {
  const state = createLifecycleAdapterState()
  const events = adaptLifecycleEvent(toolEnd(4, { isError: true, output: 'boom' }), state)
  expect(events).toEqual([{
    id: 'lifecycle:4:tool.failed',
    type: 'tool.failed',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 4).toISOString(),
    toolCallId: 'call-1',
    toolName: 'Bash',
    error: { code: 'tool_error', message: 'boom' },
  }])
})

test('message.start / turn.* / run.start / 未知事件不产 RuntimeEvent', () => {
  const state = createLifecycleAdapterState()
  expect(adaptLifecycleEvent(messageStart(1), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(2, 'turn', 'start', 'turn-1', { type: 'turn.start' }), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(3, 'turn', 'end', 'turn-1', {
    type: 'turn.end',
    assistantMessage: { role: 'assistant', content: [] },
    toolResults: [],
  }), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(4, 'run', 'start', null, { type: 'run.start' }), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(5, 'tool', 'event', 'turn-1', { type: 'tool.unknown' } as unknown as SdkLifecycleDetail), state)).toEqual([])
})

test('message.start 重置求差基线:新 message 从零开始', () => {
  const state = createLifecycleAdapterState()
  adaptLifecycleEvent(messageStart(1), state)
  adaptLifecycleEvent(messageUpdate(2, 'hello'), state)
  adaptLifecycleEvent(messageEnd(3, [{ type: 'text', text: 'hello' }]), state)

  // 下一轮 message(turn-2)重新从空累计
  adaptLifecycleEvent(envelope(4, 'message', 'start', 'turn-2', { type: 'message.start' }), state)
  const events = adaptLifecycleEvent(envelope(5, 'message', 'update', 'turn-2', {
    type: 'message.update',
    delta: null,
    partial: { text: 'next', toolUses: [] },
  }), state)
  expect((events[0] as { delta: string }).delta).toBe('next')
})

test('memory.context.used 领域事件映射:字段等价旧路,items 引用透传', () => {
  const state = createLifecycleAdapterState()
  const items = [
    { id: 'm1', kind: 'preference', scope: 'global', status: 'active', citation: 'mem#L1', reason: 'match' },
    // claim 实际是对象(detail 标注为 string 不符):透传无损断言
    { id: 'm2', kind: 'fact', scope: 'workspace', status: 'suspected_stale', citation: 'mem#L2', claim: { text: 'x' } as unknown as string },
  ]
  const events = adaptLifecycleEvent(envelope(7, 'run', 'event', null, { type: 'memory.context.used', items }), state)
  expect(events).toEqual([{
    id: 'lifecycle:7:memory.context.used',
    type: 'memory.context.used',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 7).toISOString(),
    items,
  }])
  expect((events[0] as { items: unknown }).items).toBe(items) // 引用透传,不拷贝
  // 无状态分支:不触碰求差基线
  expect(state.turnId).toBe(null)
  expect(state.lastText).toBe('')
})

test('未迁移的领域事件(memory.changed 等未知 detail)仍忽略', () => {
  const state = createLifecycleAdapterState()
  expect(adaptLifecycleEvent(envelope(8, 'run', 'event', null, { type: 'memory.changed' } as unknown as SdkLifecycleDetail), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(9, 'run', 'event', null, { type: 'memory.job.progress' } as unknown as SdkLifecycleDetail), state)).toEqual([])
})

// ── consumeBusEnvelope:总线消费副作用(seq 去重 / snapshot 不入队不置位 / push 全量) ──

function createContext() {
  const ctx: BusEnvelopeConsumerContext & {
    enqueued: LumeRuntimeEvent[]
    streaming: Record<string, 'idle' | 'streaming' | 'errored'>
    errors: Record<string, string>
  } = {
    deliveredSeqByThread: new Map(),
    adapterStatesByThread: new Map(),
    enqueued: [],
    streaming: {},
    errors: {},
    enqueueRuntimeEvent: (event) => ctx.enqueued.push(event),
    setStreamingStates: (update) => { ctx.streaming = update(ctx.streaming) },
    setErrorMessages: (update) => { ctx.errors = update(ctx.errors) },
  }
  return ctx
}

test('snapshot 回放不入队、不置 streaming(重载/切回不与旧路双份注入)', () => {
  const ctx = createContext()
  consumeBusEnvelope(messageStart(1), 'snapshot', ctx)
  consumeBusEnvelope(messageUpdate(2, 'hello'), 'snapshot', ctx)
  consumeBusEnvelope(messageEnd(3, [{ type: 'text', text: 'hello' }]), 'snapshot', ctx)
  expect(ctx.enqueued).toEqual([])
  expect(ctx.streaming).toEqual({})
})

test('snapshot 仍推进适配器基线:后续 push 只投增量(不与旧路已渲染文本叠加)', () => {
  const ctx = createContext()
  consumeBusEnvelope(messageStart(1), 'snapshot', ctx)
  consumeBusEnvelope(messageUpdate(2, 'hel'), 'snapshot', ctx)
  consumeBusEnvelope(messageUpdate(3, 'hello'), 'push', ctx)
  expect(ctx.enqueued).toEqual([expect.objectContaining({ type: 'assistant.delta', delta: 'lo' })])
  expect(ctx.streaming).toEqual({ t1: 'streaming' })
})

test('push 全量副作用:delta 入队并置 streaming;run.completed 置 idle', () => {
  const ctx = createContext()
  consumeBusEnvelope(messageStart(1), 'push', ctx)
  consumeBusEnvelope(messageUpdate(2, 'hi'), 'push', ctx)
  expect(ctx.enqueued).toEqual([expect.objectContaining({ type: 'assistant.delta', delta: 'hi' })])
  expect(ctx.streaming).toEqual({ t1: 'streaming' })

  consumeBusEnvelope(runEnd(3, { stopReason: 'end_turn' }), 'push', ctx)
  expect(ctx.streaming).toEqual({ t1: 'idle' })
})

test('push run.failed 置 errored 并写错误信息', () => {
  const ctx = createContext()
  consumeBusEnvelope(runEnd(1, { stopReason: 'error_during_execution', isError: true }), 'push', ctx)
  expect(ctx.streaming).toEqual({ t1: 'errored' })
  expect(ctx.errors).toEqual({ t1: 'error_during_execution' })
})

test('seq 水位去重:同线程重复/回退 seq 不重复消费', () => {
  const ctx = createContext()
  consumeBusEnvelope(messageUpdate(2, 'a'), 'push', ctx)
  consumeBusEnvelope(messageUpdate(2, 'a'), 'push', ctx) // 重复
  consumeBusEnvelope(messageUpdate(1, 'a'), 'push', ctx) // 回退
  expect(ctx.enqueued).toHaveLength(1)
})

test('快照路径悬空 run(有 message.update 无 run.end)不置 streaming', () => {
  const ctx = createContext()
  consumeBusEnvelope(messageStart(1), 'snapshot', ctx)
  consumeBusEnvelope(messageUpdate(2, 'partial'), 'snapshot', ctx)
  // 无后续任何 push:线程不得停留在流式态
  expect(ctx.streaming).toEqual({})
})
