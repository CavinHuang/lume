/**
 * Agent 灵动岛 service：订阅 sidecar 通知、聚合会话状态、节流推送快照到岛屿窗口。
 *
 * 纯投影逻辑见 packages/shared/src/agent-island-projections.ts（Task 3，已单测）。
 * 本 service 是订阅/聚合/推送壳，按 spec §6.3 不强求单测，端到端验证在 Task 11。
 */
import type { BrowserWindow } from 'electron'
import type { AgentRuntimePhase } from '../../../packages/shared/src/types/agent'
import type {
  AgentIslandIntent,
  AgentIslandInteractionKind,
  AgentIslandPhase,
  AgentIslandPlanningItem,
  AgentIslandState,
} from '../../../packages/shared/src/types/agent-island'
import type {
  ActivePlanningReminder,
  PlanningTodo,
  PlanningTodoListResult,
} from '../../../packages/shared/src/types/planning-todo'
import {
  AGENT_ISLAND_IPC_CHANNELS,
} from '../../../packages/shared/src/types/agent-island'
import {
  buildSnapshot,
  buildVisibilityKey,
  mapRuntimePhaseToIslandPhase,
  projectPlanning,
  selectPrimarySession,
} from '../../../packages/shared/src/agent-island-projections'
import type { IslandSessionInput } from '../../../packages/shared/src/agent-island-projections'

const PUSH_THROTTLE_MS = 80
const AGENT_STREAM_PUSH_THROTTLE_MS = 2000
const PLANNING_REFRESH_MS = 5 * 60_000
const UNREAD_RETAIN_MS = 10 * 60_000

/** 由 main.ts 注入的主进程依赖。 */
export interface AgentIslandServiceDeps {
  /** 岛屿功能是否启用（读取 generalSettings.agentIsland.enabled）。 */
  isEnabled: () => boolean
  /** 获取已创建的岛屿窗口（可能为 null/已销毁）。 */
  getIslandWindow: () => BrowserWindow | null
  /** 按需创建岛屿窗口；推送前调用以保证窗口存在。 */
  ensureIslandWindow: () => BrowserWindow
  /** 调 sidecar JSON-RPC（main 已有 sidecarHost.call）。 */
  callSidecar: <T = unknown>(method: string, params?: unknown) => Promise<T>
  /** 显示并聚焦主窗口。 */
  openMain: () => void
  /** 把主窗口切换到指定 thread（best-effort，使用与 tray 相同的导航路径）。 */
  openSession: (threadId: string) => void
  /** 测得的展开内容高度回写：main 调 clampIslandHeight 调整 BrowserWindow 高度。 */
  setExpandedHeight: (height: number) => void
}

/** sidecar runtime-status 通知中 status 字段的宽松形状。 */
interface RuntimeStatusLike {
  threadId: string
  phase: AgentRuntimePhase | string
  queuedCount?: number
  toolName?: string
  interactiveKind?: 'tool_permission' | 'ask_user_question' | string
  updatedAt: number
}

interface PlanningCache {
  todos: AgentIslandPlanningItem[]
  reminders: AgentIslandPlanningItem[]
}

const NO_DUE = Number.MAX_SAFE_INTEGER

export class AgentIslandService {
  private sessions = new Map<string, IslandSessionInput>()
  private planning: PlanningCache = { todos: [], reminders: [] }
  private manuallyExpanded = false
  private hoverExpanded = false
  private dismissedKey: string | null = null
  private lastPushAt = 0
  private lastStateJson = ''
  private planningTimer: ReturnType<typeof setInterval> | null = null

  constructor(private deps: AgentIslandServiceDeps) {}

  /** 启动：拉取首批 planning、启动周期刷新、强制首推。 */
  async start(): Promise<void> {
    await this.refreshPlanning()
    this.planningTimer = setInterval(() => {
      void this.refreshPlanning()
    }, PLANNING_REFRESH_MS)
    this.push(true)
  }

