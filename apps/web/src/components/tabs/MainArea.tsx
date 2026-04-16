import { TabBar } from './TabBar'
import { TabContent } from './TabContent'

export function MainArea() {
  return (
    <div className="h-full flex flex-col bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl rounded-2xl shadow-xl overflow-hidden">
      <TabBar />
      <div className="flex-1 min-h-0 flex">
        <TabContent />
      </div>
    </div>
  )
}
