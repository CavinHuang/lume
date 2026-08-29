import { TabBar } from './TabBar'
import { TabContent } from './TabContent'

export function MainArea() {
  return (
    <div className="h-full flex flex-col overflow-hidden rounded-l-[16px] bg-[var(--lume-bg-panel)]">
      <TabBar />
      <div className="flex-1 min-h-0 flex bg-[var(--lume-bg-panel)]">
        <TabContent />
      </div>
    </div>
  )
}
