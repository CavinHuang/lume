import { useLayoutEffect, useRef } from 'react'
import { ChevronDown } from 'lucide-react'
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
            <div className="island-expanded-head">
              <span className="island-title">{state.compactLabel.replace('Lume · ', '')}</span>
              <div className="island-actions">
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'open-session', threadId: primary.threadId })}>打开会话</Button>
                <Button size="sm" variant="ghost" onClick={() => onIntent({ name: 'set-expanded', value: false })}>收起</Button>
              </div>
            </div>
            <ul className="island-sessions">
              {state.sessions.map((s) => (
                <li
                  key={s.threadId}
                  className="island-session-row"
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
                  {s.detail && <span className="island-session-detail">{s.detail}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
