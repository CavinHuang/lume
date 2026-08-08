import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { toast } from 'sonner'
import type {
  MemoryActivation,
  MemoryIngestSourceInput,
  MemoryIngestSourcesJob,
  MemoryIngestSourcesResult,
  MemoryKind,
  MemoryOrganizeEntriesResult,
  MemoryOrganizeHistoryResult,
  MemoryOrganizeJob,
  MemoryReadToolResult,
  MemoryResolvePendingInput,
  MemorySettingsEntrySummary,
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
} from '@lume/shared'
import { memoryCenterDeepLinkAtom, memoryCenterVersionAtom } from '@/atoms'
import {
  cancelMemoryJob,
  deleteMemoryEntry,
  getMemoryIngestJob,
  getMemoryOrganizeJob,
  getMemorySettingsSnapshot,
  ingestMemorySources,
  openFileDialog,
  openFolderDialog,
  openMemorySource,
  organizeMemoryEntries,
  organizeMemoryHistory,
  readMemory,
  rememberMemory,
  resolveMemoryPending,
  retryMemoryJob,
  undoMemoryMutation,
  updateMemoryEntry,
} from '@/lib/desktop-api'
import {
  applyMemoryIngestTargetScope,
  summarizeMemoryIngestSourcesJob,
  summarizeMemoryIngestSourcesResult,
  summarizeMemoryOrganizeEntriesResult,
  summarizeMemoryOrganizeJob,
  summarizeMemoryOrganizeResult,
  type MemoryIngestTargetScopeMode,
  type MemorySettingsView,
  type MemoryUserCategory,
} from '@/components/settings/memory-settings-state'
import type { MemoryCenterDeepLink } from './memory-center-state'

export interface MemoryCenterController {
  snapshot: MemorySettingsSnapshot | null
  selectedEntry: MemorySettingsEntrySummary | null
  detail: MemoryReadToolResult | null
  selectedMemoryId: string | null
  busyAction: string | null
  view: MemorySettingsView
  userCategory: MemoryUserCategory | null
  userMemoryEntries: MemorySettingsEntrySummary[]
  detailDirty: boolean
  manualMemoryText: string
  ingestTargetScope: MemoryIngestTargetScopeMode
  externalText: string
  workspaceFilePath: string
  entryOrganizeJob: MemoryOrganizeJob | null
  historyOrganizeJob: MemoryOrganizeJob | null
  entryOrganizeResult: MemoryOrganizeEntriesResult | null
  organizeResult: MemoryOrganizeHistoryResult | null
  ingestJob: MemoryIngestSourcesJob | null
  ingestResult: MemoryIngestSourcesResult | null
  refresh: () => Promise<void>
  actions: {
    setView: React.Dispatch<React.SetStateAction<MemorySettingsView>>
    setDetailDirty: React.Dispatch<React.SetStateAction<boolean>>
    setManualMemoryText: React.Dispatch<React.SetStateAction<string>>
    setIngestTargetScope: React.Dispatch<React.SetStateAction<MemoryIngestTargetScopeMode>>
    setExternalText: React.Dispatch<React.SetStateAction<string>>
    setWorkspaceFilePath: React.Dispatch<React.SetStateAction<string>>
    openMemoryFile: (path: string) => Promise<void>
    openActivityMemory: (memoryId: string) => void
    undoActivityMutation: (mutationId: string) => Promise<void>
    inspectMemoryEntry: (entry: MemorySettingsEntrySummary) => Promise<void>
    updateMemoryEntry: (
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
    ) => Promise<void>
    toggleActivation: (entry: MemorySettingsEntrySummary, activation: MemoryActivation) => Promise<void>
    deleteMemoryEntry: (entry: MemorySettingsEntrySummary) => Promise<void>
    addManualMemory: (category: MemoryUserCategory) => Promise<void>
    resolvePending: (
      item: MemorySettingsPendingSummary,
      action: 'accept' | 'reject' | 'resolve',
      candidateOverride?: MemoryResolvePendingInput['candidateOverride'],
    ) => Promise<void>
    cancelJob: (jobId: string) => Promise<void>
    retryJob: (jobId: string) => Promise<void>
    organizeHistory: () => Promise<void>
    organizeEntries: () => Promise<void>
    ingestPastedText: () => Promise<void>
    ingestWorkspaceFile: () => Promise<void>
    ingestLocalFiles: () => Promise<void>
    ingestLocalFolder: () => Promise<void>
  }
}

