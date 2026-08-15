import { test, expect } from 'bun:test'
import type { Batch1LifecycleDetail, SdkEventEnvelope } from '@lume/shared'
import { adaptLifecycleEvent, createLifecycleAdapterState } from './lifecycle-event-adapter'

const TS = 1_723_680_000_000

function envelope(
  seq: number,
  kind: SdkEventEnvelope['kind'],
  phase: SdkEventEnvelope['phase'],
  turnId: string | null,
  detail: Batch1LifecycleDetail,
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

function runEnd(seq: number, detail: Partial<Extract<Batch1LifecycleDetail, { type: 'run.end' }>>) {
  return envelope(seq, 'run', 'end', null, {
    type: 'run.end',
    stopReason: null,
    isError: false,
    numTurns: 1,
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
  expect(adaptLifecycleEvent(envelope(5, 'tool', 'event', 'turn-1', { type: 'tool.unknown' } as unknown as Batch1LifecycleDetail), state)).toEqual([])
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
