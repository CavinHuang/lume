import type { InstallSkillMarketItemToWorkspaceInput, SkillCatalogItem } from '@lume/shared'

export function buildSkillActionLabel(item: SkillCatalogItem): string {
  if (item.installState === 'installed') return '移除'
  if (item.installState === 'update-available') return '更新'
  if (isInstallableSkillMarketItem(item)) return '安装'
  return '已同步'
}

export function buildSkillInstallRequest(
  workspaceSlug: string,
  item: SkillCatalogItem,
): InstallSkillMarketItemToWorkspaceInput {
  return {
    workspaceSlug,
    skillId: item.id,
    overwrite: item.installState === 'update-available',
  }
}

export function isInstallableSkillMarketItem(item: SkillCatalogItem): boolean {
  return (
    item.installState !== 'installed' &&
    (
      item.sourceType === 'built-in' ||
      item.sourceId?.startsWith('claude:skill:') === true ||
      item.sourceId?.startsWith('local:skill:') === true
    )
  )
}
