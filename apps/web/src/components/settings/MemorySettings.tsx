import * as React from 'react'
import {
  Archive,
  CheckCircle2,
  Database,
  FileText,
  Globe2,
  ListFilter,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
} from 'lucide-react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type {
  GlobalMemoryCandidate,
  MemoryDistillationResult,
  GlobalMemoryStatus,
  MemoryProviderStatus,
  MemoryRuntimeConfig,
  MemorySearchResult,
  MemoryStats,
} from '@lume/shared'
import { AGENT_IPC_CHANNELS } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  distillWorkspaceMemory,
  getGlobalMemoryStatus,
  getMemoryRuntimeConfig,
  getMemoryStats,
  getMemoryStatus,
  indexMemoryDocument,
  indexMemoryWorkspace,
  listGlobalMemoryCandidates,
  promoteGlobalMemory,
  rejectGlobalMemoryCandidate,
  searchMemory,
  sidecarCall,
  updateMemoryRuntimeConfig,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import {
  MEMORY_SETTINGS_VIEWS,
  MEMORY_TOOL_POLICY_GROUPS,
  buildMemoryOverviewMetrics,
  candidateStatusLabel,
  formatMemoryBackend,
  isMemoryToolGroupEnabled,
  setMemoryToolGroupEnabled,
  summarizeMemoryResult,
  type MemorySettingsView,
} from './memory-settings-state'

