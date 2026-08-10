import * as React from 'react'
import type {
  MemorySettingsJobSummary,
  MemoryDreamResult,
  MemoryOrganizeEntriesResult,
  MemoryOrganizeHistoryResult,
  MemoryIngestSourcesResult,
} from '@lume/shared'
import { ChevronDown, ChevronUp, RotateCcw, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { buildMemoryMutationFieldDiffs } from './memory-activity-state'
import { cn } from '@/lib/utils'
import {
  formatMemoryJobTime,
  MEMORY_JOB_KIND_LABELS,
  MEMORY_JOB_STATUS_LABELS,
  summarizeMemorySettingsJob,
} from './memory-job-activity-state'

const MEMORY_JOB_RESULT_ACTION_LABELS: Record<string, string> = {
  duplicate: '重复',
  related: '已写入并关联',
  mergeable: '可合并',
  conflict: '冲突待处理',
  suspected_stale: '可能过期待处理',
  low_confidence: '低置信待处理',
  new: '已写入',
  suppressed: '已跳过',
}

interface MemoryJobActivityPanelProps {
  items: MemorySettingsJobSummary[]
  busyAction: string | null
  onRetry: (jobId: string) => void
  onCancel: (jobId: string) => void
  onOpenMemory?: (memoryId: string) => void
  onUndo?: (mutationId: string) => void
}

export function MemoryJobActivityPanel({ items, busyAction, onRetry, onCancel, onOpenMemory, onUndo }: MemoryJobActivityPanelProps) {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())

  if (items.length === 0) {
    return <div className="rounded-[8px] border border-dashed border-border px-3 py-5 text-center text-[12px] text-[var(--text-3)]">暂无后台任务</div>
  }

  return (
    <div className="space-y-2">
      {items.map((job) => {
        const open = expanded.has(job.jobId)
        const canRetry = job.retryable && busyAction === null
        const canCancel = (job.status === 'queued' || job.status === 'running') && busyAction === null
        return (
          <Collapsible
            key={job.jobId}
            open={open}
            onOpenChange={(nextOpen) => setExpanded((current) => {
              const next = new Set(current)
              if (nextOpen) next.add(job.jobId)
              else next.delete(job.jobId)
              return next
            })}
          >
            <article className="lume-subpanel overflow-hidden" data-memory-job-id={job.jobId}>
              <div className="flex min-w-0 items-start gap-2 p-3">
                <CollapsibleTrigger className="flex min-w-0 flex-1 items-start gap-3 text-left">
                  <span className="mt-0.5 shrink-0 text-[var(--text-3)]">
                    {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-[var(--text-1)]">
                        {MEMORY_JOB_KIND_LABELS[job.kind]}
                      </span>
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-medium',
                        job.status === 'completed'
                          ? 'bg-emerald-500/10 text-emerald-700'
                          : job.status === 'failed' || job.status === 'interrupted'
                            ? 'bg-red-500/10 text-red-700'
                            : 'bg-[var(--surface-3)] text-[var(--text-3)]',
                      )}>
                        {MEMORY_JOB_STATUS_LABELS[job.status]}
                      </span>
                    </span>
                    <span className="mt-1 block break-words text-[12px] leading-5 text-[var(--text-2)]">
                      {summarizeMemorySettingsJob(job)}
                    </span>
                    <span className="mt-1 block text-[11px] text-[var(--text-3)]">
                      {formatMemoryJobTime(job.completedAt ?? job.createdAt)}
                    </span>
                  </span>
                </CollapsibleTrigger>
                {canRetry && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={busyAction !== null}
                    onClick={() => onRetry(job.jobId)}
                  >
                    <RotateCcw size={14} />
                    重试
                  </Button>
                )}
                {canCancel && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={busyAction !== null}
                    onClick={() => onCancel(job.jobId)}
                  >
                    <Square size={13} />
                    停止
                  </Button>
                )}
              </div>
              <CollapsibleContent>
                <div className="border-t border-border px-3 pb-3 pt-3">
                  <MemoryJobResultDetail job={job} onOpenMemory={onOpenMemory} onUndo={onUndo} />
                </div>
              </CollapsibleContent>
            </article>
          </Collapsible>
        )
      })}
    </div>
  )
}

function MemoryJobResultDetail({ job, onOpenMemory, onUndo }: { job: MemorySettingsJobSummary; onOpenMemory?: (memoryId: string) => void; onUndo?: (mutationId: string) => void }) {
  if (job.error) {
    return <div className="break-words rounded-[6px] bg-red-500/5 px-3 py-2 text-[12px] leading-5 text-red-700">{job.error}</div>
  }
  if (!job.result) {
    return job.progress
      ? <MemoryJobProgressDetail job={job} />
      : <div className="text-[12px] leading-5 text-[var(--text-3)]">任务尚未产生可展示的结果。</div>
  }

  switch (job.result.kind) {
    case 'history':
      return <HistoryResultDetail result={job.result.data} />
    case 'entries':
      return <EntriesResultDetail result={job.result.data} />
    case 'external_ingest':
      return <IngestResultDetail result={job.result.data} />
    case 'turn_extract':
      return <MetricGrid items={[['扫描项目', job.result.data.scannedItems], ['产生变更', job.result.data.changedItems]]} />
    case 'consolidation':
      return <DreamResultDetail result={job.result.data} onOpenMemory={onOpenMemory} onUndo={onUndo} />
  }
}

