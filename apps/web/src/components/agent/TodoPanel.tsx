import { Check, Circle, Loader2 } from 'lucide-react'
import type { TodoBlockData } from './runtime-message-view'

export function TodoPanel({ data }: { data: TodoBlockData | null }) {
  if (!data || data.todos.length === 0) return null
  return (
    <div className="sticky bottom-3 z-10 mx-auto w-full max-w-[920px] rounded-lg border border-[#e1e4ec] bg-white/95 px-3 py-2 text-[12px] shadow-[0_4px_16px_rgba(20,24,40,0.08)] backdrop-blur">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground/60">
        {data.currentActiveForm ? (
          <>
            <Loader2 size={12} className="animate-spin text-[#7567ff]" />
            <span>{data.currentActiveForm}</span>
          </>
        ) : (
          <span>任务列表</span>
        )}
      </div>
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
            <span className={t.status === 'completed' ? 'text-foreground/40 line-through' : 'text-foreground/70'}>
              {t.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
