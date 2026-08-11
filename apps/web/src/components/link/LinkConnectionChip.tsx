import { useSetAtom } from 'jotai'
import { activeTabIdAtom, linkProviderTargetAtom, tabsAtom } from '@/atoms'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ProviderIcon } from './ProviderIcon'

export function LinkConnectionChip({
  service,
  connectionName,
  displayText,
  className,
}: {
  service: string
  connectionName: string
  displayText: string
  className?: string
}) {
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setProviderTarget = useSetAtom(linkProviderTargetAtom)
  const openConnection = () => {
    setProviderTarget({ service, connectionName })
    setTabs((tabs) => tabs.some((tab) => tab.id === '__link__')
      ? tabs
      : [...tabs, { id: '__link__', type: 'link', title: '连接器' }])
    setActiveTabId('__link__')
  }

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={openConnection}
      title={`打开 ${displayText}`}
      className={cn(
        'inline-flex h-6 max-w-[280px] items-center gap-1.5 rounded-md border border-[color:color-mix(in_oklab,var(--lume-accent)_20%,var(--lume-border-subtle))] bg-[var(--lume-accent-soft)] px-1.5 py-0.5 align-baseline text-[13px] font-medium text-[var(--lume-accent)] hover:bg-[color:color-mix(in_oklab,var(--lume-accent)_14%,var(--surface-1))]',
        className,
      )}
    >
      <ProviderIcon service={service} displayName={displayText} size={14} />
      <span className="truncate">@{displayText}</span>
    </Button>
  )
}
