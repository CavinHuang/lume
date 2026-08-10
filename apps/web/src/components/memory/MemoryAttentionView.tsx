import type { ReactNode } from 'react'
import { Ban, Check, Inbox, Sparkles, Trash2, X } from 'lucide-react'
import type {
  MemorySettingsPendingSummary,
  SuggestionFeedback,
  SuggestionKind,
  SuggestionRecord,
  SuggestionStats,
} from '@lume/shared'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const KIND_LABEL: Record<SuggestionKind, string> = {
  correction: '修正',
  followup: '跟进',
  automation: '自动化',
  todo: '待办',
  skill: '技能',
}

const PENDING_LABEL: Record<MemorySettingsPendingSummary['type'], string> = {
  conflict: '冲突',
  stale: '过期',
  'low-confidence': '低置信',
}

export interface MemoryAttentionViewProps {
  suggestions: SuggestionRecord[]
  pendingItems: MemorySettingsPendingSummary[]
  pendingCount: number
  memoryCount: number | null
  stats: SuggestionStats | null
  busySuggestionId: number | null
  busyPendingId: string | null
  onActSuggestion: (id: number, feedback: SuggestionFeedback) => void
  onDeleteSuggestion: (id: number) => void
  onResolvePending: (item: MemorySettingsPendingSummary, action: 'accept' | 'reject') => void
}

export function MemoryAttentionView({
  suggestions,
  pendingItems,
  pendingCount,
  memoryCount,
  stats,
  busySuggestionId,
  busyPendingId,
  onActSuggestion,
  onDeleteSuggestion,
  onResolvePending,
}: MemoryAttentionViewProps) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="待确认" value={pendingCount} data-proactive-stat="pending" />
        <StatTile label="待定建议" value={stats?.suggestedCount ?? 0} data-proactive-stat="suggested" />
        <StatTile label="长期记忆" value={memoryCount ?? '—'} data-proactive-stat="memory" />
        <StatTile label="今日采纳" value={stats?.todayAccepted ?? 0} data-proactive-stat="accepted" />
      </div>

      <MemorySection title="Lume 建议" icon={<Sparkles size={15} />}>
        {suggestions.length === 0 ? (
          <MemoryEmptyState
            text="暂无待定建议"
            hint="点击右上角「分析工作模式」，让 Lume 回顾近期对话生成建议。"
          />
        ) : (
          <div className="space-y-2">
            {suggestions.map((record) => (
              <SuggestionRow
                key={record.id}
                record={record}
                busy={busySuggestionId === record.id}
                onAct={(feedback) => onActSuggestion(record.id, feedback)}
                onDelete={() => onDeleteSuggestion(record.id)}
              />
            ))}
          </div>
        )}
      </MemorySection>

      <MemorySection title="需要确认" icon={<Inbox size={15} />}>
        {pendingCount === 0 ? (
          <MemoryEmptyState
            text="暂无待确认记忆"
            hint="当 Lume 提取的记忆与现有内容冲突或置信度较低时会出现在这里。"
          />
        ) : pendingItems.length === 0 ? (
          <MemoryEmptyState
            text={`${pendingCount} 条记忆待处理`}
            hint="刷新后仍未显示时，请查看记忆活动中的任务状态。"
          />
        ) : (
          <div className="space-y-2">
            {pendingItems.map((item) => (
              <PendingMemoryRow
                key={item.id}
                item={item}
                busy={busyPendingId === item.id}
                onResolve={(action) => onResolvePending(item, action)}
              />
            ))}
          </div>
        )}
      </MemorySection>
    </>
  )
}

function StatTile({
  label,
  value,
  ...rest
}: {
  label: string
  value: number | string
} & Record<string, unknown>) {
  return (
    <div className="rounded-xl border border-border/60 bg-[var(--surface-1)] px-4 py-3 shadow-sm" {...rest}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

export function MemorySection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  )
}

export function MemoryEmptyState({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-6 text-center">
      <div className="mb-2 flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Inbox className="size-4" />
      </div>
      <div className="text-sm font-medium">{text}</div>
      {hint && <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function SuggestionRow({
  record,
  busy,
  onAct,
  onDelete,
}: {
  record: SuggestionRecord
  busy: boolean
  onAct: (feedback: SuggestionFeedback) => void
  onDelete: () => void
}) {
  return (
    <article className="flex flex-col gap-2.5 rounded-xl border border-border/60 bg-[var(--surface-1)] px-4 py-3 shadow-sm sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
            {KIND_LABEL[record.kind]}
          </span>
          <h4 className="truncate text-sm font-semibold">{record.title}</h4>
        </div>
        {record.reason && <p className="text-[13px] leading-5 text-muted-foreground">{record.reason}</p>}
        {record.evidence && <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground/80">依据：{record.evidence}</p>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <SuggestionButton action="accepted" recordId={record.id} onClick={() => onAct('accepted')} disabled={busy}>
          <Check size={13} />接受
        </SuggestionButton>
        <SuggestionButton action="ignored" recordId={record.id} aria-label="忽略此建议" onClick={() => onAct('ignored')} disabled={busy}>
          <X size={13} />忽略
        </SuggestionButton>
        <SuggestionButton action="never" recordId={record.id} aria-label="不再建议这类" onClick={() => onAct('never')} disabled={busy}>
          <Ban size={13} />不再建议这类
        </SuggestionButton>
        <Button variant="ghost" size="icon-sm" title="删除" aria-label="删除此建议" onClick={onDelete} disabled={busy} data-suggestion-delete={record.id}>
          <Trash2 size={14} />
        </Button>
      </div>
    </article>
  )
}

function SuggestionButton({
  action,
  recordId,
  onClick,
  disabled,
  children,
  'aria-label': ariaLabel,
}: {
  action: SuggestionFeedback
  recordId: number
  onClick: () => void
  disabled?: boolean
  children: ReactNode
  'aria-label'?: string
}) {
  return (
    <Button
      variant="ghost"
      type="button"
      data-suggestion-action={action}
      data-suggestion-record-id={recordId}
      aria-label={ariaLabel}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-7 items-center gap-1 rounded-full border border-border/60 px-2.5 text-[11px] font-semibold"
    >
      {children}
    </Button>
  )
}

function PendingMemoryRow({
  item,
  busy,
  onResolve,
}: {
  item: MemorySettingsPendingSummary
  busy: boolean
  onResolve: (action: 'accept' | 'reject') => void
}) {
  return (
    <article className="rounded-xl border border-border/60 bg-[var(--surface-1)] px-4 py-3 shadow-sm">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className={cn('rounded-md px-1.5 py-0.5 font-medium', item.type === 'conflict' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-muted')}>
          {PENDING_LABEL[item.type]}
        </span>
        <span>{item.candidate.scope === 'global' ? '全局' : '工作区'}</span>
      </div>
      <p className="text-sm leading-5">{item.candidate.statement}</p>
      {item.reason && <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{item.reason}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve('accept')} data-memory-pending-action="accept" data-memory-pending-id={item.id}>
          <Check size={14} />接受
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResolve('reject')} data-memory-pending-action="reject" data-memory-pending-id={item.id}>
          <X size={14} />保留现有
        </Button>
      </div>
    </article>
  )
}
