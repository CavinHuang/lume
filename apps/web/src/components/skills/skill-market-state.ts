import type { InstallSkillMarketItemToWorkspaceInput, SkillCatalogItem } from '@lume/shared'

export type SkillMarketSection = 'market' | 'settings'

export interface ResolveSkillSettingsCwdInput {
  activeSection: SkillMarketSection
  currentThreadId: string | null
  getThreadPath: (threadId: string) => Promise<string | null | undefined>
}

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

export async function resolveSkillSettingsCwd(input: ResolveSkillSettingsCwdInput): Promise<string | null> {
  if (input.activeSection !== 'settings' || !input.currentThreadId) return null

  const threadPath = await input.getThreadPath(input.currentThreadId)
  const cwd = threadPath?.trim()
  return cwd ? cwd : null
}
