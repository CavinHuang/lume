import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  Check,
  ChevronDown,
  Code2,
  Copy,
  Database,
  FileText,
  FolderSync,
  Globe2,
  Loader2,
  Megaphone,
  MessageCircle,
  MoreVertical,
  PenTool,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  X,
  type LucideIcon,
} from 'lucide-react'
import { agentWorkspacesAtom, currentThreadIdAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  deleteWorkspaceSkill,
  getAgentThreadPath,
  getGitHubSkillReview,
  getSkillMarketDetail,
  getSkillMarketCatalog,
  importLocalSkillDirectoryToWorkspace,
  installSkillMarketItemToWorkspace,
  installGitHubSkillToWorkspace,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import type { SkillCatalogItem, SkillFileTreeNode, SkillMarketDetailResult, SkillSourceType } from '@lume/shared'
import { SkillSettingsView, type SkillSettingsViewHandle } from './SkillSettingsView'
import { SkillAddSourceDialog } from './SkillAddSourceDialog'
import {
  buildSkillActionLabel,
  buildSkillInstallRequest,
  isInstallableSkillMarketItem,
  resolveSkillSettingsCwd,
  type SkillMarketSection,
} from './skill-market-state'

type SkillVisualTone = 'violet' | 'mint' | 'figma' | 'green' | 'blue' | 'orange'

interface SkillMarketCard {
  item: SkillCatalogItem
  category: string
  actionLabel: string
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

const SKILL_VISUALS: Record<string, Pick<SkillMarketCard, 'category' | 'actionLabel' | 'icon' | 'tone'>> = {
  'prd-generator': { category: '内置', actionLabel: '启用', icon: FileText, tone: 'violet' },
  'code-review': { category: '内置', actionLabel: '启用', icon: Code2, tone: 'mint' },
  'figma-spec': { category: '本地发现', actionLabel: '安装', icon: PenTool, tone: 'figma' },
  'sql-query': { category: '本地发现', actionLabel: '安装', icon: Database, tone: 'violet' },
  'release-notes': { category: '外部市场源', actionLabel: '添加', icon: Megaphone, tone: 'green' },
  'knowledge-qa': { category: '外部市场源', actionLabel: '添加', icon: MessageCircle, tone: 'blue' },
}

const SOURCE_LABELS: Record<SkillSourceType, string> = {
  'built-in': '内置',
  local: '本地发现',
  github: '外部市场源',
  'subscribed-market': '外部市场源',
}

export function SkillsMarketView() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const currentThreadId = useAtomValue(currentThreadIdAtom)
  const workspace = workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null
  const workspaceSlug = workspace?.slug ?? null
  const setCurrentWorkspaceId = useSetAtom(currentWorkspaceIdAtom)
  const [activeSection, setActiveSection] = useState<SkillMarketSection>('market')
  const [settingsCwd, setSettingsCwd] = useState<string | null>(null)
  const [items, setItems] = useState<SkillCatalogItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部分类')
  const [source, setSource] = useState('全部来源')
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
  const [busySkillSlug, setBusySkillSlug] = useState<string | null>(null)
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [skillDetail, setSkillDetail] = useState<SkillMarketDetailResult | null>(null)
  const [addSourceDialogOpen, setAddSourceDialogOpen] = useState(false)
  const skillSettingsViewRef = useRef<SkillSettingsViewHandle>(null)

  const loadCatalog = useCallback(async () => {
    if (!workspaceSlug) {
      setItems([])
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      const result = await getSkillMarketCatalog(workspaceSlug)
      setItems(result.items)
      setLastSyncedAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  useEffect(() => {
    void loadCatalog()
  }, [loadCatalog])

  useEffect(() => {
    let cancelled = false
    setSettingsCwd(null)

    if (activeSection !== 'settings' || !currentThreadId) {
      return () => {
        cancelled = true
      }
    }

    void resolveSkillSettingsCwd({
      activeSection,
      currentThreadId,
      getThreadPath: (threadId) => getAgentThreadPath(threadId, workspaceSlug ?? undefined),
    })
      .then((cwd) => {
        if (!cancelled) setSettingsCwd(cwd)
      })
      .catch(() => {
        if (!cancelled) setSettingsCwd(null)
      })

    return () => {
      cancelled = true
    }
  }, [activeSection, currentThreadId, workspaceSlug])

  const cards = useMemo(() => {
    const queryText = query.trim().toLowerCase()

    return items
      .map(toSkillMarketCard)
      .filter((card) => {
        const matchesQuery =
          !queryText ||
          card.item.name.toLowerCase().includes(queryText) ||
          card.item.description?.toLowerCase().includes(queryText) === true
        const matchesCategory = category === '全部分类' || card.category === category
        const sourceLabel = SOURCE_LABELS[card.item.sourceType]
        const matchesSource = source === '全部来源' || sourceLabel === source
        return matchesQuery && matchesCategory && matchesSource
      })
  }, [category, items, query, source])

  const sourceViews = useMemo(() => buildSkillSourceViews(items), [items])

  const handleSkillAction = async (item: SkillCatalogItem) => {
    if (!workspaceSlug) return
    setBusySkillSlug(item.slug)
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
      setBusySkillSlug(null)
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

    if (draft.connectionMode === 'local') {
      await importLocalSkillDirectoryToWorkspace({
        workspaceSlug,
        localPath: draft.localPath,
        overwrite: false,
      })
      await loadCatalog()
      return
    }

    const review = await getGitHubSkillReview({ url: draft.url })
    await installGitHubSkillToWorkspace({
      url: review.url,
      workspaceSlug,
      reviewToken: review.reviewToken,
      overwrite: false,
    })
    await loadCatalog()
  }

  return (
    <div className="min-h-0 flex-1 overflow-hidden bg-white px-7 pb-8 pt-8 text-[#121832]">
      <div className="mx-auto flex h-full max-w-[1230px] flex-col">
        <header className="mb-6">
          <h1 className="text-[25px] font-semibold leading-tight text-[#121832]">技能</h1>
          <p className="mt-2 text-[14px] leading-6 text-[#60698d]">
            市场用于发现和安装技能，设置用于管理工作区内的自有技能。
          </p>
          <div className="mt-5 inline-flex rounded-[8px] border border-[#e4e7f1] bg-[#f7f8fb] p-1">
            {([
              { id: 'market', label: '技能市场' },
              { id: 'settings', label: '技能设置' },
            ] as const).map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={cn(
                  'h-9 rounded-[6px] px-4 text-[13px] font-semibold transition-colors',
                  activeSection === section.id
                    ? 'bg-white text-[#121832] shadow-[0_8px_18px_-16px_rgba(43,52,103,0.54)]'
                    : 'text-[#687196] hover:text-[#121832]',
                )}
              >
                {section.label}
              </button>
            ))}
          </div>
        </header>

        {activeSection === 'market' ? (
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
                  正在同步技能...
                </div>
              ) : error ? (
                <div className="mt-6 rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-4 text-[13px] text-[#ba3636]">
                  {error}
                </div>
              ) : (
                <SkillCardGrid
                  cards={cards}
                  busySkillSlug={busySkillSlug}
                  onSkillAction={(item) => void handleSkillAction(item)}
                  onOpenDetail={(item) => void handleOpenSkillDetail(item)}
                />
              )}
            </main>

            <SkillSourcePanel
              loading={loading}
              sources={sourceViews}
              totalSkills={items.length}
              installedCount={items.filter((item) => item.installState === 'installed').length}
              lastSyncedAt={lastSyncedAt}
              onAddSource={() => setSourceDialogOpen(true)}
              onSync={() => void loadCatalog()}
            />
          </div>
        ) : (
          <SkillSettingsView
            ref={skillSettingsViewRef}
            workspaceSlug={workspaceSlug}
            cwd={settingsCwd}
            onOpenMarket={() => setActiveSection('market')}
            onCreateNew={() => {
              setAddSourceDialogOpen(false)
              setActiveSection('settings')
            }}
            availableWorkspaces={workspaces}
            onWorkspaceChange={(slug) => {
              const target = workspaces.find((w) => w.slug === slug)
              if (target) setCurrentWorkspaceId(target.id)
            }}
          />
        )}
      </div>

      <AddSkillSourceDialog
        open={sourceDialogOpen}
        onOpenChange={setSourceDialogOpen}
        onSubmit={handleAddSource}
      />
      <SkillAddSourceDialog
        open={addSourceDialogOpen}
        onOpenChange={setAddSourceDialogOpen}
        workspaceSlug={workspaceSlug}
        onCreateNew={() => {
          setAddSourceDialogOpen(false)
          setActiveSection('settings')
          // 延迟一帧等 SkillSettingsView 挂载后再打开编辑器
          requestAnimationFrame(() => {
            skillSettingsViewRef.current?.createNewSkill('workspace')
          })
        }}
        onOpenMarket={() => {
          setAddSourceDialogOpen(false)
          setActiveSection('market')
        }}
      />
      <SkillDetailDialog
        open={detailOpen}
        loading={detailLoading}
        error={detailError}
        detail={skillDetail}
        onOpenChange={setDetailOpen}
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
            placeholder="搜索技能"
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-[#1d2440] outline-none placeholder:text-[#6c7699]"
          />
        </label>
        <MarketSelect value={category} options={['全部分类', '内置', '本地发现', '外部市场源']} onChange={onCategoryChange} />
        <MarketSelect value={source} options={['全部来源', '内置', '本地发现', '外部市场源']} onChange={onSourceChange} />
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

function SkillCardGrid({
  cards,
  busySkillSlug,
  onSkillAction,
  onOpenDetail,
}: {
  cards: SkillMarketCard[]
  busySkillSlug: string | null
  onSkillAction: (item: SkillCatalogItem) => void
  onOpenDetail: (item: SkillCatalogItem) => void
}) {
  return (
    <section className="mt-6 grid min-h-0 content-start grid-cols-3 gap-5 overflow-y-auto pr-2 pb-2">
      {cards.map((card) => (
        <SkillCard
          key={card.item.id}
          card={card}
          busy={busySkillSlug === card.item.slug}
          onAction={() => onSkillAction(card.item)}
          onOpenDetail={() => onOpenDetail(card.item)}
        />
      ))}
      {cards.length === 0 && (
        <div className="col-span-3 rounded-[8px] border border-dashed border-[#d8ddec] p-10 text-center text-[13px] text-[#687196]">
          当前工作区还没有可展示的 Agent 技能。可添加本地目录或远程 GitHub 技能源进行同步。
        </div>
      )}
    </section>
  )
}

function SkillCard({
  card,
  busy,
  onAction,
  onOpenDetail,
}: {
  card: SkillMarketCard
  busy: boolean
  onAction: () => void
  onOpenDetail: () => void
}) {
  const Icon = card.icon
  const installed = card.item.installState === 'installed'
  const actionable = installed || isInstallableSkillMarketItem(card.item)

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
        <h2 className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-6 text-[#121832]" title={card.item.name}>
          {card.item.name}
        </h2>
        {installed && (
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[#35c977] text-white">
            <Check size={16} strokeWidth={2.5} />
          </span>
        )}
      </div>
      <div className="mt-4 min-w-0 flex-1 overflow-hidden">
        <p className="line-clamp-4 break-all text-[13px] leading-[20px] text-[#687196]">
          {card.item.description ?? '暂无描述。'}
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
  totalSkills,
  installedCount,
  lastSyncedAt,
  onAddSource,
  onSync,
}: {
  loading: boolean
  sources: SkillSourceView[]
  totalSkills: number
  installedCount: number
  lastSyncedAt: number | null
  onAddSource: () => void
  onSync: () => void
}) {
  return (
    <aside className="h-fit rounded-[8px] border border-[#e4e7f1] bg-white p-5 shadow-[0_18px_40px_-36px_rgba(43,52,103,0.52)]">
      <h2 className="text-[17px] font-semibold text-[#121832]">市场源</h2>
      <p className="mt-3 text-[13px] leading-6 text-[#60698d]">管理技能来源，并同步获取最新技能。</p>

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
        同步技能
      </button>

      <div className="my-6 h-px bg-[#edf0f6]" />

      <div className="rounded-[8px] border border-[#edf0f6] bg-white p-4">
        <div className="flex items-center gap-3 text-[#687196]">
          <ShieldCheck size={19} className="text-[#20c579]" />
          <span className="text-[13px]">上次同步：{formatSyncTime(lastSyncedAt)}</span>
        </div>
        <div className="mt-3 pl-8 text-[13px] text-[#687196]">
          已发现 {totalSkills} 个技能，当前工作区已安装 {installedCount} 个
        </div>
      </div>
    </aside>
  )
}

function AddSkillSourceDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (draft: {
    connectionMode: 'local' | 'remote'
    type: 'official' | 'team' | 'local'
    name: string
    url: string
    localPath: string
  }) => Promise<void>
}) {
  const [connectionMode, setConnectionMode] = useState<'local' | 'remote'>('remote')
  const [type, setType] = useState<'official' | 'team' | 'local'>('official')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [localPath, setLocalPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ connectionMode, type, name, url, localPath })
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#111735]/32 p-6 backdrop-blur-[2px]">
      <section className="w-full max-w-[560px] rounded-[8px] border border-[#e4e7f1] bg-white shadow-[0_28px_80px_-42px_rgba(18,24,50,0.62)]">
        <header className="flex items-start justify-between border-b border-[#edf0f6] px-6 py-5">
          <div>
            <h2 className="text-[19px] font-semibold leading-7 text-[#121832]">添加新的技能来源</h2>
            <p className="mt-1 text-[13px] leading-5 text-[#687196]">
              接入官方、团队或本地镜像源，添加后可立即同步技能目录。
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

        <div className="space-y-5 px-6 py-5">
          <fieldset>
            <legend className="mb-3 text-[13px] font-semibold text-[#121832]">接入方式</legend>
            <div className="grid grid-cols-2 gap-3">
              {([
                { id: 'remote', label: '远程地址', desc: 'GitHub、HTTPS 或私有仓库地址' },
                { id: 'local', label: '本地目录', desc: '从本机目录或镜像文件夹同步' },
              ] as const).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setConnectionMode(option.id)
                    setType(option.id === 'local' ? 'local' : 'official')
                  }}
                  className={cn(
                    'rounded-[8px] border p-3 text-left transition-colors',
                    connectionMode === option.id
                      ? 'border-[#635bff] bg-[#f4f2ff] text-[#121832]'
                      : 'border-[#e4e7f1] bg-white text-[#60698d] hover:bg-[#f8f9fc]',
                  )}
                >
                  <div className="text-[13px] font-semibold">{option.label}</div>
                  <div className="mt-1 text-[12px] leading-4 text-[#687196]">{option.desc}</div>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-3 text-[13px] font-semibold text-[#121832]">来源类型</legend>
            <div className="grid grid-cols-3 gap-3">
              {(connectionMode === 'local'
                ? [{ id: 'local', label: '本地镜像', desc: '本机目录' }]
                : [
                { id: 'official', label: '官方源', desc: '受信任市场' },
                { id: 'team', label: '团队源', desc: '组织共享' },
                ]
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setType(option.id as 'official' | 'team' | 'local')}
                  className={cn(
                    'rounded-[8px] border p-3 text-left transition-colors',
                    type === option.id
                      ? 'border-[#635bff] bg-[#f4f2ff] text-[#121832]'
                      : 'border-[#e4e7f1] bg-white text-[#60698d] hover:bg-[#f8f9fc]',
                  )}
                >
                  <div className="text-[13px] font-semibold">{option.label}</div>
                  <div className="mt-1 text-[12px] text-[#687196]">{option.desc}</div>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid grid-cols-2 gap-4">
            <SkillSourceField
              label="源名称"
              value={name}
              placeholder="例如：设计团队技能源"
              onChange={setName}
            />
            {connectionMode === 'remote' && (
              <SkillSourceField
                label="源地址"
                value={url}
                placeholder="https://github.com/org/skills"
                onChange={setUrl}
              />
            )}
          </div>

          {connectionMode === 'local' && (
            <SkillSourceField
              label="本地路径"
              value={localPath}
              placeholder="/Users/me/.lume/skill-market"
              onChange={setLocalPath}
            />
          )}

          {error && (
            <div className="rounded-[8px] border border-[#ffd2d2] bg-[#fff8f8] p-3 text-[12px] leading-5 text-[#ba3636]">
              {error}
            </div>
          )}

          <div className="rounded-[8px] border border-[#e1e9ff] bg-[#f7f9ff] p-4">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[#121832]">
              <ShieldCheck size={18} className="text-[#20c579]" />
              信任与同步
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[#687196]">
              新市场源默认启用手动审核。同步后，外部技能会标记为“外部市场源”，安装前需要确认来源与内容。
            </p>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-3 border-t border-[#edf0f6] px-6 py-4">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="h-9 rounded-[6px] border border-[#dfe3ee] px-4 text-[13px] font-semibold text-[#60698d] hover:bg-[#f8f9fc]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy || (connectionMode === 'remote' ? !url.trim() : !localPath.trim())}
            onClick={() => void handleSubmit()}
            className="h-9 rounded-[6px] bg-[#635bff] px-4 text-[13px] font-semibold text-white shadow-[0_14px_28px_-22px_rgba(99,91,255,0.82)] hover:bg-[#564dff]"
          >
            {busy ? '同步中...' : '添加并同步'}
          </button>
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
                  <span className={cn('rounded-[5px] px-2 py-1 text-[12px] font-medium', badgeToneClass(SOURCE_LABELS[detail.item.sourceType]))}>
                    {SOURCE_LABELS[detail.item.sourceType]}
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

function buildSkillSourceViews(items: SkillCatalogItem[]): SkillSourceView[] {
  const builtInCount = items.filter((item) => item.sourceType === 'built-in').length
  const localCount = items.filter((item) => item.sourceType === 'local').length
  const githubCount = items.filter((item) => item.sourceType === 'github').length

  return [
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

function formatInstallState(state: SkillCatalogItem['installState']): string {
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

function toSkillMarketCard(item: SkillCatalogItem): SkillMarketCard {
  const visual = SKILL_VISUALS[item.slug] ?? inferSkillVisual(item)
  return {
    item,
    ...visual,
    category: SOURCE_LABELS[item.sourceType],
    actionLabel: buildSkillActionLabel(item),
  }
}

function inferSkillVisual(item: SkillCatalogItem): Pick<SkillMarketCard, 'category' | 'actionLabel' | 'icon' | 'tone'> {
  const name = `${item.name} ${item.slug}`.toLowerCase()
  const category = SOURCE_LABELS[item.sourceType]
  const actionLabel = buildSkillActionLabel(item)

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
    case '内置':
      return 'bg-[#f0edff] text-[#635bff]'
    case '本地发现':
      return 'bg-[#ddf7e8] text-[#168653]'
    default:
      return 'bg-[#eaf2ff] text-[#3375d6]'
  }
}
