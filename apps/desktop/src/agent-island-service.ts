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
  AgentIslandRecentSession,
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
  msUntilNextMidnightRollover,
  nextPlanningAttentionTime,
  PLANNING_ATTENTION_WINDOW_MS,
  projectRecentSessions,
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
  /** 把主窗口切换到待办面板；传 todoId 则定位到该待办，否则打开列表。 */
  openTodo: (todoId?: string) => void
  /** 打开主窗并新建会话（复用 tray new-thread 导航）。 */
  newSession: () => void
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
    // run.started：当前会话模型（runtime-event.ts:68-79）
    model?: { provider?: string; modelId?: string; modelRef?: string; channelId?: string; contextWindow?: number }
    // usage.updated：sidecar 维护的累计成本/token（runtime-event.ts:855-868，覆盖不累加）
    billing?: { totalCostUSD?: number; cumulative?: { totalTokens?: number }; records?: unknown[] }
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
  /** threadId → title 缓存（list-threads 获取，避免灵动岛显示 raw threadId）。 */
  private threadTitles = new Map<string, string>()
  /** threadId → workspaceId（list-threads 的 meta.workspaceId）。 */
  private threadWorkspaces = new Map<string, string>()
  /** workspaceId → workspace name（list-workspaces 解析，session 后小字号显示"项目"）。 */
  private workspaceNames = new Map<string, string>()
  /**
   * 最近会话投影（无 active session 时 idle home surface 展示，top3）。
   * 由 refreshThreadMetas 从 agent:list-threads 投影，排除 active session 与 archived/trashed。
   */
  private recentSessions: AgentIslandRecentSession[] = []
  /**
   * 跨日 rollover 定时器：到下个午夜 00:00:00.150 触发——清 dismissedKey
   * （解除所有 dismiss，新一天重新浮现 planning/agent 状态）+ force push + 重排下个 rollover/attention。
   * 对齐 Proma agent-island-service.ts:671-683 `scheduleNextPlanningRollover`。
   */
  private rolloverTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 紧迫 planning attention 定时器：未来 todo/reminder 进入 1h 注意窗的瞬间触发 force push，
   * 让岛屿即时浮现紧迫项——而非等到下个 5min 轮询周期。refreshPlanning 后重排（planning 变了，
   * attention 时刻可能变）。对齐 Proma agent-island-service.ts:685-707。
   */
  private attentionTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private deps: AgentIslandServiceDeps) {}

  /** 启动：拉取首批 planning、启动周期刷新、强制首推、调度跨日/紧迫 planning 定时器。 */
  async start(): Promise<void> {
    await this.refreshPlanning()
    void this.refreshThreadMetas()
    void this.refreshWorkspaces()
    this.planningTimer = setInterval(() => {
      void this.refreshPlanning()
    }, PLANNING_REFRESH_MS)
    this.scheduleNextPlanningRollover()
    this.scheduleNextPlanningAttention()
    this.push(true)
  }

  /**
   * renderer 就绪后补推（M-6 首推竞态）：清 lastStateJson 强制下次 push 真推一次
   * （绕过去重——即使 state 没变，新 renderer 进程也从未收到过），再 force push
   * 绕过节流。由 main.ts 在岛屿窗口 `did-finish-load` +120ms 后调用。
   * 对齐 Proma agent-island-service.ts:783-787。
   */
  repush(): void {
    this.lastStateJson = ''
    this.push(true)
  }

  /**
   * 拉取 thread 元数据（sidecarCall agent:list-threads）：
   * - 缓存 title/workspaceId（applyStatus 用 title 替代 raw threadId）
   * - 为 active session 补初始 modelRef（run.started 后会被实时值覆盖）
   * - 投影 recentSessions（idle home surface 用，排除 active/archived/trashed，top3）
   */
  private async refreshThreadMetas(): Promise<void> {
    try {
      const threads = await this.deps.callSidecar<
        Array<{
          id: string
          title?: string
          workspaceId?: string
          modelRef?: string
          updatedAt?: number
          status?: string
        }>
      >('agent:list-threads')
      if (Array.isArray(threads)) {
        for (const t of threads) {
          if (!t.id) continue
          if (t.title) this.threadTitles.set(t.id, t.title)
          if (t.workspaceId) this.threadWorkspaces.set(t.id, t.workspaceId)
          // active session 的初始 modelRef（若未收到 run.started 则用 thread meta 兜底）
          if (t.modelRef) {
            const prev = this.sessions.get(t.id)
            if (prev && !prev.modelRef) this.sessions.set(t.id, { ...prev, modelRef: t.modelRef })
          }
        }
        // recent 投影（排除仍在 sessions Map 的 active、archived/trashed，dedup，top3）
        this.recentSessions = projectRecentSessions(
          threads,
          new Set(this.sessions.keys()),
          this.workspaceNames,
        )
      }
    } catch {
      // 静默失败：recent 不可用时 idle 显示空引导
    }
    this.push(false)
  }

  /** 拉取 workspace name 缓存（list-workspaces），session project 显示用。 */
  private async refreshWorkspaces(): Promise<void> {
    try {
      const workspaces = await this.deps.callSidecar<Array<{ id: string; name?: string }>>('agent:list-workspaces')
      if (Array.isArray(workspaces)) {
        for (const w of workspaces) {
          if (w.id && w.name) this.workspaceNames.set(w.id, w.name)
        }
        this.push(false)
      }
    } catch {
      // 静默失败：workspace 不可用时 project 字段为空
    }
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
        this.dismissedKey = buildVisibilityKey([...this.sessions.values()], this.planning)
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
      case 'open-todo':
        // 打开主窗待办面板；todoId 缺省时打开列表，传 id 则定位到该待办（renderer 端 openTodos 处理）。
        this.deps.openTodo(intent.todoId)
        break
      case 'new-session':
        // 打开主窗并新建会话（复用 tray new-thread 导航，聚焦 composer）。
        this.deps.newSession()
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
      title: prev?.title ?? this.threadTitles.get(status.threadId) ?? status.threadId,
      project: prev?.project ?? this.workspaceNames.get(this.threadWorkspaces.get(status.threadId) ?? '') ?? undefined,
      phase,
      ...(interactionKind ? { interactionKind } : {}),
      detail: toolName,
      activityLines,
      attention: phase === 'needs-interaction',
      unread: phase === 'completed' || phase === 'error',
      // 非终态必须清零 terminalAt:否则完成后追问的场景保留旧终态时间戳,
      // run 超过 10min 时 prune 会把正在 running 的会话误删(丢失累计 cost/token)(#125)
      terminalAt: phase === 'completed' || phase === 'error' ? Date.now() : null,
      lastActivityAt: status.updatedAt ?? Date.now(),
      // status 覆盖式 set：必须显式保留 prev 的 run/usage 写入值，否则被清空。
      modelRef: prev?.modelRef,
      costUSD: prev?.costUSD,
      tokenTotal: prev?.tokenTotal,
      queuedCount: status.queuedCount ?? prev?.queuedCount ?? 0,
    })
  }

  /**
   * 处理 sidecar `agent:runtime-event` 通知：tap 3 类事件——
   * - tool.started：累积 activityLine（工具活动信号）
   * - run.started：记录当前模型 ref（渲染层解析 label）
   * - usage.updated：覆盖 sidecar 维护的累计 cost/token（不累加，避免翻倍）
   *
   * 会话尚未注册（status 未到）则忽略——applyStatus 兜底分支会在 status 到达时补一条。
   * 解析失败一律跳过该字段、不抛（沿用 service 静默失败约定）。
   */
  private applyRuntimeEvent(payload: RuntimeEventPayload | undefined): void {
    const { threadId, event } = payload ?? {}
    if (!threadId || !event) return
    const prev = this.sessions.get(threadId)
    // tool.started：工具活动信号（保留原逻辑）
    if (event.type === 'tool.started') {
      const toolName = event.toolName?.trim()
      if (!toolName) return
      if (!prev) return
      this.sessions.set(threadId, {
        ...prev,
        activityLines: pushActivityLine(prev.activityLines, toolName),
        lastActivityAt: Date.now(),
      })
      return
    }
    // run.started：记录当前模型 ref（渲染层解析 label，不引 registry）
    if (event.type === 'run.started') {
      const modelRef = event.model?.modelRef
      if (!modelRef || !prev) return
      this.sessions.set(threadId, { ...prev, modelRef, lastActivityAt: Date.now() })
      return
    }
    // usage.updated：sidecar 维护的累计值，直接覆盖（不累加，避免翻倍）
    if (event.type === 'usage.updated') {
      if (!prev) return
      const costUSD = event.billing?.totalCostUSD
      const tokenTotal = event.billing?.cumulative?.totalTokens
      this.sessions.set(threadId, {
        ...prev,
        ...(typeof costUSD === 'number' && Number.isFinite(costUSD) ? { costUSD } : {}),
        ...(typeof tokenTotal === 'number' && Number.isFinite(tokenTotal) ? { tokenTotal } : {}),
      })
    }
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

  /**
   * Planning 变更即时推送（M-3）：sidecar 在 todo/calendar 任意变更时发
   * `planning-todo:changed`（见 planning-todo-handlers.ts:48-55），由 main.ts
   * 的 onNotification 路由到此处。先重拉 planning 快照，再 force push 绕过
   * 2000ms 节流——使完成/改期/新增 todo 后岛屿内容在 ~80ms 内更新，而不是
   * 等下个 5min 轮询周期。refreshPlanning 末尾的 push(false) 仅是节流推送，
   * 随后的 push(true) 用 force=true 绕过节流真正落地。
   */
  async onPlanningChanged(): Promise<void> {
    await this.refreshPlanning()
    this.push(true)
  }

  /**
   * thread 列表/标题变更入口（main.ts 路由 `agent:thread-list-changed` /
   * `agent:title-updated`）：重拉 thread metas 刷新 title/recent 投影，再 force push。
   * title-updated 复用同一入口——标题变化也是 thread list 维度。
   */
  async onThreadListChanged(): Promise<void> {
    await this.refreshThreadMetas()
    this.push(true)
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
    // planning 变了，attention 时刻可能变（新增/改期/完成 todo）——重排定时器。
    this.scheduleNextPlanningAttention()
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
    // planning 全量直传 buildSnapshot/buildVisibilityKey（Task 1 起 projectPlanning 已删除）；
    // recentSessions 由 refreshThreadMetas 维护；isIdle 不显式传，由 buildSnapshot 从空 inputs 推导。
    const state: AgentIslandState = buildSnapshot(
      [...this.sessions.values()],
      this.planning,
      now,
      { recentSessions: this.recentSessions },
    )
    const expanded = this.manuallyExpanded || this.hoverExpanded
    state.presentation =
      state.presentation === 'hidden' ? 'hidden' : expanded ? 'expanded' : 'compact'
    // dismiss：visibility key 不变则保持隐藏；一旦 key 变化（新会话/新 planning）自动解除。
    if (
      this.dismissedKey &&
      buildVisibilityKey([...this.sessions.values()], this.planning) === this.dismissedKey
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

  /**
   * 调度跨日 rollover：到下个午夜 00:00:00.150 清 dismissedKey（解除所有 dismiss——
   * 新一天重新浮现 planning/agent 状态）+ force push，并重排 rollover 与 attention
   * （跨日后 dueAt 相对 today 的窗内位置变了，attention 时刻需重算）。
   * 对齐 Proma agent-island-service.ts:671-683。
   */
  private scheduleNextPlanningRollover(): void {
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer)
    const delay = msUntilNextMidnightRollover(Date.now())
    this.rolloverTimer = setTimeout(() => {
      this.rolloverTimer = null
      this.dismissedKey = null
      this.push(true)
      this.scheduleNextPlanningRollover()
      this.scheduleNextPlanningAttention()
    }, delay)
  }

  /**
   * 调度紧迫 planning attention：未来 todo/reminder 进入 1h 注意窗的瞬间 force push，
   * 让岛屿即时浮现紧迫项（而非等下个 5min 轮询）。无未来进入项则不设定时器。
   * refreshPlanning/onPlanningChanged 后重排（planning 变了，attention 时刻可能变）。
   * 对齐 Proma agent-island-service.ts:685-707。
   */
  private scheduleNextPlanningAttention(): void {
    if (this.attentionTimer) clearTimeout(this.attentionTimer)
    const now = Date.now()
    // 过滤无 dueAt 的 todo（mapPlanningTodo 把它设为 NO_DUE≈MAX_SAFE_INTEGER）——
    // 它们永不进入窗，但会让 enter≈MAX_SAFE_INTEGER，导致 setTimeout 收到 28 万年的
    // delay（Node.js 把超过 2^31ms 的 delay 截断为 1ms，会立即触发再重排，形成 busy loop）。
    const planning = {
      todos: this.planning.todos.filter((t) => t.dueAt !== NO_DUE),
      reminders: this.planning.reminders,
    }
    const enter = nextPlanningAttentionTime(planning, now, PLANNING_ATTENTION_WINDOW_MS)
    if (enter === null) return
    this.attentionTimer = setTimeout(() => {
      this.attentionTimer = null
      this.push(true)
      this.scheduleNextPlanningAttention()
    }, enter - now)
  }

  destroy(): void {
    if (this.planningTimer) clearInterval(this.planningTimer)
    this.planningTimer = null
    if (this.rolloverTimer) clearTimeout(this.rolloverTimer)
    this.rolloverTimer = null
    if (this.attentionTimer) clearTimeout(this.attentionTimer)
    this.attentionTimer = null
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
