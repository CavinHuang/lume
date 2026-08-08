import { describe, expect, test } from 'bun:test'
import type {
  NativeAgentIslandSnapshot,
  NativeAgentIslandEvent,
  AgentIslandState,
} from './agent-island'

describe('agent-island native JSONL 协议', () => {
  test('NativeAgentIslandSnapshot 可 JSON round-trip', () => {
    const state: AgentIslandState = {
      presentation: 'compact',
      primarySessionId: 't1',
      compactLabel: 'Lume · 正在执行',
      sessions: [{
        threadId: 't1', title: '任务A', phase: 'running',
        detail: '第 1 步 · ls', activityLines: ['ls'],
        attention: false, unread: false, terminalAt: null, lastActivityAt: 1,
      }],
      planning: { todos: [], reminders: [] },
      updatedAt: 1,
    }
    const snap: NativeAgentIslandSnapshot = {
      type: 'snapshot', protocol: 1, revision: 1, state,
    }
    const round = JSON.parse(JSON.stringify(snap)) as NativeAgentIslandSnapshot
    expect(round.type).toBe('snapshot')
    expect(round.protocol).toBe(1)
    expect(round.state.sessions[0].threadId).toBe('t1')
    // Lume 无 planQuotas 字段
    expect('planQuotas' in round).toBe(false)
  })

  test('NativeAgentIslandEvent ready/fatal/intent 形状', () => {
    const ready: NativeAgentIslandEvent = { type: 'ready', protocol: 1 }
    const fatal: NativeAgentIslandEvent = { type: 'fatal', message: 'boom' }
    const intent: NativeAgentIslandEvent = { type: 'intent', name: 'open-session', threadId: 't1' }
    expect(JSON.parse(JSON.stringify(ready)).type).toBe('ready')
    expect(JSON.parse(JSON.stringify(fatal)).message).toBe('boom')
    expect(JSON.parse(JSON.stringify(intent)).threadId).toBe('t1')
  })
})
