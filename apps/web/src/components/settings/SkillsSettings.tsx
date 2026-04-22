import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Loader2, WandSparkles } from 'lucide-react'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import { getSkillMarketCatalog } from '@/lib/desktop-api'
import type { SkillCatalogItem } from '@lume/shared'
import { DiscoverPane } from './skills-market/DiscoverPane'
import { GitHubInstallSheet } from './skills-market/GitHubInstallSheet'
import { InstalledPane } from './skills-market/InstalledPane'
import { TrustSecurityPane } from './skills-market/TrustSecurityPane'

type SkillsView = 'discover' | 'installed' | 'updates' | 'trust'

export function SkillsSettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspace = workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null
  const workspaceSlug = workspace?.slug ?? null

  const [items, setItems] = React.useState<SkillCatalogItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [view, setView] = React.useState<SkillsView>('discover')
  const [installOpen, setInstallOpen] = React.useState(false)

  const loadCatalog = React.useCallback(async () => {
    if (!workspaceSlug) {
      setLoading(false)
      setItems([])
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await getSkillMarketCatalog(workspaceSlug, view === 'trust')
      setItems(result.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug, view])

  React.useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  if (!workspaceSlug) {
    return (
      <div className="p-6">
        <div className="rounded-xl border border-dashed p-8 text-center">
          <WandSparkles size={24} className="mx-auto mb-2 text-muted-foreground/40" />
          <p className="text-[13px] text-muted-foreground">尚未选择工作区</p>
          <p className="mt-1 text-[11px] text-muted-foreground/60">请先切换或创建工作区，再浏览和安装 Skills。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold">Skills</h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            工作区「{workspace?.name ?? workspaceSlug}」· 本地优先技能市场
          </p>
        </div>
        <div className="flex items-center gap-2">
          {(['discover', 'installed', 'updates', 'trust'] as SkillsView[]).map((item) => (
            <button
              key={item}
              onClick={() => setView(item)}
              className={`rounded-full px-3 py-1.5 text-[12px] transition-colors ${
                view === item ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {item === 'discover' ? 'Discover' : item === 'installed' ? 'Installed' : item === 'updates' ? 'Updates' : 'Trust & Security'}
            </button>
          ))}
          <button
            onClick={() => setInstallOpen(true)}
            className="rounded-lg bg-primary px-3 py-2 text-[12px] font-medium text-primary-foreground"
          >
            Install from GitHub
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />
          加载中...
        </div>
      ) : error ? (
        <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-[13px] text-destructive">
          {error}
        </div>
      ) : view === 'discover' ? (
        <DiscoverPane items={items} workspaceSlug={workspaceSlug} onChanged={() => void loadCatalog()} />
      ) : view === 'installed' || view === 'updates' ? (
        <InstalledPane items={items} workspaceSlug={workspaceSlug} mode={view} onChanged={() => void loadCatalog()} />
      ) : (
        <TrustSecurityPane items={items} />
      )}

      <GitHubInstallSheet
        open={installOpen}
        onOpenChange={setInstallOpen}
        workspaceSlug={workspaceSlug}
        onInstalled={() => void loadCatalog()}
      />
    </div>
  )
}
