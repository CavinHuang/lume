import { useState } from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import type { TodoBlockData } from './runtime-message-view'
import { cn } from '@/lib/utils'

export function TodoPanel({ data }: { data: TodoBlockData | null }) {
  const [hovered, setHovered] = useState(false)
  if (!data || data.todos.length === 0) return null

  const completed = data.todos.filter((t) => t.status === 'completed').length
  const total = data.todos.length
  const active = !!data.currentActiveForm

  return (
    <div className="sticky bottom-3 z-10 flex justify-center">
      <div
        className="relative"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {/* 固定气泡：位置与尺寸恒定，hover 不变化 */}
        <div className="flex max-w-[320px] items-center gap-2 rounded-lg border border-[#e1e4ec] bg-white/95 px-2.5 py-1.5 text-[12px] font-medium text-foreground/70 shadow-[0_4px_16px_rgba(20,24,40,0.08)] backdrop-blur">
          <ProgressRing completed={completed} total={total} active={active} />
          <span className="shrink-0 tabular-nums text-foreground/50">
            {completed}/{total}
          </span>
          {data.currentActiveForm ? (
            <span className="min-w-0 truncate">{data.currentActiveForm}</span>
          ) : (
            <span className="text-foreground/40">任务列表</span>
          )}
        </div>

        {/* popup：脱离文档流（absolute），始终在 DOM，opacity 控制可见——hover 不重建列表、不推挤气泡 */}
        <div
          className={cn(
            'pointer-events-none absolute bottom-full left-1/2 mb-2 w-[280px] -translate-x-1/2 rounded-lg border border-[#e1e4ec] bg-white/95 p-3 text-[12px] opacity-0 shadow-[0_4px_16px_rgba(20,24,40,0.12)] backdrop-blur transition-opacity duration-150',
            hovered && 'pointer-events-auto opacity-100',
          )}
        >
          <div className="space-y-0.5">
            {data.todos.map((t, i) => (
              <div key={i} className="flex items-center gap-2">
                {t.status === 'completed' ? (
                  <Check size={12} className="shrink-0 text-foreground/40" />
                ) : t.status === 'in_progress' ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-[#7567ff]" />
                ) : (
                  <Circle size={12} className="shrink-0 text-foreground/30" />
                )}
                <span
                  className={cn(
                    'min-w-0 truncate',
                    t.status === 'completed' ? 'text-foreground/40 line-through' : 'text-foreground/70',
                  )}
                >
                  {t.content}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function ProgressRing({ completed, total, active }: { completed: number; total: number; active: boolean }) {
  const ratio = total > 0 ? completed / total : 0
  const r = 7
  const circumference = 2 * Math.PI * r
  const offset = circumference * (1 - ratio)
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0">
      <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2" className="text-foreground/15" />
      <circle
        cx="9"
        cy="9"
        r={r}
        fill="none"
        stroke={active ? '#7567ff' : '#9aa0a6'}
        strokeWidth="2"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 9 9)"
      />
    </svg>
  )
}
