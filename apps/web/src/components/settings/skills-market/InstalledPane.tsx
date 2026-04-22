import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { sidecarCall } from '@/lib/desktop-api'
import { buildInstalledSections, buildSourceLabel, buildTrustMeta } from '../skills-market-state'
import type { SkillCatalogItem } from '@lume/shared'

export function InstalledPane({
  items,
  workspaceSlug,
  mode,
  onChanged,
}: {
  items: SkillCatalogItem[]
  workspaceSlug: string
  mode: 'installed' | 'updates'
  onChanged: () => void
}) {
  const [busySlug, setBusySlug] = React.useState<string | null>(null)
  const sections = React.useMemo(() => buildInstalledSections(items), [items])
  const visibleItems = mode === 'updates'
    ? sections.installed.filter((item) => item.installState === 'update-available' || item.trustLevel === 'review-required')
    : sections.installed

  const handleRemove = async (slug: string) => {
    setBusySlug(slug)
    try {
      await sidecarCall('agent:delete-skill', {
        workspaceSlug,
        skillSlug: slug,
      })
      onChanged()
    } finally {
      setBusySlug(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border bg-card p-4">
          <div className="text-[12px] text-muted-foreground">Installed</div>
          <div className="mt-1 text-[22px] font-semibold">{sections.installed.length}</div>
        </div>
        <div className="rounded-2xl border bg-card p-4">
          <div className="text-[12px] text-muted-foreground">Review Required</div>
          <div className="mt-1 text-[22px] font-semibold">{sections.reviewRequired.length}</div>
        </div>
      </div>

      <div className="space-y-2">
        {visibleItems.map((item) => {
          const trustMeta = buildTrustMeta(item.trustLevel)
          return (
            <div key={item.id} className="flex items-center gap-3 rounded-2xl border bg-card p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="truncate text-[13px] font-medium">{item.name}</div>
                  <Badge variant={trustMeta.badgeVariant} className={trustMeta.toneClass}>
                    {trustMeta.label}
                  </Badge>
                </div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  {buildSourceLabel(item.sourceType)} · {item.version ?? 'Unknown version'}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busySlug === item.slug}
                onClick={() => void handleRemove(item.slug)}
              >
                Remove
              </Button>
            </div>
          )
        })}

        {visibleItems.length === 0 && (
          <div className="rounded-2xl border border-dashed p-6 text-center text-[12px] text-muted-foreground">
            {mode === 'updates' ? 'No updates or review-required items right now.' : 'No installed skills yet.'}
          </div>
        )}
      </div>
    </div>
  )
}