  /** 由 main.ts onNotification 调用：tap sidecar 事件流。 */
  handleSidecarNotification(method: string, params: unknown): void {
    if (method === 'agent:runtime-status-changed') {
      const status = (params as { status?: RuntimeStatusLike })?.status
      if (status) this.applyStatus(status)
    }
    // 其他事件（tool/task 活动、permission/ask_user/desktop_action）目前通过
    // runtime-status-changed 的 phase 变化（awaiting_permission / awaiting_user_answer）
    // 间接反映；其 activityLines 富化留待后续基于真实 sidecar 事件参数形状增量补充。
    this.push(false)
  }

  /** 处理岛屿窗口回传的用户意图。 */
  async handleIntent(intent: AgentIslandIntent): Promise<void> {
    switch (intent.name) {
      case 'set-expanded':
        this.manuallyExpanded = intent.value === true
        break
      case 'set-hovered':
        this.hoverExpanded = intent.value === true
        break
      case 'dismiss':
        this.dismissedKey = buildVisibilityKey(this.primaryInput(), this.planningKeys())
        this.manuallyExpanded = false
        break
      case 'open-main':
        this.deps.openMain()
        break
      case 'open-session':
        if (intent.threadId) {
          this.markRead(intent.threadId)
          this.deps.openSession(intent.threadId)
        }
        break
      case 'set-expanded-height': {
        // 高度反馈环（spec §3.2）：仅调整窗口尺寸，不触发 push（否则 renderer↔main 形成回环）。
        const h = typeof intent.expandedHeight === 'number' ? intent.expandedHeight : 32
        this.deps.setExpandedHeight(h)
        return
      }
    }
    this.push(true)
  }

  private applyStatus(status: RuntimeStatusLike): void {
    const phase = mapRuntimePhaseToIslandPhase(status.phase as AgentRuntimePhase)
    const prev = this.sessions.get(status.threadId)
    const interactionKind = this.deriveInteractionKind(phase, status)
    this.sessions.set(status.threadId, {
      threadId: status.threadId,
      title: prev?.title ?? status.threadId,
      phase,
      ...(interactionKind ? { interactionKind } : {}),
      detail: status.toolName ?? '',
      activityLines: prev?.activityLines ?? [],
      attention: phase === 'needs-interaction',
      unread: phase === 'completed' || phase === 'error',
      terminalAt: phase === 'completed' || phase === 'error' ? Date.now() : prev?.terminalAt ?? null,
      lastActivityAt: status.updatedAt ?? Date.now(),
    })
  }

  private deriveInteractionKind(
    phase: AgentIslandPhase,
    status: RuntimeStatusLike,
  ): AgentIslandInteractionKind | undefined {
    if (phase !== 'needs-interaction') return undefined
    if (status.interactiveKind === 'tool_permission') return 'permission'
    if (status.interactiveKind === 'ask_user_question') return 'ask_user_question'
    return undefined
  }

  private markRead(threadId: string): void {
    const s = this.sessions.get(threadId)
    if (s && s.unread) this.sessions.set(threadId, { ...s, unread: false })
  }

  private async refreshPlanning(): Promise<void> {
    try {
      const [todosRes, remindersRaw] = await Promise.all([
        this.deps.callSidecar<PlanningTodoListResult>('planning-todo:list', { view: 'open' }),
        this.deps.callSidecar<unknown>('planning-todo:list-active-reminders', {}),
      ])
      // sidecar handler 直接 return calendar.listActiveReminders()，返回裸数组
      // (planning-calendar-store.ts:584 `listActiveReminders(...): ActivePlanningReminder[]`)。
      // 这里同时兼容 { items: [...] } 包装以防将来 drift；todos 路径则真用 PlanningTodoListResult.items。
      const reminders = Array.isArray(remindersRaw)
        ? (remindersRaw as ActivePlanningReminder[])
        : ((remindersRaw as { items?: ActivePlanningReminder[] })?.items ?? [])
      const now = Date.now()
      this.planning = {
        todos: (todosRes?.items ?? []).map((t) => mapPlanningTodo(t, now)),
        reminders: reminders.map((r) => mapActiveReminder(r, now)),
      }
    } catch {
      // 静默失败：planning 不可用时岛屿仅反映 agent 运行态。
    }
    this.push(false)
  }

