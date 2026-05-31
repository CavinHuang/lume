import * as React from 'react'
import {
  AlertTriangle,
  Check,
  Clock3,
  Download,
  FileText,
  Globe2,
  History,
  Pencil,
  RefreshCw,
  Save,
  SearchCheck,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type {
  Channel,
  MemoryCitationsMode,
  MemoryIngestSourceInput,
  MemoryIngestSourcesJob,
  MemoryIngestSourcesResult,
  MemoryKind,
  MemoryOrganizeEntriesResult,
  MemoryOrganizeHistoryResult,
  MemoryReadToolResult,
  MemoryResolvePendingInput,
  MemoryRuntimeConfig,
  MemorySettingsEntrySummary,
  MemorySettingsFileSummary,
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { WorkspaceFileBrowser } from '@/components/file-browser/WorkspaceFileBrowser'
import { agentWorkspacesAtom, currentWorkspaceIdAtom } from '@/atoms'
import {
  getMemoryRuntimeConfig,
  getMemoryIngestJob,
  getMemorySettingsSnapshot,
  ingestMemorySources,
  listChannels,
  openFileDialog,
  openFolderDialog,
  openMemorySource,
  organizeMemoryEntries,
  organizeMemoryHistory,
  readMemory,
  deleteMemoryEntry,
  resolveMemoryPending,
  updateMemoryEntry,
  updateEmbeddingModelRef,
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
  buildEmbeddingModelOptions,
  buildMemoryLayerMetrics,
  buildMemoryDetailRows,
  buildMemoryOverviewMetrics,
  buildRerankModelOptions,
  isMemoryToolGroupEnabled,
  localOnnxStatusLabel,
  localOnnxStatusTone,
  pendingNotice,
  setMemoryToolGroupEnabled,
  summarizeLocalOnnxStatus,
  summarizeMemoryIngestSourcesJob,
  summarizeMemoryOrganizeEntriesResult,
  summarizeMemoryOrganizeResult,
  summarizeMemoryIngestSourcesResult,
  summarizeMemoryEntry,
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
  const [channels, setChannels] = React.useState<Channel[]>([])
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [entryOrganizeResult, setEntryOrganizeResult] = React.useState<MemoryOrganizeEntriesResult | null>(null)
  const [organizeResult, setOrganizeResult] = React.useState<MemoryOrganizeHistoryResult | null>(null)
  const [ingestJob, setIngestJob] = React.useState<MemoryIngestSourcesJob | null>(null)
  const [ingestResult, setIngestResult] = React.useState<MemoryIngestSourcesResult | null>(null)
  const [memoryDetail, setMemoryDetail] = React.useState<MemoryReadToolResult | null>(null)
  const [selectedMemoryId, setSelectedMemoryId] = React.useState<string | null>(null)
  const [detailDirty, setDetailDirty] = React.useState(false)
  const [externalText, setExternalText] = React.useState('')
  const [workspaceFilePath, setWorkspaceFilePath] = React.useState('')

  const refresh = React.useCallback(async () => {
    if (!workspaceSlug) return
    try {
      const nextConfig = await getMemoryRuntimeConfig()
      const nextSnapshot = await getMemorySettingsSnapshot(workspaceSlug)
      const nextChannels = await listChannels()
      setRuntimeConfig(nextConfig)
      setSnapshot(nextSnapshot)
      setChannels(nextChannels)
    } catch (error) {
      console.error('[MemorySettings] refresh FAILED:', error)
      toast.error(memorySettingsErrorMessage(error))
    }
  }, [workspaceSlug])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    const status = snapshot?.retrieval.semantic.localOnnx?.status
    if (status !== 'downloading' && status !== 'initializing') return undefined
    const timer = window.setTimeout(() => void refresh(), 1500)
    return () => window.clearTimeout(timer)
  }, [refresh, snapshot?.retrieval.semantic.localOnnx?.status])

  React.useEffect(() => {
    if (!ingestJob || ingestJob.status !== 'running') return undefined

    let disposed = false
    let timer: number | undefined

    const poll = async () => {
      try {
        const nextJob = await getMemoryIngestJob({ jobId: ingestJob.jobId })
        if (disposed) return
        setIngestJob(nextJob)
        if (nextJob.status === 'running') {
          timer = window.setTimeout(poll, 1200)
          return
        }
        if (nextJob.status === 'completed') {
          if (nextJob.result) {
            setIngestResult(nextJob.result)
            toast.success(summarizeMemoryIngestSourcesResult(nextJob.result))
          }
          await refresh()
          return
        }
        toast.error(summarizeMemoryIngestSourcesJob(nextJob))
      } catch (error) {
        if (!disposed) {
          const message = memorySettingsErrorMessage(error)
          setIngestJob((current) => current?.jobId === ingestJob.jobId
            ? {
              ...current,
              status: 'failed',
              completedAt: Date.now(),
              error: message,
            }
            : current)
          toast.error(message)
        }
      }
    }

    timer = window.setTimeout(poll, 800)
    return () => {
      disposed = true
      if (timer) window.clearTimeout(timer)
    }
  }, [ingestJob?.jobId, ingestJob?.status, refresh])

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name)
    try {
      await action()
    } finally {
      setBusyAction(null)
    }
  }

  const handleOpenMemoryFile = (path: string) => runAction(`open-${path}`, async () => {
    if (!workspaceSlug) return
    await openMemorySource({ workspaceSlug, path })
  })

  const handleInspectMemoryEntry = (entry: MemorySettingsEntrySummary) => runAction(`inspect-${entry.id}`, async () => {
    if (!workspaceSlug) return
    if (detailDirty && selectedMemoryId !== entry.id && !window.confirm('当前记忆还有未保存修改，切换后会丢失。继续吗？')) {
      return
    }
    setDetailDirty(false)
    setSelectedMemoryId(entry.id)
    const detail = await readMemory({ workspaceSlug, id: entry.id })
    setMemoryDetail(detail)
  })

  const handleUpdateMemoryEntry = (
    entry: MemorySettingsEntrySummary,
    input: {
      statement: string
      kind: MemoryKind
      confidence: MemorySettingsEntrySummary['confidence']
      tags: string[]
    },
  ) => runAction(`update-${entry.id}`, async () => {
    if (!workspaceSlug) return
    await updateMemoryEntry({
      workspaceSlug,
      scope: entry.scope,
      id: entry.id,
      statement: input.statement,
      kind: input.kind,
      confidence: input.confidence,
      tags: input.tags,
    })
    const detail = await readMemory({ workspaceSlug, id: entry.id })
    setMemoryDetail(detail)
    setDetailDirty(false)
    await refresh()
    toast.success('记忆已更新')
  })

  const handleDeleteMemoryEntry = (entry: MemorySettingsEntrySummary) => runAction(`delete-${entry.id}`, async () => {
    if (!workspaceSlug) return
    if (!window.confirm('删除后这条记忆不会再参与召回。确定删除吗？')) return
    await deleteMemoryEntry({
      workspaceSlug,
      scope: entry.scope,
      id: entry.id,
    })
    setSelectedMemoryId(null)
    setMemoryDetail(null)
    setDetailDirty(false)
    await refresh()
    toast.success('记忆已删除')
  })

  const handleResolvePending = (
    item: MemorySettingsPendingSummary,
    action: 'accept' | 'reject' | 'resolve',
    candidateOverride?: MemoryResolvePendingInput['candidateOverride'],
  ) => runAction(`pending-${action}-${item.id}`, async () => {
    if (!workspaceSlug) return
    const actionLabel = action === 'accept'
      ? candidateOverride
        ? '合并后接受'
        : '接受候选记忆'
      : action === 'reject'
      ? '保留现有并忽略候选'
      : '标记为已处理'
    if (!window.confirm(`${actionLabel}？`)) return
    await resolveMemoryPending({
      workspaceSlug,
      path: item.path,
      action,
      candidateOverride,
    })
    await refresh()
    toast.success(actionLabel)
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

  const handleSemanticMode = (semantic: MemoryRuntimeConfig['retrieval']['semantic']) => runAction(`semantic-${semantic}`, async () => {
    if (!runtimeConfig) return
    const nextConfig = await updateMemoryRuntimeConfig({
      retrieval: {
        ...runtimeConfig.retrieval,
        semantic,
      },
    })
    setRuntimeConfig(nextConfig)
    await refresh()
  })

  const handleEmbeddingModel = (modelRef: string) => runAction('embedding-model', async () => {
    if (!workspaceSlug || !modelRef) return
    await updateEmbeddingModelRef(modelRef, workspaceSlug)
    await refresh()
  })

  const handleRerankModel = (modelRef: string) => runAction('rerank-model', async () => {
    if (!runtimeConfig) return
    const nextConfig = await updateMemoryRuntimeConfig({
      retrieval: {
        ...runtimeConfig.retrieval,
        rerankModelRef: modelRef.trim() || undefined,
      },
    })
    setRuntimeConfig(nextConfig)
    await refresh()
  })

  const handleOrganizeHistory = () => runAction('organize-history', async () => {
    if (!workspaceSlug) return
    const result = await organizeMemoryHistory({ workspaceSlug, limit: 200 })
    setOrganizeResult(result)
    await refresh()
    toast.success(summarizeMemoryOrganizeResult(result))
  })

  const handleOrganizeEntries = () => runAction('organize-entries', async () => {
    if (!workspaceSlug) return
    const result = await organizeMemoryEntries({ workspaceSlug })
    setEntryOrganizeResult(result)
    await refresh()
    toast.success(summarizeMemoryOrganizeEntriesResult(result))
  })

  const startIngestJob = async (sources: MemoryIngestSourceInput[]) => {
    if (!workspaceSlug) return
    setIngestResult(null)
    const job = await ingestMemorySources({
      workspaceSlug,
      sources,
    })
    setIngestJob(job)
    toast.success('已开始后台整理资料')
  }

  const handleIngestPastedText = () => runAction('ingest-text', async () => {
    if (!workspaceSlug) return
    const content = externalText.trim()
    if (!content) {
      toast.error('请先粘贴要整理的资料')
      return
    }
    await startIngestJob([{
      kind: 'pasted_text',
      title: '粘贴资料',
      content,
    }])
    setExternalText('')
  })

  const handleIngestWorkspaceFile = () => runAction('ingest-workspace-file', async () => {
    if (!workspaceSlug) return
    const path = workspaceFilePath.trim()
    if (!path) {
      toast.error('请填写工作区文件路径')
      return
    }
    await startIngestJob([{
      kind: 'workspace_file',
      path,
    }])
  })

  const handleIngestLocalFiles = () => runAction('ingest-local-files', async () => {
    if (!workspaceSlug) return
    const selection = await openFileDialog()
    if (selection.files.length === 0) return
    await startIngestJob(selection.files.map((file) => ({
      kind: 'local_file',
      path: file.sourcePath,
    })))
  })

  const handleIngestLocalFolder = () => runAction('ingest-local-folder', async () => {
    if (!workspaceSlug) return
    const selection = await openFolderDialog()
    if (!selection.path) return
    await startIngestJob([{
      kind: 'local_folder',
      path: selection.path,
    }])
  })

  const selectedMemoryEntry = React.useMemo(() => {
    if (!snapshot || !selectedMemoryId) return null
    return [...snapshot.workspaceEntries, ...snapshot.globalEntries]
      .find((entry) => entry.id === selectedMemoryId) ?? null
  }, [selectedMemoryId, snapshot])

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
          channels={channels}
          runtimeConfig={runtimeConfig}
          snapshot={snapshot}
          onCitationsMode={(mode) => void handleCitationsMode(mode)}
          onEmbeddingModel={(modelRef) => void handleEmbeddingModel(modelRef)}
          onOrganizeEntries={() => void handleOrganizeEntries()}
          onOrganizeHistory={() => void handleOrganizeHistory()}
          onIngestPastedText={() => void handleIngestPastedText()}
          onIngestLocalFiles={() => void handleIngestLocalFiles()}
          onIngestLocalFolder={() => void handleIngestLocalFolder()}
          onIngestWorkspaceFile={() => void handleIngestWorkspaceFile()}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
          onRerankModel={(modelRef) => void handleRerankModel(modelRef)}
          onSemanticMode={(mode) => void handleSemanticMode(mode)}
          onToggle={(groupId, enabled) => void handleTogglePolicyGroup(groupId, enabled)}
          externalText={externalText}
          ingestJob={ingestJob}
          ingestResult={ingestResult}
          entryOrganizeResult={entryOrganizeResult}
          organizeResult={organizeResult}
          workspaceSlug={workspaceSlug}
          workspaceFilePath={workspaceFilePath}
          onExternalTextChange={setExternalText}
          onWorkspaceFilePathChange={setWorkspaceFilePath}
        />
      )}

      {view === 'workspace' && (
        <MemoryCollectionPanel
          entries={snapshot?.workspaceEntries ?? []}
          busyAction={busyAction}
          detail={memoryDetail}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
          onInspectEntry={(entry) => void handleInspectMemoryEntry(entry)}
          onUpdateEntry={(entry, input) => void handleUpdateMemoryEntry(entry, input)}
          onDeleteEntry={(entry) => void handleDeleteMemoryEntry(entry)}
          onDirtyChange={setDetailDirty}
          selectedEntry={selectedMemoryEntry}
          selectedEntryId={selectedMemoryId}
          title="工作区"
        />
      )}

      {view === 'global' && (
        <MemoryCollectionPanel
          entries={snapshot?.globalEntries ?? []}
          busyAction={busyAction}
          detail={memoryDetail}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
          onInspectEntry={(entry) => void handleInspectMemoryEntry(entry)}
          onUpdateEntry={(entry, input) => void handleUpdateMemoryEntry(entry, input)}
          onDeleteEntry={(entry) => void handleDeleteMemoryEntry(entry)}
          onDirtyChange={setDetailDirty}
          selectedEntry={selectedMemoryEntry}
          selectedEntryId={selectedMemoryId}
          title="全局"
        />
      )}

      {view === 'pending' && (
        <PendingMemoryPanel
          busyAction={busyAction}
          items={snapshot?.pending ?? []}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
          onResolvePending={(item, action, candidateOverride) => void handleResolvePending(item, action, candidateOverride)}
        />
      )}
    </div>
  )
}

