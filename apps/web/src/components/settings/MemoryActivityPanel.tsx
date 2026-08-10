import * as React from 'react'
import type { MemoryMutationChange, MemorySettingsActivityItem } from '@lume/shared'
import { ArrowRight, ChevronDown, ChevronUp, Eye, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import {
  buildMemoryMutationFieldDiffs,
  MEMORY_MUTATION_ACTION_LABELS,
  MEMORY_MUTATION_ACTOR_LABELS,
} from './memory-activity-state'

interface MemoryActivityPanelProps {
  items: MemorySettingsActivityItem[]
  selectedMutationId?: string
  busyAction: string | null
  onOpenMemory: (memoryId: string) => void
  onUndo: (mutationId: string) => void
}

export function MemoryActivityPanel({
  items,
  selectedMutationId,
  busyAction,
  onOpenMemory,
  onUndo,
}: MemoryActivityPanelProps) {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set())
  const cardRefs = React.useRef(new Map<string, HTMLElement>())

  React.useEffect(() => {
    if (!selectedMutationId) return
    setExpanded((current) => new Set(current).add(selectedMutationId))
    const frame = window.requestAnimationFrame(() => {
      cardRefs.current.get(selectedMutationId)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectedMutationId, items])

  if (items.length === 0) {
    return <div className="rounded-[8px] border border-dashed border-border px-3 py-5 text-center text-[12px] text-[var(--text-3)]">暂无记忆活动</div>
  }

  return (
    <div className="space-y-2">
      {items.map((item) => {
        const open = expanded.has(item.mutationId)
        const count = item.changes.length || item.memoryIds.length
        return (
          <Collapsible
            key={item.mutationId}
            open={open}
            onOpenChange={(nextOpen) => setExpanded((current) => {
              const next = new Set(current)
              if (nextOpen) next.add(item.mutationId)
              else next.delete(item.mutationId)
              return next
            })}
          >
            <article
              ref={(node) => {
                if (node) cardRefs.current.set(item.mutationId, node)
                else cardRefs.current.delete(item.mutationId)
              }}
              className={cn(
                'lume-subpanel overflow-hidden',
                selectedMutationId === item.mutationId && 'ring-1 ring-[var(--brand)]',
              )}
              data-memory-mutation-id={item.mutationId}
            >
              <div className="flex min-w-0 items-start gap-2 p-3">
                <CollapsibleTrigger className="flex min-w-0 flex-1 items-start gap-3 text-left">
                  <span className="mt-0.5 shrink-0 text-[var(--text-3)]">
                    {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-[var(--text-1)]">
                        {MEMORY_MUTATION_ACTION_LABELS[item.action]}
                      </span>
                      {count > 0 && (
                        <span className="rounded-full bg-[var(--surface-3)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-3)]">
                          {count} 条
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block break-words text-[12px] leading-5 text-[var(--text-2)]">
                      {item.summary}
                    </span>
                    <span className="mt-1 block text-[11px] text-[var(--text-3)]">
                      {item.scope === 'global' ? '全局' : '工作区'} · {MEMORY_MUTATION_ACTOR_LABELS[item.actor]} · {formatActivityTime(item.createdAt)}
                    </span>
                  </span>
                </CollapsibleTrigger>
                {item.undoable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    disabled={busyAction !== null}
                    onClick={() => onUndo(item.mutationId)}
                  >
                    <RotateCcw size={14} />
                    撤销
                  </Button>
                )}
              </div>

              <CollapsibleContent>
                <div className="border-t border-border px-3 pb-3 pt-3">
                  {item.changes.length > 0 ? (
                    <div className="space-y-3">
                      {item.changes.map((change) => (
                        <MemoryChangeDetail
                          key={change.memoryId}
                          change={change}
                          onOpenMemory={onOpenMemory}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="text-[12px] leading-5 text-[var(--text-3)]">
                      {item.action === 'pending'
                        ? '这次变更进入待处理区，尚未写入可用记忆。'
                        : item.action === 'ignored'
                          ? '这次操作没有写入记忆。'
                          : '没有可展示的关联记忆内容。'}
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </article>
          </Collapsible>
        )
      })}
    </div>
  )
}

function MemoryChangeDetail({
  change,
  onOpenMemory,
}: {
  change: MemoryMutationChange
  onOpenMemory: (memoryId: string) => void
}) {
  const { before, after } = change
  const statementChanged = before?.statement !== undefined
    && after?.statement !== undefined
    && before.statement !== after.statement
  const fieldDiffs = buildMemoryMutationFieldDiffs(before, after)
  const current = after ?? before

  return (
    <div className="rounded-[8px] border border-border bg-[var(--surface-1)] p-3">
      {change.accuracy === 'current' && (
        <div className="mb-2 rounded-[6px] bg-[var(--surface-2)] px-2 py-1.5 text-[11px] leading-4 text-[var(--text-3)]">
          旧活动未保存当时快照，以下为当前关联内容。
        </div>
      )}

      {statementChanged ? (
        <div className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-stretch">
          <StatementBlock label="变更前" statement={before?.statement} />
          <ArrowRight className="hidden self-center text-[var(--text-3)] md:block" size={16} />
          <StatementBlock label="变更后" statement={after?.statement} />
        </div>
      ) : current?.statement ? (
        <StatementBlock label={before && !after ? '变更前' : '记忆内容'} statement={current.statement} />
      ) : (
        <div className="break-all text-[12px] text-[var(--text-3)]">记忆 ID：{change.memoryId}</div>
      )}

      {fieldDiffs.length > 0 && (
        <dl className="mt-3 space-y-2 border-t border-border pt-3">
          {fieldDiffs.map((diff) => (
            <div key={diff.key} className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2 text-[11px] leading-4">
              <dt className="text-[var(--text-3)]">{diff.label}</dt>
              <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-[var(--text-2)]">
                <span className="break-words">{diff.before ?? '未设置'}</span>
                <ArrowRight size={12} className="shrink-0 text-[var(--text-3)]" />
                <span className="break-words font-medium text-[var(--text-1)]">{diff.after ?? '未设置'}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {current && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-[10px] text-[var(--text-3)]">
            {current.scope === 'global' ? '全局' : '工作区'} · revision {current.revision}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpenMemory(change.memoryId)}>
            <Eye size={14} />
            查看记忆
          </Button>
        </div>
      )}
    </div>
  )
}

function StatementBlock({ label, statement }: { label: string; statement?: string }) {
  return (
    <div className="min-w-0 rounded-[6px] bg-[var(--surface-2)] p-2.5">
      <div className="text-[10px] font-medium text-[var(--text-3)]">{label}</div>
      <div className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-[var(--text-1)]">
        {statement || '无内容'}
      </div>
    </div>
  )
}

function formatActivityTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