export function MemorySettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )
  const workspaceSlug = workspace?.slug ?? null
  const [view, setView] = React.useState<MemorySettingsView>('workspace')
  const [status, setStatus] = React.useState<MemoryProviderStatus | null>(null)
  const [stats, setStats] = React.useState<MemoryStats | null>(null)
  const [globalStatus, setGlobalStatus] = React.useState<GlobalMemoryStatus | null>(null)
  const [runtimeConfig, setRuntimeConfig] = React.useState<MemoryRuntimeConfig | null>(null)
  const [candidates, setCandidates] = React.useState<GlobalMemoryCandidate[]>([])
  const [query, setQuery] = React.useState('设计决策 偏好 当前状态')
  const [results, setResults] = React.useState<MemorySearchResult[]>([])
  const [includeGlobal, setIncludeGlobal] = React.useState(true)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [distillResult, setDistillResult] = React.useState<MemoryDistillationResult | null>(null)

  const refresh = React.useCallback(async () => {
    if (!workspaceSlug) return
    try {
      const [nextStatus, nextStats, nextGlobalStatus, nextCandidates] = await Promise.all([
        getMemoryStatus(workspaceSlug),
        getMemoryStats(workspaceSlug),
        getGlobalMemoryStatus(),
        listGlobalMemoryCandidates('pending'),
      ])
      const nextRuntimeConfig = await getMemoryRuntimeConfig()
      setStatus(nextStatus)
      setStats(nextStats)
      setGlobalStatus(nextGlobalStatus)
      setRuntimeConfig(nextRuntimeConfig)
      setCandidates(nextCandidates)
    } catch (error) {
      console.error('[MemorySettings] refresh FAILED:', error)
      toast.error('读取记忆状态失败')
    }
  }, [workspaceSlug])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name)
    try {
      await action()
    } finally {
      setBusyAction(null)
    }
  }

  const handleSearch = () => runAction('search', async () => {
    if (!workspaceSlug || !query.trim()) return
    const found = await searchMemory({
      workspaceSlug,
      query: query.trim(),
      maxResults: 12,
      includeGlobal,
      includeRecent: true,
      includeLongTerm: true,
      includeWorkspaceBrief: true,
    })
    setResults(found)
    if (found.length === 0) toast.message('没有找到匹配的记忆')
  })

  const handleIndexWorkspace = () => runAction('index-workspace', async () => {
    if (!workspaceSlug) return
    const result = await indexMemoryWorkspace({ workspaceSlug, force: true })
    toast.success(`已重建索引：${result.indexedChunks} 个记忆块`)
    await refresh()
  })

  const handleIndexDocument = (filePath: string) => runAction(`index-${filePath}`, async () => {
    if (!workspaceSlug) return
    const result = await indexMemoryDocument({ workspaceSlug, filePath, force: true })
    toast.success(`${filePath} 已重建：${result.indexedChunks} 个记忆块`)
    await refresh()
  })

  const handleDistill = () => runAction('distill', async () => {
    if (!workspaceSlug) return
    const result = await distillWorkspaceMemory({
      workspaceSlug,
      days: 14,
      updateWorkspaceBrief: true,
      generateGlobalCandidates: true,
    })
    setDistillResult(result)
    toast.success(`蒸馏完成：新增 ${result.createdItems ?? 0} 条，候选 ${result.globalCandidateCount ?? 0} 条`)
    await refresh()
  })

  const handleOpenMemoryFile = (path: string) => runAction(`open-${path}`, async () => {
    if (!workspaceSlug) return
    await sidecarCall(AGENT_IPC_CHANNELS.OPEN_WORKSPACE_FILE, {
      workspaceSlug,
      path,
    })
  })

  const handleTogglePolicyGroup = (
    groupId: typeof MEMORY_TOOL_POLICY_GROUPS[number]['id'],
    enabled: boolean,
  ) => runAction(`policy-${groupId}`, async () => {
    if (!runtimeConfig) return
    const nextTools = setMemoryToolGroupEnabled(runtimeConfig, groupId, enabled)
    const nextConfig = await updateMemoryRuntimeConfig({ tools: nextTools })
    setRuntimeConfig(nextConfig)
    toast.success('记忆工具权限已更新')
  })

  const handlePromote = (candidate: GlobalMemoryCandidate) => runAction(`promote-${candidate.id}`, async () => {
    await promoteGlobalMemory({ candidateId: candidate.id, approve: true })
    toast.success('已提升为全局记忆')
    await refresh()
  })

  const handleReject = (candidate: GlobalMemoryCandidate) => runAction(`reject-${candidate.id}`, async () => {
    await rejectGlobalMemoryCandidate(candidate.id)
    toast.success('已保留在工作区，不提升为全局')
    await refresh()
  })

  if (!workspaceSlug) {
    return (
      <EmptyPanel title="暂无工作区" desc="创建或选择一个工作区后即可管理记忆索引、蒸馏和全局候选。" />
    )
  }

  const metrics = buildMemoryOverviewMetrics({ status, stats, globalStatus })

  return (
    <div className="space-y-4">
      <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
              <Database size={15} />
              {workspace.name} · {formatMemoryBackend(status)}
            </div>
            <h3 className="mt-2 text-[17px] font-semibold leading-6 text-[var(--text-1)]">记忆控制台</h3>
            <p className="mt-1 max-w-[680px] text-[13px] leading-5 text-[var(--text-2)]">
              管理 WORKSPACE.md、MEMORY.md、daily memory、结构化索引和全局候选。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busyAction !== null}>
              <RefreshCw size={14} />
              刷新
            </Button>
            <Button size="sm" onClick={() => void handleIndexWorkspace()} disabled={busyAction !== null}>
              <Archive size={14} />
              重建索引
            </Button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-5 gap-3">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
              <div className="text-[12px] text-[var(--text-3)]">{metric.label}</div>
              <div className={cn(
                'mt-1 text-[18px] font-semibold',
                metric.tone === 'good' && 'text-emerald-600',
                metric.tone === 'warn' && 'text-amber-600',
                metric.tone === 'neutral' && 'text-[var(--text-1)]',
              )}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      <MemoryPolicyPanel
        busyAction={busyAction}
        runtimeConfig={runtimeConfig}
        onToggle={(groupId, enabled) => void handleTogglePolicyGroup(groupId, enabled)}
      />

      <div className="flex gap-2">
        {MEMORY_SETTINGS_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={cn(
              'inline-flex h-8 items-center rounded-[8px] border px-3 text-[13px] font-medium transition-colors',
              view === item.id
                ? 'border-[var(--brand)] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                : 'border-border bg-[var(--surface-1)] text-[var(--text-2)] hover:bg-[var(--surface-2)]',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === 'workspace' && (
        <WorkspaceMemoryPanel
          busyAction={busyAction}
          distillResult={distillResult}
          onDistill={() => void handleDistill()}
          onIndexDocument={(path) => void handleIndexDocument(path)}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
        />
      )}

      {view === 'items' && (
        <StructuredMemoryPanel
          busy={busyAction === 'search'}
          includeGlobal={includeGlobal}
          query={query}
          results={results}
          onIncludeGlobalChange={setIncludeGlobal}
          onQueryChange={setQuery}
          onSearch={() => void handleSearch()}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
        />
      )}

      {view === 'global' && (
        <GlobalCandidatesPanel
          busyAction={busyAction}
          candidates={candidates}
          globalStatus={globalStatus}
          onPromote={(candidate) => void handlePromote(candidate)}
          onReject={(candidate) => void handleReject(candidate)}
        />
      )}
    </div>
  )
}

