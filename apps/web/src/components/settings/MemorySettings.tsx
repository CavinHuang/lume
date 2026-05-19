import * as React from 'react'
import {
  AlertTriangle,
  Clock3,
  FileText,
  Globe2,
  ListFilter,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type {
  MemoryCitationsMode,
  MemoryRuntimeConfig,
  MemorySearchResult,
  MemorySettingsEntrySummary,
  MemorySettingsFileSummary,
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  getMemoryRuntimeConfig,
  getMemorySettingsSnapshot,
  openMemorySource,
  searchMemory,
  updateMemoryRuntimeConfig,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import {
  MEMORY_CITATION_MODE_LABELS,
  MEMORY_CONFIDENCE_LABELS,
  MEMORY_FILE_KIND_LABELS,
  MEMORY_KIND_LABELS,
  MEMORY_PENDING_LABELS,
  MEMORY_SETTINGS_VIEWS,
  MEMORY_STATUS_LABELS,
  MEMORY_TOOL_POLICY_GROUPS,
  buildMemoryOverviewMetrics,
  isMemoryToolGroupEnabled,
  pendingNotice,
  setMemoryToolGroupEnabled,
  summarizeMemoryEntry,
  summarizeMemoryResult,
  type MemorySettingsView,
  type MemoryToolPolicyGroupId,
} from './memory-settings-state'

export function MemorySettings() {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )
  const workspaceSlug = workspace?.slug ?? null
  const [view, setView] = React.useState<MemorySettingsView>('overview')
  const [runtimeConfig, setRuntimeConfig] = React.useState<MemoryRuntimeConfig | null>(null)
  const [snapshot, setSnapshot] = React.useState<MemorySettingsSnapshot | null>(null)
  const [query, setQuery] = React.useState('设计决策 偏好 当前状态')
  const [results, setResults] = React.useState<MemorySearchResult[]>([])
  const [includeGlobal, setIncludeGlobal] = React.useState(true)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (!workspaceSlug) return
    try {
      const nextConfig = await getMemoryRuntimeConfig()
      const nextSnapshot = await getMemorySettingsSnapshot(workspaceSlug)
      setRuntimeConfig(nextConfig)
      setSnapshot(nextSnapshot)
    } catch (error) {
      console.error('[MemorySettings] refresh FAILED:', error)
      toast.error(memorySettingsErrorMessage(error))
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
    })
    setResults(found)
    if (found.length === 0) toast.message('没有找到匹配的记忆')
  })

  const handleOpenMemoryFile = (path: string) => runAction(`open-${path}`, async () => {
    if (!workspaceSlug) return
    await openMemorySource({ workspaceSlug, path })
  })

  const handleTogglePolicyGroup = (
    groupId: MemoryToolPolicyGroupId,
    enabled: boolean,
  ) => runAction(`policy-${groupId}`, async () => {
    if (!runtimeConfig) return
    const nextTools = setMemoryToolGroupEnabled(runtimeConfig, groupId, enabled)
    const nextConfig = await updateMemoryRuntimeConfig({ tools: nextTools })
    setRuntimeConfig(nextConfig)
    toast.success('记忆工具权限已更新')
  })

  const handleCitationsMode = (citations: MemoryCitationsMode) => runAction(`citations-${citations}`, async () => {
    const nextConfig = await updateMemoryRuntimeConfig({ citations })
    setRuntimeConfig(nextConfig)
  })

  if (!workspaceSlug) {
    return (
      <EmptyPanel title="暂无工作区" desc="创建或选择一个工作区后即可管理记忆。" />
    )
  }

  return (
    <div className="space-y-4">
      <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
              <FileText size={15} />
              {workspace.name} · Memory V2
            </div>
            <h3 className="mt-2 text-[17px] font-semibold leading-6 text-[var(--text-1)]">记忆</h3>
          </div>
          <div className="flex items-center gap-2">
            {snapshot?.counts.pending.total ? (
              <div className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-amber-200 bg-amber-50 px-2 text-[12px] font-medium text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle size={14} />
                {pendingNotice(snapshot.counts.pending)}
              </div>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busyAction !== null}>
              <RefreshCw size={14} />
              刷新
            </Button>
          </div>
        </div>
      </section>

      <div className="flex gap-2 overflow-x-auto">
        {MEMORY_SETTINGS_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center rounded-[8px] border px-3 text-[13px] font-medium transition-colors',
              view === item.id
                ? 'border-[var(--brand)] bg-[color-mix(in_oklab,var(--brand)_10%,var(--surface-1))] text-[var(--brand)]'
                : 'border-border bg-[var(--surface-1)] text-[var(--text-2)] hover:bg-[var(--surface-2)]',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {view === 'overview' && (
        <OverviewPanel
          busyAction={busyAction}
          runtimeConfig={runtimeConfig}
          snapshot={snapshot}
          onCitationsMode={(mode) => void handleCitationsMode(mode)}
          onToggle={(groupId, enabled) => void handleTogglePolicyGroup(groupId, enabled)}
        />
      )}

      {view === 'workspace' && (
        <MemoryCollectionPanel
          entries={snapshot?.workspaceEntries ?? []}
          files={(snapshot?.files ?? []).filter((file) => file.scope === 'workspace')}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
          title="工作区"
        />
      )}

      {view === 'global' && (
        <MemoryCollectionPanel
          entries={snapshot?.globalEntries ?? []}
          files={(snapshot?.files ?? []).filter((file) => file.scope === 'global')}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
          title="全局"
        />
      )}

      {view === 'pending' && (
        <PendingMemoryPanel
          items={snapshot?.pending ?? []}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
        />
      )}

      <SearchPanel
        busy={busyAction === 'search'}
        includeGlobal={includeGlobal}
        query={query}
        results={results}
        onIncludeGlobalChange={setIncludeGlobal}
        onOpenFile={(path) => void handleOpenMemoryFile(path)}
        onQueryChange={setQuery}
        onSearch={() => void handleSearch()}
      />
    </div>
  )
}

function OverviewPanel({
  busyAction,
  runtimeConfig,
  snapshot,
  onCitationsMode,
  onToggle,
}: {
  busyAction: string | null
  runtimeConfig: MemoryRuntimeConfig | null
  snapshot: MemorySettingsSnapshot | null
  onCitationsMode: (mode: MemoryCitationsMode) => void
  onToggle: (groupId: MemoryToolPolicyGroupId, enabled: boolean) => void
}) {
  const metrics = buildMemoryOverviewMetrics(snapshot)
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
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

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {MEMORY_TOOL_POLICY_GROUPS.map((group) => {
          const checked = isMemoryToolGroupEnabled(runtimeConfig?.tools, group.id)
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
                <span className="text-[13px] font-semibold text-[var(--text-1)]">{group.label}</span>
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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
          <ShieldCheck size={15} />
          回复下方引用
        </div>
        <div className="flex rounded-[8px] border border-border bg-[var(--surface-1)] p-0.5">
          {(['auto', 'on', 'off'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={!runtimeConfig || busyAction !== null}
              onClick={() => onCitationsMode(mode)}
              className={cn(
                'h-7 rounded-[6px] px-2 text-[12px] font-medium',
                runtimeConfig?.citations === mode
                  ? 'bg-[var(--surface-2)] text-[var(--text-1)] shadow-sm'
                  : 'text-[var(--text-3)]',
              )}
            >
              {MEMORY_CITATION_MODE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

function MemoryCollectionPanel({
  entries,
  files,
  onOpenFile,
  title,
}: {
  entries: MemorySettingsEntrySummary[]
  files: MemorySettingsFileSummary[]
  onOpenFile: (path: string) => void
  title: string
}) {
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-[var(--text-1)]">
        {title === '全局' ? <Globe2 size={16} /> : <FileText size={16} />}
        {title}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-2">
          {files.map((file) => (
            <FileRow key={file.path} file={file} onOpenFile={onOpenFile} />
          ))}
          {files.length === 0 && <EmptyInline text="暂无文件" />}
        </div>
        <div className="space-y-2">
          {entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} onOpenFile={onOpenFile} />
          ))}
          {entries.length === 0 && <EmptyInline text="暂无语义记忆" />}
        </div>
      </div>
    </section>
  )
}

function PendingMemoryPanel({
  items,
  onOpenFile,
}: {
  items: MemorySettingsPendingSummary[]
  onOpenFile: (path: string) => void
}) {
  const openItems = items.filter((item) => item.status === 'open')
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="space-y-2">
        {openItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onOpenFile(item.path)}
            className="block w-full rounded-[8px] border border-border bg-[var(--surface-2)] p-3 text-left hover:bg-[var(--surface-3)]"
          >
            <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
              <StatusBadge tone={item.type === 'conflict' ? 'warn' : 'neutral'}>
                {MEMORY_PENDING_LABELS[item.type]}
              </StatusBadge>
              <span>{formatDate(item.created)}</span>
            </div>
            <p className="mt-2 line-clamp-2 text-[13px] leading-5 text-[var(--text-1)]">{item.statement}</p>
            <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-[var(--text-3)]">{item.reason}</p>
          </button>
        ))}
        {openItems.length === 0 && <EmptyInline text="暂无待处理记忆" />}
      </div>
    </section>
  )
}

function SearchPanel({
  busy,
  includeGlobal,
  query,
  results,
  onIncludeGlobalChange,
  onOpenFile,
  onQueryChange,
  onSearch,
}: {
  busy: boolean
  includeGlobal: boolean
  query: string
  results: MemorySearchResult[]
  onIncludeGlobalChange: (value: boolean) => void
  onOpenFile: (path: string) => void
  onQueryChange: (value: string) => void
  onSearch: () => void
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
          全局
          <Switch checked={includeGlobal} onCheckedChange={onIncludeGlobalChange} />
        </label>
        <Button onClick={onSearch} disabled={busy || !query.trim()} size="sm">
          <ListFilter size={14} />
          搜索
        </Button>
      </div>

      <div className="mt-4 space-y-2">
        {results.map((result) => (
          <button
            key={`${result.id}:${result.path}`}
            type="button"
            onClick={() => onOpenFile(result.path)}
            className="block w-full rounded-[8px] border border-border bg-[var(--surface-2)] p-3 text-left hover:bg-[var(--surface-3)]"
          >
            <div className="text-[12px] font-medium text-[var(--text-3)]">{summarizeMemoryResult(result)}</div>
            <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-[var(--text-1)]">{result.snippet}</p>
            <div className="mt-2 truncate text-[12px] text-[var(--text-3)]">{result.citation ?? result.path}</div>
          </button>
        ))}
        {results.length === 0 && <EmptyInline text="暂无搜索结果" />}
      </div>
    </section>
  )
}

function FileRow({
  file,
  onOpenFile,
}: {
  file: MemorySettingsFileSummary
  onOpenFile: (path: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenFile(file.path)}
      className="flex min-h-[58px] w-full items-center justify-between gap-3 rounded-[8px] border border-border bg-[var(--surface-2)] p-3 text-left hover:bg-[var(--surface-3)]"
    >
      <span className="min-w-0">
        <span className="flex items-center gap-2 truncate text-[13px] font-semibold text-[var(--text-1)]">
          {file.kind === 'run' ? <Clock3 size={15} /> : <FileText size={15} />}
          {file.label}
        </span>
        <span className="mt-1 block truncate text-[12px] text-[var(--text-3)]">{formatDate(file.updatedAt)}</span>
      </span>
      <StatusBadge tone="neutral">{MEMORY_FILE_KIND_LABELS[file.kind]}</StatusBadge>
    </button>
  )
}

function EntryRow({
  entry,
  onOpenFile,
}: {
  entry: MemorySettingsEntrySummary
  onOpenFile: (path: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenFile(entry.path)}
      className="block w-full rounded-[8px] border border-border bg-[var(--surface-2)] p-3 text-left hover:bg-[var(--surface-3)]"
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
        <span>{summarizeMemoryEntry(entry)}</span>
        {entry.pinned && <StatusBadge tone="good">置顶</StatusBadge>}
        {entry.status === 'suspected_stale' && <StatusBadge tone="warn">{MEMORY_STATUS_LABELS.suspected_stale}</StatusBadge>}
      </div>
      <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-[var(--text-1)]">{entry.statement}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--text-3)]">
        <span>{MEMORY_KIND_LABELS[entry.kind]}</span>
        <span>{MEMORY_CONFIDENCE_LABELS[entry.confidence]}</span>
        <span>{formatDate(entry.updated)}</span>
      </div>
    </button>
  )
}

function StatusBadge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'neutral' | 'good' | 'warn'
}) {
  return (
    <span className={cn(
      'inline-flex h-5 items-center rounded-[6px] px-1.5 text-[11px] font-medium',
      tone === 'good' && 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200',
      tone === 'warn' && 'bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-200',
      tone === 'neutral' && 'bg-[var(--surface-1)] text-[var(--text-3)]',
    )}>
      {children}
    </span>
  )
}

function EmptyInline({ text }: { text: string }) {
  return (
    <div className="rounded-[8px] border border-dashed border-border bg-[var(--surface-2)] p-4 text-center text-[13px] text-[var(--text-3)]">
      {text}
    </div>
  )
}

function EmptyPanel({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-[10px] border border-dashed border-border bg-[var(--surface-1)] p-6 text-center">
      <div className="text-[15px] font-semibold text-[var(--text-1)]">{title}</div>
      <p className="mt-2 text-[13px] text-[var(--text-3)]">{desc}</p>
    </div>
  )
}

function formatDate(value?: string | number) {
  if (!value) return '未写入'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知'
  return date.toLocaleString()
}

function memorySettingsErrorMessage(error: unknown): string {
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''
  return detail ? `读取记忆设置失败：${detail}` : '读取记忆设置失败'
}
