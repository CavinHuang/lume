import type { AgentRuntimePhase } from "./types/agent"
import type {
  AgentIslandPhase,
  AgentIslandPlanningItem,
  AgentIslandPlanningSnapshot,
  AgentIslandSessionSnapshot,
  AgentIslandState,
} from "./types/agent-island"

const PLANNING_ATTENTION_WINDOW_MS = 60 * 60_000 // 1h

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

const PHASE_PRIORITY: Record<AgentIslandPhase, number> = {
  'needs-interaction': 0,
  running: 1,
  completed: 2,
  error: 3,
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

export function buildVisibilityKey(
  primary: IslandSessionInput | null,
  planningKeys: string[],
): string {
  if (!primary) return planningKeys.join('|')
  return [
    primary.threadId,
    primary.phase,
    primary.lastActivityAt,
    primary.detail,
    planningKeys.join(','),
  ].join(':')
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
