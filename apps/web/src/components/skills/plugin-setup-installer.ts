import type { InstallPluginPackageResult, PluginMarketplaceSetupStep } from '@lume/shared'
import { installPluginPackage } from '@/lib/desktop-api'

export async function installPluginSetupPackages(input: {
  workspaceSlug: string
  catalogItemKey?: string
  setup?: PluginMarketplaceSetupStep[]
}): Promise<InstallPluginPackageResult[]> {
  const installerSteps = (input.setup ?? []).filter((step) => step.installer)
  if (installerSteps.length === 0) return []
  if (!input.catalogItemKey) throw new Error('插件目录快照已失效，请刷新市场后重试')

  const results: InstallPluginPackageResult[] = []
  for (const step of installerSteps) {
    results.push(await installPluginPackage({
      workspaceSlug: input.workspaceSlug,
      catalogItemKey: input.catalogItemKey,
      setupStepId: step.id,
    }))
  }
  return results
}
