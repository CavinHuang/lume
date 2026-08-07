import * as React from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  Download,
  FileText,
  History,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from 'lucide-react'
import { useAtomValue } from 'jotai'
import { toast } from 'sonner'
import type {
  MemoryActivation,
  MemoryCitationsMode,
  MemoryIngestSourceInput,
  MemoryIngestSourcesJob,
  MemoryIngestSourcesResult,
  MemoryDiagnosticsSnapshot,
  MemoryKind,
  MemoryOrganizeJob,
  MemoryOrganizeEntriesResult,
  MemoryOrganizeHistoryResult,
  MemoryReadToolResult,
  MemoryResolvePendingInput,
  MemoryRuntimeConfig,
  MemorySettingsEntrySummary,
  MemorySettingsFileSummary,
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
  PersonaGetResult,
} from '@lume/shared'
import { DEFAULT_MEMORY_ACTIVATION } from '@lume/shared'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  memoryCenterDeepLinkAtom,
  memoryCenterVersionAtom,
} from '@/atoms'
import {
  getMemoryRuntimeConfig,
  cancelMemoryJob,
  retryMemoryJob,
  getMemoryIngestJob,
  getMemoryOrganizeJob,
  getMemorySettingsSnapshot,
  getMemoryDiagnosticsSnapshot,
  ingestMemorySources,
  openFileDialog,
  openFolderDialog,
  openMemorySource,
  organizeMemoryEntries,
  organizeMemoryHistory,
  readMemory,
  reloadLocalOnnxEmbedding,
  rememberMemory,
  deleteMemoryEntry,
  resolveMemoryPending,
  updateMemoryEntry,
  undoMemoryMutation,
  updateMemoryRuntimeConfig,
  getPersona,
  correctPersona,
  regeneratePersona,
} from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import {
  MEMORY_CITATION_MODE_LABELS,
  MEMORY_CONFIDENCE_LABELS,
  MEMORY_FILE_KIND_LABELS,
  MEMORY_PENDING_LABELS,
  MEMORY_SETTINGS_VIEWS,
  MEMORY_STATUS_LABELS,
  MEMORY_TOOL_POLICY_GROUPS,
  MEMORY_USER_CATEGORY_META,
  applyMemoryIngestTargetScope,
  buildMemoryIngestItemRows,
  buildMemoryLayerMetrics,
  buildMemoryDetailRows,
  buildMemoryOverviewMetrics,
  filterMemoryEntriesByUserCategory,
  isMemoryToolGroupEnabled,
  localOnnxStatusLabel,
  localOnnxStatusTone,
  memoryEntryLayerLabel,
  memoryPendingCandidateLayerLabel,
  pendingNotice,
  setMemoryToolGroupEnabled,
  summarizeLocalOnnxStatus,
  summarizeMemoryExtractionStatus,
  summarizeMemoryIngestSourcesJob,
  summarizeMemoryOrganizeJob,
  summarizeMemoryOrganizeEntriesResult,
  summarizeMemoryOrganizeResult,
  summarizeMemoryIngestSourcesResult,
  summarizeMemoryEntry,
  type MemorySettingsView,
  type MemoryToolPolicyGroupId,
  type MemoryUserCategory,
  type MemoryIngestTargetScopeMode,
} from './memory-settings-state'

