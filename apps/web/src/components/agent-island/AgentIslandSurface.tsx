import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { CalendarDays, ChevronDown, ListTodo } from 'lucide-react'
import type { AgentIslandIntent, AgentIslandState } from '@lume/shared'
import { selectPlanningIndicator } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import './agent-island.css'

const SURFACE_TRANSITION_MS = 180
const COMPACT_HEIGHT = 32

const PHASE_DOT: Record<string, string> = {
  idle: 'bg-[var(--lume-text-muted)]',
  running: 'bg-[var(--lume-accent)] animate-pulse',
  'needs-interaction': 'bg-[var(--lume-warning)]',
  completed: 'bg-[var(--lume-success)]',
  error: 'bg-[var(--lume-danger)]',
}

/** 灵动岛 planning 行的时间标签：逾期加前缀，否则仅 HH:MM。 */
function formatIslandTime(ts: number, overdue: boolean): string {
  const hhmm = new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return overdue ? `逾期 · ${hhmm}` : hhmm
}

type SurfaceMode = 'compact' | 'expanded' | 'collapsing'

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
  const surfaceRef = useRef<HTMLDivElement>(null)
  const expandedContentRef = useRef<HTMLDivElement>(null)
  const lastHeightRef = useRef(COMPACT_HEIGHT)
  const [surfaceMode, setSurfaceMode] = useState<SurfaceMode>('compact')
  const [expandedHeight, setExpandedHeight] = useState(COMPACT_HEIGHT)
  const requestedExpanded = state.presentation === 'expanded'

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
        ref={surfaceRef}
        className={cn('island-surface island-transition-surface', surfaceMode)}
        data-phase={primary?.phase ?? 'idle'}
        onMouseEnter={() => onIntent({ name: 'set-hovered', value: true })}
        onMouseLeave={() => onIntent({ name: 'set-hovered', value: false })}
        style={{ '--island-expanded-height': `${expandedHeight}px` } as CSSProperties}
      >
        {/* 窗口拖动 grip（仅非 macOS）：独立绝对定位区，不贴到 compact button 上，
            避免 -webkit-app-region:drag 吞掉 compact 整面 click。macOS 走 Phase 2 native 刘海 */}
        <div className="island-drag-handle" aria-hidden="true" />

        {/* expanded-content：surfaceMode !== compact 时渲染，collapsing 态保留旧内容淡出 */}
        {surfaceMode !== 'compact' && (
          <div ref={expandedContentRef} className="island-expanded">
            <div className="island-expanded-head island-drag-handle">
              <span className="island-title">{state.compactLabel.replace('Lume · ', '')}</span>
              <div className="island-actions island-no-drag">
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'open-main' })}>打开 Lume</Button>
                {primary?.attention && (
                  <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'dismiss' })}>关闭</Button>
                )}
                {primary && (
                  <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'open-session', threadId: primary.threadId })}>打开会话</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'set-expanded', value: false })}>收起</Button>
              </div>
            </div>

            {state.sessions.length > 0 && (
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
                    <span className="island-session-title">{s.title}</span>
                    {s.project && (
                      <span className="island-session-project">{s.project}</span>
                    )}
                    {s.activityLines.length > 0 ? (
                      <span className="island-session-activity">{s.activityLines[s.activityLines.length - 1]}</span>
                    ) : s.detail ? (
                      <span className="island-session-detail">{s.detail}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {(state.planning.todos.length > 0 || state.planning.reminders.length > 0) && (
              <div className="island-planning">
                {state.planning.todos.length > 0 && (
                  <div className="island-planning-col">
                    <div className="island-planning-head">
                      <ListTodo className="island-planning-icon" />
                      <span>待办</span>
                      <span className="island-planning-count">{state.planning.todos.length}</span>
                    </div>
                    {state.planning.todos.slice(0, 3).map((t) => (
                      <div
                        key={t.id}
                        className="island-planning-row island-no-drag"
                        data-overdue={t.overdue ? 'true' : 'false'}
                        role="button"
                        tabIndex={0}
                        onClick={() => onIntent({ name: 'open-main' })}
                      >
                        <span className={cn('island-planning-check', t.overdue && 'island-planning-check-overdue')} />
                        <span className="island-planning-text">{t.title}</span>
                        <span className="island-planning-time">{formatIslandTime(t.dueAt, t.overdue)}</span>
                      </div>
                    ))}
                  </div>
                )}
                {state.planning.reminders.length > 0 && (
                  <div className="island-planning-col">
                    <div className="island-planning-head">
                      <CalendarDays className="island-planning-icon" />
                      <span>提醒</span>
                      <span className="island-planning-count">{state.planning.reminders.length}</span>
                    </div>
                    {state.planning.reminders.slice(0, 3).map((r) => (
                      <div
                        key={r.id}
                        className="island-planning-row island-no-drag"
                        data-overdue={r.overdue ? 'true' : 'false'}
                        role="button"
                        tabIndex={0}
                        onClick={() => onIntent({ name: 'open-main' })}
                      >
                        <span className="island-planning-time">{formatIslandTime(r.dueAt, r.overdue)}</span>
                        <span className="island-planning-text">{r.title}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <button
          className="island-compact-layer"
          data-collapsed={requestedExpanded ? 'false' : 'true'}
          onClick={() => onIntent({ name: 'set-expanded', value: !requestedExpanded })}
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
          <span className={cn('island-dot', PHASE_DOT[primary?.phase ?? 'idle'])} />
          <span className="island-label">{state.compactLabel}</span>
          <ChevronDown className={cn('island-chevron', requestedExpanded && 'rotate-180')} />
        </button>
      </div>
    </div>
  )
}
