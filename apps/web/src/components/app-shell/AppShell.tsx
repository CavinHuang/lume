import { LeftSidebar } from './LeftSidebar'
import { TitleBar } from './TitleBar'
import { MainArea } from '@/components/tabs/MainArea'
import { RightPanelWorkspace } from '@/components/right-panel'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { useSetAtom } from 'jotai'
import { commandPaletteOpenAtom } from '@/atoms'
import { useEffect } from 'react'

export function AppShell() {
  const setOpen = useSetAtom(commandPaletteOpenAtom)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setOpen])

  return (
    <div className="h-screen w-screen flex flex-col overflow-hidden bg-[var(--lume-bg-app)] text-[var(--lume-text-primary)]">
      <TitleBar />
      <div className="flex-1 flex min-h-0 gap-1.5 px-2">
        <LeftSidebar />
        <div className="flex-1 min-w-0 overflow-hidden rounded-[10px] bg-[var(--lume-bg-panel)]">
          <MainArea />
        </div>
        <RightPanelWorkspace />
      </div>
      <CommandPalette />
    </div>
  )
}
