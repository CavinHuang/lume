import { LeftSidebar } from './LeftSidebar'
import { TitleBar } from './TitleBar'
import { MainArea } from '@/components/tabs/MainArea'
import { RightPanelWorkspace } from '@/components/right-panel'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeTabIdAtom, commandPaletteOpenAtom, rightPanelLayoutAtom, tabsAtom } from '@/atoms'
import { useEffect } from 'react'
import { DesktopActionVisualOverlay } from '@/components/agent/DesktopActionVisualOverlay'
import { cn } from '@/lib/utils'

export function AppShell() {
  const setOpen = useSetAtom(commandPaletteOpenAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const rightPanelLayout = useAtomValue(rightPanelLayoutAtom)
  const activeAgent = tabs.some((tab) => tab.id === activeTabId && tab.type === 'agent')
  const rightPanelVisible = rightPanelLayout.open && activeAgent
  const rightPanelExpanded = rightPanelVisible && rightPanelLayout.mode === 'expanded'

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
      <div className={cn('flex min-h-0 flex-1 gap-1.5 pl-2', rightPanelExpanded ? 'pr-0' : 'pr-2')}>
        <LeftSidebar />
        <div className={cn(
          'min-w-0 flex-1 overflow-hidden rounded-[10px] bg-[var(--lume-bg-panel)]',
          rightPanelVisible && 'mr-[-6px] rounded-r-none',
        )}>
          <MainArea />
        </div>
        <RightPanelWorkspace />
      </div>
      <CommandPalette />
      <DesktopActionVisualOverlay />
    </div>
  )
}
