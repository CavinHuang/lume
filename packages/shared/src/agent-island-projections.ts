import type { AgentRuntimePhase } from "./types/agent"
import type {
  AgentIslandPhase,
  AgentIslandPlanningItem,
  AgentIslandPlanningSnapshot,
  AgentIslandSessionSnapshot,
  AgentIslandState,
} from "./types/agent-island"

const PLANNING_ATTENTION_WINDOW_MS = 60 * 60_000 // 1h

/**
 * running/idle 会话（无 terminalAt）24h 无活动视为过期，由 service.prune 剔除。
 * 对齐 Proma agent-island-service.ts:385 `isIslandSession`（now - lastActivityAt >= 24h 剔除）。
 */
export const STALE_SESSION_MS = 24 * 60 * 60_000 // 24h

/** 累积活动行的上限（对齐 Proma MAX_ACTIVITY_LINES）。 */
const MAX_ACTIVITY_LINES = 4

/**
 * 把 line 追加到 prev 末尾，超出 MAX_ACTIVITY_LINES 时丢最早一条（FIFO）。
 * 用于 service 把 sidecar 的 tool/task 事件名累积进 session.activityLines。
 */
export function pushActivityLine(prev: string[], line: string): string[] {
  const next = [...prev, line]
  return next.slice(-MAX_ACTIVITY_LINES)
}

/** service 组装的会话输入（投影前），由 service 从事件聚合。 */
export interface IslandSessionInput {
  threadId: string
  title: string
  phase: AgentIslandPhase
  interactionKind?: AgentIslandSessionSnapshot['interactionKind']
  detail: string
  activityLines: string[]
  attention: boolean
  unread: boolean
  terminalAt: number | null
  lastActivityAt: number
}

/**
 * 判定 running/idle 会话是否过期：无 terminalAt（非终态）且 24h 无活动。
 * 终态（completed/error，有 terminalAt）由 service `UNREAD_RETAIN_MS`（10min）管，此处返回 false。
 * 用于 service.prune 剔除幽灵会话（running/idle 永无 terminalAt 旧逻辑下永不清）。
 */
export function isStaleSession(session: IslandSessionInput, now: number): boolean {
  if (session.terminalAt !== null) return false
  return now - session.lastActivityAt >= STALE_SESSION_MS
}

const PHASE_PRIORITY: Record<AgentIslandPhase, number> = {
  'needs-interaction': 0,
  error: 1,
  completed: 2,
  running: 3,
  idle: 4,
}

export function mapRuntimePhaseToIslandPhase(phase: AgentRuntimePhase): AgentIslandPhase {
  switch (phase) {
    case "streaming":
    case "compacting":
      return "running"
    case "awaiting_permission":
    case "awaiting_user_answer":
      return "needs-interaction"
    case "completed":
      return "completed"
    case "errored":
      return "error"
    case "idle":
    default:
      return "idle"
  }
}

const PHASE_LABEL: Record<AgentIslandPhase, string> = {
  idle: '空闲',
  running: '正在执行',
  'needs-interaction': '需要你接手',
  completed: '任务完成',
  error: '执行出错',
}

export function selectPrimarySession(inputs: IslandSessionInput[]): {
  primarySessionId: string | null
  sessions: IslandSessionInput[]
} {
  const sorted = [...inputs].sort((a, b) => {
    const dp = PHASE_PRIORITY[a.phase] - PHASE_PRIORITY[b.phase]
    if (dp !== 0) return dp
    return b.lastActivityAt - a.lastActivityAt
  })
  return { primarySessionId: sorted[0]?.threadId ?? null, sessions: sorted.slice(0, 3) }
}

/**
 * 构造 dismiss visibilityKey：拼全部 sessions（threadId:phase:lastActivityAt:detail）
 * + planningKeys 含 dueAt/overdue（id:dueAt:overdue）。对齐 Proma agent-island-service.ts:558-566。
 *
 * key 不变的语义：用户 dismiss 后，仅当**任一** session 状态变化（含非 primary）
 * 或**任一** planning item 的 dueAt/overdue 翻转时才解除隐藏。
 * 仅靠 id（不含 dueAt）会导致改 dueAt 不解除 dismiss —— 与 Proma 行为不一致。
 */
export function buildVisibilityKey(
  sessions: IslandSessionInput[],
  planning: AgentIslandPlanningSnapshot,
): string {
  const sessionsPart = sessions
    .map((s) => `${s.threadId}:${s.phase}:${s.lastActivityAt}:${s.detail}`)
    .join('|')
  const planningPart = [...planning.todos, ...planning.reminders]
    .map((p) => `${p.id}:${p.dueAt}:${p.overdue ? 1 : 0}`)
    .join(',')
  return `${sessionsPart}::${planningPart}`
}

export function projectPlanning(
  input: { todos: AgentIslandPlanningItem[]; reminders: AgentIslandPlanningItem[] },
  now: number,
): AgentIslandPlanningSnapshot {
  const within = (it: AgentIslandPlanningItem) =>
    it.overdue || it.dueAt - now <= PLANNING_ATTENTION_WINDOW_MS
  return {
    todos: input.todos.filter(within),
    reminders: input.reminders.filter(within),
  }
}

/**
 * compact 紧迫 planning 图标：无 primary session 时，若存在 1h window 内的
 * imminent event/todo，返回对应彩色图标（对齐 Proma AgentIslandApp.tsx:77-87）。
 * - reminder（calendar_event）→ calendar，accent 色
 * - todo → checklist，warning 色
 * - 平局（同 dueAt）倾向 calendar（events 通常更具时效约束）
 * - 仅逾期或远期项 → null（逾期已在 planning 列表红框标记，imminent 只看未来）
 */
export interface PlanningIndicator {
  symbol: 'calendar' | 'checklist'
  color: string
}

export function selectPlanningIndicator(
  planning: AgentIslandPlanningSnapshot,
  now: number,
): PlanningIndicator | null {
  const win = PLANNING_ATTENTION_WINDOW_MS
  const nextEvent = planning.reminders.find((r) => r.dueAt >= now && r.dueAt - now <= win)
  const nextTodo = planning.todos.find((t) => t.dueAt >= now && t.dueAt - now <= win)
  if (nextEvent && (!nextTodo || nextEvent.dueAt <= nextTodo.dueAt))
    return { symbol: 'calendar', color: 'var(--lume-accent)' }
  if (nextTodo) return { symbol: 'checklist', color: 'var(--lume-warning)' }
  return null
}

export function buildSnapshot(
  inputs: IslandSessionInput[],
  planning: AgentIslandPlanningSnapshot,
  now: number,
): AgentIslandState {
  const { primarySessionId, sessions } = selectPrimarySession(inputs)
  const primary = sessions.find((s) => s.threadId === primarySessionId) ?? null
  const label = primary ? PHASE_LABEL[primary.phase] : '工作提醒'
  return {
    presentation: inputs.length > 0 || planning.todos.length > 0 || planning.reminders.length > 0
      ? 'compact'
      : 'hidden',
    primarySessionId,
    compactLabel: `Lume · ${label}`,
    sessions: sessions.map<AgentIslandSessionSnapshot>((s) => ({ ...s })),
    planning,
    updatedAt: now,
  }
}