function OverviewPanel({
  busyAction,
  channels,
  runtimeConfig,
  snapshot,
  externalText,
  ingestJob,
  ingestResult,
  entryOrganizeResult,
  onCitationsMode,
  onEmbeddingModel,
  onExternalTextChange,
  onIngestPastedText,
  onIngestLocalFiles,
  onIngestLocalFolder,
  onIngestWorkspaceFile,
  onOpenFile,
  onOrganizeEntries,
  onOrganizeHistory,
  onRerankModel,
  onSemanticMode,
  onToggle,
  organizeResult,
  workspaceSlug,
  workspaceFilePath,
  onWorkspaceFilePathChange,
}: {
  busyAction: string | null
  channels: Channel[]
  runtimeConfig: MemoryRuntimeConfig | null
  snapshot: MemorySettingsSnapshot | null
  externalText: string
  ingestJob: MemoryIngestSourcesJob | null
  ingestResult: MemoryIngestSourcesResult | null
  entryOrganizeResult: MemoryOrganizeEntriesResult | null
  onCitationsMode: (mode: MemoryCitationsMode) => void
  onEmbeddingModel: (modelRef: string) => void
  onExternalTextChange: (value: string) => void
  onIngestPastedText: () => void
  onIngestLocalFiles: () => void
  onIngestLocalFolder: () => void
  onIngestWorkspaceFile: () => void
  onOpenFile: (path: string) => void
  onOrganizeEntries: () => void
  onOrganizeHistory: () => void
  onRerankModel: (modelRef: string) => void
  onSemanticMode: (mode: MemoryRuntimeConfig['retrieval']['semantic']) => void
  onToggle: (groupId: MemoryToolPolicyGroupId, enabled: boolean) => void
  organizeResult: MemoryOrganizeHistoryResult | null
  workspaceSlug: string | null
  workspaceFilePath: string
  onWorkspaceFilePathChange: (value: string) => void
}) {
  const metrics = buildMemoryOverviewMetrics(snapshot)
  const layerMetrics = buildMemoryLayerMetrics(snapshot)
  const embeddingOptions = React.useMemo(() => buildEmbeddingModelOptions(channels), [channels])
  const rerankOptions = React.useMemo(() => buildRerankModelOptions(channels), [channels])
  const ingestRunning = ingestJob?.status === 'running'
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

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {layerMetrics.map((metric) => (
          <div key={metric.label} className="rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
            <div className="text-[12px] font-medium text-[var(--text-3)]">{metric.label}</div>
            <div className="mt-1 text-[17px] font-semibold text-[var(--text-1)]">{metric.value}</div>
            <div className="mt-1 text-[11px] leading-4 text-[var(--text-3)]">{metric.desc}</div>
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

      <div className="mt-4 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
              <SearchCheck size={15} />
              语义召回
            </div>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
              {snapshot?.retrieval.semantic.message ?? '基础召回可用'}
            </p>
          </div>
          <div className="flex rounded-[8px] border border-border bg-[var(--surface-1)] p-0.5">
            {(['auto', 'off'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                disabled={!runtimeConfig || busyAction !== null}
                onClick={() => onSemanticMode(mode)}
                className={cn(
                  'h-7 rounded-[6px] px-2 text-[12px] font-medium',
                  runtimeConfig?.retrieval.semantic === mode
                    ? 'bg-[var(--surface-2)] text-[var(--text-1)] shadow-sm'
                    : 'text-[var(--text-3)]',
                )}
              >
                {mode === 'auto' ? '自动' : '关闭'}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--text-3)]">Embedding 模型</span>
            <select
              className="mt-1 h-8 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)]"
              disabled={embeddingOptions.length === 0 || busyAction !== null}
              value={snapshot?.retrieval.semantic.embeddingModelRef ?? ''}
              onChange={(event) => onEmbeddingModel(event.target.value)}
            >
              <option value="">{embeddingOptions.length === 0 ? '未检测到 Embedding 模型' : '未配置'}</option>
              {embeddingOptions.map((option) => (
                <option key={option.modelRef} value={option.modelRef}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--text-3)]">Rerank 模型</span>
            <select
              className="mt-1 h-8 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)]"
              disabled={rerankOptions.length === 0 || busyAction !== null}
              value={runtimeConfig?.retrieval.rerankModelRef ?? ''}
              onChange={(event) => onRerankModel(event.target.value)}
            >
              <option value="">
                {snapshot?.retrieval.rerank.source === 'extraction' && snapshot.retrieval.rerank.modelRef
                  ? `复用提取模型：${snapshot.retrieval.rerank.modelRef}`
                  : '未启用'}
              </option>
              {rerankOptions.map((option) => (
                <option key={option.modelRef} value={option.modelRef}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        {snapshot?.retrieval.semantic.localOnnx ? (
          <div className="mt-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-[12px] font-semibold text-[var(--text-1)]">
                <Download size={14} />
                本地 ONNX
              </div>
              <span className={cn(
                'rounded-[6px] px-2 py-0.5 text-[11px] font-medium',
                localOnnxStatusTone(snapshot.retrieval.semantic.localOnnx.status) === 'good'
                  && 'bg-emerald-500/10 text-emerald-600',
                localOnnxStatusTone(snapshot.retrieval.semantic.localOnnx.status) === 'warn'
                  && 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
                localOnnxStatusTone(snapshot.retrieval.semantic.localOnnx.status) === 'neutral'
                  && 'bg-[var(--surface-2)] text-[var(--text-3)]',
              )}>
                {localOnnxStatusLabel(snapshot.retrieval.semantic.localOnnx.status)}
              </span>
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[var(--text-3)]">
              {summarizeLocalOnnxStatus(snapshot.retrieval.semantic.localOnnx)}
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
            <History size={15} />
            整理记忆
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            {entryOrganizeResult
              ? summarizeMemoryOrganizeEntriesResult(entryOrganizeResult)
              : '使用 LLM 分析已经写入的工作区和全局记忆数据，归并相似重复项；模型不可用时只做保守本地去重。'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busyAction !== null}
          onClick={onOrganizeEntries}
        >
          <RefreshCw size={14} className={busyAction === 'organize-entries' ? 'animate-spin' : undefined} />
          {busyAction === 'organize-entries' ? '整理中' : '整理记忆'}
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-start justify-between gap-3 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
            <Clock3 size={15} />
            从历史对话生成记忆
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            {organizeResult
              ? summarizeMemoryOrganizeResult(organizeResult)
              : '从当前工作区历史线程里提取稳定记忆；这是生成新记忆，不是整理已有记忆数据。'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busyAction !== null}
          onClick={onOrganizeHistory}
        >
          <RefreshCw size={14} className={busyAction === 'organize-history' ? 'animate-spin' : undefined} />
          {busyAction === 'organize-history' ? '生成中' : '生成记忆'}
        </Button>
      </div>

      <div className="mt-4 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
              <FileText size={15} />
              外部资料
            </div>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
              {ingestJob
                ? summarizeMemoryIngestSourcesJob(ingestJob)
                : ingestResult
                ? summarizeMemoryIngestSourcesResult(ingestResult)
                : '从粘贴文本、工作区文件、本地文件或文件夹提取稳定事实、偏好、决策、经验和状态。需要命中显式记忆句式，或配置提取模型做 LLM 分析；附件默认仍只是当前对话上下文。'}
            </p>
          </div>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="space-y-2">
            <textarea
              className="min-h-[92px] w-full resize-y rounded-[8px] border border-border bg-[var(--surface-1)] p-2 text-[12px] leading-5 text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]"
              placeholder="粘贴需要整理成记忆的资料"
              value={externalText}
              disabled={busyAction !== null || ingestRunning}
              onChange={(event) => onExternalTextChange(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null || ingestRunning || externalText.trim().length === 0}
              onClick={onIngestPastedText}
            >
              <RefreshCw size={14} className={busyAction === 'ingest-text' ? 'animate-spin' : undefined} />
              {busyAction === 'ingest-text' ? '整理中' : '整理粘贴文本'}
            </Button>
          </div>
          <div className="space-y-2">
            <div className="h-[176px] overflow-hidden rounded-[8px] border border-border bg-[var(--surface-1)]">
              <WorkspaceFileBrowser
                workspaceSlug={workspaceSlug ?? undefined}
                selectedPath={workspaceFilePath}
                onOpenFile={onWorkspaceFilePathChange}
                showHeader={false}
              />
            </div>
            <input
              className="h-9 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]"
              placeholder="工作区文件路径，例如 docs/project.md"
              value={workspaceFilePath}
              disabled={busyAction !== null || ingestRunning}
              onChange={(event) => onWorkspaceFilePathChange(event.target.value)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null || ingestRunning || workspaceFilePath.trim().length === 0}
              onClick={onIngestWorkspaceFile}
            >
              <RefreshCw size={14} className={busyAction === 'ingest-workspace-file' ? 'animate-spin' : undefined} />
              {busyAction === 'ingest-workspace-file' ? '整理中' : '整理工作区文件'}
            </Button>
            <div className="border-t border-border pt-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyAction !== null || ingestRunning}
                  onClick={onIngestLocalFiles}
                >
                  <RefreshCw size={14} className={busyAction === 'ingest-local-files' ? 'animate-spin' : undefined} />
                  {busyAction === 'ingest-local-files' ? '整理中' : '选择本地文件'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyAction !== null || ingestRunning}
                  onClick={onIngestLocalFolder}
                >
                  <RefreshCw size={14} className={busyAction === 'ingest-local-folder' ? 'animate-spin' : undefined} />
                  {busyAction === 'ingest-local-folder' ? '整理中' : '选择本地文件夹'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <details className="mt-4 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
        <summary className="cursor-pointer text-[13px] font-semibold text-[var(--text-1)]">
          原始文件
        </summary>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {(snapshot?.files ?? []).map((file) => (
            <FileRow key={file.path} file={file} onOpenFile={onOpenFile} />
          ))}
          {(snapshot?.files ?? []).length === 0 && <EmptyInline text="暂无原始文件" />}
        </div>
      </details>
    </section>
  )
}

function MemoryCollectionPanel({
  busyAction,
  detail,
  entries,
  onDeleteEntry,
  onDirtyChange,
  onOpenFile,
  onInspectEntry,
  onUpdateEntry,
  selectedEntry,
  selectedEntryId,
  title,
}: {
  busyAction: string | null
  detail: MemoryReadToolResult | null
  entries: MemorySettingsEntrySummary[]
  onDeleteEntry: (entry: MemorySettingsEntrySummary) => void
  onDirtyChange: (dirty: boolean) => void
  onOpenFile: (path: string) => void
  onInspectEntry: (entry: MemorySettingsEntrySummary) => void
  onUpdateEntry: (
    entry: MemorySettingsEntrySummary,
    input: {
      statement: string
      kind: MemoryKind
      confidence: MemorySettingsEntrySummary['confidence']
      tags: string[]
    },
  ) => void
  selectedEntry: MemorySettingsEntrySummary | null
  selectedEntryId: string | null
  title: string
}) {
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-[var(--text-1)]">
        {title === '全局' ? <Globe2 size={16} /> : <FileText size={16} />}
        {title}
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.3fr)]">
        <div className="space-y-2">
          {entries.map((entry) => (
            <EntryRow
              key={entry.id}
              busy={busyAction === `inspect-${entry.id}`}
              entry={entry}
              selected={selectedEntryId === entry.id}
              onInspectEntry={onInspectEntry}
            />
          ))}
          {entries.length === 0 && <EmptyInline text="暂无语义记忆" />}
        </div>
        <MemoryDetailPanel
          busyAction={busyAction}
          detail={detail}
          entry={selectedEntry}
          onDeleteEntry={onDeleteEntry}
          onDirtyChange={onDirtyChange}
          onOpenFile={onOpenFile}
          onUpdateEntry={onUpdateEntry}
        />
      </div>
    </section>
  )
}

function PendingMemoryPanel({
  busyAction,
  items,
  onOpenFile,
  onResolvePending,
}: {
  busyAction: string | null
  items: MemorySettingsPendingSummary[]
  onOpenFile: (path: string) => void
  onResolvePending: (
    item: MemorySettingsPendingSummary,
    action: 'accept' | 'reject' | 'resolve',
    candidateOverride?: MemoryResolvePendingInput['candidateOverride'],
  ) => void
}) {
  const openItems = items.filter((item) => item.status === 'open')
  return (
    <section className="rounded-[10px] border border-border bg-[var(--surface-1)] p-4 shadow-[0_1px_2px_rgba(20,24,40,0.02)]">
      <div className="space-y-2">
        {openItems.map((item) => (
          <PendingMemoryCard
            key={item.id}
            busyAction={busyAction}
            item={item}
            onOpenFile={onOpenFile}
            onResolvePending={onResolvePending}
          />
        ))}
        {openItems.length === 0 && <EmptyInline text="暂无待处理记忆" />}
      </div>
    </section>
  )
}

function PendingMemoryCard({
  busyAction,
  item,
  onOpenFile,
  onResolvePending,
}: {
  busyAction: string | null
  item: MemorySettingsPendingSummary
  onOpenFile: (path: string) => void
  onResolvePending: (
    item: MemorySettingsPendingSummary,
    action: 'accept' | 'reject' | 'resolve',
    candidateOverride?: MemoryResolvePendingInput['candidateOverride'],
  ) => void
}) {
  const [mergeMode, setMergeMode] = React.useState(false)
  const [statement, setStatement] = React.useState(item.candidate.statement)
  const [kind, setKind] = React.useState<MemoryKind>(item.candidate.kind)
  const [confidence, setConfidence] = React.useState<MemorySettingsEntrySummary['confidence']>(item.candidate.confidence)
  const [tagsText, setTagsText] = React.useState(item.candidate.tags.join(', '))

  React.useEffect(() => {
    setMergeMode(false)
    setStatement(item.candidate.statement)
    setKind(item.candidate.kind)
    setConfidence(item.candidate.confidence)
    setTagsText(item.candidate.tags.join(', '))
  }, [item])

  const tags = parseTags(tagsText)
  const override = (): NonNullable<MemoryResolvePendingInput['candidateOverride']> => ({
    statement: statement.trim(),
    kind,
    confidence,
    tags,
  })

  return (
    <div className="rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
        <StatusBadge tone={item.type === 'conflict' ? 'warn' : 'neutral'}>
          {MEMORY_PENDING_LABELS[item.type]}
        </StatusBadge>
        <span>{item.candidate.scope === 'global' ? '全局' : '工作区'}</span>
        <span>{formatDate(item.created)}</span>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-[8px] border border-border bg-[var(--surface-1)] p-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-[var(--text-3)]">
            候选记忆
            <StatusBadge tone="neutral">{MEMORY_KIND_LABELS[item.candidate.kind]}</StatusBadge>
            <StatusBadge tone="neutral">{MEMORY_CONFIDENCE_LABELS[item.candidate.confidence]}</StatusBadge>
          </div>
          {mergeMode ? (
            <div className="mt-2 space-y-2">
              <textarea
                className="min-h-[86px] w-full resize-y rounded-[8px] border border-border bg-[var(--surface-2)] p-2 text-[12px] leading-5 text-[var(--text-1)] outline-none focus:border-[var(--brand)]"
                value={statement}
                disabled={busyAction !== null}
                onChange={(event) => setStatement(event.target.value)}
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <select
                  className="h-8 rounded-[8px] border border-border bg-[var(--surface-2)] px-2 text-[12px] text-[var(--text-1)]"
                  value={kind}
                  disabled={busyAction !== null}
                  onChange={(event) => setKind(event.target.value as MemoryKind)}
                >
                  {EDITABLE_MEMORY_KINDS.map((memoryKind) => (
                    <option key={memoryKind} value={memoryKind}>{MEMORY_KIND_LABELS[memoryKind]}</option>
                  ))}
                </select>
                <select
                  className="h-8 rounded-[8px] border border-border bg-[var(--surface-2)] px-2 text-[12px] text-[var(--text-1)]"
                  value={confidence}
                  disabled={busyAction !== null}
                  onChange={(event) => setConfidence(event.target.value as MemorySettingsEntrySummary['confidence'])}
                >
                  {(['low', 'medium', 'high'] as const).map((value) => (
                    <option key={value} value={value}>{MEMORY_CONFIDENCE_LABELS[value]}</option>
                  ))}
                </select>
              </div>
              <input
                className="h-8 w-full rounded-[8px] border border-border bg-[var(--surface-2)] px-2 text-[12px] text-[var(--text-1)] outline-none focus:border-[var(--brand)]"
                value={tagsText}
                disabled={busyAction !== null}
                onChange={(event) => setTagsText(event.target.value)}
                placeholder="标签，用逗号分隔"
              />
            </div>
          ) : (
            <>
              <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-5 text-[var(--text-1)]">{item.candidate.statement}</p>
              {item.candidate.claim && (
                <p className="mt-2 break-words font-mono text-[12px] leading-5 text-[var(--text-3)]">{formatClaim(item.candidate.claim)}</p>
              )}
            </>
          )}
        </div>
        <div className="rounded-[8px] border border-border bg-[var(--surface-1)] p-3">
          <div className="text-[12px] font-semibold text-[var(--text-3)]">现有相关记忆</div>
          <div className="mt-2 space-y-2">
            {item.existingEntries.map((entry) => (
              <div key={entry.id} className="rounded-[8px] border border-border bg-[var(--surface-2)] p-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-3)]">
                  <span>{summarizeMemoryEntry(entry)}</span>
                  <span>{MEMORY_CONFIDENCE_LABELS[entry.confidence]}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--text-1)]">{entry.statement}</p>
                {entry.claim && (
                  <p className="mt-1 break-words font-mono text-[11px] leading-5 text-[var(--text-3)]">{formatClaim(entry.claim)}</p>
                )}
              </div>
            ))}
            {item.existingEntries.length === 0 && <EmptyInline text="没有关联旧记忆" />}
          </div>
        </div>
      </div>
      <p className="mt-3 text-[12px] leading-5 text-[var(--text-3)]">{item.reason}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {mergeMode ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null || statement.trim().length === 0}
              onClick={() => onResolvePending(item, 'accept', override())}
            >
              <Save size={14} />
              保存并接受
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => setMergeMode(false)}
            >
              <XCircle size={14} />
              取消
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onResolvePending(item, 'accept')}
            >
              <Check size={14} />
              接受候选
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => setMergeMode(true)}
            >
              <Pencil size={14} />
              手动合并
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onResolvePending(item, 'reject')}
            >
              <XCircle size={14} />
              保留现有
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onResolvePending(item, 'resolve')}
            >
              <Check size={14} />
              已处理
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onOpenFile(item.path)}
            >
              <FileText size={14} />
              源文件
            </Button>
          </>
        )}
      </div>
    </div>
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
  busy,
  entry,
  onInspectEntry,
  selected,
}: {
  busy: boolean
  entry: MemorySettingsEntrySummary
  onInspectEntry: (entry: MemorySettingsEntrySummary) => void
  selected: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onInspectEntry(entry)}
      className={cn(
        'block w-full rounded-[8px] border border-border bg-[var(--surface-2)] p-3 text-left hover:bg-[var(--surface-3)]',
        selected && 'border-[var(--brand)] bg-[var(--surface-3)]',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
        <span>{summarizeMemoryEntry(entry)}</span>
        {entry.pinned && <StatusBadge tone="good">置顶</StatusBadge>}
        {entry.status === 'suspected_stale' && <StatusBadge tone="warn">{MEMORY_STATUS_LABELS.suspected_stale}</StatusBadge>}
        {busy && <StatusBadge tone="neutral">读取中</StatusBadge>}
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

const EDITABLE_MEMORY_KINDS: MemoryKind[] = ['preference', 'fact', 'decision', 'lesson', 'summary']

function MemoryDetailPanel({
  busyAction,
  detail,
  entry,
  onDeleteEntry,
  onDirtyChange,
  onOpenFile,
  onUpdateEntry,
}: {
  busyAction: string | null
  detail: MemoryReadToolResult | null
  entry: MemorySettingsEntrySummary | null
  onDeleteEntry: (entry: MemorySettingsEntrySummary) => void
  onDirtyChange: (dirty: boolean) => void
  onOpenFile: (path: string) => void
  onUpdateEntry: (
    entry: MemorySettingsEntrySummary,
    input: {
      statement: string
      kind: MemoryKind
      confidence: MemorySettingsEntrySummary['confidence']
      tags: string[]
    },
  ) => void
}) {
  const rows = buildMemoryDetailRows(detail)
  const [statement, setStatement] = React.useState('')
  const [kind, setKind] = React.useState<MemoryKind>('fact')
  const [confidence, setConfidence] = React.useState<MemorySettingsEntrySummary['confidence']>('medium')
  const [tagsText, setTagsText] = React.useState('')
  const [editMode, setEditMode] = React.useState(false)

  React.useEffect(() => {
    setStatement(entry?.statement ?? detail?.text ?? '')
    setKind(entry?.kind ?? 'fact')
    setConfidence(entry?.confidence ?? 'medium')
    setTagsText(entry?.tags.join(', ') ?? '')
    setEditMode(false)
    onDirtyChange(false)
  }, [detail?.text, entry, onDirtyChange])

  const tags = parseTags(tagsText)
  const isDirty = entry ? (
    statement.trim() !== entry.statement
    || kind !== entry.kind
    || confidence !== entry.confidence
    || tags.join('|') !== entry.tags.join('|')
  ) : false
  React.useEffect(() => {
    onDirtyChange(isDirty)
  }, [isDirty, onDirtyChange])
  if (!detail) {
    return <EmptyInline text="选择一条记忆查看完整内容" />
  }
  const path = detail.path ?? detail.citation
  const resetDraft = () => {
    setStatement(entry?.statement ?? detail.text)
    setKind(entry?.kind ?? 'fact')
    setConfidence(entry?.confidence ?? 'medium')
    setTagsText(entry?.tags.join(', ') ?? '')
    setEditMode(false)
    onDirtyChange(false)
  }
  return (
    <div className="min-w-0 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[13px] font-semibold text-[var(--text-1)]">记忆详情</div>
        <div className="flex flex-wrap gap-2">
          {entry && (
            <>
              {editMode ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyAction !== null || !isDirty || statement.trim().length === 0}
                    onClick={() => {
                      onUpdateEntry(entry, {
                        statement: statement.trim(),
                        kind,
                        confidence,
                        tags,
                      })
                      setEditMode(false)
                      onDirtyChange(false)
                    }}
                  >
                    <Save size={14} />
                    保存
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={resetDraft}
                  >
                    <XCircle size={14} />
                    取消
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyAction !== null}
                  onClick={() => setEditMode(true)}
                >
                  <Pencil size={14} />
                  编辑
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => onDeleteEntry(entry)}
              >
                <Trash2 size={14} />
                删除
              </Button>
            </>
          )}
          {path && (
            <Button
              variant="outline"
              size="sm"
              disabled={busyAction !== null}
              onClick={() => onOpenFile(path)}
            >
              <FileText size={14} />
              打开源文件
            </Button>
          )}
        </div>
      </div>
      {entry && editMode && (
        <div className="mt-3 space-y-2">
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--text-3)]">内容</span>
            <textarea
              className="mt-1 min-h-[96px] w-full resize-y rounded-[8px] border border-border bg-[var(--surface-1)] p-2 text-[12px] leading-5 text-[var(--text-1)] outline-none focus:border-[var(--brand)]"
              value={statement}
              disabled={busyAction !== null}
              onChange={(event) => setStatement(event.target.value)}
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-[12px] font-medium text-[var(--text-3)]">类型</span>
              <select
                className="mt-1 h-8 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)]"
                value={kind}
                disabled={busyAction !== null}
                onChange={(event) => setKind(event.target.value as MemoryKind)}
              >
                {EDITABLE_MEMORY_KINDS.map((item) => (
                  <option key={item} value={item}>{MEMORY_KIND_LABELS[item]}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[12px] font-medium text-[var(--text-3)]">置信度</span>
              <select
                className="mt-1 h-8 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)]"
                value={confidence}
                disabled={busyAction !== null}
                onChange={(event) => setConfidence(event.target.value as MemorySettingsEntrySummary['confidence'])}
              >
                {(['low', 'medium', 'high'] as const).map((item) => (
                  <option key={item} value={item}>{MEMORY_CONFIDENCE_LABELS[item]}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--text-3)]">标签</span>
            <input
              className="mt-1 h-8 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)] outline-none focus:border-[var(--brand)]"
              value={tagsText}
              disabled={busyAction !== null}
              onChange={(event) => setTagsText(event.target.value)}
              placeholder="用逗号分隔"
            />
          </label>
        </div>
      )}
      {rows.length > 0 && (
        <dl className="mt-3 grid gap-2 text-[12px]">
          {rows.map((row) => (
            <div key={row.label} className="grid gap-1 sm:grid-cols-[72px_minmax(0,1fr)]">
              <dt className="text-[var(--text-3)]">{row.label}</dt>
              <dd className="min-w-0 break-words font-mono text-[var(--text-1)]">{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!entry && (
        <pre className="mt-3 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-[var(--surface-1)] p-3 text-[12px] leading-5 text-[var(--text-1)]">
          {detail.text}
        </pre>
      )}
      {entry && !editMode && (
        <pre className="mt-3 max-h-[360px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] border border-border bg-[var(--surface-1)] p-3 text-[12px] leading-5 text-[var(--text-1)]">
          {entry.statement}
        </pre>
      )}
    </div>
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

function parseTags(value: string): string[] {
  return Array.from(new Set(value
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)))
}

function formatClaim(claim: NonNullable<MemorySettingsEntrySummary['claim']>): string {
  return `${claim.subject}.${claim.predicate} = ${claim.object}`
}

function memorySettingsErrorMessage(error: unknown): string {
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''
  return detail ? `读取记忆设置失败：${detail}` : '读取记忆设置失败'
}
