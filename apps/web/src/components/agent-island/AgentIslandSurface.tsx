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
 * Agent 灵动岛纯展示组件。无 IPC、无 jotaa，所有用户意图通过 onIntent 上发。
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
  return (
    <div className="island-root">
      <div
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
                <li key={s.threadId} className="island-session-row" onClick={() => onIntent({ name: 'open-session', threadId: s.threadId })}>
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
