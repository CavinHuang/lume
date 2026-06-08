import { useState } from 'react'
import { BookOpen, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ReadingView } from '../reading/ReadingView'
import { RoutinePanel } from '../routine/RoutinePanel'

type LumeSection = 'reading' | 'routine'

const LUME_NAV_ITEMS: Array<{ id: LumeSection; label: string; icon: typeof BookOpen }> = [
  { id: 'reading', label: '读书', icon: BookOpen },
  { id: 'routine', label: '日程', icon: Calendar },
]

export function LumeView() {
  const [section, setSection] = useState<LumeSection>('reading')

  return (
    <div className="flex flex-1 min-w-0 min-h-0 gap-8 bg-[var(--background)]">
      <aside className="w-[174px] shrink-0 rounded-tr-[12px] border-r border-t border-[var(--border)] bg-[var(--surface-1)] px-3 py-5 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <h1 className="mb-3 px-2.5 text-[22px] font-semibold leading-7 text-[var(--text-1)]">Lume</h1>
        <nav className="space-y-1.5">
          {LUME_NAV_ITEMS.map((item) => {
            const Icon = item.icon
            const selected = section === item.id

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={cn(
                  'flex h-9 w-full items-center gap-2.5 rounded-[8px] px-2.5 text-[13px] font-medium transition-colors',
                  selected
                    ? 'bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                    : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]'
                )}
              >
                <Icon size={16} strokeWidth={1.9} className="shrink-0" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 min-h-0">
        {section === 'reading' && <ReadingView embedded />}
        {section === 'routine' && <RoutinePanel />}
      </div>
    </div>
  )
}
