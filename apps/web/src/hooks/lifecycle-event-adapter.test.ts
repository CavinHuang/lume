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

function messageUpdate(seq: number, text: string, thinking = '') {
  return envelope(seq, 'message', 'update', 'turn-1', {
    type: 'message.update',
    delta: null,
    partial: { text, thinking, toolUses: [] },
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

test('run.end stopReason=aborted → run.cancelled(批次5 翻转:projector 已补流中止终值)', () => {
  const state = createLifecycleAdapterState()
  expect(adaptLifecycleEvent(runEnd(1, { stopReason: 'aborted' }), state)).toEqual([{
    id: 'lifecycle:1:run.cancelled',
    type: 'run.cancelled',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 1).toISOString(),
  }])
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

test('message.start / turn.* / 未知事件不产 RuntimeEvent(run.start 已翻转,见批次5 块)', () => {
  const state = createLifecycleAdapterState()
  expect(adaptLifecycleEvent(messageStart(1), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(2, 'turn', 'start', 'turn-1', { type: 'turn.start' }), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(3, 'turn', 'end', 'turn-1', {
    type: 'turn.end',
    assistantMessage: { role: 'assistant', content: [] },
    toolResults: [],
  }), state)).toEqual([])
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

// ── 批次4:background.task / context.compaction 领域事件映射 ──

function backgroundTask(seq: number, detail: Partial<Extract<SdkLifecycleDetail, { type: 'background.task' }>> = {}) {
  return envelope(seq, 'run', 'event', null, {
    type: 'background.task',
    taskId: 'job-1',
    status: 'completed',
    ...detail,
  })
}

function compaction(seq: number, detail: Partial<Extract<SdkLifecycleDetail, { type: 'context.compaction' }>>) {
  return envelope(seq, 'run', 'event', null, {
    type: 'context.compaction',
    phase: 'started',
    ...detail,
  })
}

test('background.task → background.task.completed:字段对齐旧路(taskId/status/message/summary/execution)', () => {
  const state = createLifecycleAdapterState()
  const events = adaptLifecycleEvent(backgroundTask(11, {
    status: 'failed',
    message: 'boom',
    summary: 'did things',
    execution: { durationMs: 12 },
  }), state)
  expect(events).toEqual([{
    id: 'lifecycle:11:background.task.completed',
    type: 'background.task.completed',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 11).toISOString(),
    taskId: 'job-1',
    status: 'failed',
    message: 'boom',
    summary: 'did things',
    execution: { durationMs: 12 },
  }])
  // 可选字段缺省时省略
  expect(adaptLifecycleEvent(backgroundTask(12), state)).toEqual([expect.objectContaining({
    type: 'background.task.completed',
    taskId: 'job-1',
    status: 'completed',
  })])
  expect(Object.keys(adaptLifecycleEvent(backgroundTask(13), state)[0] as object))
    .not.toContain('message')
})

test('context.compaction 三态 → 旧路同形 RuntimeEvent:默认值补齐 + preTokens/postTokens 透传', () => {
  const state = createLifecycleAdapterState()
  const base = {
    threadId: 't1',
    runId: 'r1',
    trigger: 'auto',
    preTokens: 1000,
    policy: 'sdk-default',
    source: 'agent-sdk',
  }

  expect(adaptLifecycleEvent(compaction(21, { phase: 'started', preTokens: 1000 }), state)).toEqual([{
    id: 'lifecycle:21:context.compaction.started',
    type: 'context.compaction.started',
    createdAt: new Date(TS + 21).toISOString(),
    ...base,
  }])

  // progress:progress 做旧路 clampProgress 防御复制(147 → 100);stage 用旧路默认值
  expect(adaptLifecycleEvent(compaction(22, { phase: 'progress', preTokens: 1000, progress: 147 }), state)).toEqual([{
    id: 'lifecycle:22:context.compaction.progress',
    type: 'context.compaction.progress',
    createdAt: new Date(TS + 22).toISOString(),
    ...base,
    stage: 'summarizing',
    progress: 100,
  }])
  expect(adaptLifecycleEvent(compaction(23, { phase: 'progress', preTokens: 1000, progress: -5 }), state))
    .toEqual([expect.objectContaining({ progress: 0 })])

  expect(adaptLifecycleEvent(compaction(24, {
    phase: 'completed', preTokens: 1000, postTokens: 200,
  }), state)).toEqual([{
    id: 'lifecycle:24:context.compaction.completed',
    type: 'context.compaction.completed',
    createdAt: new Date(TS + 24).toISOString(),
    ...base,
    outcome: 'succeeded',
    postTokens: 200,
  }])
  // completed 无 postTokens(压缩失败路径):字段省略,不落默认 0
  const failed = adaptLifecycleEvent(compaction(25, { phase: 'completed', preTokens: 1000 }), state)
  expect(Object.keys(failed[0] as object)).not.toContain('postTokens')
})

test('consumeBusEnvelope streaming 副作用:background.task completed→idle、failed→errored(对齐旧路映射)', () => {
  const ctx = createContext()
  consumeBusEnvelope(backgroundTask(1, { status: 'completed' }), 'push', ctx)
  expect(ctx.enqueued.map((event) => event.type)).toEqual(['background.task.completed'])
  expect(ctx.streaming).toEqual({ t1: 'idle' })

  consumeBusEnvelope(backgroundTask(2, { status: 'failed' }), 'push', ctx)
  expect(ctx.streaming).toEqual({ t1: 'errored' })

  // snapshot 版维持既有语义:不入队、不置位
  const snapshotCtx = createContext()
  consumeBusEnvelope(backgroundTask(1, { status: 'completed' }), 'snapshot', snapshotCtx)
  expect(snapshotCtx.enqueued).toEqual([])
  expect(snapshotCtx.streaming).toEqual({})
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

test('run.failed 错误文案优先取 detail.result(F3 fix round 1)', () => {
  const ctx = createContext()
  // F3 补发终值:stopReason='error',真实错误信息在 result
  consumeBusEnvelope(runEnd(1, { stopReason: 'error', isError: true, result: 'session boom' }), 'push', ctx)
  expect(ctx.errors).toEqual({ t1: 'session boom' })
  // 无 result 时回落 stopReason(现存 isError 路径,endRun 不产 result)
  const ctx2 = createContext()
  consumeBusEnvelope(runEnd(1, { stopReason: 'error_during_execution', isError: true }), 'push', ctx2)
  expect(ctx2.errors).toEqual({ t1: 'error_during_execution' })
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

// ── 批次5:thinking 折叠 / run.started·run.cancelled 翻转 / 领域事件全量 / 减配补齐 ──

test('message.update thinking 求差:partial.thinking 折叠累计,只投增量(批次5)', () => {
  const state = createLifecycleAdapterState()
  adaptLifecycleEvent(messageStart(1), state)

  const first = adaptLifecycleEvent(messageUpdate(2, '', 'let me '), state)
  expect(first).toEqual([{
    id: 'lifecycle:2:assistant.thinking_delta',
    type: 'assistant.thinking_delta',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 2).toISOString(),
    delta: 'let me ',
  }])

  // 同一 update 内 thinking 与 text 各投一条,thinking 在前(块序对齐旧路折叠形态)
  const both = adaptLifecycleEvent(messageUpdate(3, 'think', 'let me think'), state)
  expect(both.map((event) => event.type)).toEqual(['assistant.thinking_delta', 'assistant.delta'])
  expect((both[0] as { delta: string }).delta).toBe('think')
  expect((both[1] as { delta: string }).delta).toBe('think')

  // 均无变化时不产事件
  expect(adaptLifecycleEvent(messageUpdate(4, 'think', 'let me think'), state)).toEqual([])
})

test('run.start → run.started:翻转此前"不产"分支(工作区/模型三元组减配)', () => {
  const state = createLifecycleAdapterState()
  expect(adaptLifecycleEvent(envelope(1, 'run', 'start', null, { type: 'run.start' }), state)).toEqual([{
    id: 'lifecycle:1:run.started',
    type: 'run.started',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 1).toISOString(),
  }])
})

test('consumeBusEnvelope run.cancelled 置 idle 并触发 onRunCancelled(snapshot 不触发)', () => {
  const ctx = createContext()
  const cancelled: string[] = []
  ctx.onRunCancelled = (threadId) => cancelled.push(threadId)
  consumeBusEnvelope(runEnd(1, { stopReason: 'aborted' }), 'push', ctx)
  expect(ctx.enqueued.map((event) => event.type)).toEqual(['run.cancelled'])
  expect(ctx.streaming).toEqual({ t1: 'idle' })
  expect(cancelled).toEqual(['t1'])

  const snapshotCtx = createContext()
  snapshotCtx.onRunCancelled = (threadId) => cancelled.push(threadId)
  consumeBusEnvelope(runEnd(1, { stopReason: 'aborted' }), 'snapshot', snapshotCtx)
  expect(snapshotCtx.enqueued).toEqual([])
  expect(snapshotCtx.streaming).toEqual({})
  expect(cancelled).toEqual(['t1'])
})

test('todo.state → todo.state_updated:载荷同引用透传', () => {
  const state = createLifecycleAdapterState()
  const todos = [{ content: '写测试', activeForm: '写测试中', status: 'in_progress' }]
  const payload = { todos, currentActiveForm: '写测试中' }
  const events = adaptLifecycleEvent(envelope(1, 'run', 'event', null, { type: 'todo.state', state: payload }), state)
  expect(events).toEqual([{
    id: 'lifecycle:1:todo.state_updated',
    type: 'todo.state_updated',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 1).toISOString(),
    todos,
    currentActiveForm: '写测试中',
  }])
  expect((events[0] as { todos: unknown }).todos).toBe(todos)
})

test('advisor.reviewed → 旧路同形:severity 白名单外丢弃,summary/modelRef 用旧路默认值', () => {
  const state = createLifecycleAdapterState()
  const events = adaptLifecycleEvent(envelope(1, 'run', 'event', null, {
    type: 'advisor.reviewed',
    review: { severity: 'concern', summary: '注意边界', details: '见详情', modelRef: 'model-x', durationMs: 42 },
  }), state)
  expect(events).toEqual([{
    id: 'lifecycle:1:advisor.reviewed',
    type: 'advisor.reviewed',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 1).toISOString(),
    severity: 'concern',
    summary: '注意边界',
    details: '见详情',
    modelRef: 'model-x',
    durationMs: 42,
  }])

  // severity 不在旧路白名单 → 整体丢弃(对齐 run-item-events gate)
  expect(adaptLifecycleEvent(envelope(2, 'run', 'event', null, {
    type: 'advisor.reviewed',
    review: { severity: 'meh' },
  }), state)).toEqual([])

  const fallback = adaptLifecycleEvent(envelope(3, 'run', 'event', null, {
    type: 'advisor.reviewed',
    review: { severity: 'clear' },
  }), state)
  expect(fallback[0]).toMatchObject({ summary: 'Advisor review completed', modelRef: 'unknown' })
  expect(Object.keys(fallback[0] as object)).not.toContain('details')
  expect(Object.keys(fallback[0] as object)).not.toContain('durationMs')
})

test('lsp.diagnostics → lsp.diagnostics.updated:字段逐字对齐;filePath/sha256 缺失丢弃', () => {
  const state = createLifecycleAdapterState()
  const diagnostics = {
    servers: ['tsserver'],
    total: 2,
    errors: 1,
    warnings: 1,
    truncated: false,
    items: [{ message: 'TS2304', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }],
  }
  const events = adaptLifecycleEvent(envelope(1, 'run', 'event', null, {
    type: 'lsp.diagnostics',
    filePath: 'src/a.ts',
    mutationVersion: 3,
    sha256: 'abc',
    delayed: true,
    toolUseId: 'call-9',
    diagnostics,
  }), state)
  expect(events).toEqual([{
    id: 'lifecycle:1:lsp.diagnostics.updated',
    type: 'lsp.diagnostics.updated',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 1).toISOString(),
    toolUseId: 'call-9',
    filePath: 'src/a.ts',
    mutationVersion: 3,
    sha256: 'abc',
    delayed: true,
    diagnostics,
  }])
  expect((events[0] as { diagnostics: unknown }).diagnostics).toBe(diagnostics)

  expect(adaptLifecycleEvent(envelope(2, 'run', 'event', null, {
    type: 'lsp.diagnostics',
    filePath: '',
    mutationVersion: 0,
    sha256: 'x',
    delayed: false,
    diagnostics,
  }), state)).toEqual([])
})

test('coding.report → coding.report.updated:report 同引用透传', () => {
  const state = createLifecycleAdapterState()
  const report = {
    status: 'verified' as const,
    workspaceChanged: true,
    changedFiles: ['a.ts'],
    externalChangedFiles: [],
    pendingBackground: false,
  }
  const events = adaptLifecycleEvent(envelope(1, 'run', 'event', null, { type: 'coding.report', report }), state)
  expect(events).toEqual([{
    id: 'lifecycle:1:coding.report.updated',
    type: 'coding.report.updated',
    threadId: 't1',
    runId: 'r1',
    createdAt: new Date(TS + 1).toISOString(),
    codingReport: report,
  }])
  expect((events[0] as { codingReport: unknown }).codingReport).toBe(report)
})

test('批次5 裁定不映射:user.message / plan.preview / task.progress 不产事件', () => {
  const state = createLifecycleAdapterState()
  expect(adaptLifecycleEvent(envelope(1, 'message', 'end', null, { type: 'user.message', content: 'hi' }), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(2, 'run', 'event', null, { type: 'plan.preview', content: {} }), state)).toEqual([])
  expect(adaptLifecycleEvent(envelope(3, 'run', 'event', null, {
    type: 'task.progress',
    taskId: 'bg-1',
    progress: { description: 'working' },
  }), state)).toEqual([])
})

test('compaction 减配补齐:outcome←isError,trigger 真值透传(批次5)', () => {
  const state = createLifecycleAdapterState()
  expect(adaptLifecycleEvent(compaction(31, {
    phase: 'completed', preTokens: 1000, postTokens: 200, trigger: 'manual', isError: true,
  }), state)).toEqual([expect.objectContaining({
    type: 'context.compaction.completed',
    trigger: 'manual',
    outcome: 'failed',
    postTokens: 200,
  })])
  expect(adaptLifecycleEvent(compaction(32, { phase: 'completed', preTokens: 1000 }), state))
    .toEqual([expect.objectContaining({ trigger: 'auto', outcome: 'succeeded' })])
})

test('tool.end meta.execution → execution/resultRef(批次2.1 补;web 最小归一)', () => {
  const state = createLifecycleAdapterState()
  const execution = {
    version: 2,
    outcome: 'succeeded',
    durationMs: 120,
    command: 'bun test',
    shell: 'bash',
    terminationReason: 'completed',
    resultRef: { kind: 'file', path: 'out/big.txt', size: 9999, mimeType: 'text/plain' },
    stdoutPreview: 'ok',
  }
  const completed = adaptLifecycleEvent(toolEnd(3, { meta: { execution } }), state)[0] as Extract<LumeRuntimeEvent, { type: 'tool.completed' }>
  expect(completed.execution).toEqual(execution)
  expect(completed.resultRef).toEqual({ kind: 'file', path: 'out/big.txt', size: 9999, mimeType: 'text/plain' })

  // 形态不合法(terminationReason 白名单外)→ 整体省略,不产半截 execution
  const bad = adaptLifecycleEvent(toolEnd(4, {
    meta: { execution: { version: 2, outcome: 'succeeded', durationMs: 1, command: 'x', shell: 'bash', terminationReason: 'weird' } },
  }), state)[0]
  expect(Object.keys(bad as object)).not.toContain('execution')
  expect(Object.keys(bad as object)).not.toContain('resultRef')

  // tool.failed 同样携带 execution/resultRef(对齐旧路 tool_result 分支)
  const failed = adaptLifecycleEvent(toolEnd(5, { isError: true, meta: { execution } }), state)[0] as Extract<LumeRuntimeEvent, { type: 'tool.failed' }>
  expect(failed.execution).toEqual(execution)
  expect(failed.resultRef).toBeDefined()
})

test('tool.end meta.link → linkAuthorization(Fix round 1:合法透传/非法丢弃)', () => {
  const state = createLifecycleAdapterState()
  const link = {
    kind: 'link_authorization_required',
    service: 'github',
    actionId: 'act-1',
    threadId: 't1',
    errorCode: 'oauth_expired',
    connectionName: 'gh-main',
  }
  const completed = adaptLifecycleEvent(toolEnd(1, { meta: { link } }), state)[0] as Extract<LumeRuntimeEvent, { type: 'tool.completed' }>
  expect(completed.linkAuthorization).toEqual(link)

  // 形态不合法(缺必填 errorCode)→ 省略字段
  const bad = adaptLifecycleEvent(toolEnd(2, {
    meta: { link: { kind: 'link_authorization_required', service: 'github', actionId: 'a', threadId: 't' } },
  }), state)[0]
  expect(Object.keys(bad as object)).not.toContain('linkAuthorization')

  // tool.failed 同样携带(对齐旧路两分支)
  const failed = adaptLifecycleEvent(toolEnd(3, { isError: true, meta: { link } }), state)[0] as Extract<LumeRuntimeEvent, { type: 'tool.failed' }>
  expect(failed.linkAuthorization).toEqual(link)
})
