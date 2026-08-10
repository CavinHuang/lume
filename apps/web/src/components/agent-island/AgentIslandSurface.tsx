import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AppWindow, CalendarDays, ChevronDown, ChevronUp, ListTodo, MessageSquare, X } from 'lucide-react'
import type { AgentIslandIntent, AgentIslandPlanningItem, AgentIslandSessionSnapshot, AgentIslandState } from '@lume/shared'
import { findModelMeta, selectPlanningIndicator } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useModelMetaVersion } from '@/lib/model-meta-context'
import { cn } from '@/lib/utils'
import { IslandMascot } from './IslandMascot'
import './agent-island.css'

const SURFACE_TRANSITION_MS = 180
const COMPACT_HEIGHT = 32
/** expanded planning 两列各自最多直出的条目数；超出走「还有 N 条」溢出提示。 */
const PLANNING_VISIBLE_MAX = 5

const PHASE_DOT: Record<string, string> = {
  idle: 'bg-[var(--lume-text-muted)]',
  running: 'bg-[var(--lume-accent)] animate-pulse',
  'needs-interaction': 'bg-[var(--lume-warning)]',
  completed: 'bg-[var(--lume-success)]',
  error: 'bg-[var(--lume-danger)]',
}

const PHASE_LABEL: Record<string, string> = {
  idle: '空闲',
  running: '执行中',
  'needs-interaction': '待处理',
  completed: '完成',
  error: '出错',
}

const UUID_TITLE = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i

export function formatIslandSessionTitle(title: string, threadId: string): string {
  const normalized = title.trim()
  if (normalized && normalized !== threadId && !UUID_TITLE.test(normalized)) return normalized
  const source = normalized || threadId
  return `未命名会话 · ${source.slice(0, 6)}`
}

/** 灵动岛 planning 行的时间标签：逾期加前缀，否则仅 HH:MM。 */
export function formatIslandTime(ts: number, overdue: boolean): string {
  if (!Number.isFinite(ts)) return ''
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return ''
  const hhmm = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return overdue ? `逾期 · ${hhmm}` : hhmm
}

/**
 * 解析 modelRef 为注册表里的 display label。registry 无此 ref → undefined（渲染层省略 model 段，
 * 不显原始 ref 字符串）。复用 findModelMeta（同 ModelPicker/model-selection-state 的查询入口）。
 */
export function resolveIslandModelLabel(modelRef: string): string | undefined {
  return findModelMeta(modelRef)?.displayName
}

/**
 * 全量 planning 排序：overdue 置顶 + dueAt 升序。expanded 用它直出前 N 条 + 溢出。
 * 抽成纯函数便于单测（无 DOM / state 依赖）。
 */
export function sortIslandPlanningItems<T extends AgentIslandPlanningItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dueAt - b.dueAt)
}

/**
 * 拼接高密度会话行的 model · token 摘要。成本留在会话详情，不占用灵动岛横向空间。
 * 抽成纯函数便于单测；渲染层据返回是否为空决定是否渲染 <span>。
 */
export function formatSessionMeta(
  session: Pick<AgentIslandSessionSnapshot, 'modelRef' | 'costUSD' | 'tokenTotal'>,
  resolveLabel: (ref: string) => string | undefined = resolveIslandModelLabel,
): string {
  const parts: string[] = []
  const modelLabel = session.modelRef ? resolveLabel(session.modelRef) : undefined
  if (modelLabel) parts.push(modelLabel)
  if (session.tokenTotal != null && session.tokenTotal > 0) parts.push(`${(session.tokenTotal / 1000).toFixed(1)}k`)
  return parts.join(' · ')
}

/**
 * idle home surface 最近会话的相对时间标签：Date.now() - updatedAt → 中文相对描述。
 * 阈值：<1min「刚刚」、<1h「N 分钟前」、<24h「N 小时前」、否则「N 天前」。
 * 抽成纯函数便于单测（无 DOM / 时钟副作用）；now 参数测试用，默认 Date.now()。
 * 对未来时间（时钟偏移）兜底成「刚刚」，避免负数分钟。
 */
export function formatRelativeTime(updatedAt: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - updatedAt)
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

type SurfaceMode = 'compact' | 'expanded' | 'collapsing'

function IslandActionButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={(
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            className="island-action-button island-no-drag"
            aria-label={label}
            onClick={onClick}
          >
            {children}
          </Button>
        )}
      />
      <TooltipContent
        side="bottom"
        sideOffset={3}
        className="rounded-[5px] px-2 py-1 text-[9px] leading-none"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Agent 灵动岛纯展示组件。无 IPC、无 jotai，所有用户意图通过 onIntent 上发。
 * 平台形态（mac 圆角 vs 默认浮动矩形）由 CSS 键控 `html.darwin` 类决定，
 * 该类由 desktop preload 注入；组件本身不引用 process.platform（renderer 无 Node）。
 *
 * surfaceMode 状态机（对齐 Proma AgentIslandApp:192-207）：
 * compact ↔ expanded，expanded→compact 走 collapsing（180ms 保留旧内容淡出，避免硬切闪烁）。
 */
export function AgentIslandSurface({
  state,
  onIntent,
}: {
  state: AgentIslandState
  onIntent: (intent: AgentIslandIntent) => void
}) {
  const primary = state.sessions[0]
  // compact 紧迫 planning 图标：仅在无 primary session 时计算（有会话时 dot+label 优先）。
  const planningIndicator = !primary ? selectPlanningIndicator(state.planning, Date.now()) : null
  // model 注册表 version：reload 后 bump，进 useMemo 依赖强制重算 session→meta 映射。
  // 注入由 AgentIslandApp 的 ModelMetaProvider 负责（island 子窗口唯一 mount 点）。
  const modelMetaVersion = useModelMetaVersion()
  // expanded 会话行的 model·cost·token 小字：sessions/version 变化或 registry reload 时重算。
  const sessionMetaById = useMemo(() => {
    const map: Record<string, string> = {}
    for (const s of state.sessions) {
      const meta = formatSessionMeta(s)
      if (meta) map[s.threadId] = meta
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sessions, modelMetaVersion])
  // compact 队列徽章 + attention 数字 pill
  const queueCount = primary?.queuedCount ?? 0
  const needInteractionCount = state.sessions.filter((s) => s.phase === 'needs-interaction').length
  const expandedSessionCount = state.isIdle ? (state.recentSessions?.length ?? 0) : state.sessions.length
  const expandedSummary = [
    `${expandedSessionCount} 会话`,
    state.planning.todos.length > 0 ? `${state.planning.todos.length} 待办` : '',
    state.planning.reminders.length > 0 ? `${state.planning.reminders.length} 提醒` : '',
  ].filter(Boolean).join(' · ')
  const requestedExpanded = state.presentation === 'expanded'
  const expandedContentRef = useRef<HTMLDivElement>(null)
  const lastHeightRef = useRef(COMPACT_HEIGHT)
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>(requestedExpanded ? 'expanded' : 'compact')
  const [expandedHeight, setExpandedHeight] = useState(COMPACT_HEIGHT)

  // surfaceMode 状态机：expanded→compact 走 collapsing（保留旧内容淡出 180ms）
  useEffect(() => {
    if (requestedExpanded) {
      setSurfaceMode('expanded')
      return
    }
    if (surfaceMode !== 'compact') {
      setSurfaceMode('collapsing')
      const t = setTimeout(() => setSurfaceMode('compact'), SURFACE_TRANSITION_MS)
      return () => clearTimeout(t)
    }
  }, [requestedExpanded, surfaceMode])

  // 测量 expanded-content 真实高度：仅在 expanded/collapsing（.island-expanded 已挂载）时测。
  // 依赖含 surfaceMode——首次 expanded 时 surfaceMode 从 compact→expanded，此时 .island-expanded
  // 才挂载，必须重测；否则测量发生在挂载前，拿到 compact 32px 导致展开内容被截断。
  useLayoutEffect(() => {
    if (surfaceMode === 'compact') return
    const el = expandedContentRef.current
    const h = Math.max(COMPACT_HEIGHT, Math.ceil(el?.getBoundingClientRect().height ?? COMPACT_HEIGHT))
    setExpandedHeight((prev) => (prev === h ? prev : h))
  }, [state, surfaceMode])

  // 高度反馈：surfaceMode 决定 surface 高度，变化时回传 main 调窗口高度
  // （width 固定 420 from window 创建，只 height 动态——等价 Proma resize(420, height)）
  useEffect(() => {
    const h = surfaceMode === 'compact' ? COMPACT_HEIGHT : expandedHeight
    if (h !== lastHeightRef.current) {
      lastHeightRef.current = h
      onIntent({ name: 'set-expanded-height', expandedHeight: h })
    }
  }, [expandedHeight, surfaceMode, onIntent])

  return (
    <div className="island-root">
      <div
        className={cn('island-surface island-transition-surface', surfaceMode)}
        data-phase={primary?.phase ?? 'idle'}
        onMouseEnter={() => onIntent({ name: 'set-hovered', value: true })}
        onMouseLeave={() => onIntent({ name: 'set-hovered', value: false })}
        style={{ '--island-expanded-height': `${expandedHeight}px` } as CSSProperties}
      >
        <span className="island-window-drag-handle island-drag-handle" aria-hidden="true" />

        {/* expanded-content：surfaceMode !== compact 时渲染，collapsing 态保留旧内容淡出 */}
        {surfaceMode !== 'compact' && (
          <div ref={expandedContentRef} className="island-expanded">
            <div className="island-expanded-head">
              <span className={cn('island-dot', PHASE_DOT[primary?.phase ?? 'idle'])} />
              <span className="island-title">{state.compactLabel.replace('Lume · ', '')}</span>
              <span className="island-expanded-summary">{expandedSummary}</span>
              <div className="island-actions island-no-drag">
                <IslandActionButton label="打开 Lume" onClick={() => onIntent({ name: 'open-main' })}>
                  <AppWindow />
                </IslandActionButton>
                {primary?.attention && (
                  <IslandActionButton label="关闭" onClick={() => onIntent({ name: 'dismiss' })}>
                    <X />
                  </IslandActionButton>
                )}
                {primary && (
                  <IslandActionButton
                    label="打开会话"
                    onClick={() => onIntent({ name: 'open-session', threadId: primary.threadId })}
                  >
                    <MessageSquare />
                  </IslandActionButton>
                )}
                <IslandActionButton label="收起" onClick={() => onIntent({ name: 'set-expanded', value: false })}>
                  <ChevronUp />
                </IslandActionButton>
              </div>
            </div>

            {/* idle/active 互斥：isIdle 时整块替换为 recent 区（service 已去重，无需渲染层再剔）。
                planning 区在两种状态下都保留（有才显，复用下方全量逻辑）。 */}
            {state.isIdle ? (
              <div className="island-recent">
                <div className="island-section-head">
                  <span>最近会话</span>
                  <span>{state.recentSessions?.length ?? 0}</span>
                </div>
                {state.recentSessions && state.recentSessions.length > 0 ? (
                  <ul className="island-sessions">
                    {state.recentSessions.map((r) => (
                      <li
                        key={r.threadId}
                        className="island-session-row island-no-drag"
                        role="button"
                        tabIndex={0}
                        onClick={() => onIntent({ name: 'open-session', threadId: r.threadId })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onIntent({ name: 'open-session', threadId: r.threadId })
                          }
                        }}
                      >
                        <span className={cn('island-dot', PHASE_DOT[r.phase ?? 'idle'])} aria-hidden="true" />
                        <span className="island-session-copy">
                          <span className="island-session-title">{formatIslandSessionTitle(r.title, r.threadId)}</span>
                          <span className="island-session-detail">{formatRelativeTime(r.updatedAt)}</span>
                        </span>
                        {r.project && (
                          <span className="island-session-project">{r.project}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="island-recent-empty">
                    <span>还没有会话</span>
                    <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'new-session' })}>新建会话</Button>
                  </div>
                )}
              </div>
            ) : (
              state.sessions.length > 0 && (
                <>
                  <div className="island-section-head">
                    <span>活跃会话</span>
                    <span>{state.sessions.length}</span>
                  </div>
                  <ul className="island-sessions">
                    {state.sessions.map((s) => (
                      <li
                        key={s.threadId}
                        className="island-session-row island-no-drag"
                        role="button"
                        tabIndex={0}
                        onClick={() => onIntent({ name: 'open-session', threadId: s.threadId })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onIntent({ name: 'open-session', threadId: s.threadId })
                          }
                        }}
                      >
                        <span className={cn('island-dot', PHASE_DOT[s.phase])} />
                        <span className="island-session-copy">
                          <span className="island-session-title">{formatIslandSessionTitle(s.title, s.threadId)}</span>
                          {sessionMetaById[s.threadId] && (
                            <span className="island-session-meta">{sessionMetaById[s.threadId]}</span>
                          )}
                        </span>
                        <span className="island-session-phase">{PHASE_LABEL[s.phase] ?? s.phase}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )
            )}

            {(state.planning.todos.length > 0 || state.planning.reminders.length > 0) && (
              <div className="island-planning">
                {state.planning.todos.length > 0 && (() => {
                  const sorted = sortIslandPlanningItems(state.planning.todos)
                  const visible = sorted.slice(0, PLANNING_VISIBLE_MAX)
                  const overflow = sorted.length - visible.length
                  return (
                    <div className="island-planning-col">
                      <div className="island-planning-head">
                        <ListTodo className="island-planning-icon" />
                        <span>待办</span>
                        <span className="island-planning-count">{sorted.length}</span>
                      </div>
                      {visible.map((t) => {
                        const time = formatIslandTime(t.dueAt, t.overdue)
                        return (
                          <div
                            key={t.id}
                            className="island-planning-row island-no-drag"
                            data-overdue={t.overdue ? 'true' : 'false'}
                            role="button"
                            tabIndex={0}
                            onClick={() => onIntent({ name: 'open-todo', todoId: t.id })}
                          >
                            <span className={cn('island-planning-check', t.overdue && 'island-planning-check-overdue')} />
                            <span className="island-planning-text">{t.title}</span>
                            {time && <span className="island-planning-time">{time}</span>}
                          </div>
                        )
                      })}
                      {overflow > 0 && (
                        <div className="island-planning-overflow">{`还有 ${overflow} 条`}</div>
                      )}
                    </div>
                  )
                })()}
                {state.planning.reminders.length > 0 && (() => {
                  const sorted = sortIslandPlanningItems(state.planning.reminders)
                  const visible = sorted.slice(0, PLANNING_VISIBLE_MAX)
                  const overflow = sorted.length - visible.length
                  return (
                    <div className="island-planning-col">
                      <div className="island-planning-head">
                        <CalendarDays className="island-planning-icon" />
                        <span>提醒</span>
                        <span className="island-planning-count">{sorted.length}</span>
                      </div>
                      {visible.map((r) => {
                        const time = formatIslandTime(r.dueAt, r.overdue)
                        return (
                          <div
                            key={r.id}
                            className="island-planning-row island-no-drag"
                            data-overdue={r.overdue ? 'true' : 'false'}
                            role="button"
                            tabIndex={0}
                            onClick={() => onIntent({ name: 'open-main' })}
                          >
                            <span className="island-planning-text">{r.title}</span>
                            {time && <span className="island-planning-time">{time}</span>}
                          </div>
                        )
                      })}
                      {overflow > 0 && (
                        <div className="island-planning-overflow">{`还有 ${overflow} 条`}</div>
                      )}
                    </div>
                  )
                })()}
              </div>
            )}
          </div>
        )}

        <div
          className="island-compact-layer"
          data-collapsed={requestedExpanded ? 'false' : 'true'}
        >
          {!primary && planningIndicator && (
            <span className="island-planning-indicator" style={{ color: planningIndicator.color }}>
              {planningIndicator.symbol === 'calendar' ? (
                <CalendarDays className="island-indicator-icon" />
              ) : (
                <ListTodo className="island-indicator-icon" />
              )}
            </span>
          )}
          <IslandMascot phase={primary?.phase ?? 'idle'} />
          {needInteractionCount >= 2 && (
            <span
              className="island-attention-pill island-no-drag"
              data-attention-count={needInteractionCount}
            >
              {needInteractionCount}
            </span>
          )}
          <span className="island-label">{state.compactLabel}</span>
          {queueCount > 0 && (
            <span className="island-queue-badge island-no-drag">{`队列 ${queueCount}`}</span>
          )}
          <ChevronDown className="island-chevron" aria-hidden="true" />
        </div>
      </div>
    </div>
  )
}