import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
function pollOrganizeJob(input: {
  jobId: string
  workspaceSlug: string
  setJob: React.Dispatch<React.SetStateAction<MemoryOrganizeJob | null>>
  refresh: () => Promise<void>
  onCompleted: (job: MemoryOrganizeJob) => void
}): () => void {
  let disposed = false
  let timer: number | undefined

  const poll = async () => {
    try {
      const nextJob = await getMemoryOrganizeJob({
        jobId: input.jobId,
        workspaceSlug: input.workspaceSlug,
      })
      if (disposed) return
      input.setJob(nextJob)
      if (nextJob.status === 'running') {
        timer = window.setTimeout(poll, 1200)
        return
      }
      if (nextJob.status === 'completed') {
        input.onCompleted(nextJob)
        await input.refresh()
        return
      }
      toast.error(summarizeMemoryOrganizeJob(nextJob))
    } catch (error) {
      if (!disposed) {
        const message = memorySettingsErrorMessage(error)
        input.setJob((current) => current?.jobId === input.jobId
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
}

function isUserMemoryCategory(view: MemorySettingsView): view is MemoryUserCategory {
  return view === 'recent' || view === 'about' || view === 'workspace' || view === 'all'
}

/**
 * Persona 卡片：展示 Lume 基于记忆自动生成的用户画像（persona.md）。
 * - 状态：已生成（emerald + updatedAt）/ 未生成（muted 提示）。
 * - 预览：可展开的 Markdown 文本。
 * - 纠正：写入底层高置信记忆，再重建派生画像。
 * - 重新生成：regeneratePersona + toast + loading。
 * 自包含组件；通过 workspaceSlug 拉取/写入。
 */
export function PersonaCard({ workspaceSlug }: { workspaceSlug: string }) {
  const [persona, setPersona] = React.useState<PersonaGetResult | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [busy, setBusy] = React.useState<'correct' | 'regenerate' | null>(null)
  const [correction, setCorrection] = React.useState('')
  const [expanded, setExpanded] = React.useState(false)

  const refreshPersona = React.useCallback(async () => {
    if (!workspaceSlug) {
      setPersona(null)
      setLoading(false)
      return
    }
    try {
      const result = await getPersona(workspaceSlug)
      setPersona(result)
    } catch (error) {
      console.error('[PersonaCard] getPersona FAILED:', error)
      toast.error(memorySettingsErrorMessage(error, '读取用户画像失败'))
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug])

  React.useEffect(() => {
    void refreshPersona()
  }, [refreshPersona])

  const isGenerated = Boolean(persona?.updatedAt && persona.markdown.trim().length > 0)
  const handleCorrection = async () => {
    if (!workspaceSlug) return
    if (correction.trim().length === 0) {
      toast.error('请说明需要纠正的内容')
      return
    }
    setBusy('correct')
    try {
      await correctPersona({ workspaceSlug, correction: correction.trim() })
      await refreshPersona()
      setCorrection('')
      toast.success('已修正底层记忆并更新用户画像')
    } catch (error) {
      console.error('[PersonaCard] correctPersona FAILED:', error)
      toast.error(memorySettingsErrorMessage(error, '纠正用户画像失败'))
    } finally {
      setBusy(null)
    }
  }

  const handleRegenerate = async () => {
    if (!workspaceSlug) return
    setBusy('regenerate')
    const toastId = toast.loading('正在重新生成用户画像...')
    try {
      await regeneratePersona(workspaceSlug)
      await refreshPersona()
      toast.success('用户画像已重新生成', { id: toastId })
    } catch (error) {
      console.error('[PersonaCard] regeneratePersona FAILED:', error)
      toast.error(memorySettingsErrorMessage(error, '重新生成用户画像失败'), { id: toastId })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="lume-panel p-4" data-persona-card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-1)]">
            <Sparkles size={16} />
            用户画像
            {loading ? (
              <StatusBadge tone="neutral">读取中</StatusBadge>
            ) : isGenerated ? (
              <StatusBadge tone="good">已生成</StatusBadge>
            ) : (
              <StatusBadge tone="neutral">未生成</StatusBadge>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            {isGenerated
              ? `Lume 基于全局记忆自动生成的稳定画像；最近更新于 ${formatDate(persona?.updatedAt)}。纠正会更新底层记忆。`
              : 'Lume 会基于你的长期记忆自动生成用户画像；也可点击「重新生成」立即创建。'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || loading}
            onClick={() => void handleRegenerate()}
          >
            <RefreshCw size={14} className={busy === 'regenerate' ? 'animate-spin' : undefined} />
            {busy === 'regenerate' ? '生成中' : '重新生成'}
          </Button>
        </div>
      </div>

      {isGenerated && (
          <div className="rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
            <pre
              className={cn(
                'whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--text-1)] overflow-auto',
                expanded ? 'max-h-[480px]' : 'max-h-[120px]',
              )}
            >
              {persona?.markdown}
            </pre>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 h-7 px-2 text-[12px]"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? '收起' : '展开'}
            </Button>
          </div>
      )}
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input
          value={correction}
          disabled={busy !== null}
          onChange={(event) => setCorrection(event.target.value)}
          placeholder="纠正画像，例如：我现在更喜欢简洁的中文回复"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null || correction.trim().length === 0}
          onClick={() => void handleCorrection()}
        >
          <Pencil size={14} />
          {busy === 'correct' ? '纠正中' : '纠正画像'}
        </Button>
      </div>
    </section>
  )
}

export function MemorySettings() {
  return <MemorySettingsSurface surface="advanced" />
}

export function MemoryCenterContent() {
  return <MemorySettingsSurface surface="center" />
}

export function MemoryActivityContent() {
  return <MemorySettingsSurface surface="activity" />
}

function MemorySettingsSurface({ surface }: { surface: 'advanced' | 'center' | 'activity' }) {
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspace = React.useMemo(
    () => workspaces.find((item) => item.id === currentWorkspaceId) ?? workspaces[0] ?? null,
    [currentWorkspaceId, workspaces],
  )
  const workspaceSlug = workspace?.slug ?? null
  const [view, setView] = React.useState<MemorySettingsView>('recent')
  const [runtimeConfig, setRuntimeConfig] = React.useState<MemoryRuntimeConfig | null>(null)
  const [snapshot, setSnapshot] = React.useState<MemorySettingsSnapshot | null>(null)
  const [diagnostics, setDiagnostics] = React.useState<MemoryDiagnosticsSnapshot | null>(null)
  const memoryCenterVersion = useAtomValue(memoryCenterVersionAtom)
  const deepLink = useAtomValue(memoryCenterDeepLinkAtom)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [entryOrganizeJob, setEntryOrganizeJob] = React.useState<MemoryOrganizeJob | null>(null)
  const [historyOrganizeJob, setHistoryOrganizeJob] = React.useState<MemoryOrganizeJob | null>(null)
  const [entryOrganizeResult, setEntryOrganizeResult] = React.useState<MemoryOrganizeEntriesResult | null>(null)
  const [organizeResult, setOrganizeResult] = React.useState<MemoryOrganizeHistoryResult | null>(null)
  const [ingestJob, setIngestJob] = React.useState<MemoryIngestSourcesJob | null>(null)
  const [ingestResult, setIngestResult] = React.useState<MemoryIngestSourcesResult | null>(null)
  const [memoryDetail, setMemoryDetail] = React.useState<MemoryReadToolResult | null>(null)
  const [selectedMemoryId, setSelectedMemoryId] = React.useState<string | null>(null)
  const [detailDirty, setDetailDirty] = React.useState(false)
  const [manualMemoryText, setManualMemoryText] = React.useState('')
  const [ingestTargetScope, setIngestTargetScope] = React.useState<MemoryIngestTargetScopeMode>('auto')
  const [externalText, setExternalText] = React.useState('')
  const [workspaceFilePath, setWorkspaceFilePath] = React.useState('')

  const refresh = React.useCallback(async () => {
    if (!workspaceSlug) return
    try {
      if (surface === 'advanced') {
        const [nextConfig, nextDiagnostics] = await Promise.all([
          getMemoryRuntimeConfig(),
          getMemoryDiagnosticsSnapshot(workspaceSlug),
        ])
        setRuntimeConfig(nextConfig)
        setDiagnostics(nextDiagnostics)
      } else {
        setSnapshot(await getMemorySettingsSnapshot(workspaceSlug))
      }
    } catch (error) {
      console.error('[MemorySettings] refresh FAILED:', error)
      toast.error(memorySettingsErrorMessage(error))
    }
  }, [surface, workspaceSlug])

  React.useEffect(() => {
    void refresh()
  }, [refresh, memoryCenterVersion])

  React.useEffect(() => {
    if (surface !== 'center') return
    if (deepLink.libraryView) setView(deepLink.libraryView)
    if (deepLink.memoryId) setSelectedMemoryId(deepLink.memoryId)
  }, [deepLink.libraryView, deepLink.memoryId, surface])

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
        const nextJob = await getMemoryIngestJob({
          jobId: ingestJob.jobId,
          workspaceSlug: ingestJob.workspaceSlug,
        })
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

  React.useEffect(() => {
    if (!entryOrganizeJob || entryOrganizeJob.status !== 'running') return undefined
    return pollOrganizeJob({
      jobId: entryOrganizeJob.jobId,
      workspaceSlug: entryOrganizeJob.workspaceSlug,
      setJob: setEntryOrganizeJob,
      refresh,
      onCompleted: (job) => {
        if (job.kind !== 'entries' || !job.result) return
        const result = job.result as MemoryOrganizeEntriesResult
        setEntryOrganizeResult(result)
        toast.success(summarizeMemoryOrganizeEntriesResult(result))
      },
    })
  }, [entryOrganizeJob?.jobId, entryOrganizeJob?.status, refresh])

  React.useEffect(() => {
    if (!historyOrganizeJob || historyOrganizeJob.status !== 'running') return undefined
    return pollOrganizeJob({
      jobId: historyOrganizeJob.jobId,
      workspaceSlug: historyOrganizeJob.workspaceSlug,
      setJob: setHistoryOrganizeJob,
      refresh,
      onCompleted: (job) => {
        if (job.kind !== 'history' || !job.result) return
        const result = job.result as MemoryOrganizeHistoryResult
        setOrganizeResult(result)
        toast.success(summarizeMemoryOrganizeResult(result))
      },
    })
  }, [historyOrganizeJob?.jobId, historyOrganizeJob?.status, refresh])

  const runAction = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name)
    try {
      await action()
    } catch (error) {
      console.error(`[MemorySettings] ${name} FAILED:`, error)
      toast.error(memorySettingsErrorMessage(error, '记忆操作失败'))
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
      pinned?: boolean
      validTo?: string | null
      targetScope?: 'global' | 'workspace'
      explicitCorrection?: boolean
    },
  ) => runAction(`update-${entry.id}`, async () => {
    if (!workspaceSlug) return
    const result = await updateMemoryEntry({
      workspaceSlug,
      scope: entry.scope,
      id: entry.id,
      statement: input.statement,
      kind: input.kind,
      confidence: input.confidence,
      tags: input.tags,
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.validTo !== undefined ? { validTo: input.validTo } : {}),
      ...(input.targetScope ? { targetScope: input.targetScope } : {}),
      explicitCorrection: true,
    })
    const detail = await readMemory({ workspaceSlug, id: entry.id })
    setMemoryDetail(detail)
    setDetailDirty(false)
    await refresh()
    toast.success('记忆已更新', result.mutationId && result.undoable ? {
      action: {
        label: '撤销',
        onClick: () => void undoMemoryMutation({ workspaceSlug, mutationId: result.mutationId! }).then(() => refresh()),
      },
    } : undefined)
  })

  const handleToggleActivation = (
    entry: MemorySettingsEntrySummary,
    activation: MemoryActivation,
  ) => runAction(`activation-${entry.id}`, async () => {
    if (!workspaceSlug) return
    await updateMemoryEntry({
      workspaceSlug,
      scope: entry.scope,
      id: entry.id,
      activation,
    })
    await refresh()
    toast.success('激活用途已更新')
  })

  const handleDeleteMemoryEntry = (entry: MemorySettingsEntrySummary) => runAction(`delete-${entry.id}`, async () => {
    if (!workspaceSlug) return
    const toastId = toast.loading('正在删除记忆...')
    try {
      const result = await deleteMemoryEntry({
        workspaceSlug,
        scope: entry.scope,
        id: entry.id,
      })
      setSelectedMemoryId(null)
      setMemoryDetail(null)
      setDetailDirty(false)
      await refresh()
      toast.success('记忆已归档，可通过撤销恢复', {
        id: toastId,
        action: result.mutationId && result.undoable ? {
          label: '撤销',
          onClick: () => void undoMemoryMutation({ workspaceSlug, mutationId: result.mutationId! }).then(() => refresh()),
        } : undefined,
      })
    } catch (error) {
      console.error('[MemorySettings] delete entry FAILED:', error)
      toast.error(memorySettingsErrorMessage(error, '删除记忆失败'), { id: toastId })
    }
  })

  const handleAddManualMemory = (category: MemoryUserCategory) => runAction(`manual-${category}`, async () => {
    if (!workspaceSlug) return
    const content = manualMemoryText.trim()
    if (!content) {
      toast.error('请先写一条要记住的内容')
      return
    }
    await rememberMemory({
      workspaceSlug,
      scope: category === 'workspace' ? 'workspace' : category === 'about' ? 'global' : 'auto',
      content,
      confidence: 0.85,
    })
    setManualMemoryText('')
    await refresh()
    toast.success('记忆已添加')
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
    const toastId = toast.loading(`${actionLabel}中...`)
    try {
      await resolveMemoryPending({
        workspaceSlug,
        path: item.path,
        action,
        candidateOverride,
      })
      await refresh()
      toast.success(`${actionLabel}成功`, { id: toastId })
    } catch (error) {
      console.error('[MemorySettings] resolve pending FAILED:', error)
      toast.error(memorySettingsErrorMessage(error, `${actionLabel}失败`), { id: toastId })
    }
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

  const handleAutomationToggle = (
    key: 'proactiveWrite' | 'backgroundExtraction' | 'autoDream',
    enabled: boolean,
  ) => runAction(`automation-${key}`, async () => {
    const nextConfig = await updateMemoryRuntimeConfig({ [key]: enabled })
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

  const handleReloadLocalOnnx = () => runAction('reload-local-onnx', async () => {
    await reloadLocalOnnxEmbedding()
    await refresh()
  })

  const handleCancelJob = (jobId: string) => runAction(`cancel-job-${jobId}`, async () => {
    if (!workspaceSlug) return
    await cancelMemoryJob({ workspaceSlug, jobId })
    setEntryOrganizeJob((job) => job?.jobId === jobId ? { ...job, status: 'cancelled', completedAt: Date.now() } : job)
    setHistoryOrganizeJob((job) => job?.jobId === jobId ? { ...job, status: 'cancelled', completedAt: Date.now() } : job)
    setIngestJob((job) => job?.jobId === jobId ? { ...job, status: 'cancelled', completedAt: Date.now() } : job)
    await refresh()
  })

  const handleRetryJob = (jobId: string) => runAction(`retry-job-${jobId}`, async () => {
    if (!workspaceSlug) return
    const job = await retryMemoryJob({ workspaceSlug, jobId })
    setIngestJob(job)
    toast.success('已重新开始资料整理')
  })

  const handleOrganizeHistory = () => runAction('organize-history', async () => {
    if (!workspaceSlug) return
    setOrganizeResult(null)
    const job = await organizeMemoryHistory({ workspaceSlug, limit: 200 })
    setHistoryOrganizeJob(job)
    toast.success('已开始后台生成记忆')
  })

  const handleOrganizeEntries = () => runAction('organize-entries', async () => {
    if (!workspaceSlug) return
    setEntryOrganizeResult(null)
    const job = await organizeMemoryEntries({ workspaceSlug })
    setEntryOrganizeJob(job)
    toast.success('已开始后台整理记忆')
  })

  const startIngestJob = async (sources: MemoryIngestSourceInput[]) => {
    if (!workspaceSlug) return
    setIngestResult(null)
    const job = await ingestMemorySources({
      workspaceSlug,
      sources: applyMemoryIngestTargetScope(sources, ingestTargetScope),
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
  const userMemoryEntries = React.useMemo(
    () => {
      const entries = [...(snapshot?.globalEntries ?? []), ...(snapshot?.workspaceEntries ?? [])]
      const recentIds = (snapshot?.activity ?? []).flatMap((receipt) => receipt.memoryIds)
      const rank = new Map(recentIds.map((id, index) => [id, index]))
      return entries.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    },
    [snapshot?.activity, snapshot?.globalEntries, snapshot?.workspaceEntries],
  )
  const userCategory = isUserMemoryCategory(view) ? view : null

  if (!workspaceSlug) {
    return (
      <EmptyPanel title="暂无工作区" desc="创建或选择一个工作区后即可管理记忆。" />
    )
  }

  if (surface === 'advanced') {
    return (
      <OverviewPanel
        advancedOnly
        busyAction={busyAction}
        runtimeConfig={runtimeConfig}
        snapshot={diagnostics}
        onCitationsMode={(mode) => void handleCitationsMode(mode)}
        onAutomationToggle={(key, enabled) => void handleAutomationToggle(key, enabled)}
        onCancelJob={(jobId) => void handleCancelJob(jobId)}
        onRetryJob={(jobId) => void handleRetryJob(jobId)}
        onOrganizeEntries={() => void handleOrganizeEntries()}
        onOrganizeHistory={() => void handleOrganizeHistory()}
        onIngestPastedText={() => void handleIngestPastedText()}
        onIngestLocalFiles={() => void handleIngestLocalFiles()}
        onIngestLocalFolder={() => void handleIngestLocalFolder()}
        onIngestWorkspaceFile={() => void handleIngestWorkspaceFile()}
        onOpenFile={(path) => void handleOpenMemoryFile(path)}
        onSemanticMode={(mode) => void handleSemanticMode(mode)}
        onReloadLocalOnnx={() => void handleReloadLocalOnnx()}
        onToggle={(groupId, enabled) => void handleTogglePolicyGroup(groupId, enabled)}
        externalText={externalText}
        ingestJob={ingestJob}
        ingestResult={ingestResult}
        ingestTargetScope={ingestTargetScope}
        entryOrganizeJob={entryOrganizeJob}
        entryOrganizeResult={entryOrganizeResult}
        historyOrganizeJob={historyOrganizeJob}
        organizeResult={organizeResult}
        workspaceFilePath={workspaceFilePath}
        onExternalTextChange={setExternalText}
        onIngestTargetScope={setIngestTargetScope}
        onWorkspaceFilePathChange={setWorkspaceFilePath}
      />
    )
  }

  if (surface === 'activity') {
    return (
      <div className="space-y-4">
        <section className="lume-panel p-4">
          <div className="text-[14px] font-semibold text-[var(--text-1)]">记忆变更</div>
          <div className="mt-3 space-y-2">
            {(snapshot?.activity ?? []).map((item) => (
              <article key={item.mutationId} className="lume-subpanel p-3">
                <div className="text-[13px] font-medium text-[var(--text-1)]">{item.summary}</div>
                <div className="mt-1 text-[11px] text-[var(--text-3)]">
                  {item.scope === 'global' ? '全局' : '工作区'} · {item.actor}
                </div>
              </article>
            ))}
            {(snapshot?.activity ?? []).length === 0 && <EmptyInline text="暂无记忆活动" />}
          </div>
        </section>
        <section className="lume-panel p-4">
          <div className="text-[14px] font-semibold text-[var(--text-1)]">后台任务</div>
          <div className="mt-3 space-y-2">
            {(snapshot?.jobs ?? []).map((job) => (
              <article key={job.jobId} className="lume-subpanel flex items-center justify-between gap-3 p-3">
                <span className="text-[13px] text-[var(--text-1)]">{job.kind}</span>
                <span className="text-[11px] text-[var(--text-3)]">{job.status}</span>
              </article>
            ))}
            {(snapshot?.jobs ?? []).length === 0 && <EmptyInline text="暂无后台任务" />}
          </div>
        </section>
        <OverviewPanel
          operationsOnly
          busyAction={busyAction}
          runtimeConfig={runtimeConfig}
          snapshot={snapshot}
          onCitationsMode={(mode) => void handleCitationsMode(mode)}
          onAutomationToggle={(key, enabled) => void handleAutomationToggle(key, enabled)}
          onCancelJob={(jobId) => void handleCancelJob(jobId)}
          onRetryJob={(jobId) => void handleRetryJob(jobId)}
          onOrganizeEntries={() => void handleOrganizeEntries()}
          onOrganizeHistory={() => void handleOrganizeHistory()}
          onIngestPastedText={() => void handleIngestPastedText()}
          onIngestLocalFiles={() => void handleIngestLocalFiles()}
          onIngestLocalFolder={() => void handleIngestLocalFolder()}
          onIngestWorkspaceFile={() => void handleIngestWorkspaceFile()}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
          onSemanticMode={(mode) => void handleSemanticMode(mode)}
          onReloadLocalOnnx={() => void handleReloadLocalOnnx()}
          onToggle={(groupId, enabled) => void handleTogglePolicyGroup(groupId, enabled)}
          externalText={externalText}
          ingestJob={ingestJob}
          ingestResult={ingestResult}
          ingestTargetScope={ingestTargetScope}
          entryOrganizeJob={entryOrganizeJob}
          entryOrganizeResult={entryOrganizeResult}
          historyOrganizeJob={historyOrganizeJob}
          organizeResult={organizeResult}
          workspaceFilePath={workspaceFilePath}
          onExternalTextChange={setExternalText}
          onIngestTargetScope={setIngestTargetScope}
          onWorkspaceFilePathChange={setWorkspaceFilePath}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <section className="lume-panel p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
              <FileText size={15} />
              {workspace.name} · Memory V2
            </div>
            <h3 className="mt-2 text-[17px] font-semibold leading-6 text-[var(--text-1)]">用户记忆</h3>
            <p className="mt-1 max-w-2xl text-[13px] leading-5 text-[var(--text-3)]">
              Lume 会在对话中自动提取长期有用的信息；你也可以在这里手动添加、修改或删除。
            </p>
          </div>
          <div className="flex items-center gap-2">
            {snapshot?.counts.pending.total ? (
              <Button
                variant="ghost"
                type="button"
                onClick={() => setView('pending')}
                className="inline-flex h-8 items-center gap-1.5 rounded-[8px] border border-[color:color-mix(in_oklab,var(--lume-warning)_34%,var(--border))] bg-[color:color-mix(in_oklab,var(--lume-warning)_8%,var(--surface-1))] px-2 text-[12px] font-medium text-[var(--lume-warning)] transition-colors hover:bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))]"
              >
                <AlertTriangle size={14} />
                {pendingNotice(snapshot.counts.pending)}
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={busyAction !== null}>
              <RefreshCw size={14} />
              刷新
            </Button>
          </div>
        </div>
      </section>

      <div className="lume-segmented grid overflow-hidden sm:grid-cols-4">
        {MEMORY_SETTINGS_VIEWS.map((item) => (
          <Button
                variant="ghost"
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={cn(
              'lume-segmented-item min-h-10 text-center font-semibold',
              view === item.id
                ? 'lume-segmented-item-active'
                : '',
            )}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {userCategory && (
        <UserMemoryPanel
          busyAction={busyAction}
          category={userCategory}
          detail={memoryDetail}
          entries={userMemoryEntries}
          manualMemoryText={manualMemoryText}
          onManualMemoryTextChange={setManualMemoryText}
          onAddManualMemory={(category) => void handleAddManualMemory(category)}
          onOpenFile={(path) => void handleOpenMemoryFile(path)}
          onInspectEntry={(entry) => void handleInspectMemoryEntry(entry)}
          onUpdateEntry={(entry, input) => void handleUpdateMemoryEntry(entry, input)}
          onToggleActivation={(entry, activation) => void handleToggleActivation(entry, activation)}
          onDeleteEntry={(entry) => void handleDeleteMemoryEntry(entry)}
          onDirtyChange={setDetailDirty}
          selectedEntry={selectedMemoryEntry}
          selectedEntryId={selectedMemoryId}
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
  advancedOnly,
  operationsOnly,
  busyAction,
  runtimeConfig,
  snapshot,
  externalText,
  ingestJob,
  ingestResult,
  ingestTargetScope,
  entryOrganizeJob,
  entryOrganizeResult,
  historyOrganizeJob,
  onCitationsMode,
  onAutomationToggle,
  onCancelJob,
  onRetryJob,
  onExternalTextChange,
  onIngestTargetScope,
  onIngestPastedText,
  onIngestLocalFiles,
  onIngestLocalFolder,
  onIngestWorkspaceFile,
  onOpenFile,
  onOrganizeEntries,
  onOrganizeHistory,
  onSemanticMode,
  onReloadLocalOnnx,
  onToggle,
  organizeResult,
  workspaceFilePath,
  onWorkspaceFilePathChange,
}: {
  advancedOnly?: boolean
  operationsOnly?: boolean
  busyAction: string | null
  runtimeConfig: MemoryRuntimeConfig | null
  snapshot: MemorySettingsSnapshot | MemoryDiagnosticsSnapshot | null
  externalText: string
  ingestJob: MemoryIngestSourcesJob | null
  ingestResult: MemoryIngestSourcesResult | null
  ingestTargetScope: MemoryIngestTargetScopeMode
  entryOrganizeJob: MemoryOrganizeJob | null
  entryOrganizeResult: MemoryOrganizeEntriesResult | null
  historyOrganizeJob: MemoryOrganizeJob | null
  onCitationsMode: (mode: MemoryCitationsMode) => void
  onAutomationToggle: (
    key: 'proactiveWrite' | 'backgroundExtraction' | 'autoDream',
    enabled: boolean,
  ) => void
  onCancelJob: (jobId: string) => void
  onRetryJob: (jobId: string) => void
  onExternalTextChange: (value: string) => void
  onIngestTargetScope: (scope: MemoryIngestTargetScopeMode) => void
  onIngestPastedText: () => void
  onIngestLocalFiles: () => void
  onIngestLocalFolder: () => void
  onIngestWorkspaceFile: () => void
  onOpenFile: (path: string) => void
  onOrganizeEntries: () => void
  onOrganizeHistory: () => void
  onSemanticMode: (mode: MemoryRuntimeConfig['retrieval']['semantic']) => void
  onReloadLocalOnnx: () => void
  onToggle: (groupId: MemoryToolPolicyGroupId, enabled: boolean) => void
  organizeResult: MemoryOrganizeHistoryResult | null
  workspaceFilePath: string
  onWorkspaceFilePathChange: (value: string) => void
}) {
  const fullSnapshot = snapshot && 'counts' in snapshot ? snapshot : null
  const metrics = buildMemoryOverviewMetrics(fullSnapshot)
  const layerMetrics = buildMemoryLayerMetrics(fullSnapshot)
  const ingestItemRows = React.useMemo(() => buildMemoryIngestItemRows(ingestResult), [ingestResult])
  const ingestRunning = ingestJob?.status === 'running'
  const entryOrganizeRunning = entryOrganizeJob?.status === 'running'
  const historyOrganizeRunning = historyOrganizeJob?.status === 'running'
  const activeJobs = [entryOrganizeJob, historyOrganizeJob, ingestJob]
    .filter((job): job is MemoryOrganizeJob | MemoryIngestSourcesJob => job?.status === 'running')
  return (
    <details className="lume-panel group p-4" open={advancedOnly || operationsOnly || undefined}>
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold text-[var(--text-1)]">
              {operationsOnly ? '整理与导入' : '高级设置'}
            </div>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
              {operationsOnly
                ? '整理现有记忆、从历史对话生成记忆，或导入外部资料。'
                : advancedOnly
                ? '管理主动记忆、后台整理、召回与迁移诊断。'
                : '模型、语义召回、整理记忆和外部资料导入。默认配置已经可用，通常不需要调整。'}
            </p>
          </div>
          <span className="lume-subpanel px-2 py-1 text-[12px] font-medium text-[var(--text-3)]">
            <span className="group-open:hidden">展开</span>
            <span className="hidden group-open:inline">收起</span>
          </span>
        </div>
      </summary>
      {!advancedOnly && !operationsOnly && <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        {metrics.map((metric) => (
          <div key={metric.label} className="lume-subpanel p-3">
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
      </div>}

      {activeJobs.length > 0 && (
        <div className="lume-subpanel mt-4 space-y-2 p-3">
          <div className="text-[12px] font-semibold text-[var(--text-3)]">后台任务</div>
          {activeJobs.map((job) => (
            <div key={job.jobId} className="flex items-center justify-between gap-3 text-[12px]">
              <span className="min-w-0 truncate text-[var(--text-2)]">
                {'kind' in job ? summarizeMemoryOrganizeJob(job) : summarizeMemoryIngestSourcesJob(job)}
              </span>
              <Button variant="outline" size="sm" onClick={() => onCancelJob(job.jobId)}>
                停止
              </Button>
            </div>
          ))}
        </div>
      )}

      {!advancedOnly && !operationsOnly && <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {layerMetrics.map((metric) => (
          <div key={metric.label} className="lume-subpanel p-3">
            <div className="text-[12px] font-medium text-[var(--text-3)]">{metric.label}</div>
            <div className="mt-1 text-[17px] font-semibold text-[var(--text-1)]">{metric.value}</div>
            <div className="mt-1 text-[11px] leading-4 text-[var(--text-3)]">{metric.desc}</div>
          </div>
        ))}
      </div>}

      {!operationsOnly && <>
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
                  : 'lume-subpanel',
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

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {([
          ['proactiveWrite', '主 Agent 主动记忆', '私聊中发现稳定信息时立即记住。'],
          ['backgroundExtraction', '后台自动提取', '回答完成后异步检查遗漏的稳定记忆。'],
          ['autoDream', 'AutoDream', '满足 24 小时和 5 个会话门槛后自动整理。'],
        ] as const).map(([key, label, desc]) => (
          <label key={key} className="lume-subpanel flex min-h-[84px] items-center justify-between gap-3 p-3">
            <span>
              <span className="text-[13px] font-semibold text-[var(--text-1)]">{label}</span>
              <span className="mt-1 block text-[12px] leading-5 text-[var(--text-3)]">{desc}</span>
            </span>
            <Switch
              checked={runtimeConfig?.[key] ?? true}
              disabled={!runtimeConfig || busyAction !== null}
              onCheckedChange={(enabled) => onAutomationToggle(key, enabled)}
            />
          </label>
        ))}
      </div>

      <div className="lume-subpanel mt-4 flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
          <ShieldCheck size={15} />
          回复下方引用
        </div>
        <div className="lume-segmented flex">
          {(['auto', 'on', 'off'] as const).map((mode) => (
            <Button
                variant="ghost"
              key={mode}
              type="button"
              disabled={!runtimeConfig || busyAction !== null}
              onClick={() => onCitationsMode(mode)}
              className={cn(
                'lume-segmented-item px-2 text-[12px]',
                runtimeConfig?.citations === mode
                  ? 'lume-segmented-item-active'
                  : '',
              )}
            >
              {MEMORY_CITATION_MODE_LABELS[mode]}
            </Button>
          ))}
        </div>
      </div>

      <div className="lume-subpanel mt-4 p-3">
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
          <div className="lume-segmented flex">
            {(['auto', 'off'] as const).map((mode) => (
              <Button
                variant="ghost"
                key={mode}
                type="button"
                disabled={!runtimeConfig || busyAction !== null}
                onClick={() => onSemanticMode(mode)}
                className={cn(
                  'lume-segmented-item px-2 text-[12px]',
                  runtimeConfig?.retrieval.semantic === mode
                    ? 'lume-segmented-item-active'
                    : '',
                )}
              >
                {mode === 'auto' ? '自动' : '关闭'}
              </Button>
            ))}
          </div>
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
            {(snapshot.retrieval.semantic.localOnnx.status === 'not_cached'
              || snapshot.retrieval.semantic.localOnnx.status === 'failed') && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                disabled={busyAction !== null}
                onClick={onReloadLocalOnnx}
              >
                <RefreshCw size={14} className={busyAction === 'reload-local-onnx' ? 'animate-spin' : undefined} />
                {busyAction === 'reload-local-onnx'
                  ? '加载中'
                  : snapshot.retrieval.semantic.localOnnx.status === 'not_cached'
                    ? '下载模型'
                    : '重新加载'}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      </>}

      {!advancedOnly && <>
      <div className="lume-subpanel mt-4 flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
            <History size={15} />
            整理记忆
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            {entryOrganizeRunning && entryOrganizeJob
              ? summarizeMemoryOrganizeJob(entryOrganizeJob)
              : entryOrganizeResult
              ? summarizeMemoryOrganizeEntriesResult(entryOrganizeResult)
              : '使用 LLM 分析已经写入的工作区和全局记忆数据，归并相似重复项；模型不可用时只做保守本地去重。'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busyAction !== null || entryOrganizeRunning || historyOrganizeRunning}
          onClick={onOrganizeEntries}
        >
          <RefreshCw size={14} className={entryOrganizeRunning || busyAction === 'organize-entries' ? 'animate-spin' : undefined} />
          {entryOrganizeRunning || busyAction === 'organize-entries' ? '整理中' : '整理记忆'}
        </Button>
      </div>

      <div className="lume-subpanel mt-4 flex flex-wrap items-start justify-between gap-3 p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-1)]">
            <Clock3 size={15} />
            从历史对话生成记忆
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
            {historyOrganizeRunning && historyOrganizeJob
              ? summarizeMemoryOrganizeJob(historyOrganizeJob)
              : organizeResult
              ? summarizeMemoryOrganizeResult(organizeResult)
              : '从当前工作区历史线程里提取稳定记忆；这是生成新记忆，不是整理已有记忆数据。'}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busyAction !== null || entryOrganizeRunning || historyOrganizeRunning}
          onClick={onOrganizeHistory}
        >
          <RefreshCw size={14} className={historyOrganizeRunning || busyAction === 'organize-history' ? 'animate-spin' : undefined} />
          {historyOrganizeRunning || busyAction === 'organize-history' ? '生成中' : '生成记忆'}
        </Button>
      </div>

      <div className="lume-subpanel mt-4 p-3">
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
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
              支持 md、txt、json、yaml；本地单文件最多读取前 512KB，文件夹最多扫描 200 个文本文件、6 层目录。
            </p>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
              粘贴文本会先拆块分析：命中“记住、以后、叫我、我的写作风格”等明确句式可直接写入；普通资料需要配置提取模型，并且必须能从原文找到可引用的长期事实、偏好、决策、经验或当前状态。
            </p>
            <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">
              {summarizeMemoryExtractionStatus(snapshot?.extraction)}
            </p>
          </div>
          <div className="lume-segmented flex">
            {([
              ['auto', '自动'],
              ['workspace', '工作区'],
              ['global', '全局'],
            ] as const).map(([scope, label]) => (
              <Button
                variant="ghost"
                key={scope}
                type="button"
                disabled={busyAction !== null || ingestRunning}
                onClick={() => onIngestTargetScope(scope)}
                className={cn(
                  'lume-segmented-item px-2 text-[12px]',
                  ingestTargetScope === scope
                    ? 'lume-segmented-item-active'
                    : '',
                )}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          <div className="space-y-2">
            <Textarea
              className="min-h-[92px] w-full resize-y rounded-[8px] border border-border bg-[var(--surface-1)] p-2 text-[12px] leading-5 text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]"
              placeholder="例如：叫我 Mason。以后默认用中文回答。我的写作风格偏好简洁、有温度。"
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
            <Input
              className="h-9 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--brand)]"
              placeholder="工作区文件路径，例如 docs/project.md"
              value={workspaceFilePath}
              disabled={busyAction !== null || ingestRunning}
              onChange={(event) => onWorkspaceFilePathChange(event.target.value)}
            />
            <p className="text-[12px] leading-5 text-[var(--text-3)]">
              工作区路径用于整理项目内已有文本文件；本地资料请使用下面的文件或文件夹选择。
            </p>
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
        {ingestItemRows.length > 0 ? (
          <div className="mt-3 space-y-2 border-t border-border pt-3">
            {ingestItemRows.map((row) => (
              <div key={row.id} className="rounded-[8px] border border-border bg-[var(--surface-1)] p-2">
                <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-[var(--text-1)]">
                  <StatusBadge tone={row.tone}>{row.title}</StatusBadge>
                </div>
                <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--text-3)]">{row.desc}</p>
              </div>
            ))}
          </div>
        ) : ingestResult && ingestResult.candidateCount === 0 ? (
          <div className="mt-3 rounded-[8px] border border-border bg-[var(--surface-1)] p-2 text-[12px] leading-5 text-[var(--text-3)]">
            没有抽取出候选记忆。可以使用“记住 / 以后 / 我偏好 / 叫我 / 我的写作风格”这类明确句式，或配置记忆提取模型做 LLM 分析；重复、冲突、低置信内容不会直接写成可用记忆。
          </div>
        ) : null}
      </div>

      </>}

      {!operationsOnly && <div className="lume-subpanel mt-4 grid gap-3 p-3 text-[12px] text-[var(--text-3)] md:grid-cols-3">
        <div>
          <div className="font-semibold text-[var(--text-2)]">迁移版本</div>
          <div className="mt-1">Memory Schema v{snapshot?.migration.schemaVersion ?? '未知'}</div>
        </div>
        <div>
          <div className="font-semibold text-[var(--text-2)]">最近后台任务</div>
          <div className="mt-1">
            {snapshot?.jobs[0]
              ? `${snapshot.jobs[0].kind} · ${snapshot.jobs[0].status}`
              : '暂无任务'}
          </div>
          {snapshot?.jobs[0]?.retryable && (
            <Button variant="ghost" size="sm" className="mt-1 h-auto px-0" onClick={() => onRetryJob(snapshot.jobs[0]!.jobId)}>
              重试中断任务
            </Button>
          )}
        </div>
        <div>
          <div className="font-semibold text-[var(--text-2)]">迁移备份</div>
          {snapshot?.migration.backupPaths[0] ? (
            <Button variant="ghost" size="sm" className="mt-1 h-auto px-0" onClick={() => onOpenFile(snapshot.migration.backupPaths[0]!)}>
              打开最近备份
            </Button>
          ) : <div className="mt-1">无需迁移或暂无备份</div>}
        </div>
      </div>}

      {!advancedOnly && <details className="mt-4 rounded-[8px] border border-border bg-[var(--surface-2)] p-3">
        <summary className="cursor-pointer text-[13px] font-semibold text-[var(--text-1)]">
          原始文件
        </summary>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {(fullSnapshot?.files ?? []).map((file) => (
            <FileRow key={file.path} file={file} onOpenFile={onOpenFile} />
          ))}
          {(fullSnapshot?.files ?? []).length === 0 && <EmptyInline text="暂无原始文件" />}
        </div>
      </details>}
    </details>
  )
}

function UserMemoryPanel({
  busyAction,
  category,
  detail,
  entries,
  manualMemoryText,
  onAddManualMemory,
  onDeleteEntry,
  onDirtyChange,
  onManualMemoryTextChange,
  onOpenFile,
  onInspectEntry,
  onUpdateEntry,
  onToggleActivation,
  selectedEntry,
  selectedEntryId,
}: {
  busyAction: string | null
  category: MemoryUserCategory
  detail: MemoryReadToolResult | null
  entries: MemorySettingsEntrySummary[]
  manualMemoryText: string
  onAddManualMemory: (category: MemoryUserCategory) => void
  onDeleteEntry: (entry: MemorySettingsEntrySummary) => void
  onDirtyChange: (dirty: boolean) => void
  onManualMemoryTextChange: (value: string) => void
  onOpenFile: (path: string) => void
  onInspectEntry: (entry: MemorySettingsEntrySummary) => void
  onUpdateEntry: (
    entry: MemorySettingsEntrySummary,
    input: {
      statement: string
      kind: MemoryKind
      confidence: MemorySettingsEntrySummary['confidence']
      tags: string[]
      pinned?: boolean
      validTo?: string | null
      targetScope?: 'global' | 'workspace'
    },
  ) => void
  onToggleActivation: (entry: MemorySettingsEntrySummary, activation: MemoryActivation) => void
  selectedEntry: MemorySettingsEntrySummary | null
  selectedEntryId: string | null
}) {
  const meta = MEMORY_USER_CATEGORY_META[category]
  const [query, setQuery] = React.useState('')
  const [scopeFilter, setScopeFilter] = React.useState<'all' | 'global' | 'workspace'>('all')
  const [statusFilter, setStatusFilter] = React.useState<'all' | MemorySettingsEntrySummary['status']>('all')
  const [sourceFilter, setSourceFilter] = React.useState<'all' | string>('all')
  const [facetFilter, setFacetFilter] = React.useState<'all' | string>('all')
  const [updatedFilter, setUpdatedFilter] = React.useState<'all' | '7d' | '30d'>('all')
  const filterOptions = React.useMemo(() => ({
    sources: Array.from(new Set(entries.flatMap((entry) => (entry.evidenceRefs ?? []).map((ref) => ref.type)))).sort(),
    facets: Array.from(new Set(entries.flatMap((entry) => [...(entry.facets ?? []), ...entry.tags]))).sort(),
  }), [entries])
  const filteredEntries = React.useMemo(() => {
    const base = filterMemoryEntriesByUserCategory(entries, category)
    if (category !== 'all') return base
    const normalized = query.trim().toLowerCase()
    return base.filter((entry) => {
      if (scopeFilter !== 'all' && entry.scope !== scopeFilter) return false
      if (statusFilter !== 'all' && entry.status !== statusFilter) return false
      if (sourceFilter !== 'all' && !(entry.evidenceRefs ?? []).some((ref) => ref.type === sourceFilter)) return false
      if (facetFilter !== 'all' && ![...(entry.facets ?? []), ...entry.tags].includes(facetFilter)) return false
      if (updatedFilter !== 'all') {
        const updatedAt = Date.parse(entry.updated)
        const age = Date.now() - updatedAt
        const maxAge = updatedFilter === '7d' ? 7 : 30
        if (!Number.isFinite(updatedAt) || age > maxAge * 24 * 60 * 60 * 1000) return false
      }
      if (!normalized) return true
      return [
        entry.statement,
        entry.semanticRole,
        ...(entry.facets ?? []),
        ...entry.tags,
        ...(entry.evidenceRefs ?? []).map((ref) => ref.type),
      ].filter(Boolean).some((value) => String(value).toLowerCase().includes(normalized))
    })
  }, [category, entries, query, scopeFilter, statusFilter, sourceFilter, facetFilter, updatedFilter])
  return (
    <section className="lume-panel p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[14px] font-semibold text-[var(--text-1)]">
            {category === 'about' ? <Sparkles size={16} /> : category === 'workspace' ? <ShieldCheck size={16} /> : <FileText size={16} />}
            {meta.label}
          </div>
          <p className="mt-1 text-[12px] leading-5 text-[var(--text-3)]">{meta.desc}</p>
        </div>
        <div className="lume-subpanel px-2 py-1 text-[12px] font-medium text-[var(--text-3)]">
          {filteredEntries.length} 条
        </div>
      </div>
      {category === 'all' && (
        <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_140px_150px_150px_150px_150px]">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索内容、来源或标签"
          />
          <Select value={scopeFilter} onValueChange={(value) => setScopeFilter(value as typeof scopeFilter)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部作用域</SelectItem>
              <SelectItem value="global">全局</SelectItem>
              <SelectItem value="workspace">工作区</SelectItem>
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部状态</SelectItem>
              {Object.entries(MEMORY_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={(value) => setSourceFilter(value ?? 'all')}>
            <SelectTrigger><SelectValue placeholder="全部来源" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部来源</SelectItem>
              {filterOptions.sources.map((source) => <SelectItem key={source} value={source}>{source}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={facetFilter} onValueChange={(value) => setFacetFilter(value ?? 'all')}>
            <SelectTrigger><SelectValue placeholder="全部标签" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部标签</SelectItem>
              {filterOptions.facets.map((facet) => <SelectItem key={facet} value={facet}>{facet}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={updatedFilter} onValueChange={(value) => setUpdatedFilter(value as typeof updatedFilter)}>
            <SelectTrigger><SelectValue placeholder="更新时间" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部时间</SelectItem>
              <SelectItem value="7d">最近 7 天</SelectItem>
              <SelectItem value="30d">最近 30 天</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.3fr)]">
        <div className="min-w-0 space-y-3">
          <div className="lume-subpanel p-3">
            <div className="flex gap-2">
              <Input
                value={manualMemoryText}
                onChange={(event) => onManualMemoryTextChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    onAddManualMemory(category)
                  }
                }}
                placeholder={meta.placeholder}
                className="min-h-9 flex-1 rounded-[8px] border border-border bg-[var(--surface-1)] px-3 text-[13px] text-[var(--text-1)] outline-none transition-colors placeholder:text-[var(--text-4)] focus:border-[var(--brand)]"
              />
              <Button
                size="sm"
                onClick={() => onAddManualMemory(category)}
                disabled={busyAction === `manual-${category}`}
              >
                <Plus size={14} />
                添加
              </Button>
            </div>
          </div>
          {filteredEntries.map((entry) => (
            <EntryRow
              key={entry.id}
              busy={busyAction === `inspect-${entry.id}`}
              entry={entry}
              selected={selectedEntryId === entry.id}
              onInspectEntry={onInspectEntry}
            />
          ))}
          {filteredEntries.length === 0 && <EmptyInline text={meta.empty} />}
        </div>
        <MemoryDetailPanel
          busyAction={busyAction}
          detail={detail}
          entry={selectedEntry}
          onDeleteEntry={onDeleteEntry}
          onDirtyChange={onDirtyChange}
          onOpenFile={onOpenFile}
          onUpdateEntry={onUpdateEntry}
          onToggleActivation={onToggleActivation}
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
    <section className="lume-panel p-4">
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
    <div className="lume-subpanel p-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px] font-medium text-[var(--text-3)]">
        <StatusBadge tone={item.type === 'conflict' ? 'warn' : 'neutral'}>
          {MEMORY_PENDING_LABELS[item.type]}
        </StatusBadge>
        <span>{item.candidate.scope === 'global' ? '全局' : '工作区'}</span>
        <span>{formatDate(item.created)}</span>
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="lume-panel p-3">
          <div className="flex flex-wrap items-center gap-2 text-[12px] font-semibold text-[var(--text-3)]">
            候选记忆
            <StatusBadge tone="neutral">{memoryPendingCandidateLayerLabel(item.candidate)}</StatusBadge>
            <StatusBadge tone="neutral">{MEMORY_CONFIDENCE_LABELS[item.candidate.confidence]}</StatusBadge>
          </div>
          {mergeMode ? (
            <div className="mt-2 space-y-2">
              <Textarea
                className="min-h-[86px] w-full resize-y rounded-[8px] border border-border bg-[var(--surface-2)] p-2 text-[12px] leading-5 text-[var(--text-1)] outline-none focus:border-[var(--brand)]"
                value={statement}
                disabled={busyAction !== null}
                onChange={(event) => setStatement(event.target.value)}
              />
              <div>
                <Select value={confidence} onValueChange={(value) => { if (value) setConfidence(value as MemorySettingsEntrySummary['confidence']) }} disabled={busyAction !== null}>
                  <SelectTrigger className="h-8 w-full border-border bg-[var(--surface-2)] px-2 text-[12px] text-[var(--text-1)] shadow-none focus-visible:ring-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                  {(['low', 'medium', 'high'] as const).map((value) => (
                    <SelectItem key={value} value={value}>{MEMORY_CONFIDENCE_LABELS[value]}</SelectItem>
                  ))}
                  </SelectContent>
                </Select>
              </div>
              <Input
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
        <div className="lume-panel p-3">
          <div className="text-[12px] font-semibold text-[var(--text-3)]">现有相关记忆</div>
          <div className="mt-2 space-y-2">
            {item.existingEntries.map((entry) => (
              <div key={entry.id} className="lume-subpanel p-2">
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-3)]">
                  <span>{summarizeMemoryEntry(entry)}</span>
                  <StatusBadge tone="neutral">{memoryEntryLayerLabel(entry)}</StatusBadge>
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
    <Button
                variant="ghost"
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
    </Button>
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
    <Button
                variant="ghost"
      type="button"
      onClick={() => onInspectEntry(entry)}
      className={cn(
        'block h-auto min-h-[112px] min-w-0 w-full whitespace-normal rounded-[8px] border border-border bg-[var(--surface-2)] p-3 text-left shadow-sm hover:bg-[var(--surface-3)]',
        selected && 'border-[var(--brand)] bg-[var(--surface-3)]',
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2 whitespace-normal text-[12px] font-medium text-[var(--text-3)]">
        <span>{summarizeMemoryEntry(entry)}</span>
        <StatusBadge tone="neutral">{memoryEntryLayerLabel(entry)}</StatusBadge>
        {entry.pinned && <StatusBadge tone="good">置顶</StatusBadge>}
        {entry.status === 'suspected_stale' && <StatusBadge tone="warn">{MEMORY_STATUS_LABELS.suspected_stale}</StatusBadge>}
        {busy && <StatusBadge tone="neutral">读取中</StatusBadge>}
      </div>
      <p className="mt-1 max-w-full line-clamp-3 break-words whitespace-normal text-[13px] leading-5 text-[var(--text-1)]">{entry.statement}</p>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 whitespace-normal text-[12px] text-[var(--text-3)]">
        <span>{entry.semanticRole ?? 'memory'}</span>
        <span>{MEMORY_CONFIDENCE_LABELS[entry.confidence]}</span>
        <span>{formatDate(entry.updated)}</span>
      </div>
    </Button>
  )
}

function MemoryDetailPanel({
  busyAction,
  detail,
  entry,
  onDeleteEntry,
  onDirtyChange,
  onOpenFile,
  onUpdateEntry,
  onToggleActivation,
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
      pinned?: boolean
      validTo?: string | null
      targetScope?: 'global' | 'workspace'
    },
  ) => void
  onToggleActivation: (entry: MemorySettingsEntrySummary, activation: MemoryActivation) => void
}) {
  const rows = buildMemoryDetailRows(detail)
  const [statement, setStatement] = React.useState('')
  const [kind, setKind] = React.useState<MemoryKind>('fact')
  const [confidence, setConfidence] = React.useState<MemorySettingsEntrySummary['confidence']>('medium')
  const [tagsText, setTagsText] = React.useState('')
  const [validTo, setValidTo] = React.useState('')
  const [targetScope, setTargetScope] = React.useState<'global' | 'workspace'>('workspace')
  const [editMode, setEditMode] = React.useState(false)

  React.useEffect(() => {
    setStatement(entry?.statement ?? detail?.text ?? '')
    setKind(entry?.kind ?? 'fact')
    setConfidence(entry?.confidence ?? 'medium')
    setTagsText(entry?.tags.join(', ') ?? '')
    setValidTo(entry?.validTo?.slice(0, 10) ?? '')
    setTargetScope(entry?.scope ?? 'workspace')
    setEditMode(false)
    onDirtyChange(false)
  }, [detail?.text, entry, onDirtyChange])

  const tags = parseTags(tagsText)
  const isDirty = entry ? (
    statement.trim() !== entry.statement
    || confidence !== entry.confidence
    || tags.join('|') !== entry.tags.join('|')
    || validTo !== (entry.validTo?.slice(0, 10) ?? '')
    || targetScope !== entry.scope
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
    setValidTo(entry?.validTo?.slice(0, 10) ?? '')
    setTargetScope(entry?.scope ?? 'workspace')
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
                        validTo: validTo ? new Date(`${validTo}T23:59:59.999Z`).toISOString() : null,
                        targetScope,
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
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={() => onUpdateEntry(entry, {
                      statement: entry.statement,
                      kind: entry.kind,
                      confidence: entry.confidence,
                      tags: entry.tags,
                      pinned: !entry.pinned,
                    })}
                  >
                    {entry.pinned ? '取消置顶' : '置顶'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyAction !== null}
                    onClick={() => setEditMode(true)}
                  >
                    <Pencil size={14} />
                    编辑
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={busyAction !== null}
                onClick={() => onDeleteEntry(entry)}
              >
                <Trash2 size={14} />
                归档
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
            <Textarea
              className="mt-1 min-h-[96px] w-full resize-y rounded-[8px] border border-border bg-[var(--surface-1)] p-2 text-[12px] leading-5 text-[var(--text-1)] outline-none focus:border-[var(--brand)]"
              value={statement}
              disabled={busyAction !== null}
              onChange={(event) => setStatement(event.target.value)}
            />
          </label>
          <div>
            <label className="block">
              <span className="text-[12px] font-medium text-[var(--text-3)]">置信度</span>
              <Select value={confidence} onValueChange={(value) => { if (value) setConfidence(value as MemorySettingsEntrySummary['confidence']) }} disabled={busyAction !== null}>
                <SelectTrigger className="mt-1 h-8 w-full border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)] shadow-none focus-visible:ring-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                {(['low', 'medium', 'high'] as const).map((item) => (
                  <SelectItem key={item} value={item}>{MEMORY_CONFIDENCE_LABELS[item]}</SelectItem>
                ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--text-3)]">标签</span>
            <Input
              className="mt-1 h-8 w-full rounded-[8px] border border-border bg-[var(--surface-1)] px-2 text-[12px] text-[var(--text-1)] outline-none focus:border-[var(--brand)]"
              value={tagsText}
              disabled={busyAction !== null}
              onChange={(event) => setTagsText(event.target.value)}
              placeholder="用逗号分隔"
            />
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--text-3)]">作用域</span>
            <Select value={targetScope} onValueChange={(value) => setTargetScope(value as typeof targetScope)} disabled={busyAction !== null}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="global">全局</SelectItem>
                <SelectItem value="workspace">工作区</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="block">
            <span className="text-[12px] font-medium text-[var(--text-3)]">有效期至</span>
            <Input
              type="date"
              className="mt-1"
              value={validTo}
              disabled={busyAction !== null}
              onChange={(event) => setValidTo(event.target.value)}
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
      {entry && (
        <dl className="mt-3 grid gap-2 text-[12px]">
          <div className="grid gap-1 sm:grid-cols-[72px_minmax(0,1fr)]">
            <dt className="text-[var(--text-3)]">版本</dt>
            <dd className="text-[var(--text-1)]">revision {entry.revision ?? 1}</dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-[72px_minmax(0,1fr)]">
            <dt className="text-[var(--text-3)]">最后确认</dt>
            <dd className="text-[var(--text-1)]">{formatDate(entry.lastConfirmedAt)}</dd>
          </div>
          <div className="grid gap-1 sm:grid-cols-[72px_minmax(0,1fr)]">
            <dt className="text-[var(--text-3)]">证据</dt>
            <dd className="break-words text-[var(--text-1)]">
              {(entry.evidenceRefs ?? []).map((ref) => [ref.type, ref.id ?? ref.path].filter(Boolean).join(': ')).join(' · ') || '无可展示证据'}
            </dd>
          </div>
          {(entry.supersedes?.length || entry.supersededBy) && (
            <div className="grid gap-1 sm:grid-cols-[72px_minmax(0,1fr)]">
              <dt className="text-[var(--text-3)]">版本链</dt>
              <dd className="break-words text-[var(--text-1)]">
                {[entry.supersedes?.length ? `替代 ${entry.supersedes.join(', ')}` : '', entry.supersededBy ? `被 ${entry.supersededBy} 替代` : ''].filter(Boolean).join(' · ')}
              </dd>
            </div>
          )}
        </dl>
      )}
      {entry && (
        <ActivationToggleGroup
          entry={entry}
          disabled={busyAction !== null}
          onToggle={(activation) => onToggleActivation(entry, activation)}
        />
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
      tone === 'good' && 'bg-[color:color-mix(in_oklab,var(--lume-success)_10%,var(--surface-1))] text-[var(--lume-success)]',
      tone === 'warn' && 'bg-[color:color-mix(in_oklab,var(--lume-warning)_12%,var(--surface-1))] text-[var(--lume-warning)]',
      tone === 'neutral' && 'bg-[var(--surface-1)] text-[var(--text-3)]',
    )}>
      {children}
    </span>
  )
}

const MEMORY_ACTIVATION_ITEMS: ReadonlyArray<{
  key: keyof MemoryActivation
  label: string
  desc: string
}> = [
  { key: 'recall', label: '召回', desc: '对话中通过 memory.read / 搜索调用此记忆' },
  { key: 'persona', label: 'Persona', desc: '生成/注入 L3 用户画像时使用此记忆' },
  { key: 'suggestion', label: '主动建议', desc: '匹配触发条件时由主动建议引用此记忆' },
  { key: 'analyst', label: '工作模式分析', desc: '周期性工作模式分析读取此记忆' },
]

/**
 * 4 toggle：recall/persona/suggestion/analyst。
 * 读 entry.activation（缺省 DEFAULT_MEMORY_ACTIVATION 兼容旧记忆）；toggle → onToggle(全新 activation 对象)。
 */
export function ActivationToggleGroup({
  entry,
  disabled,
  onToggle,
}: {
  entry: MemorySettingsEntrySummary
  disabled: boolean
  onToggle: (activation: MemoryActivation) => void
}) {
  const activation: MemoryActivation = {
    ...DEFAULT_MEMORY_ACTIVATION,
    ...(entry.activation ?? {}),
  }
  return (
    <div className="mt-3 rounded-[8px] border border-border bg-[var(--surface-1)] p-3">
      <div className="text-[12px] font-semibold text-[var(--text-3)]">激活用途</div>
      <p className="mt-1 text-[11px] leading-4 text-[var(--text-3)]">
        精调这条记忆在哪些场景被读取；关闭后即使命中也不会被该用途读取。
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {MEMORY_ACTIVATION_ITEMS.map((item) => {
          const checked = activation[item.key]
          return (
            <label
              key={item.key}
              className={cn(
                'flex min-h-[56px] items-center justify-between gap-3 rounded-[6px] border p-2',
                checked
                  ? 'border-[color-mix(in_oklab,var(--brand)_30%,var(--border))] bg-[color-mix(in_oklab,var(--brand)_6%,var(--surface-1))]'
                  : 'border-border bg-[var(--surface-2)]',
              )}
            >
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold text-[var(--text-1)]">{item.label}</span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[var(--text-3)]">{item.desc}</span>
              </span>
              <Switch
                checked={checked}
                disabled={disabled}
                aria-label={`激活用途：${item.label}`}
                onCheckedChange={(value) => onToggle({ ...activation, [item.key]: value })}
              />
            </label>
          )
        })}
      </div>
    </div>
  )
}

function EmptyInline({ text }: { text: string }) {
  return (
    <div className="lume-subpanel border-dashed p-4 text-center text-[13px] text-[var(--text-3)]">
      {text}
    </div>
  )
}

function EmptyPanel({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="lume-panel border-dashed p-6 text-center">
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

function memorySettingsErrorMessage(error: unknown, fallback = '读取记忆设置失败'): string {
  const detail = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : ''
  return detail ? `${fallback}：${detail}` : fallback
}