/** 统一管理记忆中心的快照、草稿、后台任务轮询和 revision-safe mutation。 */
export function useMemoryCenter(
  workspaceSlug: string | null,
  deepLink: MemoryCenterDeepLink,
): MemoryCenterController {
  const memoryCenterVersion = useAtomValue(memoryCenterVersionAtom)
  const setMemoryCenterDeepLink = useSetAtom(memoryCenterDeepLinkAtom)
  const [view, setView] = React.useState<MemorySettingsView>('recent')
  const [snapshot, setSnapshot] = React.useState<MemorySettingsSnapshot | null>(null)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [entryOrganizeJob, setEntryOrganizeJob] = React.useState<MemoryOrganizeJob | null>(null)
  const [historyOrganizeJob, setHistoryOrganizeJob] = React.useState<MemoryOrganizeJob | null>(null)
  const [entryOrganizeResult, setEntryOrganizeResult] = React.useState<MemoryOrganizeEntriesResult | null>(null)
  const [organizeResult, setOrganizeResult] = React.useState<MemoryOrganizeHistoryResult | null>(null)
  const [ingestJob, setIngestJob] = React.useState<MemoryIngestSourcesJob | null>(null)
  const [ingestResult, setIngestResult] = React.useState<MemoryIngestSourcesResult | null>(null)
  const [detail, setDetail] = React.useState<MemoryReadToolResult | null>(null)
  const [selectedMemoryId, setSelectedMemoryId] = React.useState<string | null>(null)
  const [detailDirty, setDetailDirty] = React.useState(false)
  const [manualMemoryText, setManualMemoryText] = React.useState('')
  const [ingestTargetScope, setIngestTargetScope] = React.useState<MemoryIngestTargetScopeMode>('auto')
  const [externalText, setExternalText] = React.useState('')
  const [workspaceFilePath, setWorkspaceFilePath] = React.useState('')

  const refresh = React.useCallback(async () => {
    if (!workspaceSlug) {
      setSnapshot(null)
      return
    }
    try {
      setSnapshot(await loadMemoryCenterSnapshot(workspaceSlug))
    } catch (error) {
      console.error('[useMemoryCenter] refresh FAILED:', error)
      toast.error(errorMessage(error, '读取记忆中心失败'))
    }
  }, [workspaceSlug])

  React.useEffect(() => {
    setSnapshot(null)
    setDetail(null)
    setSelectedMemoryId(null)
    setDetailDirty(false)
    setView('recent')
    setManualMemoryText('')
    setExternalText('')
    setWorkspaceFilePath('')
    setEntryOrganizeJob(null)
    setHistoryOrganizeJob(null)
    setEntryOrganizeResult(null)
    setOrganizeResult(null)
    setIngestJob(null)
    setIngestResult(null)
  }, [workspaceSlug])

  React.useEffect(() => {
    void refresh()
  }, [memoryCenterVersion, refresh])

  React.useEffect(() => {
    if (deepLink.libraryView) setView(deepLink.libraryView)
    if (deepLink.memoryId) setSelectedMemoryId(deepLink.memoryId)
  }, [deepLink.libraryView, deepLink.memoryId, deepLink.workspaceSlug])

  React.useEffect(() => {
    if (!workspaceSlug || !deepLink.memoryId || !snapshot) return
    const entry = [...snapshot.workspaceEntries, ...snapshot.globalEntries]
      .find((item) => item.id === deepLink.memoryId)
    if (!entry) return
    let disposed = false
    void readMemory({ workspaceSlug, id: entry.id }).then((result) => {
      if (!disposed) setDetail(result)
    }).catch((error) => {
      if (!disposed) toast.error(errorMessage(error, '读取记忆详情失败'))
    })
    return () => { disposed = true }
  }, [deepLink.memoryId, snapshot, workspaceSlug])

  React.useEffect(() => {
    const status = snapshot?.retrieval.semantic.localOnnx?.status
    if (status !== 'downloading' && status !== 'initializing') return undefined
    const timer = window.setTimeout(() => void refresh(), 1500)
    return () => window.clearTimeout(timer)
  }, [refresh, snapshot?.retrieval.semantic.localOnnx?.status])

  React.useEffect(() => {
    if (!snapshot?.jobs.some((job) => job.status === 'queued' || job.status === 'running')) return undefined
    const timer = window.setTimeout(() => void refresh(), 1200)
    return () => window.clearTimeout(timer)
  }, [refresh, snapshot?.jobs])

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
        } else if (nextJob.status === 'completed') {
          if (nextJob.result) {
            setIngestResult(nextJob.result)
            toast.success(summarizeMemoryIngestSourcesResult(nextJob.result))
          }
          await refresh()
        } else {
          toast.error(summarizeMemoryIngestSourcesJob(nextJob))
        }
      } catch (error) {
        if (!disposed) {
          setIngestJob((current) => current?.jobId === ingestJob.jobId
            ? { ...current, status: 'failed', completedAt: Date.now(), error: errorMessage(error, '资料整理失败') }
            : current)
          toast.error(errorMessage(error, '资料整理失败'))
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

  const runAction = React.useCallback(async (name: string, action: () => Promise<void>) => {
    setBusyAction(name)
    try {
      await action()
    } catch (error) {
      console.error(`[useMemoryCenter] ${name} FAILED:`, error)
      toast.error(errorMessage(error, '记忆操作失败'))
    } finally {
      setBusyAction(null)
    }
  }, [])

  const openMemoryFile = (path: string) => runAction(`open-${path}`, async () => {
    if (!workspaceSlug) return
    await openMemorySource({ workspaceSlug, path })
  })

  const openActivityMemory = (memoryId: string) => {
    if (!workspaceSlug) return
    setMemoryCenterDeepLink({ section: 'memory', workspaceSlug, libraryView: 'all', memoryId })
  }

  const undoActivityMutation = (mutationId: string) => runAction(`undo-${mutationId}`, async () => {
    if (!workspaceSlug) return
    await undoMemoryMutation({ workspaceSlug, mutationId })
    await refresh()
    toast.success('已撤销记忆变更')
  })

  const inspectMemoryEntry = (entry: MemorySettingsEntrySummary) => runAction(`inspect-${entry.id}`, async () => {
    if (!workspaceSlug) return
    if (detailDirty && selectedMemoryId !== entry.id && !window.confirm('当前记忆还有未保存修改，切换后会丢失。继续吗？')) return
    setDetailDirty(false)
    setSelectedMemoryId(entry.id)
    setDetail(await readMemory({ workspaceSlug, id: entry.id }))
  })

  const updateEntry: MemoryCenterController['actions']['updateMemoryEntry'] = (entry, input) => runAction(`update-${entry.id}`, async () => {
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
    setDetail(await readMemory({ workspaceSlug, id: entry.id }))
    setDetailDirty(false)
    await refresh()
    toast.success('记忆已更新', result.mutationId && result.undoable ? {
      action: {
        label: '撤销',
        onClick: () => void undoMemoryMutation({ workspaceSlug, mutationId: result.mutationId! }).then(() => refresh()),
      },
    } : undefined)
  })

  const toggleActivation = (entry: MemorySettingsEntrySummary, activation: MemoryActivation) => runAction(`activation-${entry.id}`, async () => {
    if (!workspaceSlug) return
    await updateMemoryEntry({ workspaceSlug, scope: entry.scope, id: entry.id, activation })
    await refresh()
    toast.success('激活用途已更新')
  })

  const deleteEntry = (entry: MemorySettingsEntrySummary) => runAction(`delete-${entry.id}`, async () => {
    if (!workspaceSlug) return
    const result = await deleteMemoryEntry({ workspaceSlug, scope: entry.scope, id: entry.id })
    setSelectedMemoryId(null)
    setDetail(null)
    setDetailDirty(false)
    await refresh()
    toast.success('记忆已归档，可通过撤销恢复', {
      action: result.mutationId && result.undoable ? {
        label: '撤销',
        onClick: () => void undoMemoryMutation({ workspaceSlug, mutationId: result.mutationId! }).then(() => refresh()),
      } : undefined,
    })
  })

  const addManualMemory = (category: MemoryUserCategory) => runAction(`manual-${category}`, async () => {
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

  const resolvePending: MemoryCenterController['actions']['resolvePending'] = (item, action, candidateOverride) => runAction(`pending-${action}-${item.id}`, async () => {
    if (!workspaceSlug) return
    await resolveMemoryPending({ workspaceSlug, path: item.path, action, candidateOverride })
    await refresh()
    toast.success(action === 'accept' ? '候选记忆已接受' : action === 'reject' ? '候选记忆已忽略' : '待处理记忆已解决')
  })

  const cancelJob = (jobId: string) => runAction(`cancel-job-${jobId}`, async () => {
    if (!workspaceSlug) return
    await cancelMemoryJob({ workspaceSlug, jobId })
    setEntryOrganizeJob((job) => job?.jobId === jobId ? { ...job, status: 'cancelled', completedAt: Date.now() } : job)
    setHistoryOrganizeJob((job) => job?.jobId === jobId ? { ...job, status: 'cancelled', completedAt: Date.now() } : job)
    setIngestJob((job) => job?.jobId === jobId ? { ...job, status: 'cancelled', completedAt: Date.now() } : job)
    await refresh()
  })

  const retryJob = (jobId: string) => runAction(`retry-job-${jobId}`, async () => {
    if (!workspaceSlug) return
    setIngestJob(await retryMemoryJob({ workspaceSlug, jobId }))
    toast.success('已重新开始资料整理')
  })

  const organizeHistory = () => runAction('organize-history', async () => {
    if (!workspaceSlug) return
    setOrganizeResult(null)
    setHistoryOrganizeJob(await organizeMemoryHistory({ workspaceSlug, limit: 200 }))
    toast.success('已开始后台生成记忆')
  })

  const organizeEntries = () => runAction('organize-entries', async () => {
    if (!workspaceSlug) return
    setEntryOrganizeResult(null)
    setEntryOrganizeJob(await organizeMemoryEntries({ workspaceSlug }))
    toast.success('已开始后台整理记忆')
  })

  const startIngestJob = async (sources: MemoryIngestSourceInput[]) => {
    if (!workspaceSlug) return
    setIngestResult(null)
    setIngestJob(await ingestMemorySources({
      workspaceSlug,
      sources: applyMemoryIngestTargetScope(sources, ingestTargetScope),
    }))
    toast.success('已开始后台整理资料')
  }

  const ingestPastedText = () => runAction('ingest-text', async () => {
    const content = externalText.trim()
    if (!content) {
      toast.error('请先粘贴要整理的资料')
      return
    }
    await startIngestJob([{ kind: 'pasted_text', title: '粘贴资料', content }])
    setExternalText('')
  })

  const ingestWorkspaceFile = () => runAction('ingest-workspace-file', async () => {
    const path = workspaceFilePath.trim()
    if (!path) {
      toast.error('请填写工作区文件路径')
      return
    }
    await startIngestJob([{ kind: 'workspace_file', path }])
  })

  const ingestLocalFiles = () => runAction('ingest-local-files', async () => {
    const selection = await openFileDialog()
    if (selection.files.length === 0) return
    await startIngestJob(selection.files.map((file) => ({ kind: 'local_file', path: file.sourcePath })))
  })

  const ingestLocalFolder = () => runAction('ingest-local-folder', async () => {
    const selection = await openFolderDialog()
    if (!selection.path) return
    await startIngestJob([{ kind: 'local_folder', path: selection.path }])
  })

  const selectedEntry = React.useMemo(() => {
    if (!snapshot || !selectedMemoryId) return null
    return [...snapshot.workspaceEntries, ...snapshot.globalEntries]
      .find((entry) => entry.id === selectedMemoryId) ?? null
  }, [selectedMemoryId, snapshot])

  const userMemoryEntries = React.useMemo(
    () => rankMemoryCenterEntries(snapshot),
    [snapshot],
  )

  const userCategory = isUserMemoryCategory(view) ? view : null

  return {
    snapshot,
    selectedEntry,
    detail,
    selectedMemoryId,
    busyAction,
    view,
    userCategory,
    userMemoryEntries,
    detailDirty,
    manualMemoryText,
    ingestTargetScope,
    externalText,
    workspaceFilePath,
    entryOrganizeJob,
    historyOrganizeJob,
    entryOrganizeResult,
    organizeResult,
    ingestJob,
    ingestResult,
    refresh,
    actions: {
      setView,
      setDetailDirty,
      setManualMemoryText,
      setIngestTargetScope,
      setExternalText,
      setWorkspaceFilePath,
      openMemoryFile,
      openActivityMemory,
      undoActivityMutation,
      inspectMemoryEntry,
      updateMemoryEntry: updateEntry,
      toggleActivation,
      deleteMemoryEntry: deleteEntry,
      addManualMemory,
      resolvePending,
      cancelJob,
      retryJob,
      organizeHistory,
      organizeEntries,
      ingestPastedText,
      ingestWorkspaceFile,
      ingestLocalFiles,
      ingestLocalFolder,
    },
  }
}

export async function loadMemoryCenterSnapshot(
  workspaceSlug: string,
  loader: (workspaceSlug: string) => Promise<MemorySettingsSnapshot> = getMemorySettingsSnapshot,
): Promise<MemorySettingsSnapshot> {
  return loader(workspaceSlug)
}

export function rankMemoryCenterEntries(snapshot: MemorySettingsSnapshot | null): MemorySettingsEntrySummary[] {
  const entries = [...(snapshot?.globalEntries ?? []), ...(snapshot?.workspaceEntries ?? [])]
  const recentIds = (snapshot?.activity ?? []).flatMap((receipt) => receipt.memoryIds)
  const rank = new Map(recentIds.map((id, index) => [id, index]))
  return entries.sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
}

function isUserMemoryCategory(view: MemorySettingsView): view is MemoryUserCategory {
  return view === 'recent' || view === 'about' || view === 'workspace' || view === 'all'
}

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
      const nextJob = await getMemoryOrganizeJob({ jobId: input.jobId, workspaceSlug: input.workspaceSlug })
      if (disposed) return
      input.setJob(nextJob)
      if (nextJob.status === 'running') {
        timer = window.setTimeout(poll, 1200)
      } else if (nextJob.status === 'completed') {
        input.onCompleted(nextJob)
        await input.refresh()
      } else {
        toast.error(summarizeMemoryOrganizeJob(nextJob))
      }
    } catch (error) {
      if (!disposed) {
        input.setJob((current) => current?.jobId === input.jobId
          ? { ...current, status: 'failed', completedAt: Date.now(), error: errorMessage(error, '记忆整理失败') }
          : current)
        toast.error(errorMessage(error, '记忆整理失败'))
      }
    }
  }
  timer = window.setTimeout(poll, 800)
  return () => {
    disposed = true
    if (timer) window.clearTimeout(timer)
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}
