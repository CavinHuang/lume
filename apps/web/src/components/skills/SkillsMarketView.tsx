import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import {
  Check,
  ChevronDown,
  Code2,
  Copy,
  Database,
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
  Trash2,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
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
  setPluginEnablement,
  uninstallPlugin,
  updatePluginsConfig,
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
  MARKET_CATEGORY_OPTIONS,
  MARKET_SOURCE_OPTIONS,
  PLUGIN_SOURCE_LABELS,
  SKILL_SOURCE_LABELS,
  type MarketCardKind,
  type MarketCardView,
} from './plugin-market-ui-state'

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

export function SkillsMarketView() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspace = workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null
  const workspaceSlug = workspace?.slug ?? null
  const [activeKind, setActiveKind] = useState<MarketCardKind>('plugin')
  const [skills, setSkills] = useState<SkillCatalogItem[]>([])
  const [plugins, setPlugins] = useState<PluginMarketItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部分类')
  const [source, setSource] = useState('全部来源')
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const [busyItemId, setBusyItemId] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [skillDetail, setSkillDetail] = useState<SkillMarketDetailResult | null>(null)
  const [pluginDetailOpen, setPluginDetailOpen] = useState(false)
  const [pluginDetailLoading, setPluginDetailLoading] = useState(false)
  const [pluginDetailError, setPluginDetailError] = useState<string | null>(null)
  const [pluginDetail, setPluginDetail] = useState<GetMarketDetailResult | null>(null)

  const loadCatalog = useCallback(async () => {
    if (!workspaceSlug) {
      setSkills([])
      setPlugins([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await getMarketCatalog({ workspaceSlug })
      setSkills(result.skills)
      setPlugins(result.plugins)
      setLastSyncedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSkills([])
      setPlugins([])
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  const cards = useMemo(() => {
    const marketCards = buildMarketCards({ plugins, skills }).map(toMarketDisplayCard)
    return filterMarketCards(marketCards, { query, category, source, kind: activeKind })
  }, [activeKind, category, plugins, query, skills, source])
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

  const handlePluginAction = async (item: PluginMarketItem) => {
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
      await installMarketItem({
        workspaceSlug,
        kind: 'plugin',
        itemId: marketItem.id,
        acceptedPermissionsHash: pluginDetail.inspect.permissionsHash,
        enableScope: 'workspace',
        overwrite: marketItem.installState === 'update-available',
      })
      setPluginDetailOpen(false)
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
      await uninstallPlugin({ pluginId: marketItem.pluginId, version: marketItem.version, force: true })
      setPluginDetailOpen(false)
      await loadCatalog()
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyItemId(null)
    }
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
    setPluginDetailOpen(true)
    setPluginDetailLoading(true)
    setPluginDetailError(null)
    setPluginDetail(null)
    setError(null)
    try {
      setPluginDetail(await getMarketDetail({ workspaceSlug, kind: 'plugin', itemId: item.id }))
    } catch (err) {
      setPluginDetailError(err instanceof Error ? err.message : String(err))
      setPluginDetail({ item: { kind: 'plugin', plugin: item }, diagnostics: item.diagnostics ?? [] })
    } finally {
      setPluginDetailLoading(false)
    }
  }

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

  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-white px-7 pb-8 pt-8 text-[#121832]">
      <div className="mx-auto flex h-full max-w-[1230px] flex-col">
        <header className="mb-6 flex items-start justify-between gap-5">
          <div className="min-w-0">
            <h1 className="text-[25px] font-semibold leading-tight text-[#121832]">插件市场</h1>
            <p className="mt-2 text-[14px] leading-6 text-[#60698d]">
              市场用于发现、审核和安装插件与技能，可在插件和技能视图之间快速切换。
            </p>
          </div>
          <div className="inline-flex shrink-0 rounded-[8px] border border-[#e4e7f1] bg-[#f7f8fb] p-1">
            {([
              { id: 'plugin', label: `插件 ${summary.totalPlugins}` },
              { id: 'skill', label: `技能 ${summary.totalSkills}` },
            ] as const).map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveKind(section.id)}
                className={cn(
                  'h-9 rounded-[6px] px-4 text-[13px] font-semibold transition-colors',
                  activeKind === section.id
                    ? 'bg-white text-[#121832] shadow-[0_8px_18px_-16px_rgba(43,52,103,0.54)]'
                    : 'text-[#687196] hover:text-[#121832]',
                )}
              >
                {section.label}
              </button>
            ))}
          </div>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_338px] gap-5">
          <main className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
            <SkillFilterBar
              query={query}
              category={category}
              source={source}
              onQueryChange={setQuery}
              onCategoryChange={setCategory}
              onSourceChange={setSource}
            />

            {loading ? (
              <div className="mt-6 flex h-[180px] items-center justify-center gap-2 rounded-[8px] border border-[#e4e7f1] text-[13px] text-[#626b8f]">
                <Loader2 size={16} className="animate-spin" />
                正在同步市场...
              </div>
            ) : error ? (
              <div className="mt-6 rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-4 text-[13px] text-[#ba3636]">
                {error}
              </div>
            ) : (
              <MarketCardGrid
                cards={cards}
                activeKind={activeKind}
                busyItemId={busyItemId}
                onAction={(card) => {
                  if (card.kind === 'skill') void handleSkillAction(card.item as SkillCatalogItem)
                  else void handlePluginAction(card.item as PluginMarketItem)
                }}
                onOpenDetail={(card) => {
                  if (card.kind === 'skill') void handleOpenSkillDetail(card.item as SkillCatalogItem)
                  else void handleOpenPluginDetail(card.item as PluginMarketItem)
                }}
              />
            )}
          </main>

          <SkillSourcePanel
            loading={loading}
            sources={sourceViews}
            summary={summary}
            lastSyncedAt={lastSyncedAt}
            onAddSource={() => setSourceDialogOpen(true)}
            onSync={() => void loadCatalog()}
          />
        </div>
      </div>

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
      <PluginDetailDialog
        open={pluginDetailOpen}
        loading={pluginDetailLoading}
        error={pluginDetailError}
        detail={pluginDetail}
        busy={busyItemId !== null}
        onInstall={() => void handleInstallPluginFromDetail()}
        onUninstall={() => void handleUninstallPluginFromDetail()}
        onOpenChange={setPluginDetailOpen}
      />
    </div>
  )
}

