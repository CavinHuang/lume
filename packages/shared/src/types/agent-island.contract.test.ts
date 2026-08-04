import { describe, expect, test } from 'bun:test'
import { AGENT_ISLAND_IPC_CHANNELS } from './agent-island'
import type { AgentIslandState, AgentIslandWindowSnapshot } from './agent-island'

describe('agent-island 契约', () => {
  test('IPC 通道常量值正确', () => {
    // STATE 是事件通道（main→renderer，lume:event:<channel>），用冒号风格
    expect(AGENT_ISLAND_IPC_CHANNELS.STATE).toBe('agent:island:state')
    // INTENT 是 invoke 命令（renderer→main，经 lume:invoke→dispatchCommand），用下划线风格
    expect(AGENT_ISLAND_IPC_CHANNELS.INTENT).toBe('agent_island_intent')
  })

  test('AgentIslandWindowSnapshot 可 JSON round-trip', () => {
    const state: AgentIslandState = {
      presentation: 'compact',
      primarySessionId: 't1',
      compactLabel: 'Lume · 正在执行',
      sessions: [{
        threadId: 't1', title: '任务A', phase: 'running',
        detail: '第 1 步 · ls', activityLines: ['ls'], attention: false,
        unread: false, terminalAt: null, lastActivityAt: 1,
      }],
      planning: { todos: [], reminders: [] },
      updatedAt: 1,
    }
    const snap: AgentIslandWindowSnapshot = { state, expandedHeight: 32 }
    const round = JSON.parse(JSON.stringify(snap)) as AgentIslandWindowSnapshot
    expect(round.state.primarySessionId).toBe('t1')
    expect(round.state.sessions[0].phase).toBe('running')
  })
})
