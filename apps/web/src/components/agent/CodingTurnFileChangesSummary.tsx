import { useEffect, useMemo } from 'react'
import { useSetAtom } from 'jotai'
import type { RuntimeCodingFileChange, RuntimeCodingReport } from '@lume/shared'
import { codingReviewPanelActionAtom } from '@/atoms'
import { codingReviewFileKey } from '@/atoms/right-panel-atoms'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { Button } from '@/components/ui/button'
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
  const changes = useMemo(() => collectCodingTurnChanges(report), [report])

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

  const canReviewDiff = Boolean(report.runId || report.changeSet || report.fileChanges)
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
    <div data-coding-file-changes-summary="true" className="mt-3 border-t-2 border-dashed border-[var(--lume-border-subtle)] pt-3">
      <div className="flex flex-wrap gap-1.5">
        {changes.map((change) => {
          const filename = change.path.split(/[\\/]/).pop() || change.path
          return (
            <Button
              key={codingReviewFileKey(change)}
              variant="outline"
              size="sm"
              title={change.path}
              className="h-7 max-w-full gap-1.5 rounded-md px-2 font-mono text-[12px] font-medium"
              onClick={() => void openChange(change)}
            >
              <FileTypeIcon filename={filename} size={13} className="shrink-0" />
              <span className="truncate">{filename}</span>
            </Button>
          )
        })}
      </div>
    </div>
  )
}