function MemoryPolicyPanel({
  busyAction,
  runtimeConfig,
  onToggle,
}: {
  busyAction: string | null
  runtimeConfig: MemoryRuntimeConfig | null
  onToggle: (groupId: typeof MEMORY_TOOL_POLICY_GROUPS[number]['id'], enabled: boolean) => void
}) {
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[16px] font-semibold text-[var(--text-1)]">Agent 记忆工具权限</h3>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">控制 Agent 能读、写、蒸馏或提升哪些记忆能力。变更会保存到本地 memory 配置。</p>
        </div>
        <div className="rounded-[8px] border border-border bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--text-2)]">
          citations {runtimeConfig?.citations ?? 'auto'}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {MEMORY_TOOL_POLICY_GROUPS.map((group) => {
          const checked = isMemoryToolGroupEnabled(runtimeConfig?.tools, group.id)
          const isGlobalWrite = group.id === 'group:memory-global-write'
          return (
            <label
              key={group.id}
              className={cn(
                'flex min-h-[76px] items-center justify-between gap-3 rounded-[8px] border p-3',
                checked
                  ? 'border-[color-mix(in_oklab,var(--brand)_35%,var(--border))] bg-[color-mix(in_oklab,var(--brand)_8%,var(--surface-1))]'
                  : 'border-border bg-[var(--surface-2)]',
              )}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
                  {group.label}
                  {isGlobalWrite && <span className="rounded-[6px] bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-200">高影响</span>}
                </span>
                <span className="mt-1 block text-[12px] leading-5 text-[var(--text-3)]">{group.desc}</span>
              </span>
              <Switch
                checked={checked}
                disabled={!runtimeConfig || busyAction !== null}
                onCheckedChange={(value) => onToggle(group.id, value)}
              />
            </label>
          )
        })}
      </div>
    </section>
  )
}

