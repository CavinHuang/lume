import { TabBar } from './TabBar'
import { TabContent } from './TabContent'

export function MainArea() {
  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      <TabBar />
      <div className="flex-1 min-h-0 flex bg-background">
        <TabContent />
      </div>
    </div>
  )
}
