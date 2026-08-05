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
  NativeAgentIslandSnapshot,
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
  isImmediateAgentIslandEvent,
  isStaleSession,
  mapRuntimePhaseToIslandPhase,
  projectPlanning,
  pushActivityLine,
  selectHoverDelay,
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
  /** Phase 2：若 native host ready，同步推送快照；否则忽略。 */
  publishNativeSnapshot?: (snapshot: NativeAgentIslandSnapshot) => void
  /** Phase 2：native host 是否 ready（main.ts 路由：macOS26+ 且 helper 已握手）。 */
  isNativeReady?: () => boolean
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

/** sidecar `agent:runtime-event` 通知的宽松形状（只取灵动岛关心的字段）。 */
interface RuntimeEventPayload {
  threadId?: string
  event?: {
    type?: string
    toolName?: string
  }
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
  /**
   * 即时的指针 hover 状态（不进 state，仅 service 内部用）。
   * 对齐 Proma pointerHovered：驱动高亮反馈（renderer 侧用 CSS :hover），
   * 与延迟的 hoverExpanded 分离，避免鼠标掠过立即展开又收起。
   */
  private pointerHovered = false
  /** hover 防疫定时器：进入/离开时延迟翻转 hoverExpanded（防抖）。 */
  private hoverTimer: ReturnType<typeof setTimeout> | null = null
  private dismissedKey: string | null = null
  private lastPushAt = 0
  private lastStateJson = ''
  /** Phase 2：native snapshot 单调版本号，Swift 据此丢弃乱序/重复快照。 */
  private revision = 0
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
    } else if (method === 'agent:runtime-event') {
      // sidecar 在每次工具调用、消息追加、run 生命周期都会发 runtime-event；
      // 这里只关心 tool.started —— 它是工具活动的权威信号（携带 toolName），
      // 比 runtime-status-changed.toolName 更精确（后者仅在 phase 变化时携带）。
      this.applyRuntimeEvent(params as RuntimeEventPayload | undefined)
    }
    // 紧迫事件（permission/ask_user/run 终态/tool.started）提权到 80ms 桶：
    // 即使聚合 phase 尚未翻转，事件本身也能让岛屿在 ~80ms 内浮现（不等待 2000ms）。
    const immediate = isImmediateAgentIslandEvent(method, params)
    this.push(false, immediate)
  }

  /** 处理岛屿窗口回传的用户意图。 */
  async handleIntent(intent: AgentIslandIntent): Promise<void> {
    switch (intent.name) {
      case 'set-expanded':
        this.manuallyExpanded = intent.value === true
        // 显式收起应立即终结任何 pending 的 hover 展开——否则点击收起后
        // 延迟到期会把岛屿又拉开（"click 收起被忽略"的错觉）。对齐 Proma
        // agent-island-service.ts:858-865 setAgentIslandExpanded 收起分支。
        if (!this.manuallyExpanded) {
          this.hoverExpanded = false
          this.clearHoverTimer()
        }
        break
      case 'set-hovered': {
        // 即时记下指针状态（仅内部），延迟翻转 hoverExpanded——鼠标掠过不会
        // 立即展开又收起。重复 set-hovered 事件清旧 timer（防抖）。
        // 对齐 Proma agent-island-service.ts:869-883 setAgentIslandHovered。
        const hovered = intent.value === true
        this.pointerHovered = hovered
        this.clearHoverTimer()
        this.hoverTimer = setTimeout(() => {
          this.hoverTimer = null
          if (this.hoverExpanded === hovered) return
          this.hoverExpanded = hovered
          this.push(true)
        }, selectHoverDelay(hovered))
        break
      }
      case 'dismiss':
        this.dismissedKey = buildVisibilityKey(
          [...this.sessions.values()],
          projectPlanning(this.planning, Date.now()),
        )
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
    const toolName = status.toolName?.trim() ?? ''
    // 兜底：正常路径下 tool.started 事件已先于 status 把 toolName 推入 activityLines；
    // 此分支仅在 runtime-event 未路由（或会话首次注册）且 status 携带 toolName 时，
    // 保证 activityLines 至少有一条而非空数组——Swift/Surface 才能显示。
    const prevActivity = prev?.activityLines ?? []
    const activityLines =
      toolName && prevActivity.length === 0 ? pushActivityLine(prevActivity, toolName) : prevActivity
    this.sessions.set(status.threadId, {
      threadId: status.threadId,
      title: prev?.title ?? status.threadId,
      phase,
      ...(interactionKind ? { interactionKind } : {}),
      detail: toolName,
      activityLines,
      attention: phase === 'needs-interaction',
      unread: phase === 'completed' || phase === 'error',
      terminalAt: phase === 'completed' || phase === 'error' ? Date.now() : prev?.terminalAt ?? null,
      lastActivityAt: status.updatedAt ?? Date.now(),
    })
  }

  /**
   * 处理 sidecar `agent:runtime-event` 通知：仅在 tool.started 时累积 activityLine。
   * 会话尚未注册（status 未到）则忽略——applyStatus 兜底分支会在 status 到达时补一条。
   */
  private applyRuntimeEvent(payload: RuntimeEventPayload | undefined): void {
    const { threadId, event } = payload ?? {}
    if (!threadId || !event || event.type !== 'tool.started') return
    const toolName = event.toolName?.trim()
    if (!toolName) return
    const prev = this.sessions.get(threadId)
    if (!prev) return
    this.sessions.set(threadId, {
      ...prev,
      activityLines: pushActivityLine(prev.activityLines, toolName),
      lastActivityAt: Date.now(),
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

  private prune(now: number): void {
    for (const [id, s] of this.sessions) {
      // 终态会话（completed/error，有 terminalAt）按 UNREAD_RETAIN_MS（10min）清；
      // running/idle 无 terminalAt，旧逻辑永不清 → 用 isStaleSession（24h 无活动）兜底，
      // 防止幽灵会话累积（对齐 Proma agent-island-service.ts:385 isIslandSession）。
      if (s.terminalAt && now - s.terminalAt > UNREAD_RETAIN_MS) this.sessions.delete(id)
      else if (isStaleSession(s, now)) this.sessions.delete(id)
    }
  }

  private push(force: boolean, immediate = false): void {
    if (!this.deps.isEnabled()) return
    const now = Date.now()
    this.prune(now)
    // 复用同一 planning 投影给 buildSnapshot 与 buildVisibilityKey（避免重复 projectPlanning）。
    const planningSnapshot = projectPlanning(this.planning, now)
    const state: AgentIslandState = buildSnapshot(
      [...this.sessions.values()],
      planningSnapshot,
      now,
    )
    const expanded = this.manuallyExpanded || this.hoverExpanded
    state.presentation =
      state.presentation === 'hidden' ? 'hidden' : expanded ? 'expanded' : 'compact'
    // dismiss：visibility key 不变则保持隐藏；一旦 key 变化（新会话/新 planning）自动解除。
    if (
      this.dismissedKey &&
      buildVisibilityKey([...this.sessions.values()], planningSnapshot) === this.dismissedKey
    ) {
      state.presentation = 'hidden'
    } else {
      this.dismissedKey = null
    }
    const json = JSON.stringify(state)
    if (!force && json === this.lastStateJson) return
    // 节流：force / immediate（事件级）/ urgent（state 级）走 80ms 桶；普通 token 流走 2000ms。
    // 去掉原先 `state.presentation !== 'hidden'` 守卫——hidden 时由上面 json 去重已足够，
    // immediate 在 dismissed/hidden 时仍能 80ms 浮现更符合"紧迫事件即时反馈"语义。
    const throttle =
      force || immediate || this.urgent(state)
        ? PUSH_THROTTLE_MS
        : AGENT_STREAM_PUSH_THROTTLE_MS
    if (!force && now - this.lastPushAt < throttle) return
    this.lastPushAt = now
    this.lastStateJson = json
    // Phase 2：native 推送与 Electron 窗口创建完全解耦——ensure 抛错也不影响 native。
    if (this.deps.isNativeReady?.()) {
      this.deps.publishNativeSnapshot?.({
        type: 'snapshot',
        protocol: 1,
        revision: this.revision++,
        state,
      })
    }
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

  /** 清 pending hover 定时器（防抖与销毁时调用）。 */
  private clearHoverTimer(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer)
      this.hoverTimer = null
    }
  }

  destroy(): void {
    if (this.planningTimer) clearInterval(this.planningTimer)
    this.planningTimer = null
    this.clearHoverTimer()
    this.pointerHovered = false
    this.hoverExpanded = false
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
