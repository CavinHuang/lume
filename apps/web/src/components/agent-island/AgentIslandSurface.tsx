import { useLayoutEffect, useRef } from 'react'
import { CalendarDays, ChevronDown, ListTodo } from 'lucide-react'
import type { AgentIslandIntent, AgentIslandState } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import './agent-island.css'

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

/**
 * Agent 灵动岛纯展示组件。无 IPC、无 jotai，所有用户意图通过 onIntent 上发。
 * 平台形态（mac 圆角 vs 默认浮动矩形）由 CSS 键控 `html.darwin` 类决定，
 * 该类由 desktop preload 注入；组件本身不引用 process.platform（renderer 无 Node）。
 */
export function AgentIslandSurface({
  state,
  onIntent,
}: {
  state: AgentIslandState
  onIntent: (intent: AgentIslandIntent) => void
}) {
  const expanded = state.presentation === 'expanded'
  const primary = state.sessions[0]
  const surfaceRef = useRef<HTMLDivElement>(null)
  const lastHeightRef = useRef(32)

  // 高度反馈环（spec §3.2）：展开/收起时测量 surface 真实内容高度，写 CSS var 并回传 main，
  // main 据此 clampIslandHeight 调整 BrowserWindow 高度。两路同步：surface 长高 + 窗口长高，
  // 才能让展开卡片真正可见（窗口透明、surface overflow:hidden）。
  useLayoutEffect(() => {
    const el = surfaceRef.current
    if (!el) return
    const h = expanded ? Math.max(32, Math.ceil(el.scrollHeight)) : 32
    el.style.setProperty('--island-expanded-height', `${h}px`)
    if (h !== lastHeightRef.current) {
      lastHeightRef.current = h
      onIntent({ name: 'set-expanded-height', expandedHeight: h })
    }
  }, [expanded, state, onIntent])

  return (
    <div className="island-root">
      <div
        ref={surfaceRef}
        className="island-surface island-transition-surface"
        data-phase={primary?.phase ?? 'idle'}
        onMouseEnter={() => onIntent({ name: 'set-hovered', value: true })}
        onMouseLeave={() => onIntent({ name: 'set-hovered', value: false })}
      >
        {/* 窗口拖动 grip（仅非 macOS）：独立绝对定位区，不贴到 compact button 上，
            避免 -webkit-app-region:drag 吞掉 compact 整面 click。macOS 走 Phase 2 native 刘海 */}
        <div className="island-drag-handle" aria-hidden="true" />
        <button
          className="island-compact-layer"
          data-collapsed={expanded ? 'false' : 'true'}
          onClick={() => onIntent({ name: 'set-expanded', value: !expanded })}
        >
          <span className={cn('island-dot', PHASE_DOT[primary?.phase ?? 'idle'])} />
          <span className="island-label">{state.compactLabel}</span>
          <ChevronDown className={cn('island-chevron', expanded && 'rotate-180')} />
        </button>
        {expanded && primary && (
          <div className="island-expanded">
            <div className="island-expanded-head island-drag-handle">
              <span className="island-title">{state.compactLabel.replace('Lume · ', '')}</span>
              <div className="island-actions island-no-drag">
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'open-main' })}>打开 Lume</Button>
                {primary.attention && (
                  <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'dismiss' })}>关闭</Button>
                )}
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'open-session', threadId: primary.threadId })}>打开会话</Button>
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'set-expanded', value: false })}>收起</Button>
              </div>
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
                  <span className="island-session-title">{s.title}</span>
                  {s.activityLines.length > 0 ? (
                    <span className="island-session-activity">
                      {s.activityLines[s.activityLines.length - 1]}
                    </span>
                  ) : s.detail ? (
                    <span className="island-session-detail">{s.detail}</span>
                  ) : null}
                </li>
              ))}
            </ul>
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
      </div>
    </div>
  )
}
