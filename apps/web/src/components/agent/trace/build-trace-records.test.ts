import { describe, expect, test } from 'bun:test'
import { buildTraceRecords } from './build-trace-records'
import type {
  MessageEndDetail,
  SdkEventEnvelope,
  ToolEndDetail,
  ToolStartDetail,
  TurnStartDetail,
} from '@lume/shared'

let seq = 0
function env(partial: Partial<SdkEventEnvelope> & { detail: unknown }): SdkEventEnvelope {
  return {
    v: 1,
    seq: ++seq,
    threadId: 't1',
    runId: 'r1',
    turnId: null,
    ts: 1000 + seq * 100,
    kind: 'message',
    phase: 'event',
    ...partial,
  } as SdkEventEnvelope
}

const turnStart = (turnId: string) =>
  env({ kind: 'turn', phase: 'start', turnId, detail: { type: 'turn.start' } satisfies TurnStartDetail })
const userMsg = (content: string) =>
  env({ kind: 'message', phase: 'start', detail: { type: 'user.message', content } })
const msgEnd = (text: string, turnId: string) =>
  env({
    kind: 'message',
    phase: 'end',
    turnId,
    detail: { type: 'message.end', message: { role: 'assistant', content: [{ type: 'text', text }] } } satisfies MessageEndDetail,
  })
const toolStart = (callId: string, name: string, input: unknown) =>
  env({
    kind: 'tool',
    phase: 'start',
    detail: { type: 'tool.start', toolCallId: callId, toolName: name, input },
  } satisfies { type: 'tool.start'; toolCallId: string; toolName: string; input: unknown } as ToolStartDetail)
const toolEnd = (callId: string, name: string, output: string, isError = false) =>
  env({
    kind: 'tool',
    phase: 'end',
    detail: { type: 'tool.end', toolCallId: callId, toolName: name, isError, output },
  } satisfies ToolEndDetail)

