import { useAtomValue } from 'jotai'
import { sidebarCollapsedAtom } from '@/atoms'
import { cn } from '@/lib/utils'
import { TabBar } from './TabBar'
import { TabContent } from './TabContent'

export function MainArea() {
  // 侧栏收起后纸片贴窗口左缘，左圆角去除
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)

  return (
    <div className={cn(
      'h-full flex flex-col overflow-hidden bg-[var(--lume-bg-panel)]',
      !sidebarCollapsed && 'rounded-l-[16px]',
    )}>
      <TabBar />
      <div className="flex-1 min-h-0 flex bg-[var(--lume-bg-panel)]">
        <TabContent />
      </div>
    </div>
  )
}