function WorkspaceMemoryPanel({
  busyAction,
  distillResult,
  onDistill,
  onIndexDocument,
  onOpenFile,
}: {
  busyAction: string | null
  distillResult: MemoryDistillationResult | null
  onDistill: () => void
  onIndexDocument: (path: string) => void
  onOpenFile: (path: string) => void
}) {
  const documents = [
    { path: 'WORKSPACE.md', desc: '工作区当前状态、目标、约束和重要决策' },
    { path: 'MEMORY.md', desc: '长期工作区记忆、偏好、事实和经验' },
    { path: 'memory', desc: '每日过程记录与 Memory Flush 结果' },
  ]

  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[16px] font-semibold text-[var(--text-1)]">工作区旅程</h3>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">维护可见 Markdown 记忆，并把近期过程蒸馏成长期状态。</p>
        </div>
        <Button onClick={onDistill} disabled={busyAction !== null} size="sm">
          <ShieldCheck size={14} />
          蒸馏最近 14 天
        </Button>
      </div>

      <div className="mt-4 grid gap-3">
        {documents.map((doc) => (
          <div key={doc.path} className="flex items-center justify-between gap-3 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
                <FileText size={15} />
                {doc.path}
              </div>
              <p className="mt-1 text-[12px] text-[var(--text-3)]">{doc.desc}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => onOpenFile(doc.path)} disabled={busyAction !== null}>
                打开
              </Button>
              {doc.path !== 'memory' && (
                <Button variant="outline" size="sm" onClick={() => onIndexDocument(doc.path)} disabled={busyAction !== null}>
                  索引
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {distillResult && (
        <div className="mt-4 rounded-[8px] border border-emerald-200 bg-emerald-50 p-3 text-[13px] text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200">
          蒸馏结果：扫描 {distillResult.scannedFiles ?? 0} 个文件，新增 {distillResult.createdItems ?? 0} 条，跳过 {distillResult.skippedItems ?? 0} 条，全局候选 {distillResult.globalCandidateCount ?? 0} 条。
        </div>
      )}
    </section>
  )
}

function StructuredMemoryPanel({
  busy,
  includeGlobal,
  query,
  results,
  onIncludeGlobalChange,
  onQueryChange,
  onSearch,
  onOpenFile,
}: {
  busy: boolean
  includeGlobal: boolean
  query: string
  results: MemorySearchResult[]
  onIncludeGlobalChange: (value: boolean) => void
  onQueryChange: (value: string) => void
  onSearch: () => void
  onOpenFile: (path: string) => void
}) {
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-9 min-w-[280px] flex-1 items-center gap-2 rounded-[8px] border border-border bg-[var(--surface-1)] px-3 text-[var(--text-3)]">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onSearch()
            }}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)]"
            placeholder="搜索偏好、决策、事实、过程"
          />
        </label>
        <label className="flex h-9 items-center gap-2 rounded-[8px] border border-border px-3 text-[13px] text-[var(--text-2)]">
          <Globe2 size={14} />
          全局
          <Switch checked={includeGlobal} onCheckedChange={onIncludeGlobalChange} />
        </label>
        <Button onClick={onSearch} disabled={busy || !query.trim()} size="sm">
          <ListFilter size={14} />
          搜索
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        {results.length === 0 ? (
          <EmptyPanel title="还没有搜索结果" desc="输入关键词后可以查看结构化记忆、来源和评分。" compact />
        ) : results.map((result) => (
          <article key={result.id} className="rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-[var(--text-3)]">{summarizeMemoryResult(result)}</div>
                <p className="mt-1 whitespace-pre-wrap text-[13px] leading-5 text-[var(--text-1)]">{result.snippet}</p>
                {result.citation && <p className="mt-2 text-[12px] text-[var(--text-3)]">{result.citation}</p>}
              </div>
              {result.path && (
                <Button variant="outline" size="sm" onClick={() => onOpenFile(result.path)}>
                  来源
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function GlobalCandidatesPanel({
  busyAction,
  candidates,
  globalStatus,
  onPromote,
  onReject,
}: {
  busyAction: string | null
  candidates: GlobalMemoryCandidate[]
  globalStatus: GlobalMemoryStatus | null
  onPromote: (candidate: GlobalMemoryCandidate) => void
  onReject: (candidate: GlobalMemoryCandidate) => void
}) {
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[16px] font-semibold text-[var(--text-1)]">全局记忆候选</h3>
          <p className="mt-1 text-[13px] text-[var(--text-2)]">跨工作区偏好只生成候选，确认后才进入全局记忆。</p>
        </div>
        <div className="rounded-[8px] border border-border bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--text-2)]">
          全局记忆 {globalStatus?.itemCount ?? 0} · 待确认 {globalStatus?.pendingCandidateCount ?? 0}
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {candidates.length === 0 ? (
          <EmptyPanel title="没有待确认候选" desc="执行工作区蒸馏后，稳定偏好和通用经验会出现在这里。" compact />
        ) : candidates.map((candidate) => (
          <article key={candidate.id} className="rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-3)]">
                  <span>{candidateStatusLabel(candidate.status)}</span>
                  <span>importance {candidate.importance}</span>
                  <span>confidence {candidate.confidence.toFixed(2)}</span>
                </div>
                {candidate.title && <h4 className="mt-1 text-[14px] font-semibold text-[var(--text-1)]">{candidate.title}</h4>}
                <p className="mt-1 text-[13px] leading-5 text-[var(--text-1)]">{candidate.content}</p>
                <p className="mt-2 text-[12px] text-[var(--text-3)]">{candidate.reason}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => onReject(candidate)} disabled={busyAction !== null}>
                  <XCircle size={14} />
                  保留工作区
                </Button>
                <Button size="sm" onClick={() => onPromote(candidate)} disabled={busyAction !== null}>
                  <CheckCircle2 size={14} />
                  提升
                </Button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

function EmptyPanel({ title, desc, compact = false }: { title: string; desc: string; compact?: boolean }) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center rounded-[8px] border border-dashed border-border bg-[var(--surface-2)] text-center',
      compact ? 'min-h-[160px] p-6' : 'min-h-[280px] p-10',
    )}>
      <div className="flex size-10 items-center justify-center rounded-[10px] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]">
        <Database size={18} />
      </div>
      <h3 className="mt-3 text-[15px] font-semibold text-[var(--text-1)]">{title}</h3>
      <p className="mt-1 max-w-[360px] text-[13px] leading-5 text-[var(--text-3)]">{desc}</p>
    </div>
  )
}
