import type { SkillCatalogItem, SkillSourceType, SkillTrustLevel } from '@lume/shared'

const SOURCE_PRIORITY: Record<SkillSourceType, number> = {
  'built-in': 0,
  local: 1,
  github: 2,
  'subscribed-market': 3,
}

const TRUST_PRIORITY: Record<SkillTrustLevel, number> = {
  trusted: 0,
  'review-required': 1,
  'blocked-by-default': 2,
}

export function sortCatalogItems(items: SkillCatalogItem[]): SkillCatalogItem[] {
  return [...items].sort((a, b) =>
    TRUST_PRIORITY[a.trustLevel] - TRUST_PRIORITY[b.trustLevel] ||
    SOURCE_PRIORITY[a.sourceType] - SOURCE_PRIORITY[b.sourceType] ||
    a.name.localeCompare(b.name, 'zh-CN')
  )
}

export function filterCatalogItems(
  items: SkillCatalogItem[],
  options: {
    query?: string
    sourceType?: SkillSourceType | 'all'
    installedOnly?: boolean
  }
): SkillCatalogItem[] {
  const query = options.query?.trim().toLowerCase() ?? ''

  return sortCatalogItems(items).filter((item) => {
    if (options.installedOnly && item.installState === 'not-installed') return false
    if (options.sourceType && options.sourceType !== 'all' && item.sourceType !== options.sourceType) return false
    if (!query) return true

    return (
      item.name.toLowerCase().includes(query) ||
      item.slug.toLowerCase().includes(query) ||
      item.description?.toLowerCase().includes(query) === true
    )
  })
}

export function buildInstalledSections(items: SkillCatalogItem[]): {
  installed: SkillCatalogItem[]
  reviewRequired: SkillCatalogItem[]
} {
  const installed = sortCatalogItems(items.filter((item) => item.installState !== 'not-installed'))
  return {
    installed,
    reviewRequired: installed.filter((item) => item.trustLevel === 'review-required'),
  }
}

export function buildTrustMeta(trustLevel: SkillTrustLevel): {
  label: string
  badgeVariant: 'secondary' | 'outline' | 'destructive'
  toneClass: string
} {
  switch (trustLevel) {
    case 'trusted':
      return {
        label: 'Trusted',
        badgeVariant: 'secondary',
        toneClass: 'text-emerald-700',
      }
    case 'review-required':
      return {
        label: 'Review Required',
        badgeVariant: 'outline',
        toneClass: 'text-amber-700',
      }
    case 'blocked-by-default':
      return {
        label: 'Blocked',
        badgeVariant: 'destructive',
        toneClass: 'text-rose-700',
      }
  }
}

export function buildSourceLabel(sourceType: SkillSourceType): string {
  switch (sourceType) {
    case 'built-in':
      return 'Built-in'
    case 'local':
      return 'Local'
    case 'github':
      return 'GitHub'
    case 'subscribed-market':
      return 'Market'
  }
}
