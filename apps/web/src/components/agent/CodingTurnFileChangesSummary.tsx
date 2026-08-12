import { useEffect, useMemo, useState } from 'react'
import { useSetAtom } from 'jotai'
import { FileDiff, Loader2 } from 'lucide-react'
import { AGENT_IPC_CHANNELS, type CodingDiffPayload, type RuntimeCodingFileChange, type RuntimeCodingReport } from '@lume/shared'
import { codingReviewPanelActionAtom } from '@/atoms'
import { codingReviewFileKey } from '@/atoms/right-panel-atoms'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { PierreDiffView } from '@/components/diff/PierreDiffView'
import { requestSessionCodingDiff } from '@/components/right-panel/coding-diff-cache'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { sidecarCall } from '@/lib/desktop-api'
import type { OpenThreadFile } from './AgentFileReference'

export function collectCodingTurnChanges(report: RuntimeCodingReport): RuntimeCodingFileChange[] {
  const source = report.changeSet?.files.length
    ? report.changeSet.files
    : report.fileChanges?.length
      ? report.fileChanges
      : report.changedFiles.map((path) => ({ path }))
  const seen = new Set<string>()

  return source.filter((change) => {
    const key = codingReviewFileKey(change)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function CodingTurnFileChangesSummary({
  report,
  assistantMessageId,
  threadId,
  onOpenThreadFile,
}: {
  report: RuntimeCodingReport
  assistantMessageId?: string
  threadId: string
  onOpenThreadFile?: OpenThreadFile
}) {
  const codingReviewPanelAction = useSetAtom(codingReviewPanelActionAtom)
  const [liveChangeSet, setLiveChangeSet] = useState(report.changeSet)
  const effectiveReport = useMemo(
    () => liveChangeSet ? { ...report, changeSet: liveChangeSet } : report,
    [liveChangeSet, report],
  )
  const changes = useMemo(() => collectCodingTurnChanges(effectiveReport), [effectiveReport])
  const addedLines = effectiveReport.changeSet?.totalAddedLines
    ?? report.totalAddedLines
    ?? changes.reduce((sum, change) => sum + (change.addedLines ?? 0), 0)
  const removedLines = effectiveReport.changeSet?.totalRemovedLines
    ?? report.totalRemovedLines
    ?? changes.reduce((sum, change) => sum + (change.removedLines ?? 0), 0)

  useEffect(() => {
    setLiveChangeSet(report.changeSet)
  }, [report.changeSet])

  useEffect(() => {
    const hasFileStats = changes.length > 0 && changes.every((change) => (
      change.addedLines !== undefined && change.removedLines !== undefined
    ))
    if (report.changeSet || report.changedFiles.length === 0 || hasFileStats) return
    let cancelled = false
    void sidecarCall<RuntimeCodingReport['changeSet']>(AGENT_IPC_CHANNELS.GET_CODING_CHANGE_SET, {
      threadId,
      paths: report.changedFiles,
    }).then((changeSet) => {
      if (!cancelled && changeSet) setLiveChangeSet(changeSet)
    }).catch(() => {
      // 历史任务的工作区可能已经不可读，保留报告中已有的统计。
    })
    return () => {
      cancelled = true
    }
  }, [changes, report.changeSet, report.changedFiles, threadId])

  useEffect(() => {
    codingReviewPanelAction({
      type: 'update',
      threadId,
      patch: {
        phase: report.phase,
        verificationRecords: report.verificationRecords,
        recommendedVerificationCommands: report.recommendedVerificationCommands,
        gitActions: report.gitActions,
        review: report.review,
      },
    })
  }, [codingReviewPanelAction, report.gitActions, report.phase, report.recommendedVerificationCommands, report.review, report.verificationRecords, threadId])

  if (changes.length === 0) return null

  const canReviewDiff = Boolean(report.runId || effectiveReport.changeSet || report.fileChanges)
  const openChange = async (change: RuntimeCodingFileChange) => {
    if (!canReviewDiff) {
      await onOpenThreadFile?.(change.path)
      return
    }
    codingReviewPanelAction({
      type: 'open',
      threadId,
      changes,
      selectedPath: change.path,
      selectedRootId: change.rootId,
      runId: report.runId,
      turnId: report.turnId,
      assistantMessageId: report.assistantMessageId ?? assistantMessageId,
      phase: report.phase,
      verificationRecords: report.verificationRecords,
      recommendedVerificationCommands: report.recommendedVerificationCommands,
      gitActions: report.gitActions,
      review: report.review,
    })
  }

  return (
    <Card data-coding-file-changes-summary="true" size="sm" className="max-w-[640px] gap-0 py-0">
      <CardHeader className="flex min-h-9 flex-row items-center border-b px-3 py-1.5">
        <CardTitle className="flex min-w-0 items-center gap-2 text-[13px]">
          <FileDiff size={15} className="shrink-0 text-[var(--lume-text-secondary)]" />
          <span>{changes.length} 个文件已修改</span>
        </CardTitle>
        <div className="shrink-0 text-[12px] tabular-nums">
          <span className="text-emerald-500">+{addedLines}</span>
          <span className="ml-2 text-red-500">-{removedLines}</span>
        </div>
      </CardHeader>
      <CardContent className="py-1">
        {changes.map((change) => (
          <CodingFileChangeRow
            key={codingReviewFileKey(change)}
            change={change}
            report={report}
            threadId={threadId}
            onOpen={() => void openChange(change)}
          />
        ))}
      </CardContent>
    </Card>
  )
}

function CodingFileChangeRow({
  change,
  report,
  threadId,
  onOpen,
}: {
  change: RuntimeCodingFileChange
  report: RuntimeCodingReport
  threadId: string
  onOpen: () => void
}) {
  const [diff, setDiff] = useState<CodingDiffPayload>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const filename = change.path.split(/[\\/]/).pop() || change.path

  const loadDiff = (open: boolean) => {
    if (!open || !report.runId || diff || loading) return
    setLoading(true)
    setError(false)
    void requestSessionCodingDiff(threadId, report.runId, change.path, change.rootId)
      .then(setDiff)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }

  return (
    <Tooltip onOpenChange={loadDiff}>
      <TooltipTrigger render={<div />}>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto min-h-8 w-full justify-start gap-2 rounded-md px-3 py-1.5 text-[12px] font-normal hover:bg-foreground/[0.04]"
          onClick={onOpen}
        >
          <FileTypeIcon filename={filename} size={13} className="shrink-0" />
          <span className="min-w-0 flex-1 whitespace-normal break-all text-left font-mono" title={change.path}>{change.path}</span>
          <span className="shrink-0 tabular-nums">
            <span className="text-emerald-500">+{change.addedLines ?? 0}</span>
            <span className="ml-2 text-red-500">-{change.removedLines ?? 0}</span>
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        sideOffset={8}
        className="block w-[min(680px,calc(100vw-48px))] max-w-none overflow-hidden bg-[var(--lume-bg-elevated)] p-0 text-[var(--lume-text-primary)]"
      >
        <div className="truncate border-b border-[var(--lume-border-subtle)] px-3 py-2 font-mono text-[11px]">{change.path}</div>
        {loading && (
          <div className="flex h-28 items-center justify-center gap-2 text-[12px] text-[var(--lume-text-muted)]">
            <Loader2 size={14} className="animate-spin" />加载 Diff
          </div>
        )}
        {error && <div className="px-3 py-8 text-center text-[12px] text-[var(--lume-text-muted)]">无法读取当前文件的 Diff</div>}
        {diff?.kind === 'text' && (
          <PierreDiffView
            patch={diff.patch}
            oldContent={diff.oldContent}
            newContent={diff.newContent}
            filePath={diff.path}
            cacheKey={diff.diffHash}
            compact
            className="max-h-[360px]"
          />
        )}
        {diff && diff.kind !== 'text' && (
          <div className="px-3 py-8 text-center text-[12px] text-[var(--lume-text-muted)]">
            {diff.kind === 'media' ? '媒体文件请在右侧面板查看对比' : '二进制文件无法显示文本 Diff'}
          </div>
        )}
        {!report.runId && !loading && !diff && !error && (
          <div className="px-3 py-8 text-center text-[12px] text-[var(--lume-text-muted)]">历史记录没有可读取的 Diff</div>
        )}
      </TooltipContent>
    </Tooltip>
  )
}