describe('buildTraceRecords', () => {
  test('空输入产出空记录', () => {
    expect(buildTraceRecords([])).toEqual([])
  })

  test('user.message 与 assistant message.end 配对为独立记录并计算时长', () => {
    const records = buildTraceRecords([
      userMsg('帮我读下 package.json'),
      turnStart('u1'),
      env({ kind: 'message', phase: 'start', turnId: 'u1', detail: { type: 'message.start' } }),
      msgEnd('好的，已读取', 'u1'),
    ])
    expect(records.map((r) => r.kind)).toEqual(['user', 'assistant'])
    expect(records[0]?.summary).toContain('package.json')
    expect(records[1]?.summary).toBe('好的，已读取')
    expect(records[1]?.endedAt).toBeGreaterThan(records[1]!.startedAt)
    expect(records[1]?.durationMs).toBeGreaterThan(0)
  })

  test('turn.start 递增轮次编号，user 消息归属 null 轮', () => {
    const records = buildTraceRecords([
      userMsg('第一问'),
      turnStart('t1'),
      msgEnd('答一', 't1'),
      userMsg('第二问'),
      turnStart('t2'),
      msgEnd('答二', 't2'),
    ])
    expect(records.map((r) => r.turnNumber)).toEqual([null, 1, null, 2])
  })

  test('tool.start/end 按 toolCallId 配对，携带输出与错误标记', () => {
    const records = buildTraceRecords([
      turnStart('t1'),
      toolStart('c1', 'Bash', { command: 'ls -la' }),
      toolEnd('c1', 'Bash', 'total 48'),
      toolStart('c2', 'Read', { file_path: '/a/b.ts' }),
      toolEnd('c2', 'Read', 'boom', true),
    ])
    const tools = records.filter((r) => r.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ toolName: 'Bash', isError: false })
    expect(tools[0]?.input).toContain('ls -la')
    expect(tools[0]?.output).toBe('total 48')
    expect(tools[1]?.isError).toBe(true)
  })

  test('未配对的 tool.start 保持运行态(endedAt 为 null)', () => {
    const records = buildTraceRecords([turnStart('t1'), toolStart('c1', 'Bash', { command: 'sleep 100' })])
    const tool = records.find((r) => r.kind === 'tool')
    expect(tool?.endedAt).toBeNull()
    expect(tool?.running).toBe(true)
  })

  test('message.update 折叠为流式预览，不产生新记录', () => {
    const records = buildTraceRecords([
      turnStart('t1'),
      env({ kind: 'message', phase: 'start', turnId: 't1', detail: { type: 'message.start' } }),
      env({
        kind: 'message',
        phase: 'update',
        turnId: 't1',
        detail: { type: 'message.update', delta: null, partial: { text: '正在分', thinking: '', toolUses: [] } },
      }),
      env({
        kind: 'message',
        phase: 'update',
        turnId: 't1',
        detail: { type: 'message.update', delta: null, partial: { text: '正在分析代码结构', thinking: '推理中', toolUses: [] } },
      }),
    ])
    const assistant = records.filter((r) => r.kind === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]?.summary).toBe('正在分析代码结构')
    expect(assistant[0]?.running).toBe(true)
    expect(assistant[0]?.thinking).toBe('推理中')
  })

  test('message.end 收口流式记录并提供完整文本', () => {
    const records = buildTraceRecords([
      turnStart('t1'),
      env({ kind: 'message', phase: 'start', turnId: 't1', detail: { type: 'message.start' } }),
      env({
        kind: 'message',
        phase: 'update',
        turnId: 't1',
        detail: { type: 'message.update', delta: null, partial: { text: '部分', thinking: '想', toolUses: [] } },
      }),
      msgEnd('完整回答', 't1'),
    ])
    const assistant = records.find((r) => r.kind === 'assistant')
    expect(assistant?.running).toBe(false)
    expect(assistant?.summary).toBe('完整回答')
    expect(assistant?.output).toContain('完整回答')
  })

  test('run.end 产出运行汇总记录，良性 end_turn 不上摘要尾巴', () => {
    const records = buildTraceRecords([
      env({ kind: 'run', phase: 'start', detail: { type: 'run.start' } }),
      turnStart('t1'),
      msgEnd('done', 't1'),
      env({
        kind: 'run',
        phase: 'end',
        detail: { type: 'run.end', stopReason: 'end_turn', isError: false, numTurns: 3, costUSD: 0.42 },
      }),
    ])
    const runEnd = records.find((r) => r.kind === 'run')
    expect(runEnd).toBeDefined()
    expect(runEnd?.numTurns).toBe(3)
    expect(runEnd?.stopReason).toBe('end_turn')
    expect(runEnd?.isError).toBe(false)
    expect(runEnd?.summary).toBe('运行结束 · 3 轮 · $0.4200')
    expect(runEnd?.summary).not.toContain('end_turn')
  })

  test('异常停止原因保留在运行摘要中', () => {
    const records = buildTraceRecords([
      env({
        kind: 'run',
        phase: 'end',
        detail: { type: 'run.end', stopReason: 'max_turns', isError: true, numTurns: 10 },
      }),
    ])
    const runEnd = records.find((r) => r.kind === 'run')
    expect(runEnd?.summary).toContain('max_turns')
    expect(runEnd?.summary).toContain('运行失败')
    expect(runEnd?.isError).toBe(true)
  })

  test('user 消息按真实序列(message.start(null)+user.message 成对)投影不受干扰', () => {
    const records = buildTraceRecords([
      env({ kind: 'message', phase: 'start', turnId: null, detail: { type: 'message.start' } }),
      env({ detail: { type: 'user.message', content: '真实前缀' } }),
      turnStart('u1'),
      msgEnd('ok', 'u1'),
    ])
    expect(records.map((r) => r.kind)).toEqual(['user', 'assistant'])
    expect(records[0]?.summary).toBe('真实前缀')
  })

  test('message.end 携带 error 时标记失败并传导到 run.end', () => {
    const records = buildTraceRecords([
      turnStart('t1'),
      env({ kind: 'message', phase: 'start', turnId: 't1', detail: { type: 'message.start' } }),
      env({
        kind: 'message',
        phase: 'end',
        turnId: 't1',
        detail: { type: 'message.end', message: { role: 'assistant', content: [] }, error: 'provider overloaded' },
      }),
      env({ kind: 'run', phase: 'end', detail: { type: 'run.end', stopReason: 'error_max_turns', isError: true, numTurns: 1 } }),
    ])
    const assistant = records.find((r) => r.kind === 'assistant')
    const runEnd = records.find((r) => r.kind === 'run')
    expect(assistant?.isError).toBe(true)
    expect(runEnd?.isError).toBe(true)
  })

  test('compaction completed 产一条压缩记录，started/progress 忽略', () => {
    const records = buildTraceRecords([
      env({ detail: { type: 'context.compaction', phase: 'started' } }),
      env({ detail: { type: 'context.compaction', phase: 'progress', progress: 40 } }),
      env({ detail: { type: 'context.compaction', phase: 'completed', preTokens: 900, postTokens: 300 } }),
    ])
    const compactions = records.filter((r) => r.kind === 'compaction')
    expect(compactions).toHaveLength(1)
    expect(compactions[0]?.summary).toContain('900')
  })

  test('乱序输入按 seq 重排后投影', () => {
    const ordered = [userMsg('q'), turnStart('t1'), msgEnd('a', 't1')]
    const shuffled = [ordered[2], ordered[0], ordered[1]]
    expect(buildTraceRecords(shuffled).map((r) => r.summary)).toEqual(
      buildTraceRecords(ordered).map((r) => r.summary),
    )
  })

  test('index 从 1 连续递增且 id 稳定唯一', () => {
    const records = buildTraceRecords([
      userMsg('q'),
      turnStart('t1'),
      toolStart('c1', 'Read', {}),
      toolEnd('c1', 'Read', 'ok'),
      msgEnd('a', 't1'),
    ])
    expect(records.map((r) => r.index)).toEqual(records.map((_, i) => i + 1))
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length)
  })

  test('run.end 收口中止 run 残留的在途记录(不再永久 running)', () => {
    const events = [
      turnStart('t1'),
      env({ kind: 'message', phase: 'start', turnId: 't1', detail: { type: 'message.start' } }),
      toolStart('c1', 'Bash', { command: 'sleep 999' }),
    ]
    // 用户主动停止：没有 message.end / tool.end，直接 run.end（最后创建保证 seq 在后）
    const [runEnd] = [...events, env({
      kind: 'run',
      phase: 'end',
      detail: { type: 'run.end', stopReason: 'aborted', isError: false, numTurns: 1 },
    })].slice(-1)
    const records = buildTraceRecords([...events, runEnd])
    for (const record of records.filter((r) => r.kind !== 'run')) {
      expect(record.running).toBe(false)
      expect(record.endedAt).toBe(runEnd.ts)
    }
  })

  test('orphan tool.end(缺起始事件)产出兜底行并透传错误标记', () => {
    const records = buildTraceRecords([
      turnStart('t1'),
      toolEnd('c1', 'Write', '写入失败', true),
    ])
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: 'tool',
      isError: true,
      running: false,
      output: '写入失败',
    })
    expect(records[0]?.summary).toContain('缺失起始事件')
  })

  test('流式 update 仅含 toolUses 且 name 为空时摘要兜底「工具调用中」', () => {
    const records = buildTraceRecords([
      turnStart('t1'),
      env({ kind: 'message', phase: 'start', turnId: 't1', detail: { type: 'message.start' } }),
      env({
        kind: 'message',
        phase: 'update',
        turnId: 't1',
        detail: { type: 'message.update', delta: null, partial: { text: '', thinking: '', toolUses: [{ id: 'x', name: '', partialJson: '{"cmd"' }] } },
      }),
    ])
    expect(records.find((r) => r.kind === 'assistant')?.summary).toBe('工具调用中')
  })
})
