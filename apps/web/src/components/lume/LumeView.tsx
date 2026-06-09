import { ReadingView } from '../reading/ReadingView'

export function LumeView() {
  return (
    <div className="flex flex-1 min-w-0 min-h-0 gap-8 bg-[var(--background)]">
      <ReadingView />
    </div>
  )
}
