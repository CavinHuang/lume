import * as React from 'react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { buildSourceLabel, buildTrustMeta, filterCatalogItems } from '../skills-market-state'
import { SkillDetailPane } from './SkillDetailPane'
import type { SkillCatalogItem, SkillSourceType } from '@lume/shared'

const SOURCE_FILTERS: Array<{ value: SkillSourceType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'built-in', label: 'Built-in' },
  { value: 'local', label: 'Local' },
  { value: 'github', label: 'GitHub' },
]

export function DiscoverPane({
  items,
  workspaceSlug,
  onChanged,
}: {
  items: SkillCatalogItem[]
  workspaceSlug: string
  onChanged: () => void
}) {
  const [query, setQuery] = React.useState('')
  const [sourceType, setSourceType] = React.useState<SkillSourceType | 'all'>('all')
  const [selectedSlug, setSelectedSlug] = React.useState<string | null>(null)

  const filtered = React.useMemo(
    () => filterCatalogItems(items, { query, sourceType }),
    [items, query, sourceType]
  )

  React.useEffect(() => {
    if (!filtered.some((item) => item.slug === selectedSlug)) {
      setSelectedSlug(filtered[0]?.slug ?? null)
    }
  }, [filtered, selectedSlug])

  const selectedItem = filtered.find((item) => item.slug === selectedSlug) ?? null

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-3 rounded-2xl border bg-card p-4">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search skills..."
        />
        <div className="flex flex-wrap gap-2">
          {SOURCE_FILTERS.map((filter) => (
            <button
              key={filter.value}
              onClick={() => setSourceType(filter.value)}
              className={`rounded-full px-3 py-1.5 text-[12px] transition-colors ${
                sourceType === filter.value
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {filtered.map((item) => {
            const trustMeta = buildTrustMeta(item.trustLevel)
            return (
              <button
                key={item.id}
                onClick={() => setSelectedSlug(item.slug)}
                className={`w-full rounded-xl border p-3 text-left transition-colors ${
                  selectedItem?.slug === item.slug
                    ? 'border-foreground/20 bg-muted/60'
                    : 'border-border hover:bg-muted/30'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">{item.name}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      {buildSourceLabel(item.sourceType)}
                    </div>
                  </div>
                  <Badge variant={trustMeta.badgeVariant} className={trustMeta.toneClass}>
                    {trustMeta.label}
                  </Badge>
                </div>
              </button>
            )
          })}

          {filtered.length === 0 && (
            <div className="rounded-xl border border-dashed p-5 text-center text-[12px] text-muted-foreground">
              No skills match the current filters.
            </div>
          )}
        </div>
      </div>

      <SkillDetailPane item={selectedItem} workspaceSlug={workspaceSlug} onChanged={onChanged} />
    </div>
  )
}
