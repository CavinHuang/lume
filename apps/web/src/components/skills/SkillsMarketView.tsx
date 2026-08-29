import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import {
  Check,
  Code2,
  Copy,
  Database,
  Download,
  FileText,
  FolderSync,
  Globe2,
  Info,
  Loader2,
  Megaphone,
  MessageCircle,
  MoreVertical,
  PenTool,
  Plus,
  Power,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { activeTabIdAtom, agentWorkspacesAtom, capabilityDetailTargetAtom, currentWorkspaceIdAtom, tabsAtom, welcomeCapabilitySeedAtom, welcomePromptSeedAtom } from '@/atoms'
import {
  deleteWorkspaceSkill,
  getEffectiveLumeConfig,
  getMarketCatalog,
  getMarketDetail,
  getSkillMarketDetail,
  getGitHubSkillReview,
  importLocalSkillDirectoryToWorkspace,
  inspectMarketSource,
  installMarketItem,
  installGitHubSkillToWorkspace,
  installSkillMarketItemToWorkspace,
  openFolderDialog,
  setPluginActiveVersion,
  setPluginEnablement,
  uninstallPlugin,
  updatePlugin,
  updatePluginsConfig,
  writeClipboardText,
  savePluginPackage,
  installPluginPackage,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import type {
  GetMarketDetailResult,
  LumeConfigPluginMarketSourceRef,
  PluginMarketItem,
  PluginSourceRef,
  SkillCatalogItem,
  SkillFileTreeNode,
  SkillMarketDetailResult,
} from '@lume/shared'
import {
  buildSkillInstallRequest,
  isInstallableSkillMarketItem,
} from './skill-market-state'
import {
  buildMarketCards,
  buildMarketSummary,
  filterMarketCards,
  SKILL_SOURCE_LABELS,
  type MarketCardView,
} from './plugin-market-ui-state'
import { formatRiskLabel } from './plugin-detail-state'
import { buildPluginTryPrompt } from './plugin-try-prompt-state'
import { installPluginSetupPackages } from './plugin-setup-installer'

import { upsertWelcomeTab } from '@/components/app-shell/LeftSidebar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { PluginDetailPage } from './PluginDetailPage'
import { BridgeInstallWizard } from './BridgeInstallWizard'
import { PluginLogo } from './PluginLogo'
import { bridgeWizardOpenAtom, bridgeWizardPluginAtom } from '@/atoms'
type SkillVisualTone = 'violet' | 'mint' | 'figma' | 'green' | 'blue' | 'orange'

interface MarketDisplayCard extends MarketCardView {
  icon: LucideIcon
  tone: SkillVisualTone
}

interface SkillSourceView {
  id: string
  name: string
  detail: string
  enabled: boolean
  icon: LucideIcon
  tone: SkillVisualTone
}

const SKILL_VISUALS: Record<string, Pick<MarketDisplayCard, 'category' | 'actionLabel' | 'icon' | 'tone'>> = {
  'prd-generator': { category: '内置', actionLabel: '启用', icon: FileText, tone: 'violet' },
  'code-review': { category: '内置', actionLabel: '启用', icon: Code2, tone: 'mint' },
  'figma-spec': { category: '本地发现', actionLabel: '安装', icon: PenTool, tone: 'figma' },
  'sql-query': { category: '本地发现', actionLabel: '安装', icon: Database, tone: 'violet' },
  'release-notes': { category: '外部市场源', actionLabel: '添加', icon: Megaphone, tone: 'green' },
  'knowledge-qa': { category: '外部市场源', actionLabel: '添加', icon: MessageCircle, tone: 'blue' },
}

/** 分类分区展示顺序 */
const MARKET_SECTION_ORDER = ['插件', '内置', '外部市场源', '本地发现'] as const

export function SkillsMarketView() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const setTabs = useSetAtom(tabsAtom)
  const setActiveTabId = useSetAtom(activeTabIdAtom)
  const setWelcomePromptSeed = useSetAtom(welcomePromptSeedAtom)
  const setWelcomeCapabilitySeed = useSetAtom(welcomeCapabilitySeedAtom)
  const capabilityDetailTarget = useAtomValue(capabilityDetailTargetAtom)
  const setCapabilityDetailTarget = useSetAtom(capabilityDetailTargetAtom)
  const setBridgeWizardOpen = useSetAtom(bridgeWizardOpenAtom)
  const setBridgeWizardPlugin = useSetAtom(bridgeWizardPluginAtom)
  const workspace = workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null
  const workspaceSlug = workspace?.slug ?? null
  const [marketTab, setMarketTab] = useState<'public' | 'personal'>('public')
  const [skills, setSkills] = useState<SkillCatalogItem[]>([])
  const [plugins, setPlugins] = useState<PluginMarketItem[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sourcePanelOpen, setSourcePanelOpen] = useState(false)
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const [busyItemId, setBusyItemId] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [skillDetail, setSkillDetail] = useState<SkillMarketDetailResult | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<PluginMarketItem | null>(null)
  const [pluginDetailLoading, setPluginDetailLoading] = useState(false)
  const [pluginDetailError, setPluginDetailError] = useState<string | null>(null)
  const [pluginDetail, setPluginDetail] = useState<GetMarketDetailResult | null>(null)

  const loadCatalog = useCallback(async (cacheMode: 'cache-first' | 'force-refresh' = 'cache-first', background = false) => {
    if (!workspaceSlug) {
      setSkills([])
      setPlugins([])
      setLoading(false)
      return
    }

    if (background) setSyncing(true)
    else setLoading(true)
    setError(null)
    try {
      const result = await getMarketCatalog({ workspaceSlug, cacheMode })
      setSkills(result.skills)
      setPlugins(result.plugins)
      setLastSyncedAt(result.syncedAt ? Date.parse(result.syncedAt) : null)
      setSyncNotice(
        result.status === 'failed-with-stale' || result.status === 'stale'
          ? '远程同步失败，当前继续使用上次成功的数据。'
          : result.status === 'partial'
            ? '部分市场源同步失败，其余内容仍可正常使用。'
            : null,
      )
      if (result.refreshRecommended && cacheMode === 'cache-first') void loadCatalog('force-refresh', true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (background) {
        setSyncNotice(`同步失败，当前内容保持不变：${message}`)
      } else {
        setError(message)
        setSkills([])
        setPlugins([])
      }
    } finally {
      if (!background) setLoading(false)
      else setSyncing(false)
    }
  }, [workspaceSlug])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  const allCards = useMemo(() => buildMarketCards({ plugins, skills }).map(toMarketDisplayCard), [plugins, skills])
  const cards = useMemo(() => {
    const base = filterMarketCards(allCards, { query, category: '全部分类', source: '全部来源' })
    // 公开 = 市场来源（内置/外部市场源/插件市场），个人 = 本地发现
    return marketTab === 'personal'
      ? base.filter((card) => card.sourceLabel === '本地发现')
      : base.filter((card) => card.sourceLabel !== '本地发现')
  }, [allCards, marketTab, query])
  const installedCards = useMemo(
    () => allCards.filter((card) => card.installState === 'installed' || card.installState === 'update-available'),
    [allCards],
  )
  const sections = useMemo(
    () =>
      MARKET_SECTION_ORDER.map((category) => ({ category, cards: cards.filter((card) => card.category === category) }))
        .filter((section) => section.cards.length > 0),
    [cards],
  )
  const summary = useMemo(() => buildMarketSummary({ plugins, skills }), [plugins, skills])
  const sourceViews = useMemo(() => buildMarketSourceViews(skills, plugins), [plugins, skills])

  const handleSkillAction = async (item: SkillCatalogItem) => {
    if (!workspaceSlug) return
    setBusyItemId(`skill:${item.id}`)
    setError(null)
    try {
      if (item.installState === 'installed') {
        await deleteWorkspaceSkill(workspaceSlug, item.slug)
        await loadCatalog()
        return
      }

      if (isInstallableSkillMarketItem(item)) {
        await installSkillMarketItemToWorkspace(buildSkillInstallRequest(workspaceSlug, item))
        await loadCatalog()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handleUninstallPlugin = async (item: PluginMarketItem) => {
    if (!workspaceSlug) return
    setBusyItemId(`plugin:${item.id}`)
    setError(null)
    try {
      await uninstallPlugin({ pluginId: item.pluginId, force: true })
      toast.success('插件已卸载')
      await loadCatalog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handlePluginAction = async (item: PluginMarketItem) => {
    if ((item.marketplace?.setup?.length ?? 0) > 0) {
      setBridgeWizardPlugin(item)
      setBridgeWizardOpen(true)
      return
    }
    if (!workspaceSlug) return
    if (item.installState !== 'installed') {
      await handleOpenPluginDetail(item)
      return
    }

    setBusyItemId(`plugin:${item.id}`)
    setError(null)
    try {
      const enabled = item.enableState !== 'global-enabled' && item.enableState !== 'workspace-enabled'
      await setPluginEnablement({
        workspaceSlug,
        pluginId: item.pluginId,
        scope: 'workspace',
        enabled,
      })
      await loadCatalog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handleInstallPluginFromDetail = async () => {
    if (!workspaceSlug || !pluginDetail?.inspect || pluginDetail.inspect.kind !== 'plugin') return
    const marketItem = pluginDetail.item.kind === 'plugin' ? pluginDetail.item.plugin : null
    if (!marketItem) return

    setBusyItemId(`plugin:${marketItem.id}`)
    setPluginDetailError(null)
    setError(null)
    try {
      const installState = pluginDetail.inspect.kind === 'plugin' ? pluginDetail.inspect.installState : marketItem.installState
      if (installState === 'update-available') {
        await updatePlugin({
          workspaceSlug,
          pluginId: marketItem.pluginId,
          acceptedPermissionsHash: pluginDetail.inspect.permissionsHash,
        })
        const installedPackages = await installPluginSetupPackages({
          workspaceSlug,
          catalogItemKey: marketItem.catalogItemKey,
          setup: marketItem.marketplace?.setup,
        })
        if (installedPackages.length > 0) toast.success('插件与 Native Host 已更新')
        const refreshed = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: marketItem.id })
        setPluginDetail(refreshed)
        if (refreshed.item.kind === 'plugin') {
          const refreshedPlugin = refreshed.item.plugin
          setSelectedPlugin((current) => ({ ...refreshedPlugin, catalogItemKey: current?.catalogItemKey }))
        }
      } else {
        await installMarketItem({
          workspaceSlug,
          kind: 'plugin',
          itemId: marketItem.id,
          acceptedPermissionsHash: pluginDetail.inspect.permissionsHash,
          enableScope: 'workspace',
          overwrite: false,
        })
        const installedPackages = await installPluginSetupPackages({
          workspaceSlug,
          catalogItemKey: marketItem.catalogItemKey,
          setup: marketItem.marketplace?.setup,
        })
        if (installedPackages.length > 0) toast.success('插件与 Native Host 已安装')
        setSelectedPlugin(null)
        setPluginDetail(null)
      }
      await loadCatalog()
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handleRollbackPluginFromDetail = async () => {
    const marketItem = pluginDetail?.item.kind === 'plugin' ? pluginDetail.item.plugin : selectedPlugin
    if (!workspaceSlug || !marketItem?.rollbackVersion) return

    setBusyItemId(`plugin:${marketItem.id}`)
    setPluginDetailError(null)
    setError(null)
    try {
      await setPluginActiveVersion({
        pluginId: marketItem.pluginId,
        version: marketItem.rollbackVersion,
      })
      const refreshed = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: marketItem.id })
      setPluginDetail(refreshed)
      if (refreshed.item.kind === 'plugin') {
        const refreshedPlugin = refreshed.item.plugin
        setSelectedPlugin((current) => ({ ...refreshedPlugin, catalogItemKey: current?.catalogItemKey }))
      }
      await loadCatalog()
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handleUninstallPluginFromDetail = async () => {
    const marketItem = pluginDetail?.item.kind === 'plugin' ? pluginDetail.item.plugin : null
    if (!marketItem) return

    setBusyItemId(`plugin:${marketItem.id}`)
    setPluginDetailError(null)
    setError(null)
    try {
      await uninstallPlugin({ pluginId: marketItem.pluginId, force: true })
      setSelectedPlugin(null)
      setPluginDetail(null)
      await loadCatalog()
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handleBackFromPluginDetail = () => {
    setSelectedPlugin(null)
    setPluginDetail(null)
    setPluginDetailError(null)
    setPluginDetailLoading(false)
  }

  const handleTogglePluginFromDetail = async () => {
    const marketItem = pluginDetail?.item.kind === 'plugin' ? pluginDetail.item.plugin : selectedPlugin
    if (!workspaceSlug || !marketItem) return
    const enableState = pluginDetail?.inspect?.kind === 'plugin' ? pluginDetail.inspect.enableState : marketItem.enableState
    const installState = pluginDetail?.inspect?.kind === 'plugin' ? pluginDetail.inspect.installState : marketItem.installState
    if (installState !== 'installed' && installState !== 'update-available') return

    setBusyItemId(`plugin:${marketItem.id}`)
    setPluginDetailError(null)
    setError(null)
    try {
      const enabled = enableState !== 'global-enabled' && enableState !== 'workspace-enabled'
      await setPluginEnablement({
        workspaceSlug,
        pluginId: marketItem.pluginId,
        scope: 'workspace',
        enabled,
      })
      const refreshed = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: marketItem.id })
      setPluginDetail(refreshed)
      if (refreshed.item.kind === 'plugin') {
        const refreshedPlugin = refreshed.item.plugin
        setSelectedPlugin((current) => ({ ...refreshedPlugin, catalogItemKey: current?.catalogItemKey }))
      }
      await loadCatalog()
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handleTryPluginInChat = () => {
    const marketItem = pluginDetail?.item.kind === 'plugin' ? pluginDetail.item.plugin : selectedPlugin
    if (!marketItem) return
    const workspaceId = workspace?.id ?? null
    const prompt = buildPluginTryPrompt(marketItem.pluginId)
    const uri = prompt.split(' ', 1)[0] ?? ''
    setWelcomeCapabilitySeed({
      uri,
      kind: 'plugin',
      label: marketItem.displayName || marketItem.pluginId,
      ...(marketItem.marketplace?.icon?.url ? { iconUrl: marketItem.marketplace.icon.url } : {}),
    })
    setWelcomePromptSeed(prompt)
    setTabs((previous) => upsertWelcomeTab(previous, workspaceId))
    setActiveTabId('__welcome__')
  }

  const handleOpenSkillDetail = async (item: SkillCatalogItem) => {
    if (!workspaceSlug) return
    setDetailOpen(true)
    setDetailLoading(true)
    setDetailError(null)
    setSkillDetail(null)
    setError(null)
    try {
      setSkillDetail(await getSkillMarketDetail({ workspaceSlug, skillSlug: item.slug }))
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetailLoading(false)
    }
  }

  const handleOpenPluginDetail = async (item: PluginMarketItem) => {
    if (!workspaceSlug) return
    setSelectedPlugin(item)
    setPluginDetailLoading(true)
    setPluginDetailError(null)
    setPluginDetail(null)
    setError(null)
    try {
      const detail = await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: item.id })
      if (detail.item.kind === 'plugin') {
        detail.item.plugin = {
          ...detail.item.plugin,
          catalogItemKey: item.catalogItemKey,
          marketplace: detail.item.plugin.marketplace
            ? {
                ...detail.item.plugin.marketplace,
                icon: detail.item.plugin.marketplace.icon?.url
                  ? detail.item.plugin.marketplace.icon
                  : item.marketplace?.icon,
              }
            : item.marketplace,
        }
      }
      setPluginDetail(detail)
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
      setPluginDetail({ item: { kind: 'plugin', plugin: item }, diagnostics: item.diagnostics ?? [] })
    } finally {
      setPluginDetailLoading(false)
    }
  }

  const handlePreparePackage = async (setupStepId: string) => {
    const item = selectedPlugin
    if (!workspaceSlug || !item?.catalogItemKey) return
    setBusyItemId(`package:${setupStepId}`)
    setPluginDetailError(null)
    try {
      const result = await savePluginPackage({ workspaceSlug, catalogItemKey: item.catalogItemKey, setupStepId })
      if (result.status === 'saved') toast.success(`配套包已保存${result.savedPath ? `：${result.savedPath}` : ''}`)
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  const handleInstallPackage = async (setupStepId: string) => {
    const item = selectedPlugin
    if (!workspaceSlug || !item?.catalogItemKey) return
    setBusyItemId(`package:${setupStepId}`)
    setPluginDetailError(null)
    try {
      const result = await installPluginPackage({ workspaceSlug, catalogItemKey: item.catalogItemKey, setupStepId })
      toast.success(`Native Host 已安装：${result.hostName}`)
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
  }

  useEffect(() => {
    if (!capabilityDetailTarget || loading || !workspaceSlug) return
    setCapabilityDetailTarget(null)
    if (capabilityDetailTarget.kind === 'skill') {
      const slug = decodeURIComponent(capabilityDetailTarget.uri.slice('lume-skill://'.length))
      const item = skills.find((candidate) => candidate.slug === slug)
      if (item) void handleOpenSkillDetail(item)
      else toast.info('此技能当前没有可打开的详情')
      return
    }
    const encodedPluginId = capabilityDetailTarget.kind === 'plugin'
      ? capabilityDetailTarget.uri.slice('lume-plugin://'.length)
      : capabilityDetailTarget.uri.slice('lume-skill://'.length).split(':', 1)[0] ?? ''
    const pluginId = decodeURIComponent(encodedPluginId)
    const item = plugins.find((candidate) => candidate.pluginId === pluginId)
    if (item) void handleOpenPluginDetail(item)
    else toast.info('此插件当前没有可打开的详情')
  }, [capabilityDetailTarget, loading, plugins, setCapabilityDetailTarget, skills, workspaceSlug])

  const handleAddSource = async (draft: {
    connectionMode: 'local' | 'remote'
    type: 'official' | 'team' | 'local'
    name: string
    url: string
    localPath: string
  }) => {
    if (!workspaceSlug) {
      throw new Error('请先选择工作区')
    }

    const config = await getEffectiveLumeConfig()
    const sourceRef = buildMarketSourceRef(draft)
    const marketSources = [
      ...(config.plugins?.marketSources ?? []).filter((source) => source.id !== sourceRef.id),
      sourceRef,
    ]

    await updatePluginsConfig({
      ...(config.plugins ?? {}),
      marketSources,
    })
    await loadCatalog()
  }

  if (selectedPlugin || pluginDetailLoading || pluginDetail) {
    return (
      <PluginDetailPage
        detail={pluginDetail}
        loading={pluginDetailLoading}
        error={pluginDetailError}
        busy={busyItemId !== null}
        onBack={handleBackFromPluginDetail}
        onInstall={() => void handleInstallPluginFromDetail()}
        onUninstall={() => void handleUninstallPluginFromDetail()}
        onToggleEnable={() => void handleTogglePluginFromDetail()}
        onTryInChat={handleTryPluginInChat}
        onPreparePackage={handlePreparePackage}
        onInstallPackage={handleInstallPackage}
        onRollback={() => void handleRollbackPluginFromDetail()}
      />
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--background)] px-7 pb-12 pt-8 text-[var(--text-1)]">
      <div className="mx-auto w-full max-w-[1100px]">
        <header className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <h1 className="text-[26px] font-bold leading-tight text-[var(--text-1)]">插件市场</h1>
            <p className="mt-2 text-[14px] text-[var(--text-2)]">用插件为 Lume 扩展技能、命令与 MCP 能力</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              type="button"
              size="icon"
              disabled={syncing}
              onClick={() => void loadCatalog('force-refresh', true)}
              title="同步市场"
            >
              <RefreshCw size={16} className={cn(syncing && 'animate-spin')} />
            </Button>
            <Button
              variant="ghost"
              type="button"
              size="icon"
              onClick={() => setSourcePanelOpen(true)}
              title="市场源设置"
            >
              <SlidersHorizontal size={16} />
            </Button>
            <Button
              type="button"
              onClick={() => setSourceDialogOpen(true)}
              className="ml-1 h-8 gap-1 rounded-lg px-3 text-[13px] font-semibold"
            >
              <Plus size={15} />
              新建
            </Button>
          </div>
        </header>

        <label className="mt-5 flex h-10 items-center gap-2.5 rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_48%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-2)_58%,var(--surface-1))] px-3.5 text-[var(--text-3)] transition-colors focus-within:border-[color:color-mix(in_oklab,var(--brand)_28%,var(--border-strong))]">
          <Search size={16} />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索插件"
            className="h-full min-w-0 flex-1 border-0 bg-transparent px-0 text-[13.5px] text-[var(--text-1)] shadow-none outline-none placeholder:text-[var(--text-3)] focus-visible:ring-0"
          />
        </label>

        {installedCards.length > 0 && (
          <section className="mt-8">
            <div className="flex items-center justify-between border-b border-[color:color-mix(in_oklab,var(--border-strong)_30%,transparent)] pb-2.5">
              <h2 className="text-[15px] font-semibold text-[var(--text-1)]">已安装</h2>
              <Button
                variant="ghost"
                type="button"
                size="icon-sm"
                onClick={() => setSourcePanelOpen(true)}
                title="管理市场源"
              >
                <SlidersHorizontal size={15} />
              </Button>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {installedCards.map((card) => (
                <InstalledCardIcon
                  key={`${card.kind}:${card.id}`}
                  card={card}
                  onOpenDetail={() => {
                    if (card.kind === 'skill') void handleOpenSkillDetail(card.item as SkillCatalogItem)
                    else void handleOpenPluginDetail(card.item as PluginMarketItem)
                  }}
                />
              ))}
            </div>
          </section>
        )}

        <div className="mt-7 flex items-center justify-between">
          <div className="lume-segmented inline-flex">
            {([
              { id: 'public', label: '公开' },
              { id: 'personal', label: '个人' },
            ] as const).map((tab) => (
              <Button
                variant="ghost"
                key={tab.id}
                type="button"
                onClick={() => setMarketTab(tab.id)}
                className={cn(
                  'lume-segmented-item px-4 text-[13px]',
                  marketTab === tab.id ? 'lume-segmented-item-active' : '',
                )}
              >
                {tab.label}
              </Button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="mt-8 flex h-[180px] items-center justify-center gap-2 rounded-lg border border-[color:color-mix(in_oklab,var(--border-strong)_36%,transparent)] text-[13px] text-[var(--text-3)]">
            <Loader2 size={16} className="animate-spin" />
            正在同步市场...
          </div>
        ) : error ? (
          <div className="mt-8 rounded-lg border border-[color:color-mix(in_oklab,var(--lume-danger)_24%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] p-4 text-[13px] text-[var(--lume-danger)]">
            {error}
          </div>
        ) : sections.length === 0 ? (
          <div className="mt-8 rounded-lg border border-dashed border-[var(--border)] p-10 text-center text-[13px] text-[var(--text-3)]">
            {marketTab === 'personal'
              ? '还没有本地插件或技能。可通过右上角「新建」添加本地来源。'
              : '没有匹配的插件或技能，换个关键词试试。'}
          </div>
        ) : (
          <div className="min-w-0">
            {syncNotice && (
              <div className="mt-6 rounded-lg border border-[color:color-mix(in_oklab,var(--lume-warning)_24%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-warning)_7%,var(--surface-1))] px-3 py-2 text-[12px] text-[var(--text-2)]">
                {syncNotice}
              </div>
            )}
            {sections.map((section) => (
              <section key={section.category} className="mt-7">
                <h2 className="border-b border-[color:color-mix(in_oklab,var(--border-strong)_30%,transparent)] pb-2.5 text-[15px] font-semibold text-[var(--text-1)]">
                  {section.category}
                </h2>
                <div className="mt-1.5 grid grid-cols-2 gap-x-10">
                  {section.cards.map((card) => (
                    <MarketItemRow
                      key={`${card.kind}:${card.id}`}
                      card={card}
                      busy={busyItemId === `${card.kind}:${card.id}`}
                      onOpenDetail={() => {
                        if (card.kind === 'skill') void handleOpenSkillDetail(card.item as SkillCatalogItem)
                        else void handleOpenPluginDetail(card.item as PluginMarketItem)
                      }}
                      onAction={() => {
                        if (card.kind === 'skill') void handleSkillAction(card.item as SkillCatalogItem)
                        else void handlePluginAction(card.item as PluginMarketItem)
                      }}
                      onUninstall={() => {
                        if (card.kind === 'plugin') void handleUninstallPlugin(card.item as PluginMarketItem)
                      }}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <Dialog open={sourcePanelOpen} onOpenChange={setSourcePanelOpen}>
        <DialogContent showCloseButton className="w-[calc(100%-2rem)] sm:max-w-[400px]">
          <DialogTitle className="sr-only">市场源设置</DialogTitle>
          <SkillSourcePanel
            loading={loading || syncing}
            sources={sourceViews}
            summary={summary}
            lastSyncedAt={lastSyncedAt}
            onAddSource={() => setSourceDialogOpen(true)}
            onSync={() => void loadCatalog('force-refresh', true)}
          />
        </DialogContent>
      </Dialog>

      <AddSkillSourceDialog
        open={sourceDialogOpen}
        workspaceSlug={workspaceSlug}
        onOpenChange={setSourceDialogOpen}
        onSubmit={handleAddSource}
        onCatalogChanged={() => void loadCatalog()}
      />
      <SkillDetailDialog
        open={detailOpen}
        loading={detailLoading}
        error={detailError}
        detail={skillDetail}
        onOpenChange={setDetailOpen}
      />
      <BridgeInstallWizard workspaceSlug={workspaceSlug} />
    </div>
  )
}

function InstalledCardIcon({ card, onOpenDetail }: { card: MarketDisplayCard; onOpenDetail: () => void }) {
  const Icon = card.icon
  const plugin = card.kind === 'plugin' ? card.item as PluginMarketItem : null
  return (
    <button
      type="button"
      onClick={onOpenDetail}
      title={card.name}
      className={cn(
        'flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] transition-transform hover:scale-105',
        iconToneClass(card.tone),
      )}
    >
      {plugin
        ? <PluginLogo src={plugin.marketplace?.icon?.url} alt={`${card.name} 图标`} className="size-6" />
        : <Icon size={20} strokeWidth={2.2} />}
    </button>
  )
}

function MarketItemRow({
  card,
  busy,
  onOpenDetail,
  onAction,
  onUninstall,
}: {
  card: MarketDisplayCard
  busy: boolean
  onOpenDetail: () => void
  onAction: () => void
  onUninstall: () => void
}) {
  const Icon = card.icon
  const plugin = card.kind === 'plugin' ? card.item as PluginMarketItem : null
  const installed = card.installState === 'installed'
  const canUninstall = card.kind === 'plugin' && (installed || card.installState === 'update-available')
  const toggleLabel = card.enabled ? '禁用' : '启用'

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenDetail()
        }
      }}
      className="group flex min-w-0 cursor-pointer items-center gap-3.5 rounded-lg px-2 py-3 transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:color-mix(in_oklab,var(--brand)_30%,transparent)]"
    >
      <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-[10px]', iconToneClass(card.tone))}>
        {plugin
          ? <PluginLogo src={plugin.marketplace?.icon?.url} alt={`${card.name} 图标`} className="size-6" />
          : <Icon size={20} strokeWidth={2.2} />}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-[15px] font-semibold leading-5 text-[var(--text-1)]" title={card.name}>
          {card.name}
        </h3>
        <p className="mt-0.5 truncate text-[13px] leading-[18px] text-[var(--text-2)]" title={card.description ?? undefined}>
          {card.description ?? '暂无描述。'}
        </p>
      </div>
      {busy && <Loader2 size={15} className="mr-1 shrink-0 animate-spin text-[var(--text-3)]" />}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              type="button"
              size="icon-sm"
              disabled={busy}
              className="shrink-0 text-[var(--text-3)] hover:text-[var(--text-1)]"
              onClick={(event) => event.stopPropagation()}
              title="更多操作"
            />
          }
        >
          <MoreVertical size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[128px]">
          {plugin && card.installState === 'update-available' ? (
            <DropdownMenuItem onSelect={onAction}>
              <Download size={14} />
              更新
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={onAction}>
              {card.kind === 'plugin' && installed ? <Power size={14} /> : <Download size={14} />}
              {card.kind === 'plugin' && installed ? toggleLabel : card.actionLabel}
            </DropdownMenuItem>
          )}
          {canUninstall && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={onUninstall}>
                <Trash2 size={14} />
                卸载
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function SkillSourcePanel({
  loading,
  sources,
  summary,
  lastSyncedAt,
  onAddSource,
  onSync,
}: {
  loading: boolean
  sources: SkillSourceView[]
  summary: ReturnType<typeof buildMarketSummary>
  lastSyncedAt: number | null
  onAddSource: () => void
  onSync: () => void
}) {
  return (
    <aside className="h-fit rounded-[8px] border border-[color:color-mix(in_oklab,var(--border)_60%,transparent)] bg-[var(--surface-1)] p-3 shadow-[0_2px_8px_-5px_hsl(var(--lume-shadow-panel)/0.24)]">
      <h2 className="text-[14px] font-semibold leading-5 text-[var(--text-1)]">市场源</h2>
      <p className="mt-1 text-[12px] leading-4 text-[var(--text-3)]">管理插件与技能来源，并同步获取最新内容。</p>

      <div className="lume-subpanel mt-2.5 space-y-0.5 p-1">
        {sources.map((source) => (
          <SkillSourceRow key={source.id} source={source} />
        ))}
      </div>

      <Button
                variant="ghost"
        type="button"
        onClick={onAddSource}
        className="mt-2.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-[7px] border border-dashed border-[color:color-mix(in_oklab,var(--brand)_24%,var(--border))] bg-[var(--surface-1)] text-[12px] font-semibold text-[var(--brand)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--surface-1))]"
      >
        <Plus size={14} />
        添加市场源
      </Button>

      <Button
                variant="ghost"
        type="button"
        onClick={onSync}
        disabled={loading}
        className="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-[7px] bg-[var(--brand)] text-[12px] font-semibold text-[var(--brand-foreground)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--brand)_88%,var(--brand-2))] disabled:cursor-wait disabled:opacity-70"
      >
        <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
        同步市场
      </Button>

      <div className="my-3 h-px bg-[color:color-mix(in_oklab,var(--border)_48%,transparent)]" />

      <div className="rounded-[7px] bg-[var(--surface-2)] p-2.5">
        <div className="flex items-center gap-1.5 text-[var(--text-2)]">
          <ShieldCheck size={14} className="text-[var(--lume-success)]" />
          <span className="text-[11px] font-medium">上次同步：{formatSyncTime(lastSyncedAt)}</span>
        </div>
        <div className="mt-1.5 pl-5 text-[11px] leading-4 text-[var(--text-3)]">
          已发现 {summary.totalPlugins} 个插件、{summary.totalSkills} 个技能；当前工作区已启用 {summary.enabledPlugins} 个插件，已安装 {summary.installedSkills} 个技能
        </div>
      </div>
    </aside>
  )
}

function AddSkillSourceDialog({
  open,
  workspaceSlug,
  onOpenChange,
  onSubmit,
  onCatalogChanged,
}: {
  open: boolean
  workspaceSlug: string | null
  onOpenChange: (open: boolean) => void
  onSubmit: (draft: {
    connectionMode: 'local' | 'remote'
    type: 'official' | 'team' | 'local'
    name: string
    url: string
    localPath: string
  }) => Promise<void>
  onCatalogChanged: () => void
}) {
  const [panel, setPanel] = useState<'source' | 'plugin' | 'skill' | 'format'>('source')
  const [connectionMode, setConnectionMode] = useState<'local' | 'remote'>('remote')
  const [type, setType] = useState<'official' | 'team' | 'local'>('official')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [pluginMode, setPluginMode] = useState<'local' | 'remote'>('local')
  const [pluginLocalPath, setPluginLocalPath] = useState('')
  const [pluginUrl, setPluginUrl] = useState('')
  const [pluginReview, setPluginReview] = useState<{
    source: PluginSourceRef
    name: string
    version: string
    permissionsHash: string
    risks: string[]
  } | null>(null)
  const [skillMode, setSkillMode] = useState<'local' | 'remote'>('local')
  const [skillLocalPath, setSkillLocalPath] = useState('')
  const [skillUrl, setSkillUrl] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const chooseLocalPath = async (target: 'source' | 'plugin' | 'skill') => {
    const selected = await openFolderDialog()
    if (!selected.path) return
    if (target === 'source') setLocalPath(selected.path)
    if (target === 'plugin') {
      setPluginLocalPath(selected.path)
      setPluginReview(null)
    }
    if (target === 'skill') setSkillLocalPath(selected.path)
  }

  const handleSubmitSource = async () => {
    setBusy('source')
    setError(null)
    try {
      await onSubmit({ connectionMode, type, name, url, localPath })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleInspectPlugin = async () => {
    if (!workspaceSlug) {
      setError('请先选择工作区')
      return
    }
    setBusy('plugin-review')
    setError(null)
    try {
      const sourceRef = buildDirectPluginSource(pluginMode, pluginLocalPath, pluginUrl)
      const inspected = await inspectMarketSource({ workspaceSlug, source: sourceRef })
      if (inspected.kind !== 'plugin') throw new Error('没有检测到有效插件')
      setPluginReview({
        source: sourceRef,
        name: inspected.normalized.displayName ?? inspected.normalized.name,
        version: inspected.normalized.version,
        permissionsHash: inspected.permissionsHash,
        risks: inspected.permissionSummary.riskLabels.map(formatRiskLabel),
      })
    } catch (err) {
      setPluginReview(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleInstallReviewedPlugin = async () => {
    if (!workspaceSlug || !pluginReview) return
    setBusy('plugin-install')
    setError(null)
    try {
      await installMarketItem({
        workspaceSlug,
        kind: 'plugin',
        source: pluginReview.source,
        acceptedPermissionsHash: pluginReview.permissionsHash,
        enableScope: 'workspace',
        overwrite: true,
      })
      onCatalogChanged()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleInstallSkill = async () => {
    if (!workspaceSlug) {
      setError('请先选择工作区')
      return
    }
    setBusy('skill-install')
    setError(null)
    try {
      if (skillMode === 'local') {
        await importLocalSkillDirectoryToWorkspace({ workspaceSlug, localPath: skillLocalPath.trim(), overwrite: true })
      } else {
        const review = await getGitHubSkillReview({ url: skillUrl.trim() })
        await installGitHubSkillToWorkspace({ workspaceSlug, url: review.url, reviewToken: review.reviewToken, overwrite: true })
      }
      onCatalogChanged()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[color:color-mix(in_oklab,var(--text-1)_28%,transparent)] p-6 backdrop-blur-[2px]">
      <section className="grid max-h-[88vh] w-full max-w-[720px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_24px_72px_-40px_hsl(var(--lume-shadow-panel)/0.5)]">
        <header className="flex items-start justify-between border-b border-[var(--border)] px-6 py-5">
          <div>
            <h2 className="text-[19px] font-semibold leading-7 text-[var(--text-1)]">添加技能 / 插件</h2>
            <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">
              添加 marketplace root，或单独安装插件目录、技能目录、GitHub 地址。
            </p>
          </div>
          <Button
                variant="ghost"
            type="button"
            title="关闭"
            onClick={() => onOpenChange(false)}
            className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <X size={18} />
          </Button>
        </header>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <div className="lume-segmented mb-5 grid grid-cols-4 gap-2">
            {([
              { id: 'source', label: '市场源' },
              { id: 'plugin', label: '单独安装插件' },
              { id: 'skill', label: '单独安装技能' },
              { id: 'format', label: '格式说明' },
            ] as const).map((option) => (
              <Button
                variant="ghost"
                key={option.id}
                type="button"
                onClick={() => {
                  setPanel(option.id)
                  setError(null)
                }}
                className={cn(
                  'lume-segmented-item px-3 text-[12px] font-semibold',
                  panel === option.id ? 'lume-segmented-item-active' : '',
                )}
              >
                {option.label}
              </Button>
            ))}
          </div>

          {panel === 'source' && (
            <div className="space-y-5">
              <SourceModeSwitch value={connectionMode} onChange={(value) => {
                setConnectionMode(value)
                setType(value === 'local' ? 'local' : 'official')
              }} localLabel="本地 marketplace root" remoteLabel="GitHub marketplace root" />
              <div className="grid grid-cols-2 gap-4">
                <SkillSourceField label="源名称" value={name} placeholder="例如：superpowers-dev" onChange={setName} />
                {connectionMode === 'remote' && (
                  <SkillSourceField label="GitHub root 地址" value={url} placeholder="https://github.com/org/repo/tree/main/path" onChange={setUrl} />
                )}
              </div>
              {connectionMode === 'local' && (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                  <SkillSourceField label="marketplace root" value={localPath} placeholder="/Users/me/marketplace-root" onChange={setLocalPath} />
                  <ChooseFolderButton onClick={() => void chooseLocalPath('source')} />
                </div>
              )}
              <FormatHint compact />
            </div>
          )}

          {panel === 'plugin' && (
            <div className="space-y-5">
              <SourceModeSwitch value={pluginMode} onChange={(value) => {
                setPluginMode(value)
                setPluginReview(null)
              }} localLabel="插件目录" remoteLabel="GitHub 插件" />
              {pluginMode === 'local' ? (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                  <SkillSourceField label="插件目录" value={pluginLocalPath} placeholder="/Users/me/plugin-root" onChange={(value) => {
                    setPluginLocalPath(value)
                    setPluginReview(null)
                  }} />
                  <ChooseFolderButton onClick={() => void chooseLocalPath('plugin')} />
                </div>
              ) : (
                <SkillSourceField label="GitHub 插件地址" value={pluginUrl} placeholder="https://github.com/org/repo/tree/main/plugin" onChange={(value) => {
                  setPluginUrl(value)
                  setPluginReview(null)
                }} />
              )}
              <Button
                variant="ghost"
                type="button"
                disabled={busy !== null || (pluginMode === 'local' ? !pluginLocalPath.trim() : !pluginUrl.trim())}
                onClick={() => void handleInspectPlugin()}
                className="flex h-10 items-center gap-2 rounded-[6px] border border-[color:color-mix(in_oklab,var(--brand)_28%,var(--border))] px-4 text-[13px] font-semibold text-[var(--brand)] hover:bg-[color:color-mix(in_oklab,var(--brand)_7%,var(--surface-1))] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {busy === 'plugin-review' ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                检查权限
              </Button>
              {pluginReview && (
                <div className="lume-subpanel p-4">
                  <div className="text-[13px] font-semibold text-[var(--text-1)]">{pluginReview.name} v{pluginReview.version}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {pluginReview.risks.length > 0 ? pluginReview.risks.map((risk) => (
                      <span key={risk} className="rounded-[5px] bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))] px-2 py-1 text-[12px] font-semibold text-[var(--lume-warning)]">{risk}</span>
                    )) : (
                      <span className="rounded-[5px] bg-[color:color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] px-2 py-1 text-[12px] font-semibold text-[var(--lume-success)]">低风险</span>
                    )}
                  </div>
                  <div className="mt-3 break-all font-mono text-[12px] leading-5 text-[var(--text-3)]">{pluginReview.permissionsHash}</div>
                </div>
              )}
            </div>
          )}

          {panel === 'skill' && (
            <div className="space-y-5">
              <SourceModeSwitch value={skillMode} onChange={setSkillMode} localLabel="技能目录" remoteLabel="GitHub 技能" />
              {skillMode === 'local' ? (
                <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
                  <SkillSourceField label="技能目录" value={skillLocalPath} placeholder="/Users/me/skills/debugging 或 /Users/me/skills" onChange={setSkillLocalPath} />
                  <ChooseFolderButton onClick={() => void chooseLocalPath('skill')} />
                </div>
              ) : (
                <SkillSourceField label="GitHub 技能地址" value={skillUrl} placeholder="https://github.com/org/repo/tree/main/skills/debugging" onChange={setSkillUrl} />
              )}
              <div className="lume-subpanel p-4 text-[12px] leading-5 text-[var(--text-2)]">
                本地可以选择一个包含 SKILL.md 的技能目录，也可以选择包含多个技能子目录的父目录。远程地址会先走 GitHub skill review，再安装到当前工作区。
              </div>
            </div>
          )}

          {panel === 'format' && <MarketplaceFormatGuide />}

          {error && (
            <div className="mt-5 rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-danger)_24%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] p-3 text-[12px] leading-5 text-[var(--lume-danger)]">{error}</div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-6 py-4">
          <Button
                variant="ghost"
            type="button"
            onClick={() => setPanel('format')}
            className="flex h-9 items-center gap-2 rounded-[6px] px-3 text-[13px] font-semibold text-[var(--text-2)] hover:bg-[var(--surface-2)]"
          >
            <Info size={16} />
            支持格式
          </Button>
          <div className="flex items-center gap-3">
            <Button
                variant="ghost" type="button" onClick={() => onOpenChange(false)} className="h-9 rounded-[6px] border border-[var(--border)] px-4 text-[13px] font-semibold text-[var(--text-2)] hover:bg-[var(--surface-2)]">取消</Button>
            {panel === 'source' && (
              <Button
                variant="ghost" type="button" disabled={busy !== null || (connectionMode === 'remote' ? !url.trim() : !localPath.trim())} onClick={() => void handleSubmitSource()} className="h-9 rounded-[6px] bg-[var(--brand)] px-4 text-[13px] font-semibold text-[var(--brand-foreground)] hover:bg-[color:color-mix(in_oklab,var(--brand)_88%,var(--brand-2))] disabled:cursor-not-allowed disabled:opacity-55">
                {busy === 'source' ? '同步中...' : '添加并同步'}
              </Button>
            )}
            {panel === 'plugin' && (
              <Button
                variant="ghost" type="button" disabled={busy !== null || !pluginReview} onClick={() => void handleInstallReviewedPlugin()} className="h-9 rounded-[6px] bg-[var(--brand)] px-4 text-[13px] font-semibold text-[var(--brand-foreground)] hover:bg-[color:color-mix(in_oklab,var(--brand)_88%,var(--brand-2))] disabled:cursor-not-allowed disabled:opacity-55">
                {busy === 'plugin-install' ? '安装中...' : '确认安装插件'}
              </Button>
            )}
            {panel === 'skill' && (
              <Button
                variant="ghost" type="button" disabled={busy !== null || (skillMode === 'local' ? !skillLocalPath.trim() : !skillUrl.trim())} onClick={() => void handleInstallSkill()} className="h-9 rounded-[6px] bg-[var(--brand)] px-4 text-[13px] font-semibold text-[var(--brand-foreground)] hover:bg-[color:color-mix(in_oklab,var(--brand)_88%,var(--brand-2))] disabled:cursor-not-allowed disabled:opacity-55">
                {busy === 'skill-install' ? '安装中...' : '审查并安装技能'}
              </Button>
            )}
          </div>
        </footer>
      </section>
    </div>
  )
}

function SkillSourceField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}) {
  return (
    <label className="block">
      <span className="text-[13px] font-semibold text-[var(--text-1)]">{label}</span>
      <Input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-10 w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[color:color-mix(in_oklab,var(--brand)_50%,var(--border-strong))]"
      />
    </label>
  )
}

function ChooseFolderButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
                variant="ghost"
      type="button"
      onClick={onClick}
      className="h-10 rounded-[6px] border border-[var(--border)] px-4 text-[13px] font-semibold text-[var(--text-2)] hover:bg-[var(--surface-2)]"
    >
      选择目录
    </Button>
  )
}

function SourceModeSwitch({
  value,
  onChange,
  localLabel,
  remoteLabel,
}: {
  value: 'local' | 'remote'
  onChange: (value: 'local' | 'remote') => void
  localLabel: string
  remoteLabel: string
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {([
        { id: 'local', label: localLabel },
        { id: 'remote', label: remoteLabel },
      ] as const).map((option) => (
        <Button
                variant="ghost"
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-[8px] border p-3 text-left text-[13px] font-semibold transition-colors',
            value === option.id
              ? 'border-transparent bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--text-1)]'
              : 'border-transparent bg-[var(--surface-2)] text-[var(--text-2)] hover:bg-[var(--surface-3)]',
          )}
        >
          {option.label}
        </Button>
      ))}
    </div>
  )
}

function FormatHint({ compact = false }: { compact?: boolean }) {
  return (
    <div className="lume-subpanel p-4 text-[12px] leading-5 text-[var(--text-2)]">
      市场源必须是 marketplace root，根目录下存在 <span className="font-mono text-[var(--text-1)]">.lume-plugin/marketplace.json</span>
      {compact ? '。' : '，其中 plugins[] 和 skills[] 的 source 都是相对 root 的目录路径。'}
    </div>
  )
}

function MarketplaceFormatGuide() {
  return (
    <div className="space-y-4 text-[13px] leading-6 text-[var(--text-2)]">
      <FormatHint />
      <div className="lume-subpanel p-4">
        <div className="font-semibold text-[var(--text-1)]">marketplace.json</div>
        <pre className="mt-3 overflow-auto rounded-[8px] bg-[var(--surface-1)] p-3 font-mono text-[12px] leading-5 text-[var(--text-1)]">
{`{
  "name": "superpowers-dev",
  "description": "Development marketplace",
  "plugins": [
    { "name": "superpowers", "version": "6.0.2", "source": "./" }
  ],
  "skills": [
    { "name": "debugging", "version": "1.0.0", "source": "./skills/debugging" }
  ]
}`}
        </pre>
      </div>
      <div className="lume-subpanel p-4">
        插件目录需要包含 <span className="font-mono">.lume-plugin/plugin.json</span> 或 <span className="font-mono">.codex-plugin/plugin.json</span>。
        技能目录需要包含 <span className="font-mono">SKILL.md</span>。<span className="font-mono">plugins[]</span> 和 <span className="font-mono">skills[]</span> 至少有一个非空数组。
      </div>
    </div>
  )
}

function SkillSourceRow({ source }: { source: SkillSourceView }) {
  const Icon = source.icon

  return (
    <div className="flex min-h-12 items-center gap-2.5 rounded-[6px] px-2 py-1.5 transition-colors hover:bg-[var(--surface-1)]">
      <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-[6px]', iconToneClass(source.tone))}>
        <Icon size={16} strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-[12px] font-semibold leading-4 text-[var(--text-1)]">{source.name}</span>
          {source.enabled && (
            <>
              <span className="size-1 shrink-0 rounded-full bg-[var(--lume-success)]" />
              <span className="shrink-0 text-[10px] font-medium text-[var(--lume-success)]">已启用</span>
            </>
          )}
        </div>
        <div className="truncate text-[11px] leading-4 text-[var(--text-3)]">{source.detail}</div>
      </div>
      <Button
                variant="ghost" type="button" className="flex size-6 shrink-0 items-center justify-center rounded-[5px] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]">
        <MoreVertical size={14} />
      </Button>
    </div>
  )
}

function SkillDetailDialog({
  open,
  loading,
  error,
  detail,
  onOpenChange,
}: {
  open: boolean
  loading: boolean
  error: string | null
  detail: SkillMarketDetailResult | null
  onOpenChange: (open: boolean) => void
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const selectedFile = useMemo(() => findFileNode(detail?.files ?? [], selectedPath), [detail?.files, selectedPath])

  useEffect(() => {
    if (!open || !detail) {
      setSelectedPath(null)
      return
    }

    setSelectedPath(findDefaultSkillFilePath(detail.files))
  }, [detail, open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[color:color-mix(in_oklab,var(--text-1)_28%,transparent)] p-4 backdrop-blur-[2px]">
      <section className="grid max-h-[90vh] w-full max-w-[1180px] grid-rows-[auto_minmax(0,1fr)] rounded-[8px] border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_24px_72px_-40px_hsl(var(--lume-shadow-panel)/0.5)]">
        <header className="flex items-start justify-between border-b border-[var(--border)] px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-semibold leading-7 text-[var(--text-1)]">
              {detail?.item.name ?? '技能详情'}
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-[var(--text-2)]">
              查看该 Agent 技能的来源、安装状态与包含文件树。
            </p>
          </div>
          <Button
                variant="ghost"
            type="button"
            title="关闭"
            onClick={() => onOpenChange(false)}
            className="flex size-8 items-center justify-center rounded-[6px] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text-1)]"
          >
            <X size={18} />
          </Button>
        </header>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex h-[220px] items-center justify-center gap-2 text-[13px] text-[var(--text-3)]">
              <Loader2 size={16} className="animate-spin" />
              正在读取技能文件...
            </div>
          ) : error ? (
            <div className="rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-danger)_24%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-danger)_7%,var(--surface-1))] p-5 text-[13px] leading-6 text-[var(--lume-danger)]">
              {error}
            </div>
          ) : detail ? (
            <div className="space-y-5">
              <section className="lume-subpanel p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded-[5px] px-2 py-1 text-[12px] font-medium', badgeToneClass(SKILL_SOURCE_LABELS[detail.item.sourceType]))}>
                    {SKILL_SOURCE_LABELS[detail.item.sourceType]}
                  </span>
                  <span className="rounded-[5px] bg-[var(--surface-1)] px-2 py-1 text-[12px] font-medium text-[var(--text-2)]">
                    {formatInstallState(detail.item.installState)}
                  </span>
                  {detail.item.version && (
                    <span className="rounded-[5px] bg-[var(--surface-1)] px-2 py-1 text-[12px] font-medium text-[var(--text-2)]">
                      v{detail.item.version}
                    </span>
                  )}
                </div>
                <p className="mt-3 text-[13px] leading-6 text-[var(--text-2)]">
                  {detail.item.description ?? '暂无描述。'}
                </p>
                <div className="mt-4 border-t border-[var(--border)] pt-3">
                  <div className="text-[12px] font-semibold text-[var(--text-1)]">技能目录</div>
                  <div className="mt-2 break-all text-[12px] leading-5 text-[var(--text-3)]">{detail.rootPath}</div>
                </div>
              </section>

              <div className="grid h-[min(620px,calc(90vh-250px))] min-h-[420px] gap-4 md:grid-cols-[300px_minmax(0,1fr)]">
                <section className="lume-subpanel grid min-h-0 grid-rows-[auto_minmax(0,1fr)] p-4">
                  <h3 className="text-[14px] font-semibold text-[var(--text-1)]">文件树</h3>
                  <div className="mt-3 min-h-0 overflow-y-auto rounded-[6px] bg-[var(--surface-1)] p-2">
                    <SkillFileTree nodes={detail.files} selectedPath={selectedPath} onSelect={setSelectedPath} />
                  </div>
                </section>

                <SkillFileContentPreview file={selectedFile} />
              </div>
            </div>
          ) : (
            <div className="rounded-[8px] border border-dashed border-[var(--border)] p-8 text-center text-[13px] text-[var(--text-3)]">
              暂无技能详情。
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function SkillFileContentPreview({ file }: { file: SkillFileTreeNode | null }) {
  const [copied, setCopied] = useState(false)
  const content = file?.content ?? ''
  const lines = useMemo(() => (content ? content.split('\n') : []), [content])
  const language = file ? inferFileLanguage(file.name) : null

  useEffect(() => {
    setCopied(false)
  }, [file?.path])

  const handleCopy = useCallback(async () => {
    if (!content) return
    await writeClipboardText(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }, [content])

  return (
    <section className="lume-subpanel grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
      <div className="flex min-h-16 items-center justify-between gap-3 border-b border-[var(--border)] px-4">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-[var(--text-1)]">当前文件内容</h3>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-[var(--text-3)]">
            <span className="max-w-[520px] truncate">{file?.path ?? '未选择文件'}</span>
            {language && <span className="rounded-[5px] bg-[var(--surface-1)] px-2 py-0.5 font-medium text-[var(--text-2)]">{language}</span>}
            {file && <span>{formatFileSize(content.length)}</span>}
            {file && <span>{lines.length || 1} 行</span>}
          </div>
        </div>
        <Button
                variant="ghost"
          type="button"
          title="复制文件内容"
          disabled={!content}
          onClick={handleCopy}
          className="flex h-9 shrink-0 items-center gap-2 rounded-[7px] border border-[var(--border)] bg-[var(--surface-1)] px-3 text-[12px] font-semibold text-[var(--text-2)] hover:border-[color:color-mix(in_oklab,var(--brand)_30%,var(--border-strong))] hover:text-[var(--brand)] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? '已复制' : '复制'}
        </Button>
      </div>

      {file && content ? (
        <div className="min-h-0 overflow-auto bg-[var(--surface-1)]">
          <div className="grid min-w-full grid-cols-[auto_minmax(0,1fr)] font-mono text-[12px] leading-6">
            <div className="select-none border-r border-[var(--border)] bg-[var(--surface-2)] px-3 py-4 text-right text-[var(--text-3)]">
              {lines.map((_, index) => (
                <div key={index} className="h-6 tabular-nums">
                  {index + 1}
                </div>
              ))}
            </div>
            <pre className="min-w-0 whitespace-pre-wrap break-words px-4 py-4 text-[var(--text-1)]">
              {lines.map((line, index) => (
                <span key={index} className="block min-h-6">
                  {line || ' '}
                </span>
              ))}
            </pre>
          </div>
        </div>
      ) : (
        <div className="flex min-h-[320px] items-center justify-center bg-[var(--surface-1)] px-6 text-center text-[13px] leading-6 text-[var(--text-3)]">
          {file ? '暂无可预览内容。' : '从左侧文件树选择一个文件查看内容。'}
        </div>
      )}
    </section>
  )
}

function SkillFileTree({
  nodes,
  selectedPath,
  onSelect,
}: {
  nodes: SkillFileTreeNode[]
  selectedPath: string | null
  onSelect: (path: string) => void
}) {
  return (
    <ul className="space-y-1">
      {nodes.map((node) => (
        <li key={node.path}>
          {node.type === 'file' ? (
            <Button
                variant="ghost"
              type="button"
              onClick={() => onSelect(node.path)}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12px] text-[var(--text-2)] hover:bg-[var(--surface-2)]',
                selectedPath === node.path && 'bg-[color:color-mix(in_oklab,var(--brand)_9%,var(--surface-1))] font-semibold text-[var(--brand)]',
              )}
            >
              <span className="w-4 text-center text-[var(--text-3)]">·</span>
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            </Button>
          ) : (
            <div className="flex h-7 items-center gap-2 px-2 text-[12px] text-[var(--text-2)]">
              <span className="w-4 text-center text-[var(--text-3)]">▸</span>
              <span className="min-w-0 flex-1 truncate font-semibold text-[var(--text-1)]">{node.name}</span>
            </div>
          )}
          {node.children && node.children.length > 0 && (
            <div className="ml-4 border-l border-[var(--border)] pl-2">
              <SkillFileTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function findDefaultSkillFilePath(nodes: SkillFileTreeNode[]): string | null {
  const files = flattenFileNodes(nodes)
  return files.find((node) => node.path.toLowerCase() === 'skill.md')?.path ?? files[0]?.path ?? null
}

function findFileNode(nodes: SkillFileTreeNode[], path: string | null): SkillFileTreeNode | null {
  if (!path) return null
  for (const node of nodes) {
    if (node.type === 'file' && node.path === path) return node
    const child = node.children ? findFileNode(node.children, path) : null
    if (child) return child
  }
  return null
}

function flattenFileNodes(nodes: SkillFileTreeNode[]): SkillFileTreeNode[] {
  return nodes.flatMap((node) => {
    if (node.type === 'file') return [node]
    return flattenFileNodes(node.children ?? [])
  })
}

function inferFileLanguage(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase()
  if (!extension || extension === fileName.toLowerCase()) return 'text'
  const labels: Record<string, string> = {
    md: 'markdown',
    markdown: 'markdown',
    json: 'json',
    jsonc: 'jsonc',
    js: 'javascript',
    jsx: 'javascript',
    ts: 'typescript',
    tsx: 'typescript',
    py: 'python',
    sh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    txt: 'text',
  }
  return labels[extension] ?? extension
}

function formatFileSize(length: number): string {
  if (length < 1024) return `${length} B`
  return `${(length / 1024).toFixed(1)} KB`
}

function buildMarketSourceViews(skills: SkillCatalogItem[], plugins: PluginMarketItem[]): SkillSourceView[] {
  const pluginCount = plugins.length
  const builtInCount = skills.filter((item) => item.sourceType === 'built-in').length
  const localCount = skills.filter((item) => item.sourceType === 'local').length
  const githubCount = skills.filter((item) => item.sourceType === 'github' || item.sourceType === 'subscribed-market').length

  return [
    {
      id: 'plugins',
      name: '插件来源',
      detail: `已发现 ${pluginCount} 个插件`,
      enabled: pluginCount > 0,
      icon: Puzzle,
      tone: 'mint',
    },
    {
      id: 'built-in',
      name: '内置技能',
      detail: `已发现 ${builtInCount} 个技能`,
      enabled: builtInCount > 0,
      icon: Sparkles,
      tone: 'violet',
    },
    {
      id: 'local',
      name: '本地技能',
      detail: `已发现 ${localCount} 个技能`,
      enabled: localCount > 0,
      icon: FolderSync,
      tone: 'mint',
    },
    {
      id: 'github',
      name: 'GitHub 来源',
      detail: `已安装 ${githubCount} 个技能`,
      enabled: githubCount > 0,
      icon: Globe2,
      tone: 'mint',
    },
  ]
}

function buildMarketSourceRef(draft: {
  connectionMode: 'local' | 'remote'
  type: 'official' | 'team' | 'local'
  name: string
  url: string
  localPath: string
}): LumeConfigPluginMarketSourceRef {
  const location = draft.connectionMode === 'local' ? draft.localPath.trim() : draft.url.trim()
  const name = draft.name.trim() || inferMarketSourceName(location)
  const base = `${draft.connectionMode}-${name}-${location}`
  const id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || `market-${Date.now()}`

  if (draft.connectionMode === 'local') {
    return {
      id,
      name,
      kind: 'local-index',
      enabled: true,
      path: location,
    }
  }

  return {
    id,
    name,
    kind: 'remote-index',
    enabled: true,
    url: location,
  }
}

function buildDirectPluginSource(mode: 'local' | 'remote', localPath: string, url: string): PluginSourceRef {
  if (mode === 'local') {
    const path = localPath.trim()
    if (!path) throw new Error('请选择插件目录')
    return { type: 'local', path }
  }

  const parsed = parseGitHubPluginUrl(url.trim())
  return {
    type: 'github',
    owner: parsed.owner,
    repo: parsed.repo,
    ref: parsed.ref,
    url: parsed.url,
    ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
  }
}

function parseGitHubPluginUrl(input: string): { owner: string; repo: string; ref: string; subdir?: string; url: string } {
  if (!input) throw new Error('请输入 GitHub 插件地址')
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('GitHub URL 非法')
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error('仅支持 github.com 地址')
  }
  const segments = url.pathname.replace(/^\/|\/$/g, '').split('/').filter(Boolean)
  const owner = segments[0] ?? ''
  const repo = (segments[1] ?? '').replace(/\.git$/i, '')
  if (!owner || !repo) throw new Error('GitHub URL 缺少 owner/repo')
  if (segments[2] === 'tree') {
    const ref = segments[3] ?? ''
    if (!ref) throw new Error('GitHub tree URL 缺少 ref')
    return { owner, repo, ref, subdir: segments.slice(4).join('/') || undefined, url: input }
  }
  return { owner, repo, ref: 'main', url: input }
}

function inferMarketSourceName(location: string): string {
  const trimmed = location.replace(/\/$/, '')
  const lastSegment = trimmed.split('/').filter(Boolean).pop()
  return lastSegment || '自定义市场源'
}

function formatInstallState(state: SkillCatalogItem['installState'] | PluginMarketItem['installState']): string {
  switch (state) {
    case 'installed':
      return '已安装'
    case 'update-available':
      return '有更新'
    case 'not-installed':
      return '未安装'
  }
}

function formatSyncTime(timestamp: number | null): string {
  if (!timestamp) return '尚未同步'
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (elapsedSeconds < 60) return '刚刚'
  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`
  return `${Math.floor(elapsedMinutes / 60)} 小时前`
}

function toMarketDisplayCard(card: MarketCardView): MarketDisplayCard {
  if (card.kind === 'plugin') {
    return {
      ...card,
      icon: Puzzle,
      tone: inferPluginTone(card.item as PluginMarketItem),
    }
  }
  const skill = card.item as SkillCatalogItem
  const visual = SKILL_VISUALS[skill.slug] ?? inferSkillVisual(skill)
  return {
    ...card,
    ...visual,
    category: card.category,
    actionLabel: card.actionLabel,
  }
}

function inferSkillVisual(item: SkillCatalogItem): Pick<MarketDisplayCard, 'category' | 'actionLabel' | 'icon' | 'tone'> {
  const name = `${item.name} ${item.slug}`.toLowerCase()
  const category = SKILL_SOURCE_LABELS[item.sourceType]
  const actionLabel = ''

  if (name.includes('sql') || name.includes('database')) {
    return { category, actionLabel, icon: Database, tone: 'violet' }
  }
  if (name.includes('code') || name.includes('review')) {
    return { category, actionLabel, icon: Code2, tone: 'mint' }
  }
  if (name.includes('release') || name.includes('发布')) {
    return { category, actionLabel, icon: Megaphone, tone: 'green' }
  }
  if (name.includes('knowledge') || name.includes('qa') || name.includes('问答')) {
    return { category, actionLabel, icon: MessageCircle, tone: 'blue' }
  }
  return { category, actionLabel, icon: Sparkles, tone: 'violet' }
}

function inferPluginTone(item: PluginMarketItem): SkillVisualTone {
  if (item.permissions.riskLabels.includes('shell') || item.permissions.riskLabels.includes('high-risk-tool')) return 'orange'
  if (item.permissions.riskLabels.includes('network')) return 'blue'
  if (item.permissions.riskLabels.includes('write')) return 'green'
  return 'mint'
}

function iconToneClass(tone: SkillVisualTone): string {
  switch (tone) {
    case 'violet':
      return 'bg-[color:color-mix(in_oklab,var(--brand)_12%,var(--surface-1))] text-[var(--brand)]'
    case 'mint':
      return 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
    case 'figma':
      return 'bg-[var(--surface-2)] text-[var(--brand)]'
    case 'green':
      return 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
    case 'blue':
      return 'bg-[color:color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
    case 'orange':
      return 'bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))] text-[var(--lume-warning)]'
  }
}

function badgeToneClass(category: string): string {
  switch (category) {
    case '插件':
      return 'bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--surface-1))] text-[var(--brand)]'
    case '内置':
      return 'bg-[color:color-mix(in_oklab,var(--brand)_8%,var(--surface-1))] text-[var(--brand)]'
    case '本地发现':
      return 'bg-[var(--surface-2)] text-[var(--text-2)]'
    default:
      return 'bg-[var(--surface-2)] text-[var(--text-2)]'
  }
}
