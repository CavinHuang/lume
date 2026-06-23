import { LeftSidebar } from './LeftSidebar'
import { TitleBar } from './TitleBar'
import { MainArea } from '@/components/tabs/MainArea'
import { RightPanelWorkspace } from '@/components/right-panel'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { useSetAtom } from 'jotai'
import { commandPaletteOpenAtom } from '@/atoms'
import { useEffect } from 'react'
import { cn } from '@/lib/utils'
import { isMacosTauri } from '@/lib/platform'

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
    <div className="h-screen w-screen flex overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className={cn('pb-2 pl-2 pr-0 relative z-[60]', isMacosTauri ? 'pt-5' : 'pt-0')}>
        <LeftSidebar />
      </div>
      <div className={cn('flex-1 min-w-0 pb-2 pl-2 pr-2 relative z-[60]', isMacosTauri ? 'pt-5' : 'pt-0')}>
        <MainArea />
      </div>
      <RightPanelWorkspace />
      <CommandPalette />
    </div>
  )
}
