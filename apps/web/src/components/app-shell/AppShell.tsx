import { LeftSidebar } from './LeftSidebar'
import { TitleBar } from './TitleBar'
import { MainArea } from '@/components/tabs/MainArea'
import { RightPanelWorkspace } from '@/components/right-panel'
import { CommandPalette } from '@/components/command-palette/CommandPalette'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeTabIdAtom, commandPaletteOpenAtom, rightPanelLayoutAtom, sidebarCollapsedAtom, tabsAtom } from '@/atoms'
import { useEffect, useState } from 'react'
import { DesktopActionVisualOverlay } from '@/components/agent/DesktopActionVisualOverlay'
import { cn } from '@/lib/utils'

export function AppShell() {
  const setOpen = useSetAtom(commandPaletteOpenAtom)
  const tabs = useAtomValue(tabsAtom)
  const activeTabId = useAtomValue(activeTabIdAtom)
  const rightPanelLayout = useAtomValue(rightPanelLayoutAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === 'undefined' ? 1024 : window.innerWidth)
  const activeAgent = tabs.some((tab) => tab.id === activeTabId && tab.type === 'agent')
  const rightPanelVisible = rightPanelLayout.open && activeAgent
  const rightPanelExpanded = rightPanelVisible && rightPanelLayout.mode === 'expanded'
  const forceCompactSidebar = rightPanelVisible && rightPanelLayout.mode !== 'compact' && viewportWidth < 1120
  const effectiveSidebarWidth = sidebarCollapsed || forceCompactSidebar ? 72 : 286
  const rightPanelMaxWidth = Math.max(360, viewportWidth - effectiveSidebarWidth - 420 - 28)

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', updateViewportWidth)
    return () => window.removeEventListener('resize', updateViewportWidth)
  }, [])

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
        <LeftSidebar forceCollapsed={forceCompactSidebar} />
        <div className={cn(
          'min-w-0 flex-1 overflow-hidden rounded-[10px] bg-[var(--lume-bg-panel)]',
          rightPanelVisible && 'mr-[-6px] rounded-r-none',
        )}>
          <MainArea />
        </div>
        <RightPanelWorkspace maxWidth={rightPanelMaxWidth} />
      </div>
      <CommandPalette />
      <DesktopActionVisualOverlay />
    </div>
  )
}
