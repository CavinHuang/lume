import { describe, expect, test } from 'bun:test'
import {
  mapRuntimePhaseToIslandPhase,
  selectPrimarySession,
  buildVisibilityKey,
  buildSnapshot,
  projectRecentSessions,
  pushActivityLine,
  selectPlanningIndicator,
  isStaleSession,
  STALE_SESSION_MS,
  selectHoverDelay,
  HOVER_EXPAND_DELAY_MS,
  HOVER_COLLAPSE_DELAY_MS,
  isImmediateAgentIslandEvent,
  msUntilNextMidnightRollover,
  nextPlanningAttentionTime,
} from './agent-island-projections'
import type { IslandSessionInput } from './agent-island-projections'
import type { AgentIslandPlanningSnapshot } from './types/agent-island'

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
  test('error 优先于 completed（对齐 Proma attentionScore）', () => {
    // 同级 lastActivityAt 时，error 应胜出成为 primary
    const list = selectPrimarySession([
      session({ threadId: 'ok', phase: 'completed', lastActivityAt: 5 }),
      session({ threadId: 'boom', phase: 'error', lastActivityAt: 5 }),
    ])
    expect(list.primarySessionId).toBe('boom')
  })
  test('completed 优先于 running（running 后置）', () => {
    const list = selectPrimarySession([
      session({ threadId: 'run', phase: 'running', lastActivityAt: 9 }),
      session({ threadId: 'ok', phase: 'completed', lastActivityAt: 1 }),
    ])
    expect(list.primarySessionId).toBe('ok')
  })
  test('空列表返回 null primary', () => {
    expect(selectPrimarySession([]).primarySessionId).toBeNull()
  })
})

describe('isStaleSession', () => {
  test('running 23h 无活动 → 不过期（保留）', () => {
    const now = 1_000_000
    const s = session({ phase: 'running', lastActivityAt: now - (STALE_SESSION_MS - 60_000) })
    expect(isStaleSession(s, now)).toBe(false)
  })
  test('running 25h 无活动 → 过期（剔除）', () => {
    const now = 1_000_000
    const s = session({ phase: 'running', lastActivityAt: now - (STALE_SESSION_MS + 60_000) })
    expect(isStaleSession(s, now)).toBe(true)
  })
  test('idle 25h 无活动 → 过期（剔除）', () => {
    const now = 1_000_000
    const s = session({ phase: 'idle', lastActivityAt: now - (STALE_SESSION_MS + 60_000) })
    expect(isStaleSession(s, now)).toBe(true)
  })
  test('terminalAt 非空（终态）→ 永不归 stale（归 UNREAD_RETAIN_MS 管）', () => {
    const now = 1_000_000
    // completed 25h 前 lastActivity，但已 terminalAt=now-100ms（10min 窗内）：不归 stale
    const s = session({
      phase: 'completed',
      lastActivityAt: now - (STALE_SESSION_MS + 60_000),
      terminalAt: now - 100,
    })
    expect(isStaleSession(s, now)).toBe(false)
  })
  test('terminalAt 非空且超过 stale 阈值 → 仍不归 stale（终态优先）', () => {
    const now = 1_000_000
    const s = session({
      phase: 'error',
      lastActivityAt: now - (STALE_SESSION_MS * 3),
      terminalAt: now - 5 * 60_000, // UNREAD_RETAIN_MS 窗内
    })
    expect(isStaleSession(s, now)).toBe(false)
  })
})