function DreamResultDetail({
  result,
  onOpenMemory,
  onUndo,
}: {
  result: MemoryDreamResult
  onOpenMemory?: (memoryId: string) => void
  onUndo?: (mutationId: string) => void
}) {
  const actionLabels: Record<string, string> = {
    created: '新增',
    versioned: '生成新版本',
    updated: '更新',
    merged: '合并',
    stale: '标记过期',
    pending: '待处理',
    ignored: '未处理',
  }
  return (
    <div className="space-y-3">
      <MetricGrid items={[
        ['检查会话', result.sessionsReviewed],
        ['核对证据', result.evidenceItemsReviewed],
        ['扫描记忆', result.scannedEntries],
        ['产生变更', result.actions.created + result.actions.versioned + result.actions.updated + result.actions.merged + result.actions.stale],
      ]} extra={result.rebuilt.length > 0 ? `已重建：${result.rebuilt.join('、')}` : undefined} />
      {result.items.length === 0 ? (
        <div className="text-[12px] leading-5 text-[var(--text-3)]">记忆已经整理妥当，本次没有变更。</div>
      ) : (
        <div className="space-y-2">
          <div className="text-[11px] font-medium text-[var(--text-3)]">整理明细</div>
          {result.items.slice(0, 20).map((item, index) => {
            const fieldDiffs = buildMemoryMutationFieldDiffs(item.before, item.after)
            return (
            <div key={`${item.mutationId ?? item.memoryIds.join('-')}-${index}`} className="lume-subpanel p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-[var(--text-1)]">{actionLabels[item.action] ?? item.action}</span>
                <div className="flex gap-1.5">
                  {item.memoryIds[0] && onOpenMemory && <Button variant="ghost" size="sm" onClick={() => onOpenMemory(item.memoryIds[0]!)}>查看记忆</Button>}
                  {item.undoable && item.mutationId && onUndo && <Button variant="ghost" size="sm" onClick={() => onUndo(item.mutationId!)}>撤销</Button>}
                </div>
              </div>
              {item.before?.statement && item.after?.statement && item.before.statement !== item.after.statement ? (
                <div className="mt-1.5 space-y-1 text-[11px] leading-4">
                  <div className="break-words text-[var(--text-3)]">原：{item.before.statement}</div>
                  <div className="break-words text-[var(--text-1)]">新：{item.after.statement}</div>
                </div>
              ) : item.after?.statement ? (
                <div className="mt-1.5 break-words text-[12px] leading-5 text-[var(--text-1)]">{item.after.statement}</div>
              ) : null}
              {fieldDiffs.length > 0 && (
                <div className="mt-1.5 space-y-1 text-[10px] leading-4 text-[var(--text-3)]">
                  {fieldDiffs.map((diff) => (
                    <div key={diff.key}>{diff.label}：{diff.before ?? '无'} → {diff.after ?? '无'}</div>
                  ))}
                </div>
              )}
              <div className="mt-1 break-words text-[11px] leading-4 text-[var(--text-3)]">{item.reason}</div>
              {item.evidenceRefs.length > 0 && (
                <div className="mt-1 space-y-0.5 text-[10px] text-[var(--text-3)]">
                  <div>依据 {item.evidenceRefs.length} 条来源</div>
                  {item.evidenceRefs.slice(0, 3).map((ref, refIndex) => (
                    <div key={`${ref.type}-${ref.id ?? ref.path ?? refIndex}`} className="truncate">
                      {dreamEvidenceLabel(ref.type)}{ref.id || ref.path ? ` · ${ref.id ?? ref.path}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )})}
        </div>
      )}
      {result.warnings.length > 0 && <div className="rounded-[6px] bg-amber-500/5 px-3 py-2 text-[11px] leading-4 text-amber-700">{result.warnings.join('；')}</div>}
    </div>
  )
}

function dreamEvidenceLabel(type: MemoryDreamResult['items'][number]['evidenceRefs'][number]['type']): string {
  const labels = {
    user_message: '用户消息',
    assistant_message: 'Assistant 上下文',
    tool_result: '工具结果',
    external_file: '外部文件',
    workspace_file: '工作区文件',
    manual: '手动记录',
    consolidation: '连续性摘要',
  } satisfies Record<typeof type, string>
  return labels[type]
}

function MemoryJobProgressDetail({ job }: { job: MemorySettingsJobSummary }) {
  const progress = job.progress
  if (!progress) return null
  const metrics: Array<[string, number]> = []
  if (progress.scannedItems !== undefined) metrics.push(['已扫描', progress.scannedItems])
  if (progress.processedItems !== undefined) metrics.push(['已处理', progress.processedItems])
  if (progress.reviewedSessions !== undefined) metrics.push(['检查会话', progress.reviewedSessions])
  if (progress.reviewedEvidence !== undefined) metrics.push(['核对证据', progress.reviewedEvidence])
  if (progress.proposedActions !== undefined) metrics.push(['整理建议', progress.proposedActions])
  if (progress.changedItems !== undefined) metrics.push(['已变更', progress.changedItems])
  if (progress.candidateCount !== undefined) metrics.push(['候选', progress.candidateCount])
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium text-[var(--text-2)]">{progress.phase}</div>
      {metrics.length > 0 && <MetricGrid items={metrics} />}
      {progress.changedFiles.length > 0 && (
        <div className="rounded-[6px] bg-[var(--surface-2)] px-2.5 py-2 text-[11px] leading-5 text-[var(--text-3)]">
          <div className="font-medium text-[var(--text-2)]">变更文件</div>
          {progress.changedFiles.map((path) => <div key={path} className="break-all">{path}</div>)}
        </div>
      )}
    </div>
  )
}

function HistoryResultDetail({ result }: { result: MemoryOrganizeHistoryResult }) {
  return (
    <div className="space-y-3">
      <MetricGrid items={[
        ['扫描来源', result.scannedSources],
        ['扫描消息', result.scannedMessages],
        ['候选', result.candidateCount],
        ['已写入', result.actions.new + result.actions.related],
      ]} />
      <ResultItems items={result.items.map((item) => ({
        action: MEMORY_JOB_RESULT_ACTION_LABELS[item.action] ?? item.action,
        statement: item.statement,
        reason: item.reason,
        source: item.sourcePath,
      }))} />
    </div>
  )
}

function EntriesResultDetail({ result }: { result: MemoryOrganizeEntriesResult }) {
  return (
    <div className="space-y-3">
      <MetricGrid items={[
        ['扫描记忆', result.scannedEntries],
        ['保留', result.keptEntries],
        ['合并重复', result.supersededDuplicates],
        ['更新', result.updated ?? 0],
      ]} />
      <ResultItems items={result.items.map((item) => ({
        action: '已合并',
        statement: item.statement,
        reason: `${item.reason}；重复内容：${item.duplicateStatement}`,
        source: item.scope === 'global' ? '全局' : '工作区',
      }))} />
    </div>
  )
}

function IngestResultDetail({ result }: { result: MemoryIngestSourcesResult }) {
  return (
    <div className="space-y-3">
      <MetricGrid items={[
        ['扫描来源', result.scannedSources],
        ['扫描分块', result.scannedChunks],
        ['扫描批次', result.scannedBatches],
        ['候选', result.candidateCount],
        ['已写入', result.actions.new + result.actions.related],
      ]} />
      <ResultItems items={result.items.map((item) => ({
        action: MEMORY_JOB_RESULT_ACTION_LABELS[item.action] ?? item.action,
        statement: item.statement,
        reason: item.reason,
        source: item.sourcePath,
      }))} />
    </div>
  )
}

function MetricGrid({
  items,
  extra,
}: {
  items: Array<[string, number]>
  extra?: string
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-[6px] bg-[var(--surface-2)] px-2.5 py-2">
            <div className="text-[10px] text-[var(--text-3)]">{label}</div>
            <div className="mt-0.5 text-[14px] font-semibold text-[var(--text-1)]">{value}</div>
          </div>
        ))}
      </div>
      {extra && <div className="break-words text-[11px] leading-4 text-[var(--text-3)]">{extra}</div>}
    </div>
  )
}

function ResultItems({
  items,
}: {
  items: Array<{ action: string; statement: string; reason: string; source: string }>
}) {
  if (items.length === 0) {
    return <div className="text-[12px] leading-5 text-[var(--text-3)]">没有逐条变更。</div>
  }
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-medium text-[var(--text-3)]">处理明细</div>
      {items.slice(0, 20).map((item, index) => (
        <div key={`${item.statement}-${index}`} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-3)]">
            <span className="font-medium text-[var(--text-1)]">{item.action}</span>
            <span>{item.source}</span>
          </div>
          <div className="mt-1 break-words text-[12px] leading-5 text-[var(--text-1)]">{item.statement}</div>
          <div className="mt-1 break-words text-[11px] leading-4 text-[var(--text-3)]">{item.reason}</div>
        </div>
      ))}
      {items.length > 20 && <div className="text-[11px] text-[var(--text-3)]">仅展示前 20 条，完整结果已保存在任务记录中。</div>}
    </div>
  )
}
