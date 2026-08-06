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
  /** 所属工作区/项目名（小字号显示在 title 后，来自 AgentWorkspace.name）。 */
  project?: string
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
  /** 所属工作区名（session 后小字号显示）。 */
  project?: string
  /** 用于 'set-expanded-height'：展开内容真实高度（px），main 据此调用 clampIslandHeight。 */
  expandedHeight?: number
}

export const AGENT_ISLAND_IPC_CHANNELS = {
  /** main → 岛屿窗口：推送状态快照（事件通道） */
  STATE: 'agent:island:state',
  /** 岛屿窗口 → main：用户意图（invoke 命令，下划线风格，匹配 dispatchCommand case） */
  INTENT: 'agent_island_intent',
} as const

// ────────────────────────────────────────────────────────────
// Phase 2：原生 macOS helper 的 JSONL 协议（main ↔ Swift）
// ────────────────────────────────────────────────────────────

/** 主进程 → Swift helper 的 JSONL 全量状态。Lume 无 planQuotas。 */
export interface NativeAgentIslandSnapshot {
  type: 'snapshot'
  protocol: 1
  /** 单调递增；Swift 据此丢弃乱序/重复快照。 */
  revision: number
  state: AgentIslandState
}

/** Swift helper → 主进程的受限事件。intent 与 Electron renderer 共用 AgentIslandIntentName。 */
export type NativeAgentIslandEvent =
  | { type: 'ready'; protocol: 1 }
  | { type: 'fatal'; message: string }
  | { type: 'intent'; name: 'set-expanded'; value: boolean }
  | { type: 'intent'; name: 'set-hovered'; value: boolean }
  | { type: 'intent'; name: 'open-main' }
  | { type: 'intent'; name: 'open-session'; threadId: string }
  | { type: 'intent'; name: 'open-planning' }
  | { type: 'intent'; name: 'dismiss' }

/** native intent → service 能理解的形状（与 renderer intent 归并到同一 handler）。 */
export function nativeEventToIntent(event: Extract<NativeAgentIslandEvent, { type: 'intent' }>): {
  name: AgentIslandIntentName
  value?: boolean
  threadId?: string
} {
  switch (event.name) {
    case 'set-expanded': return { name: 'set-expanded', value: event.value }
    case 'set-hovered': return { name: 'set-hovered', value: event.value }
    case 'open-session': return { name: 'open-session', threadId: event.threadId }
    case 'open-main': return { name: 'open-main' }
    case 'open-planning': return { name: 'open-main' }   // Lume 无独立 planning 窗，降级打开主窗
    case 'dismiss': return { name: 'dismiss' }
  }
}