  private primaryInput(): IslandSessionInput | null {
    // 复用 selectPrimarySession（phase 优先级 + lastActivityAt），保证 dismiss 构造的
    // visibilityKey 与 buildSnapshot 显示的主导会话一致；否则二者可能选出不同 session。
    const { primarySessionId } = selectPrimarySession([...this.sessions.values()])
    if (!primarySessionId) return null
    return this.sessions.get(primarySessionId) ?? null
  }

  private planningKeys(): string[] {
    return [...this.planning.todos, ...this.planning.reminders].map((p) => p.id)
  }

  private prune(now: number): void {
    for (const [id, s] of this.sessions) {
      if (s.terminalAt && now - s.terminalAt > UNREAD_RETAIN_MS) this.sessions.delete(id)
    }
  }

  private push(force: boolean): void {
    if (!this.deps.isEnabled()) return
    const now = Date.now()
    this.prune(now)
    const state: AgentIslandState = buildSnapshot(
      [...this.sessions.values()],
      projectPlanning(this.planning, now),
      now,
    )
    const expanded = this.manuallyExpanded || this.hoverExpanded
    state.presentation =
      state.presentation === 'hidden' ? 'hidden' : expanded ? 'expanded' : 'compact'
    // dismiss：visibility key 不变则保持隐藏；一旦 key 变化（新会话/新 planning）自动解除。
    if (
      this.dismissedKey &&
      buildVisibilityKey(this.primaryInput(), this.planningKeys()) === this.dismissedKey
    ) {
      state.presentation = 'hidden'
    } else {
      this.dismissedKey = null
    }
    const json = JSON.stringify(state)
    if (!force && json === this.lastStateJson) return
    const throttle =
      state.presentation !== 'hidden' && this.urgent(state)
        ? PUSH_THROTTLE_MS
        : AGENT_STREAM_PUSH_THROTTLE_MS
    if (!force && now - this.lastPushAt < throttle) return
    this.lastPushAt = now
    this.lastStateJson = json
    let win = this.deps.getIslandWindow()
    if (!win || win.isDestroyed()) {
      try {
        win = this.deps.ensureIslandWindow()
      } catch {
        return // ensure 失败：本次推送丢弃，下次 push 重试。
      }
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send(`lume:event:${AGENT_ISLAND_IPC_CHANNELS.STATE}`, { state })
    }
  }

  private urgent(state: AgentIslandState): boolean {
    return state.sessions.some(
      (s) => s.phase === 'needs-interaction' || s.phase === 'completed' || s.phase === 'error',
    )
  }

  destroy(): void {
    if (this.planningTimer) clearInterval(this.planningTimer)
    this.planningTimer = null
  }
}

/** PlanningTodo → AgentIslandPlanningItem（kind='todo'）。无 dueAt 视为永不进入 1h 紧迫窗。 */
function mapPlanningTodo(todo: PlanningTodo, now: number): AgentIslandPlanningItem {
  const dueAt = typeof todo.dueAt === 'number' ? todo.dueAt : NO_DUE
  return {
    id: todo.id,
    title: todo.title,
    kind: 'todo',
    dueAt,
    overdue: dueAt !== NO_DUE && dueAt < now,
  }
}

/** ActivePlanningReminder → AgentIslandPlanningItem（kind 取自 targetType）。 */
function mapActiveReminder(
  reminder: ActivePlanningReminder,
  now: number,
): AgentIslandPlanningItem {
  const dueAt = reminder.snoozedUntil ?? reminder.triggerAt
  return {
    id: reminder.id,
    title: reminder.targetTitle,
    kind: reminder.targetType === 'calendar_event' ? 'calendar_event' : 'todo',
    dueAt,
    overdue: dueAt < now,
  }
}