describe('buildVisibilityKey', () => {
  test('同状态同 key（稳定）', () => {
    const s = session({ threadId: 't1', phase: 'running', detail: 'x', lastActivityAt: 3 })
    expect(buildVisibilityKey([s], planning())).toBe(buildVisibilityKey([s], planning()))
  })
  test('detail 变 → key 变', () => {
    const a = session({ threadId: 't1', phase: 'running', detail: 'x', lastActivityAt: 3 })
    const b = session({ threadId: 't1', phase: 'running', detail: 'y', lastActivityAt: 3 })
    expect(buildVisibilityKey([a], planning())).not.toBe(buildVisibilityKey([b], planning()))
  })
  test('todo dueAt 变（id 不变）→ key 变（解除 dismiss）', () => {
    const s = session({ threadId: 't1', phase: 'running', detail: 'x', lastActivityAt: 3 })
    const before = planning({
      todos: [{ id: 'todo-1', title: '写文档', kind: 'todo', dueAt: 100, overdue: false }],
    })
    const after = planning({
      todos: [{ id: 'todo-1', title: '写文档', kind: 'todo', dueAt: 200, overdue: false }],
    })
    expect(buildVisibilityKey([s], before)).not.toBe(buildVisibilityKey([s], after))
  })
  test('reminder overdue 翻转 → key 变', () => {
    const s = session({ threadId: 't1', phase: 'running', detail: 'x', lastActivityAt: 3 })
    const before = planning({
      reminders: [{ id: 'r-1', title: '站会', kind: 'calendar_event', dueAt: 100, overdue: false }],
    })
    const after = planning({
      reminders: [{ id: 'r-1', title: '站会', kind: 'calendar_event', dueAt: 100, overdue: true }],
    })
    expect(buildVisibilityKey([s], before)).not.toBe(buildVisibilityKey([s], after))
  })
  test('非 primary session phase 变 → key 变（解除 dismiss）', () => {
    const primary = session({ threadId: 't1', phase: 'needs-interaction', detail: 'x', lastActivityAt: 10 })
    const otherBefore = session({ threadId: 't2', phase: 'running', detail: '', lastActivityAt: 5 })
    const otherAfter = session({ threadId: 't2', phase: 'completed', detail: '', lastActivityAt: 5 })
    expect(buildVisibilityKey([primary, otherBefore], planning()))
      .not.toBe(buildVisibilityKey([primary, otherAfter], planning()))
  })
  test('新增 session → key 变', () => {
    const a = session({ threadId: 't1', phase: 'running', detail: '', lastActivityAt: 1 })
    const b = session({ threadId: 't2', phase: 'idle', detail: '', lastActivityAt: 2 })
    expect(buildVisibilityKey([a], planning())).not.toBe(buildVisibilityKey([a, b], planning()))
  })
  test('全空 → 稳定 key', () => {
    expect(buildVisibilityKey([], planning())).toBe(buildVisibilityKey([], planning()))
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

const HOUR = 60 * 60_000

function planning(over: Partial<AgentIslandPlanningSnapshot> = {}): AgentIslandPlanningSnapshot {
  return { todos: [], reminders: [], ...over }
}

describe('selectPlanningIndicator', () => {
  test('空 planning → null', () => {
    expect(selectPlanningIndicator(planning(), 1_000_000)).toBeNull()
  })

  test('window 内只有 reminder → calendar(accent)', () => {
    const now = 1_000_000
    const snap = planning({
      reminders: [{ id: 'r1', title: '站会', kind: 'calendar_event', dueAt: now + 30 * 60_000, overdue: false }],
    })
    const ind = selectPlanningIndicator(snap, now)
    expect(ind).not.toBeNull()
    expect(ind?.symbol).toBe('calendar')
    expect(ind?.color).toBe('var(--lume-accent)')
  })

  test('window 内只有 todo → checklist(warning)', () => {
    const now = 1_000_000
    const snap = planning({
      todos: [{ id: 't1', title: '写文档', kind: 'todo', dueAt: now + 15 * 60_000, overdue: false }],
    })
    const ind = selectPlanningIndicator(snap, now)
    expect(ind).not.toBeNull()
    expect(ind?.symbol).toBe('checklist')
    expect(ind?.color).toBe('var(--lume-warning)')
  })

  test('event 早于 todo → calendar 胜', () => {
    const now = 1_000_000
    const snap = planning({
      todos: [{ id: 't1', title: '写文档', kind: 'todo', dueAt: now + 40 * 60_000, overdue: false }],
      reminders: [{ id: 'r1', title: '站会', kind: 'calendar_event', dueAt: now + 10 * 60_000, overdue: false }],
    })
    expect(selectPlanningIndicator(snap, now)?.symbol).toBe('calendar')
  })

  test('todo 早于 event → checklist 胜', () => {
    const now = 1_000_000
    const snap = planning({
      todos: [{ id: 't1', title: '写文档', kind: 'todo', dueAt: now + 5 * 60_000, overdue: false }],
      reminders: [{ id: 'r1', title: '站会', kind: 'calendar_event', dueAt: now + 20 * 60_000, overdue: false }],
    })
    expect(selectPlanningIndicator(snap, now)?.symbol).toBe('checklist')
  })

  test('event 与 todo 同 dueAt → calendar 胜（平局倾向 event）', () => {
    const now = 1_000_000
    const due = now + 20 * 60_000
    const snap = planning({
      todos: [{ id: 't1', title: '写文档', kind: 'todo', dueAt: due, overdue: false }],
      reminders: [{ id: 'r1', title: '站会', kind: 'calendar_event', dueAt: due, overdue: false }],
    })
    expect(selectPlanningIndicator(snap, now)?.symbol).toBe('calendar')
  })

  test('仅逾期项（dueAt < now）→ null（imminent 仅看未来）', () => {
    const now = 1_000_000
    const snap = planning({
      todos: [{ id: 't-over', title: '过期', kind: 'todo', dueAt: now - 5 * 60_000, overdue: true }],
      reminders: [{ id: 'r-over', title: '过期会', kind: 'calendar_event', dueAt: now - 60_000, overdue: true }],
    })
    expect(selectPlanningIndicator(snap, now)).toBeNull()
  })

  test('仅远期项（超出 1h window）→ null', () => {
    const now = 1_000_000
    const snap = planning({
      todos: [{ id: 't-far', title: '远期', kind: 'todo', dueAt: now + 3 * HOUR, overdue: false }],
      reminders: [{ id: 'r-far', title: '远期会', kind: 'calendar_event', dueAt: now + 2 * HOUR, overdue: false }],
    })
    expect(selectPlanningIndicator(snap, now)).toBeNull()
  })

  test('不修改入参 planning（纯函数）', () => {
    const now = 1_000_000
    const snap = planning({
      reminders: [{ id: 'r1', title: '站会', kind: 'calendar_event', dueAt: now + 10 * 60_000, overdue: false }],
    })
    const before = JSON.stringify(snap)
    selectPlanningIndicator(snap, now)
    expect(JSON.stringify(snap)).toBe(before)
  })
})

describe('selectHoverDelay', () => {
  test('进入(true) → HOVER_EXPAND_DELAY_MS', () => {
    expect(selectHoverDelay(true)).toBe(HOVER_EXPAND_DELAY_MS)
    expect(HOVER_EXPAND_DELAY_MS).toBe(300)
  })
  test('离开(false) → HOVER_COLLAPSE_DELAY_MS', () => {
    expect(selectHoverDelay(false)).toBe(HOVER_COLLAPSE_DELAY_MS)
    expect(HOVER_COLLAPSE_DELAY_MS).toBe(420)
  })
})

describe('isImmediateAgentIslandEvent', () => {
  test('runtime-status-changed: awaiting_permission/awaiting_user_answer → true', () => {
    expect(
      isImmediateAgentIslandEvent('agent:runtime-status-changed', {
        status: { phase: 'awaiting_permission' },
      }),
    ).toBe(true)
    expect(
      isImmediateAgentIslandEvent('agent:runtime-status-changed', {
        status: { phase: 'awaiting_user_answer' },
      }),
    ).toBe(true)
  })
  test('runtime-status-changed: completed/errored → true', () => {
    expect(
      isImmediateAgentIslandEvent('agent:runtime-status-changed', {
        status: { phase: 'completed' },
      }),
    ).toBe(true)
    expect(
      isImmediateAgentIslandEvent('agent:runtime-status-changed', {
        status: { phase: 'errored' },
      }),
    ).toBe(true)
  })
  test('runtime-status-changed: streaming/compacting/idle → false', () => {
    for (const phase of ['streaming', 'compacting', 'idle'] as const) {
      expect(
        isImmediateAgentIslandEvent('agent:runtime-status-changed', {
          status: { phase },
        }),
      ).toBe(false)
    }
  })
  test('runtime-event: tool.started → true', () => {
    expect(
      isImmediateAgentIslandEvent('agent:runtime-event', { event: { type: 'tool.started' } }),
    ).toBe(true)
  })
  test('runtime-event: permission.requested / ask_user.requested → true', () => {
    expect(
      isImmediateAgentIslandEvent('agent:runtime-event', { event: { type: 'permission.requested' } }),
    ).toBe(true)
    expect(
      isImmediateAgentIslandEvent('agent:runtime-event', { event: { type: 'ask_user.requested' } }),
    ).toBe(true)
  })
  test('runtime-event: run.completed / run.failed → true', () => {
    expect(
      isImmediateAgentIslandEvent('agent:runtime-event', { event: { type: 'run.completed' } }),
    ).toBe(true)
    expect(
      isImmediateAgentIslandEvent('agent:runtime-event', { event: { type: 'run.failed' } }),
    ).toBe(true)
  })
  test('runtime-event: token 流 / 普通 tool 事件 → false', () => {
    for (const type of [
      'assistant.delta',
      'assistant.thinking_delta',
      'assistant.final',
      'tool.completed',
      'tool.failed',
      'usage.updated',
      'message.user.submitted',
    ]) {
      expect(
        isImmediateAgentIslandEvent('agent:runtime-event', { event: { type } }),
      ).toBe(false)
    }
  })
  test('未知 method → false', () => {
    expect(isImmediateAgentIslandEvent('agent:message-appended', {})).toBe(false)
    expect(isImmediateAgentIslandEvent('agent:thread-list-changed', {})).toBe(false)
  })
  test('字段缺失 / params=undefined → false（宽松兜底）', () => {
    expect(isImmediateAgentIslandEvent('agent:runtime-status-changed', {})).toBe(false)
    expect(isImmediateAgentIslandEvent('agent:runtime-status-changed', undefined)).toBe(false)
    expect(isImmediateAgentIslandEvent('agent:runtime-event', {})).toBe(false)
    expect(isImmediateAgentIslandEvent('agent:runtime-event', undefined)).toBe(false)
    expect(
      isImmediateAgentIslandEvent('agent:runtime-event', { event: {} }),
    ).toBe(false)
  })
})

describe('msUntilNextMidnightRollover', () => {
  // 用本地时区构造稳定时刻：分别取 23:59:00 与 00:00:00 两个边界。
  test('23:59:00 → 到 00:00:00.150 约 60s+150ms', () => {
    const d = new Date()
    d.setHours(23, 59, 0, 0)
    const ms = msUntilNextMidnightRollover(d.getTime())
    // 跨日仅 1 分钟，差值应恰好是 60_000 + 150 = 60_150。
    expect(ms).toBe(60_150)
  })
  test('00:00:00 → 到下个午夜 00:00:00.150 约 24h', () => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const ms = msUntilNextMidnightRollover(d.getTime())
    // 24h - 150ms 偏移：差值 = 24*60*60_000 - 150 + 150 = 24h 整（因为目标含 150ms 偏移）。
    // 实际：明天 00:00:00.150 - 今天 00:00:00.000 = 24h + 150ms。
    expect(ms).toBe(24 * 60 * 60_000 + 150)
  })
  test('00:00:00.200 → 已过 150ms 偏移点 → 顺延到下个午夜（约 24h）', () => {
    const d = new Date()
    d.setHours(0, 0, 0, 200)
    const ms = msUntilNextMidnightRollover(d.getTime())
    // 明天 00:00:00.150 - 今天 00:00:00.200 = 24h - 50ms。
    expect(ms).toBe(24 * 60 * 60_000 - 50)
  })
  test('始终为正数（不会返回 0 或负数）', () => {
    for (const hour of [0, 6, 12, 18, 23]) {
      const d = new Date()
      d.setHours(hour, 30, 30, 500)
      expect(msUntilNextMidnightRollover(d.getTime())).toBeGreaterThan(0)
    }
  })
})

describe('nextPlanningAttentionTime', () => {
  const WINDOW = 60 * 60_000 // 1h
  test('未来 item 进入 1h 窗 → 返回进入时刻（dueAt - window）', () => {
    const now = 1_000_000
    const due = now + 3 * 60 * 60_000 // 3h 后到期
    const res = nextPlanningAttentionTime({
      todos: [{ id: 't1', title: '写文档', kind: 'todo', dueAt: due, overdue: false }],
      reminders: [],
    }, now, WINDOW)
    expect(res).toBe(due - WINDOW)
  })
  test('多 item 取最早进入窗的时刻', () => {
    const now = 1_000_000
    const res = nextPlanningAttentionTime({
      todos: [
        { id: 'late', title: '晚', kind: 'todo', dueAt: now + 5 * 60 * 60_000, overdue: false },
        { id: 'early', title: '早', kind: 'todo', dueAt: now + 2 * 60 * 60_000, overdue: false },
      ],
      reminders: [],
    }, now, WINDOW)
    expect(res).toBe(now + 2 * 60 * 60_000 - WINDOW)
  })
  test('已进入窗的 item 跳过（由普通 push 反映，不算未来 attention）', () => {
    const now = 1_000_000
    const due = now + 30 * 60_000 // 30min 后到期 → 已在 1h 窗内
    const res = nextPlanningAttentionTime({
      todos: [{ id: 't1', title: '即将', kind: 'todo', dueAt: due, overdue: false }],
      reminders: [],
    }, now, WINDOW)
    // enter = due - WINDOW = now - 30min < now → 跳过；无其他 → null。
    expect(res).toBeNull()
  })
  test('同时混入 reminders 取最早', () => {
    const now = 1_000_000
    const res = nextPlanningAttentionTime({
      todos: [{ id: 't', title: 'todo 4h', kind: 'todo', dueAt: now + 4 * 60 * 60_000, overdue: false }],
      reminders: [{ id: 'r', title: 'reminder 2h', kind: 'calendar_event', dueAt: now + 2 * 60 * 60_000, overdue: false }],
    }, now, WINDOW)
    expect(res).toBe(now + 2 * 60 * 60_000 - WINDOW)
  })
  test('无未来进入窗的 item → null', () => {
    const now = 1_000_000
    expect(nextPlanningAttentionTime({ todos: [], reminders: [] }, now, WINDOW)).toBeNull()
  })
  test('逾期项（dueAt < now）被跳过 → 无未来项则 null', () => {
    const now = 1_000_000
    const res = nextPlanningAttentionTime({
      todos: [{ id: 'over', title: '过期', kind: 'todo', dueAt: now - 5 * 60_000, overdue: true }],
      reminders: [],
    }, now, WINDOW)
    // enter = -5min - 1h < now → 跳过 → null
    expect(res).toBeNull()
  })
  test('不修改入参（纯函数）', () => {
    const now = 1_000_000
    const input = {
      todos: [{ id: 't1', title: '远', kind: 'todo', dueAt: now + 5 * 60 * 60_000, overdue: false }],
      reminders: [],
    }
    const before = JSON.stringify(input)
    nextPlanningAttentionTime(input, now, WINDOW)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('buildSnapshot (info-density)', () => {
  test('buildSnapshot 用全量 planning——远期 todo 不被过滤进 expanded', () => {
    const now = 10_000
    const farTodo = { id: 'p1', title: '下周', kind: 'todo' as const, dueAt: now + 7 * 86400_000, overdue: false }
    const snap = buildSnapshot([], { todos: [farTodo], reminders: [] }, now, { recentSessions: [], isIdle: true })
    expect(snap.planning.todos).toHaveLength(1) // 全量，非 0（旧 projectPlanning 会过滤掉）
    expect(snap.planning.todos[0].id).toBe('p1')
  })

  test('buildSnapshot isIdle=true 时 presentation 不为 hidden（home surface 总显示）', () => {
    const snap = buildSnapshot([], { todos: [], reminders: [] }, 1000, { recentSessions: [], isIdle: true })
    expect(snap.presentation).toBe('compact') // 非隐藏，即使空
    expect(snap.isIdle).toBe(true)
  })

  test('buildSnapshot 默认 isIdle 由 primarySessionId 推导（无 session 即 idle）', () => {
    const snap = buildSnapshot([], { todos: [], reminders: [] }, 1000)
    expect(snap.isIdle).toBe(true)
    expect(snap.presentation).toBe('compact')
    expect(snap.recentSessions).toEqual([])
  })

  test('buildSnapshot 有 session 时默认非 idle，无内容则 hidden', () => {
    const snap = buildSnapshot(
      [session({ threadId: 't1', phase: 'idle', lastActivityAt: 1 })],
      { todos: [], reminders: [] },
      1000,
    )
    expect(snap.isIdle).toBe(false)
    // inputs.length > 0 → hasContent=true → compact（非 hidden）
    expect(snap.presentation).toBe('compact')
  })

  test('buildSnapshot idle 时 compactLabel 用 "最近会话"', () => {
    const snap = buildSnapshot([], { todos: [], reminders: [] }, 1000, { recentSessions: [], isIdle: true })
    expect(snap.compactLabel).toBe('Lume · 最近会话')
  })

  test('buildSnapshot 透传 recentSessions（opts 提供）', () => {
    const recent = [{ threadId: 'r1', title: 'R', updatedAt: 100 }]
    const snap = buildSnapshot([], { todos: [], reminders: [] }, 1000, { recentSessions: recent, isIdle: true })
    expect(snap.recentSessions).toBe(recent)
  })
})

describe('selectPlanningIndicator (info-density 全量 planning)', () => {
  test('selectPlanningIndicator 仍只看 1h 窗（compact 紧迫语义保留）', () => {
    const now = 10_000
    const far = { id: 'p1', title: '远', kind: 'todo' as const, dueAt: now + 7 * 86400_000, overdue: false }
    const near = { id: 'p2', title: '近', kind: 'todo' as const, dueAt: now + 10 * 60_000, overdue: false }
    expect(selectPlanningIndicator({ todos: [far], reminders: [] }, now)).toBeNull()
    expect(selectPlanningIndicator({ todos: [near], reminders: [] }, now)?.symbol).toBe('checklist')
  })
})

describe('buildVisibilityKey (info-density 全量 planning)', () => {
  test('buildVisibilityKey 用全量 planning（远期 todo 改 dueAt 触发 dismiss 重显）', () => {
    const now = 10_000
    const far = { id: 'p1', title: 'x', kind: 'todo' as const, dueAt: now + 7 * 86400_000, overdue: false }
    const k1 = buildVisibilityKey([], { todos: [far], reminders: [] })
    const k2 = buildVisibilityKey([], { todos: [{ ...far, dueAt: now + 8 * 86400_000 }], reminders: [] })
    expect(k1).not.toBe(k2)
  })
})

describe('projectRecentSessions', () => {
  test('排除 archived/trashed、排除 active、updatedAt desc、top3、dedup', () => {
    const metas = [
      { id: 'a', title: 'A', updatedAt: 100, status: 'active', workspaceId: 'w1' },
      { id: 'b', title: 'B', updatedAt: 300, status: 'active', workspaceId: 'w1' },
      { id: 'c', title: 'C', updatedAt: 200, status: 'archived', workspaceId: 'w1' },
      { id: 'd', title: 'D', updatedAt: 400, status: 'trashed', workspaceId: 'w1' },
      { id: 'e', title: 'E', updatedAt: 500, status: 'active', workspaceId: 'w1' },
      { id: 'a', title: 'A-dup', updatedAt: 999, status: 'active', workspaceId: 'w1' }, // dedup 保留首次
    ]
    const ws = new Map([['w1', 'Proj']])
    const recent = projectRecentSessions(metas as any, new Set(['e']), ws)
    expect(recent.map((r) => r.threadId)).toEqual(['b', 'a']) // e 是 active 排除；c/d 归档/回收排除；top3 实得2
    expect(recent[0].project).toBe('Proj')
  })

  test('无 status 字段视为 active（保留）', () => {
    const metas = [
      { id: 'x', title: 'X', updatedAt: 200, workspaceId: 'w1' },
    ]
    const recent = projectRecentSessions(metas as any, new Set(), new Map())
    expect(recent.map((r) => r.threadId)).toEqual(['x'])
  })

  test('title 缺失/空白时 fallback 到 id', () => {
    const metas = [
      { id: 'k', title: '   ', updatedAt: 2, status: 'active' },
      { id: 'm', updatedAt: 1, status: 'active' },
    ]
    const recent = projectRecentSessions(metas as any, new Set(), new Map())
    expect(recent[0].title).toBe('k')
    expect(recent[1].title).toBe('m')
  })

  test('updatedAt 缺失视为 0', () => {
    const metas = [
      { id: 'late', title: 'L', updatedAt: 100, status: 'active' },
      { id: 'unk', title: 'U', status: 'active' }, // updatedAt undefined
    ]
    const recent = projectRecentSessions(metas as any, new Set(), new Map())
    expect(recent.map((r) => r.threadId)).toEqual(['late', 'unk'])
    expect(recent[1].updatedAt).toBe(0)
  })

  test('top3 截断', () => {
    const metas = [
      { id: '1', title: 'a', updatedAt: 100, status: 'active' },
      { id: '2', title: 'b', updatedAt: 200, status: 'active' },
      { id: '3', title: 'c', updatedAt: 300, status: 'active' },
      { id: '4', title: 'd', updatedAt: 400, status: 'active' },
      { id: '5', title: 'e', updatedAt: 500, status: 'active' },
    ]
    const recent = projectRecentSessions(metas as any, new Set(), new Map())
    expect(recent.map((r) => r.threadId)).toEqual(['5', '4', '3'])
  })

  test('空 metas → 空数组', () => {
    expect(projectRecentSessions([], new Set(), new Map())).toEqual([])
  })

  test('workspaceId 未在 workspaceNames 中 → project undefined', () => {
    const metas = [{ id: 'x', title: 'X', updatedAt: 1, status: 'active', workspaceId: 'unknown' }]
    const recent = projectRecentSessions(metas as any, new Set(), new Map())
    expect(recent[0].project).toBeUndefined()
  })

  test('不修改入参 metas（纯函数）', () => {
    const metas = [{ id: 'x', title: 'X', updatedAt: 1, status: 'active', workspaceId: 'w1' }]
    const before = JSON.stringify(metas)
    projectRecentSessions(metas as any, new Set(), new Map([['w1', 'P']]))
    expect(JSON.stringify(metas)).toBe(before)
  })
})
