import { useState } from 'react'
import { BookOpen, CalendarDays, Library } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { ReadingView } from '../reading/ReadingView'
import { RoutinePanel } from '../routine/RoutinePanel'
import { WikiView } from '../wiki/WikiView'

type LumeFeature = 'reading' | 'routine' | 'wiki'
const STORAGE_KEY = 'lume:last-feature'

export function LumeView() {
  const [feature, setFeatureState] = useState<LumeFeature>(() => {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY)
    return saved === 'routine' || saved === 'wiki' ? saved : 'reading'
  })
  const setFeature = (next: LumeFeature) => {
    setFeatureState(next)
    globalThis.localStorage?.setItem(STORAGE_KEY, next)
  }
  const items: Array<{ id: LumeFeature; label: string; icon: typeof BookOpen }> = [
    { id: 'reading', label: '一起读书', icon: BookOpen },
    { id: 'routine', label: '今日日程', icon: CalendarDays },
    { id: 'wiki', label: 'Wiki', icon: Library },
  ]
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--background)]">
      <nav className="flex shrink-0 items-center gap-1 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-2">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <Button key={item.id} variant="ghost" size="sm" onClick={() => setFeature(item.id)} className={cn('gap-2', feature === item.id && 'bg-[var(--surface-2)] text-[var(--text-1)]')}>
              <Icon size={15} />{item.label}
            </Button>
          )
        })}
      </nav>
      <div className="flex min-h-0 flex-1">
        {feature === 'reading' && <ReadingView />}
        {feature === 'routine' && (
          <ScrollArea className="min-h-0 min-w-0 flex-1">
            <main className="mx-auto w-full max-w-[980px] px-5 py-7 lg:px-8"><RoutinePanel /></main>
          </ScrollArea>
        )}
        {feature === 'wiki' && <WikiView />}
      </div>
    </div>
  )
}
