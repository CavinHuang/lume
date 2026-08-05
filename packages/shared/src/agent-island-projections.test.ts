import { describe, expect, test } from 'bun:test'
import {
  mapRuntimePhaseToIslandPhase,
  selectPrimarySession,
  buildVisibilityKey,
  projectPlanning,
  pushActivityLine,
} from './agent-island-projections'
import type { IslandSessionInput } from './agent-island-projections'

describe('mapRuntimePhaseToIslandPhase', () => {
  test('streaming/compacting → running', () => {
    expect(mapRuntimePhaseToIslandPhase('streaming')).toBe('running')
    expect(mapRuntimePhaseToIslandPhase('compacting')).toBe('running')
  })
  test('awaiting_* → needs-interaction', () => {
    expect(mapRuntimePhaseToIslandPhase('awaiting_permission')).toBe('needs-interaction')
    expect(mapRuntimePhaseToIslandPhase('awaiting_user_answer')).toBe('needs-interaction')
  })
  test('completed/errored/idle 直映', () => {
    expect(mapRuntimePhaseToIslandPhase('completed')).toBe('completed')
    expect(mapRuntimePhaseToIslandPhase('errored')).toBe('error')
    expect(mapRuntimePhaseToIslandPhase('idle')).toBe('idle')
  })
})

function session(over: Partial<IslandSessionInput>): IslandSessionInput {
  return {
    threadId: 't', title: '', phase: 'idle', detail: '', activityLines: [],
    attention: false, unread: false, terminalAt: null, lastActivityAt: 0, ...over,
  }
}

describe('selectPrimarySession', () => {
  test('needs-interaction 优先于 running', () => {
    const list = selectPrimarySession([
      session({ threadId: 'a', phase: 'running', lastActivityAt: 5 }),
      session({ threadId: 'b', phase: 'needs-interaction', lastActivityAt: 1 }),
    ])
    expect(list.primarySessionId).toBe('b')
    expect(list.sessions).toHaveLength(2)
  })
  test('同级按 lastActivityAt 降序', () => {
    const list = selectPrimarySession([
      session({ threadId: 'a', phase: 'running', lastActivityAt: 1 }),
      session({ threadId: 'b', phase: 'running', lastActivityAt: 9 }),
    ])
    expect(list.primarySessionId).toBe('b')
  })
  test('空列表返回 null primary', () => {
    expect(selectPrimarySession([]).primarySessionId).toBeNull()
  })
})

describe('buildVisibilityKey', () => {
  test('同状态同 key', () => {
    const s = session({ threadId: 't1', phase: 'running', detail: 'x', lastActivityAt: 3 })
    expect(buildVisibilityKey(s, [])).toBe(buildVisibilityKey(s, []))
  })
  test('detail 变 → key 变', () => {
    const a = session({ threadId: 't1', phase: 'running', detail: 'x', lastActivityAt: 3 })
    const b = session({ threadId: 't1', phase: 'running', detail: 'y', lastActivityAt: 3 })
    expect(buildVisibilityKey(a, [])).not.toBe(buildVisibilityKey(b, []))
  })
})

describe('projectPlanning', () => {
  test('只保留 1h 内或逾期的项', () => {
    const now = 1_000_000
    const snap = projectPlanning({
      todos: [
        { id: 'soon', title: '即将', kind: 'todo', dueAt: now + 30 * 60_000, overdue: false },
        { id: 'later', title: '远期', kind: 'todo', dueAt: now + 3 * 3_600_000, overdue: false },
      ],
      reminders: [
        { id: 'over', title: '逾期', kind: 'calendar_event', dueAt: now - 1000, overdue: true },
      ],
    }, now)
    expect(snap.todos.map((t) => t.id)).toEqual(['soon'])
    expect(snap.reminders.map((r) => r.id)).toEqual(['over'])
  })
})

describe('pushActivityLine', () => {
  test('空数组追加一条', () => {
    expect(pushActivityLine([], 'Read')).toEqual(['Read'])
  })
  test('累积多条保持顺序', () => {
    let lines: string[] = []
    for (const l of ['Read', 'Write', 'Edit']) lines = pushActivityLine(lines, l)
    expect(lines).toEqual(['Read', 'Write', 'Edit'])
  })
  test('超过 4 条丢最早一条（FIFO 截断）', () => {
    let lines: string[] = []
    for (const l of ['A', 'B', 'C', 'D', 'E']) lines = pushActivityLine(lines, l)
    expect(lines).toEqual(['B', 'C', 'D', 'E'])
  })
  test('不修改原数组（纯函数）', () => {
    const prev = ['Read']
    const next = pushActivityLine(prev, 'Write')
    expect(prev).toEqual(['Read'])
    expect(next).toEqual(['Read', 'Write'])
  })
})
