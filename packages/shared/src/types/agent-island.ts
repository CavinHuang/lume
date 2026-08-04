/** Agent 灵动岛类型契约。设计参考 Cindy (makecindy/cindy) 的 Agent Island。 */

export type AgentIslandPhase =
  | 'idle'
  | 'running'
  | 'needs-interaction'
  | 'completed'
  | 'error'

export type AgentIslandPresentation = 'hidden' | 'compact' | 'expanded'

export type AgentIslandInteractionKind =
  | 'permission'
  | 'ask_user_question'
  | 'plan_review'
  | 'desktop_action' // Lume 特有扩展

export interface AgentIslandSessionSnapshot {
  threadId: string
  title: string
  phase: AgentIslandPhase
  interactionKind?: AgentIslandInteractionKind
  detail: string
  activityLines: string[]
  attention: boolean
  unread: boolean
  terminalAt: number | null
  lastActivityAt: number
}

export interface AgentIslandPlanningItem {
  id: string
  title: string
  kind: 'todo' | 'calendar_event'
  dueAt: number
  overdue: boolean
}

export interface AgentIslandPlanningSnapshot {
  todos: AgentIslandPlanningItem[]
  reminders: AgentIslandPlanningItem[]
}

export interface AgentIslandState {
  presentation: AgentIslandPresentation
  primarySessionId: string | null
  compactLabel: string
  sessions: AgentIslandSessionSnapshot[]
  planning: AgentIslandPlanningSnapshot
  updatedAt: number
}

/** 推给岛屿窗口的完整包（Electron 路径需要 expandedHeight）。 */
export interface AgentIslandWindowSnapshot {
  state: AgentIslandState
  expandedHeight: number
}

export type AgentIslandIntentName =
  | 'set-expanded'
  | 'set-hovered'
  | 'dismiss'
  | 'open-main'
  | 'open-session'
  | 'set-expanded-height'

export interface AgentIslandIntent {
  name: AgentIslandIntentName
  value?: boolean
  threadId?: string
  /** 用于 'set-expanded-height'：展开内容真实高度（px），main 据此调用 clampIslandHeight。 */
  expandedHeight?: number
}

export const AGENT_ISLAND_IPC_CHANNELS = {
  /** main → 岛屿窗口：推送状态快照（事件通道） */
  STATE: 'agent:island:state',
  /** 岛屿窗口 → main：用户意图（invoke 命令，下划线风格，匹配 dispatchCommand case） */
  INTENT: 'agent_island_intent',
} as const
