import * as React from 'react'
import { buildInstalledSections } from '../skills-market-state'
import type { SkillCatalogItem } from '@lume/shared'

export function TrustSecurityPane({ items }: { items: SkillCatalogItem[] }) {
  const sections = React.useMemo(() => buildInstalledSections(items), [items])

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4 rounded-2xl border bg-card p-5">
        <div>
          <h3 className="text-[15px] font-semibold">Trust model</h3>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Skills are grouped by source and trust level so ordinary users can tell what is safe to install.
          </p>
        </div>

        <div className="grid gap-3">
          <div className="rounded-xl bg-emerald-50 p-4 text-[13px] text-emerald-900">
            <div className="font-medium">Trusted</div>
            <div className="mt-1 text-[12px]">Built-in and known local sources can be imported directly.</div>
          </div>
          <div className="rounded-xl bg-amber-50 p-4 text-[13px] text-amber-900">
            <div className="font-medium">Review Required</div>
            <div className="mt-1 text-[12px]">
              GitHub installs must pass through a review sheet before installation.
            </div>
          </div>
          <div className="rounded-xl bg-rose-50 p-4 text-[13px] text-rose-900">
            <div className="font-medium">Blocked by Default</div>
            <div className="mt-1 text-[12px]">
              Third-party subscribed sources stay out of normal install flows until the product supports them safely.
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-2xl border bg-card p-5">
        <div className="text-[12px] text-muted-foreground">Current workspace summary</div>
        <div className="text-[22px] font-semibold">{sections.installed.length}</div>
        <div className="text-[12px] text-muted-foreground">Installed skills</div>
        <div className="pt-2 text-[13px]">
          {sections.reviewRequired.length} installed skill(s) still carry review-required trust.
        </div>
      </div>
    </div>
  )
}