function SkillFilterBar({
  query,
  category,
  source,
  onQueryChange,
  onCategoryChange,
  onSourceChange,
}: {
  query: string
  category: string
  source: string
  onQueryChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onSourceChange: (value: string) => void
}) {
  return (
    <section className="rounded-[8px] border border-[#e4e7f1] bg-white px-4 py-3">
      <div className="grid grid-cols-[minmax(210px,1fr)_minmax(190px,255px)_minmax(190px,255px)] gap-5">
        <label className="flex h-10 items-center gap-3 rounded-[8px] border border-[#e4e7f1] bg-white px-4 text-[#687196] shadow-[0_8px_20px_-18px_rgba(48,58,110,0.32)]">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索插件或技能"
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[#1d2440] outline-none placeholder:text-[#6c7699]"
          />
        </label>
        <MarketSelect value={category} options={[...MARKET_CATEGORY_OPTIONS]} onChange={onCategoryChange} />
        <MarketSelect value={source} options={[...MARKET_SOURCE_OPTIONS]} onChange={onSourceChange} />
      </div>
    </section>
  )
}

function MarketSelect({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (value: string) => void
}) {
  return (
    <label className="relative flex h-10 items-center rounded-[8px] border border-[#e4e7f1] bg-white text-[13px] font-medium text-[#60698d] shadow-[0_8px_20px_-18px_rgba(48,58,110,0.32)]">
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-full w-full appearance-none bg-transparent px-4 pr-10 outline-none"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown size={16} className="pointer-events-none absolute right-4 text-[#46527a]" />
    </label>
  )
}

function MarketCardGrid({
  cards,
  activeKind,
  busyItemId,
  onAction,
  onOpenDetail,
}: {
  cards: MarketDisplayCard[]
  activeKind: MarketCardKind
  busyItemId: string | null
  onAction: (card: MarketDisplayCard) => void
  onOpenDetail: (card: MarketDisplayCard) => void
}) {
  return (
    <section className="mt-6 grid min-h-0 content-start grid-cols-3 gap-5 overflow-y-auto pr-2 pb-2">
      {cards.map((card) => (
        <MarketCard
          key={`${card.kind}:${card.id}`}
          card={card}
          busy={busyItemId === `${card.kind}:${card.id}`}
          onAction={() => onAction(card)}
          onOpenDetail={() => onOpenDetail(card)}
        />
      ))}
      {cards.length === 0 && (
        <div className="col-span-3 rounded-[8px] border border-dashed border-[#d8ddec] p-10 text-center text-[13px] text-[#687196]">
          {activeKind === 'plugin'
            ? '当前工作区还没有可展示的插件。可添加本地或 GitHub marketplace root 进行同步。'
            : '当前工作区还没有可展示的 Agent 技能。可添加市场源或同步已有来源。'}
        </div>
      )}
    </section>
  )
}

function MarketCard({
  card,
  busy,
  onAction,
  onOpenDetail,
}: {
  card: MarketDisplayCard
  busy: boolean
  onAction: () => void
  onOpenDetail: () => void
}) {
  const Icon = card.icon
  const installed = card.installState === 'installed'
  const skillActionable = card.kind === 'skill' && (installed || isInstallableSkillMarketItem(card.item as SkillCatalogItem))
  const pluginActionable = card.kind === 'plugin'
  const actionable = skillActionable || pluginActionable

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenDetail()
        }
      }}
      className="flex h-[216px] min-w-0 cursor-pointer flex-col overflow-hidden rounded-[8px] border border-[#e4e7f1] bg-white p-4 [overflow-wrap:anywhere] shadow-[0_16px_36px_-32px_rgba(43,52,103,0.48)] transition-colors hover:border-[#cfd5e8] hover:bg-[#fbfcff]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-[8px]', iconToneClass(card.tone))}>
          <Icon size={21} strokeWidth={2.2} />
        </div>
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-6 text-[#121832]" title={card.name}>
          {card.name}
        </h2>
        {card.enabled && (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#35c977] text-white">
            <Check size={16} strokeWidth={2.5} />
          </span>
        )}
      </div>
      <div className="mt-4 min-w-0 flex-1 overflow-hidden">
        <p className="line-clamp-4 break-all text-[13px] leading-[20px] text-[#687196]">
          {card.description ?? '暂无描述。'}
        </p>
      </div>
      <div className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-3 pt-3">
        <span className={cn('min-w-0 break-all rounded-[5px] px-2 py-1 text-[12px] font-medium', badgeToneClass(card.category))}>
          {card.category}
        </span>
        <button
          type="button"
          disabled={!actionable || busy}
          onClick={(event) => {
            event.stopPropagation()
            onAction()
          }}
          className="min-h-8 max-w-full shrink-0 whitespace-nowrap rounded-[6px] border border-[#bdb6ff] px-4 py-1 text-[13px] font-semibold text-[#635bff] transition-colors hover:bg-[#f5f3ff]"
        >
          {busy ? '处理中' : card.actionLabel}
        </button>
      </div>
    </article>
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
    <aside className="h-fit rounded-[8px] border border-[#e4e7f1] bg-white p-5 shadow-[0_18px_40px_-36px_rgba(43,52,103,0.52)]">
      <h2 className="text-[17px] font-semibold text-[#121832]">市场源</h2>
      <p className="mt-3 text-[13px] leading-6 text-[#60698d]">管理插件与技能来源，并同步获取最新市场内容。</p>

      <div className="mt-5 space-y-4">
        {sources.map((source) => (
          <SkillSourceRow key={source.id} source={source} />
        ))}
      </div>

      <button
        type="button"
        onClick={onAddSource}
        className="mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-[8px] border border-dashed border-[#bfc5ff] bg-white text-[14px] font-semibold text-[#635bff] transition-colors hover:bg-[#f7f7ff]"
      >
        <Plus size={18} />
        添加市场源
      </button>

      <button
        type="button"
        onClick={onSync}
        disabled={loading}
        className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-[8px] bg-[#635bff] text-[14px] font-semibold text-white shadow-[0_16px_30px_-22px_rgba(99,91,255,0.82)] transition-colors hover:bg-[#564dff] disabled:cursor-wait disabled:opacity-70"
      >
        <RefreshCw size={18} className={cn(loading && 'animate-spin')} />
        同步市场
      </button>

      <div className="my-6 h-px bg-[#edf0f6]" />

      <div className="rounded-[8px] border border-[#edf0f6] bg-white p-4">
        <div className="flex items-center gap-3 text-[#687196]">
          <ShieldCheck size={19} className="text-[#20c579]" />
          <span className="text-[13px]">上次同步：{formatSyncTime(lastSyncedAt)}</span>
        </div>
        <div className="mt-3 pl-8 text-[13px] text-[#687196]">
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
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#111735]/32 p-6 backdrop-blur-[2px]">
      <section className="grid max-h-[88vh] w-full max-w-[720px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-[8px] border border-[#e4e7f1] bg-white shadow-[0_28px_80px_-42px_rgba(18,24,50,0.62)]">
        <header className="flex items-start justify-between border-b border-[#edf0f6] px-6 py-5">
          <div>
            <h2 className="text-[19px] font-semibold leading-7 text-[#121832]">添加技能 / 插件</h2>
            <p className="mt-1 text-[13px] leading-5 text-[#687196]">
              添加 marketplace root，或单独安装插件目录、技能目录、GitHub 地址。
            </p>
          </div>
          <button
            type="button"
            title="关闭"
            onClick={() => onOpenChange(false)}
            className="flex size-8 items-center justify-center rounded-[6px] text-[#687196] hover:bg-[#f4f6fb] hover:text-[#121832]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          <div className="mb-5 grid grid-cols-4 gap-2 rounded-[8px] border border-[#e4e7f1] bg-[#f7f8fb] p-1">
            {([
              { id: 'source', label: '市场源' },
              { id: 'plugin', label: '单独安装插件' },
              { id: 'skill', label: '单独安装技能' },
              { id: 'format', label: '格式说明' },
            ] as const).map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => {
                  setPanel(option.id)
                  setError(null)
                }}
                className={cn(
                  'h-9 rounded-[6px] px-3 text-[12px] font-semibold transition-colors',
                  panel === option.id ? 'bg-white text-[#121832] shadow-[0_8px_18px_-16px_rgba(43,52,103,0.54)]' : 'text-[#687196] hover:text-[#121832]',
                )}
              >
                {option.label}
              </button>
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
              <button
                type="button"
                disabled={busy !== null || (pluginMode === 'local' ? !pluginLocalPath.trim() : !pluginUrl.trim())}
                onClick={() => void handleInspectPlugin()}
                className="flex h-10 items-center gap-2 rounded-[6px] border border-[#bdb6ff] px-4 text-[13px] font-semibold text-[#635bff] hover:bg-[#f5f3ff] disabled:cursor-not-allowed disabled:opacity-55"
              >
                {busy === 'plugin-review' ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                检查权限
              </button>
              {pluginReview && (
                <div className="rounded-[8px] border border-[#e4e7f1] bg-[#fbfcff] p-4">
                  <div className="text-[13px] font-semibold text-[#121832]">{pluginReview.name} v{pluginReview.version}</div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {pluginReview.risks.length > 0 ? pluginReview.risks.map((risk) => (
                      <span key={risk} className="rounded-[5px] bg-[#fff4e5] px-2 py-1 text-[12px] font-semibold text-[#a45f00]">{risk}</span>
                    )) : (
                      <span className="rounded-[5px] bg-[#eaf8f0] px-2 py-1 text-[12px] font-semibold text-[#168653]">低风险</span>
                    )}
                  </div>
                  <div className="mt-3 break-all font-mono text-[12px] leading-5 text-[#687196]">{pluginReview.permissionsHash}</div>
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
              <div className="rounded-[8px] border border-[#e1e9ff] bg-[#f7f9ff] p-4 text-[12px] leading-5 text-[#687196]">
                本地可以选择一个包含 SKILL.md 的技能目录，也可以选择包含多个技能子目录的父目录。远程地址会先走 GitHub skill review，再安装到当前工作区。
              </div>
            </div>
          )}

          {panel === 'format' && <MarketplaceFormatGuide />}

          {error && (
            <div className="mt-5 rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-3 text-[12px] leading-5 text-[#ba3636]">{error}</div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[#edf0f6] px-6 py-4">
          <button
            type="button"
            onClick={() => setPanel('format')}
            className="flex h-9 items-center gap-2 rounded-[6px] px-3 text-[13px] font-semibold text-[#60698d] hover:bg-[#f8f9fc]"
          >
            <Info size={16} />
            支持格式
          </button>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => onOpenChange(false)} className="h-9 rounded-[6px] border border-[#dfe3ee] px-4 text-[13px] font-semibold text-[#60698d] hover:bg-[#f8f9fc]">取消</button>
            {panel === 'source' && (
              <button type="button" disabled={busy !== null || (connectionMode === 'remote' ? !url.trim() : !localPath.trim())} onClick={() => void handleSubmitSource()} className="h-9 rounded-[6px] bg-[#635bff] px-4 text-[13px] font-semibold text-white shadow-[0_14px_28px_-22px_rgba(99,91,255,0.82)] hover:bg-[#564dff] disabled:cursor-not-allowed disabled:opacity-55">
                {busy === 'source' ? '同步中...' : '添加并同步'}
              </button>
            )}
            {panel === 'plugin' && (
              <button type="button" disabled={busy !== null || !pluginReview} onClick={() => void handleInstallReviewedPlugin()} className="h-9 rounded-[6px] bg-[#635bff] px-4 text-[13px] font-semibold text-white shadow-[0_14px_28px_-22px_rgba(99,91,255,0.82)] hover:bg-[#564dff] disabled:cursor-not-allowed disabled:opacity-55">
                {busy === 'plugin-install' ? '安装中...' : '确认安装插件'}
              </button>
            )}
            {panel === 'skill' && (
              <button type="button" disabled={busy !== null || (skillMode === 'local' ? !skillLocalPath.trim() : !skillUrl.trim())} onClick={() => void handleInstallSkill()} className="h-9 rounded-[6px] bg-[#635bff] px-4 text-[13px] font-semibold text-white shadow-[0_14px_28px_-22px_rgba(99,91,255,0.82)] hover:bg-[#564dff] disabled:cursor-not-allowed disabled:opacity-55">
                {busy === 'skill-install' ? '安装中...' : '审查并安装技能'}
              </button>
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
      <span className="text-[13px] font-semibold text-[#121832]">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 h-10 w-full rounded-[8px] border border-[#e4e7f1] bg-white px-3 text-[13px] text-[#121832] outline-none placeholder:text-[#9aa2bd] focus:border-[#bdb6ff]"
      />
    </label>
  )
}

function ChooseFolderButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-10 rounded-[6px] border border-[#dfe3ee] px-4 text-[13px] font-semibold text-[#46527a] hover:bg-[#f8f9fc]"
    >
      选择目录
    </button>
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
        <button
          key={option.id}
          type="button"
          onClick={() => onChange(option.id)}
          className={cn(
            'rounded-[8px] border p-3 text-left text-[13px] font-semibold transition-colors',
            value === option.id
              ? 'border-[#635bff] bg-[#f4f2ff] text-[#121832]'
              : 'border-[#e4e7f1] bg-white text-[#60698d] hover:bg-[#f8f9fc]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function FormatHint({ compact = false }: { compact?: boolean }) {
  return (
    <div className="rounded-[8px] border border-[#e1e9ff] bg-[#f7f9ff] p-4 text-[12px] leading-5 text-[#687196]">
      市场源必须是 marketplace root，根目录下存在 <span className="font-mono text-[#46527a]">.lume-plugin/marketplace.json</span>
      {compact ? '。' : '，其中 plugins[] 和 skills[] 的 source 都是相对 root 的目录路径。'}
    </div>
  )
}

function MarketplaceFormatGuide() {
  return (
    <div className="space-y-4 text-[13px] leading-6 text-[#60698d]">
      <FormatHint />
      <div className="rounded-[8px] border border-[#e4e7f1] bg-white p-4">
        <div className="font-semibold text-[#121832]">marketplace.json</div>
        <pre className="mt-3 overflow-auto rounded-[8px] bg-[#fbfcff] p-3 font-mono text-[12px] leading-5 text-[#26304f]">
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
      <div className="rounded-[8px] border border-[#e4e7f1] bg-white p-4">
        插件目录需要包含 <span className="font-mono">.lume-plugin/plugin.json</span> 或 <span className="font-mono">.codex-plugin/plugin.json</span>。
        技能目录需要包含 <span className="font-mono">SKILL.md</span>。<span className="font-mono">plugins[]</span> 和 <span className="font-mono">skills[]</span> 至少有一个非空数组。
      </div>
    </div>
  )
}

function SkillSourceRow({ source }: { source: SkillSourceView }) {
  const Icon = source.icon

  return (
    <div className="flex h-[82px] items-center gap-4 rounded-[8px] border border-[#e9ecf4] bg-white px-4">
      <div className={cn('flex size-12 items-center justify-center rounded-[8px]', iconToneClass(source.tone))}>
        <Icon size={25} strokeWidth={2.2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[15px] font-semibold text-[#121832]">{source.name}</span>
          {source.enabled && (
            <>
              <span className="size-2 rounded-full bg-[#23c66d]" />
              <span className="text-[12px] font-semibold text-[#11aa5a]">已启用</span>
            </>
          )}
        </div>
        <div className="mt-2 text-[13px] text-[#687196]">{source.detail}</div>
      </div>
      <button type="button" className="flex size-8 items-center justify-center rounded-[6px] text-[#46527a] hover:bg-[#f4f6fb]">
        <MoreVertical size={18} />
      </button>
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
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#111735]/32 p-4 backdrop-blur-[2px]">
      <section className="grid max-h-[90vh] w-full max-w-[1180px] grid-rows-[auto_minmax(0,1fr)] rounded-[8px] border border-[#e4e7f1] bg-white shadow-[0_28px_80px_-42px_rgba(18,24,50,0.62)]">
        <header className="flex items-start justify-between border-b border-[#edf0f6] px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-semibold leading-7 text-[#121832]">
              {detail?.item.name ?? '技能详情'}
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-[#687196]">
              查看该 Agent 技能的来源、安装状态与包含文件树。
            </p>
          </div>
          <button
            type="button"
            title="关闭"
            onClick={() => onOpenChange(false)}
            className="flex size-8 items-center justify-center rounded-[6px] text-[#687196] hover:bg-[#f4f6fb] hover:text-[#121832]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex h-[220px] items-center justify-center gap-2 text-[13px] text-[#687196]">
              <Loader2 size={16} className="animate-spin" />
              正在读取技能文件...
            </div>
          ) : error ? (
            <div className="rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-5 text-[13px] leading-6 text-[#ba3636]">
              {error}
            </div>
          ) : detail ? (
            <div className="space-y-5">
              <section className="rounded-[8px] border border-[#e4e7f1] bg-[#fbfcff] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded-[5px] px-2 py-1 text-[12px] font-medium', badgeToneClass(SKILL_SOURCE_LABELS[detail.item.sourceType]))}>
                    {SKILL_SOURCE_LABELS[detail.item.sourceType]}
                  </span>
                  <span className="rounded-[5px] bg-white px-2 py-1 text-[12px] font-medium text-[#687196]">
                    {formatInstallState(detail.item.installState)}
                  </span>
                  {detail.item.version && (
                    <span className="rounded-[5px] bg-white px-2 py-1 text-[12px] font-medium text-[#687196]">
                      v{detail.item.version}
                    </span>
                  )}
                </div>
                <p className="mt-3 text-[13px] leading-6 text-[#60698d]">
                  {detail.item.description ?? '暂无描述。'}
                </p>
                <div className="mt-4 border-t border-[#e4e7f1] pt-3">
                  <div className="text-[12px] font-semibold text-[#121832]">技能目录</div>
                  <div className="mt-2 break-all text-[12px] leading-5 text-[#687196]">{detail.rootPath}</div>
                </div>
              </section>

              <div className="grid h-[min(620px,calc(90vh-250px))] min-h-[420px] gap-4 md:grid-cols-[300px_minmax(0,1fr)]">
                <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] rounded-[8px] border border-[#e4e7f1] bg-white p-4">
                  <h3 className="text-[14px] font-semibold text-[#121832]">文件树</h3>
                  <div className="mt-3 min-h-0 overflow-y-auto rounded-[6px] bg-[#fbfcff] p-2">
                    <SkillFileTree nodes={detail.files} selectedPath={selectedPath} onSelect={setSelectedPath} />
                  </div>
                </section>

                <SkillFileContentPreview file={selectedFile} />
              </div>
            </div>
          ) : (
            <div className="rounded-[8px] border border-dashed border-[#d8ddec] p-8 text-center text-[13px] text-[#687196]">
              暂无技能详情。
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function PluginDetailDialog({
  open,
  loading,
  error,
  detail,
  busy,
  onInstall,
  onUninstall,
  onOpenChange,
}: {
  open: boolean
  loading: boolean
  error: string | null
  detail: GetMarketDetailResult | null
  busy: boolean
  onInstall: () => void
  onUninstall: () => void
  onOpenChange: (open: boolean) => void
}) {
  const item = detail?.item.kind === 'plugin' ? detail.item.plugin : null
  const inspected = detail?.inspect?.kind === 'plugin' ? detail.inspect : null
  const permissionRows = item ? buildPermissionRows(item) : []
  const canInstall = Boolean(item && inspected && item.installState !== 'installed')

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#111735]/32 p-4 backdrop-blur-[2px]">
      <section className="grid max-h-[88vh] w-full max-w-[820px] grid-rows-[auto_minmax(0,1fr)_auto] rounded-[8px] border border-[#e4e7f1] bg-white shadow-[0_28px_80px_-42px_rgba(18,24,50,0.62)]">
        <header className="flex items-start justify-between border-b border-[#edf0f6] px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-[19px] font-semibold leading-7 text-[#121832]">
              {item?.displayName ?? item?.name ?? '插件详情'}
            </h2>
            <p className="mt-1 text-[13px] leading-5 text-[#687196]">
              安装前检查插件能力、权限摘要与来源状态。
            </p>
          </div>
          <button
            type="button"
            title="关闭"
            onClick={() => onOpenChange(false)}
            className="flex size-8 items-center justify-center rounded-[6px] text-[#687196] hover:bg-[#f4f6fb] hover:text-[#121832]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex h-[220px] items-center justify-center gap-2 text-[13px] text-[#687196]">
              <Loader2 size={16} className="animate-spin" />
              正在检查插件...
            </div>
          ) : error && !item ? (
            <div className="rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-5 text-[13px] leading-6 text-[#ba3636]">
              {error}
            </div>
          ) : item ? (
            <div className="space-y-5">
              {error && (
                <div className="rounded-[8px] border border-[#ffe5b8] bg-[#fffaf0] p-4 text-[13px] leading-6 text-[#9a6418]">
                  {error}
                </div>
              )}

              <section className="rounded-[8px] border border-[#e4e7f1] bg-[#fbfcff] p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn('rounded-[5px] px-2 py-1 text-[12px] font-medium', badgeToneClass('插件'))}>插件</span>
                  <span className={cn('rounded-[5px] px-2 py-1 text-[12px] font-medium', badgeToneClass(PLUGIN_SOURCE_LABELS[item.sourceType]))}>
                    {PLUGIN_SOURCE_LABELS[item.sourceType]}
                  </span>
                  <span className="rounded-[5px] bg-white px-2 py-1 text-[12px] font-medium text-[#687196]">
                    {formatInstallState(item.installState)}
                  </span>
                  <span className="rounded-[5px] bg-white px-2 py-1 text-[12px] font-medium text-[#687196]">
                    {formatPluginEnableState(item.enableState)}
                  </span>
                  <span className="rounded-[5px] bg-white px-2 py-1 text-[12px] font-medium text-[#687196]">v{item.version}</span>
                </div>
                <p className="mt-3 text-[13px] leading-6 text-[#60698d]">
                  {item.description ?? '暂无描述。'}
                </p>
              </section>

              <section className="grid gap-3 md:grid-cols-4">
                <PluginMetric label="技能" value={item.capabilities.skillCount} />
                <PluginMetric label="命令工具" value={item.capabilities.commandToolNames.length} />
                <PluginMetric label="MCP 服务" value={item.capabilities.mcpServerNames.length} />
                <PluginMetric label="Hook 事件" value={item.capabilities.hookEvents.length} />
              </section>

              <section className="rounded-[8px] border border-[#e4e7f1] bg-white p-4">
                <div className="flex items-center gap-2 text-[14px] font-semibold text-[#121832]">
                  <ShieldCheck size={18} className="text-[#20c579]" />
                  权限审核
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.permissions.riskLabels.length > 0 ? item.permissions.riskLabels.map((risk) => (
                    <span key={risk} className="rounded-[5px] bg-[#fff4e5] px-2 py-1 text-[12px] font-semibold text-[#a45f00]">
                      {formatRiskLabel(risk)}
                    </span>
                  )) : (
                    <span className="rounded-[5px] bg-[#eaf8f0] px-2 py-1 text-[12px] font-semibold text-[#168653]">低风险</span>
                  )}
                </div>
                <div className="mt-4 space-y-3">
                  {permissionRows.map((row) => (
                    <div key={row.label} className="grid gap-2 rounded-[8px] bg-[#fbfcff] px-3 py-2 text-[12px] leading-5 md:grid-cols-[120px_minmax(0,1fr)]">
                      <span className="font-semibold text-[#121832]">{row.label}</span>
                      <span className="break-all text-[#687196]">{row.value}</span>
                    </div>
                  ))}
                </div>
                {inspected && (
                  <div className="mt-4 rounded-[8px] border border-[#edf0f6] bg-[#fbfcff] px-3 py-2 text-[12px] leading-5 text-[#687196]">
                    权限 hash：<span className="font-mono">{inspected.permissionsHash}</span>
                  </div>
                )}
              </section>

              {item.diagnostics && item.diagnostics.length > 0 && (
                <section className="rounded-[8px] border border-[#ffe5b8] bg-[#fffaf0] p-4">
                  <div className="text-[13px] font-semibold text-[#9a6418]">诊断信息</div>
                  <ul className="mt-2 space-y-1 text-[12px] leading-5 text-[#9a6418]">
                    {item.diagnostics.map((diagnostic, index) => (
                      <li key={`${diagnostic.code}-${index}`}>{diagnostic.message}</li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          ) : (
            <div className="rounded-[8px] border border-dashed border-[#d8ddec] p-8 text-center text-[13px] text-[#687196]">
              暂无插件详情。
            </div>
          )}
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-[#edf0f6] px-6 py-4">
          {item?.installState === 'installed' && (
            <button
              type="button"
              disabled={busy}
              onClick={onUninstall}
              className="flex h-9 items-center gap-2 rounded-[6px] border border-[#ffd2d2] px-4 text-[13px] font-semibold text-[#ba3636] hover:bg-[#fff8f8] disabled:cursor-wait disabled:opacity-60"
            >
              <Trash2 size={16} />
              卸载
            </button>
          )}
          {item?.installState !== 'installed' && (
            <button
              type="button"
              disabled={!canInstall || busy}
              onClick={onInstall}
              className="flex h-9 items-center gap-2 rounded-[6px] bg-[#635bff] px-4 text-[13px] font-semibold text-white shadow-[0_14px_28px_-22px_rgba(99,91,255,0.82)] hover:bg-[#564dff] disabled:cursor-not-allowed disabled:opacity-55"
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <Power size={16} />}
              {item?.installState === 'update-available' ? '确认权限并更新' : '确认权限并安装'}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

function PluginMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[8px] border border-[#e4e7f1] bg-white p-3">
      <div className="text-[12px] font-semibold text-[#687196]">{label}</div>
      <div className="mt-1 text-[20px] font-semibold leading-7 text-[#121832]">{value}</div>
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
    await navigator.clipboard.writeText(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }, [content])

  return (
    <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[8px] border border-[#e4e7f1] bg-white">
      <div className="flex min-h-16 items-center justify-between gap-3 border-b border-[#edf0f6] bg-white px-4">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-[#121832]">当前文件内容</h3>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-[12px] text-[#687196]">
            <span className="max-w-[520px] truncate">{file?.path ?? '未选择文件'}</span>
            {language && <span className="rounded-[5px] bg-[#f4f6fb] px-2 py-0.5 font-medium text-[#687196]">{language}</span>}
            {file && <span>{formatFileSize(content.length)}</span>}
            {file && <span>{lines.length || 1} 行</span>}
          </div>
        </div>
        <button
          type="button"
          title="复制文件内容"
          disabled={!content}
          onClick={handleCopy}
          className="flex h-9 shrink-0 items-center gap-2 rounded-[7px] border border-[#dfe3f0] bg-white px-3 text-[12px] font-semibold text-[#46527a] shadow-[0_1px_4px_rgba(18,24,50,0.04)] hover:border-[#c8cfff] hover:text-[#4f46e5] disabled:cursor-not-allowed disabled:opacity-45"
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>

      {file && content ? (
        <div className="min-h-0 overflow-auto bg-[#fbfcff]">
          <div className="grid min-w-full grid-cols-[auto_minmax(0,1fr)] font-mono text-[12px] leading-6">
            <div className="select-none border-r border-[#edf0f6] bg-[#f5f7fc] px-3 py-4 text-right text-[#9aa2bd]">
              {lines.map((_, index) => (
                <div key={index} className="h-6 tabular-nums">
                  {index + 1}
                </div>
              ))}
            </div>
            <pre className="min-w-0 whitespace-pre-wrap break-words px-4 py-4 text-[#26304f]">
              {lines.map((line, index) => (
                <span key={index} className="block min-h-6">
                  {line || ' '}
                </span>
              ))}
            </pre>
          </div>
        </div>
      ) : (
        <div className="flex min-h-[320px] items-center justify-center bg-[#fbfcff] px-6 text-center text-[13px] leading-6 text-[#687196]">
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
            <button
              type="button"
              onClick={() => onSelect(node.path)}
              className={cn(
                'flex h-7 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[12px] text-[#46527a] hover:bg-white',
                selectedPath === node.path && 'bg-white font-semibold text-[#4f46e5] shadow-[0_1px_6px_rgba(18,24,50,0.08)]',
              )}
            >
              <span className="w-4 text-center text-[#8a93ad]">·</span>
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            </button>
          ) : (
            <div className="flex h-7 items-center gap-2 px-2 text-[12px] text-[#46527a]">
              <span className="w-4 text-center text-[#8a93ad]">▸</span>
              <span className="min-w-0 flex-1 truncate font-semibold text-[#121832]">{node.name}</span>
            </div>
          )}
          {node.children && node.children.length > 0 && (
            <div className="ml-4 border-l border-[#e4e7f1] pl-2">
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
      tone: 'orange',
    },
    {
      id: 'github',
      name: 'GitHub 来源',
      detail: `已安装 ${githubCount} 个技能`,
      enabled: githubCount > 0,
      icon: Globe2,
      tone: 'blue',
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

function formatPluginEnableState(state: PluginMarketItem['enableState']): string {
  switch (state) {
    case 'global-enabled':
      return '全局启用'
    case 'workspace-enabled':
      return '工作区启用'
    case 'disabled':
      return '已禁用'
    case 'needs-review':
      return '需要审核'
    case 'not-installed':
      return '未安装'
  }
}

function formatRiskLabel(risk: PluginMarketItem['permissions']['riskLabels'][number]): string {
  switch (risk) {
    case 'shell':
      return 'Shell'
    case 'network':
      return '网络'
    case 'write':
      return '写文件'
    case 'mcp':
      return '注册 MCP'
    case 'high-risk-tool':
      return '高风险工具'
  }
}

function buildPermissionRows(item: PluginMarketItem): Array<{ label: string; value: string }> {
  const permissions = item.permissions
  return [
    { label: '读取文件', value: formatPermissionList(permissions.filesystemRead) },
    { label: '写入文件', value: formatPermissionList(permissions.filesystemWrite) },
    { label: '网络访问', value: formatPermissionList(permissions.networkOutbound) },
    { label: '工具允许', value: formatPermissionList(permissions.toolAllow) },
    { label: '工具询问', value: formatPermissionList(permissions.toolAsk) },
    { label: '工具拒绝', value: formatPermissionList(permissions.toolDeny) },
    { label: 'Hook 事件', value: formatPermissionList(permissions.hookEvents) },
    { label: 'Shell', value: permissions.shellAllow ? '允许' : '未声明' },
    { label: 'MCP 注册', value: permissions.mcpRegister ? '允许' : '未声明' },
  ]
}

function formatPermissionList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '未声明'
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
      return 'bg-gradient-to-br from-[#a787ff] to-[#6755f6] text-white'
    case 'mint':
      return 'bg-gradient-to-br from-[#c9f6df] to-[#55d08f] text-[#06724b]'
    case 'figma':
      return 'bg-white text-[#5f54ff]'
    case 'green':
      return 'bg-gradient-to-br from-[#38d894] to-[#16b968] text-white'
    case 'blue':
      return 'bg-gradient-to-br from-[#639cff] to-[#3c76e8] text-white'
    case 'orange':
      return 'bg-gradient-to-br from-[#ffb04d] to-[#ff8a1f] text-white'
  }
}

function badgeToneClass(category: string): string {
  switch (category) {
    case '插件':
      return 'bg-[#eaf8f0] text-[#168653]'
    case '内置':
      return 'bg-[#f0edff] text-[#635bff]'
    case '本地发现':
      return 'bg-[#ddf7e8] text-[#168653]'
    default:
      return 'bg-[#eaf2ff] text-[#3375d6]'
  }
}
