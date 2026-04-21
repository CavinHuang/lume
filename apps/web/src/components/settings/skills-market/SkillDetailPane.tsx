import * as React from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { sidecarCall } from '@/lib/desktop-api'
import { buildSourceLabel, buildTrustMeta } from '../skills-market-state'
import type { SkillCatalogItem } from '@lume/shared'

export function SkillDetailPane({
  item,
  workspaceSlug,
  onChanged,
}: {
  item: SkillCatalogItem | null
  workspaceSlug: string
  onChanged: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const trustMeta = item ? buildTrustMeta(item.trustLevel) : null

  const handleInstall = async () => {
    if (!item?.sourceId || item.sourceType !== 'local') return
    setBusy(true)
    try {
      await sidecarCall('agent:import-global-skill-to-workspace', {
        workspaceSlug,
        skillId: item.sourceId,
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async () => {
    if (!item) return
    setBusy(true)
    try {
      await sidecarCall('agent:delete-skill', {
        workspaceSlug,
        skillSlug: item.slug,
      })
      onChanged()
    } finally {
      setBusy(false)
    }
  }

  if (!item) {
    return (
      <div className="rounded-2xl border border-dashed p-8 text-center text-[13px] text-muted-foreground">
        选择左侧 Skill 查看详情
      </div>
    )
  }

  return (
    <div className="space-y-4 rounded-2xl border bg-card p-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[16px] font-semibold">{item.name}</h3>
          {trustMeta && (
            <Badge variant={trustMeta.badgeVariant} className={trustMeta.toneClass}>
              {trustMeta.label}
            </Badge>
          )}
          <Badge variant="outline">{buildSourceLabel(item.sourceType)}</Badge>
        </div>
        <p className="text-[13px] text-muted-foreground">
          {item.description ?? '暂无描述。'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-muted/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Install state</div>
          <div className="mt-1 text-[13px] font-medium">
            {item.installState === 'installed'
              ? 'Installed in workspace'
              : item.installState === 'update-available'
                ? 'Update available'
                : 'Not installed'}
          </div>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Version</div>
          <div className="mt-1 text-[13px] font-medium">{item.version ?? 'Unknown'}</div>
        </div>
      </div>

      <div className="rounded-xl bg-amber-50 p-3 text-[12px] text-amber-900">
        {item.trustLevel === 'trusted'
          ? 'This source is trusted and safe to use in the current workspace.'
          : item.trustLevel === 'review-required'
            ? 'Review-required skills should be inspected before install or update.'
            : 'Blocked sources are intentionally hidden from normal install flows.'}
      </div>

      <div className="flex flex-wrap gap-2">
        {item.installState === 'installed' ? (
          <Button variant="outline" size="sm" onClick={() => void handleRemove()} disabled={busy}>
            Remove from Workspace
          </Button>
        ) : item.sourceType === 'local' && item.sourceId?.startsWith('claude:skill:') ? (
          <Button size="sm" onClick={() => void handleInstall()} disabled={busy}>
            Import to Workspace
          </Button>
        ) : item.sourceType === 'built-in' ? (
          <Button size="sm" disabled>
            Built-in skills are seeded automatically
          </Button>
        ) : (
          <Button size="sm" disabled>
            Install path not available here
          </Button>
        )}
      </div>
    </div>
  )
}
