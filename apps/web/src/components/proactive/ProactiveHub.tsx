import { useCallback, useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import {
  Ban,
  Check,
  Inbox,
  Sparkles,
  Trash2,
  Wand2,
  X,
  Brain,
  History,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  suggestionsVersionAtom,
  memoryCenterDeepLinkAtom,
  memoryCenterVersionAtom,
} from '@/atoms'
import { Button } from '@/components/ui/button'
import { getMemorySettingsSnapshot, resolveMemoryPending } from '@/lib/desktop-api/memory-center'
import {
  actOnSuggestion,
  deleteSuggestion,
  getSuggestionStats,
  listSuggestions,
  runSuggestionAnalysis,
} from '@/lib/desktop-api/suggestion'
import { cn } from '@/lib/utils'
import {
  MemoryActivityContent,
  MemoryCenterContent,
  PersonaCard,
} from '@/components/settings/MemorySettings'
import { normalizeMemoryCenterLink } from '@/components/memory/memory-center-state'
import type {
  MemorySettingsPendingSummary,
  MemorySettingsSnapshot,
  SuggestionFeedback,
  SuggestionKind,
  SuggestionRecord,
  SuggestionStats,
} from '@lume/shared'

const KIND_LABEL: Record<SuggestionKind, string> = {
  correction: '修正',
  followup: '跟进',
  automation: '自动化',
  todo: '待办',
  skill: '技能',
}

/**
 * 主动中心：聚合建议 / 自动化 / 待确认记忆 / 用户画像 的单一视图。
 * Task 17 会将其挂到侧栏作为独立入口。
 *
 * 数据并发拉取（Promise.all），任一失败不阻塞其它 section；
 * 订阅 suggestionsVersionAtom → sidecar 推送 CHANGED 时 bump → 触发重拉。
 */
export interface ProactiveHubProps {
  /** 兼容旧调用方；记忆管理已经收敛到当前中心。 */
  onOpenMemorySettings?: () => void
}

export function ProactiveHub(_props: ProactiveHubProps) {
  const version = useAtomValue(suggestionsVersionAtom)
  const memoryVersion = useAtomValue(memoryCenterVersionAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceSlug =
    workspaces.find((w) => w.id === currentWorkspaceId)?.slug ??
    workspaces[0]?.slug

  const [suggestions, setSuggestions] = useState<SuggestionRecord[]>([])
  const [snapshot, setSnapshot] = useState<MemorySettingsSnapshot | null>(null)
  const [stats, setStats] = useState<SuggestionStats | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [busyPendingId, setBusyPendingId] = useState<string | null>(null)
  const [deepLink, setDeepLink] = useAtom(memoryCenterDeepLinkAtom)
  const section = deepLink.section

  useEffect(() => {
    if (!workspaceSlug || deepLink.workspaceSlug === workspaceSlug) return
    setDeepLink(normalizeMemoryCenterLink(deepLink, workspaceSlug))
  }, [deepLink, setDeepLink, workspaceSlug])

  /**
   * 并发拉取独立数据源；每个源各自 catch → 失败仅降级为该 section 的空状态，
   * 不影响其它 section 展示（Promise.all + per-task catch 等价 allSettled 但更直白）。
   */
  const refresh = useCallback(async () => {
    await Promise.all([
      listSuggestions('suggested')
        .then(setSuggestions)
        .catch((err) => {
          console.error('[ProactiveHub] listSuggestions failed', err)
        }),
      getSuggestionStats()
        .then(setStats)
        .catch((err) => {
          console.error('[ProactiveHub] getSuggestionStats failed', err)
        }),
      workspaceSlug && (section === 'attention' || section === 'insights')
        ? getMemorySettingsSnapshot(workspaceSlug)
            .then(setSnapshot)
            .catch((err) => {
              console.error(
                '[ProactiveHub] getMemorySettingsSnapshot failed',
                err,
              )
              setSnapshot(null)
            })
        : Promise.resolve(),
    ])
    if (!workspaceSlug) setSnapshot(null)
  }, [section, workspaceSlug])

  useEffect(() => {
    void refresh()
  }, [refresh, memoryVersion, version])

  const reloadSuggestions = useCallback(async () => {
    const [list, nextStats] = await Promise.all([
      listSuggestions('suggested'),
      getSuggestionStats().catch(() => null),
    ])
    setSuggestions(list)
    if (nextStats) setStats(nextStats)
  }, [])

  const analyze = async () => {
    setAnalyzing(true)
    try {
      const result = await runSuggestionAnalysis(workspaceSlug)
      toast.success(
        result.added > 0
          ? `分析完成，新增 ${result.added} 条建议`
          : '分析完成，暂无新建议',
      )
      await reloadSuggestions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '工作模式分析失败')
    } finally {
      setAnalyzing(false)
    }
  }

  const handleAct = async (id: number, feedback: SuggestionFeedback) => {
    setBusyId(id)
    try {
      await actOnSuggestion(id, feedback)
      await reloadSuggestions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '反馈失败')
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (id: number) => {
    setBusyId(id)
    try {
      await deleteSuggestion(id)
      await reloadSuggestions()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setBusyId(null)
    }
  }

  const handlePending = async (
    item: MemorySettingsPendingSummary,
    action: 'accept' | 'reject',
  ) => {
    if (!workspaceSlug) return
    setBusyPendingId(item.id)
    try {
      await resolveMemoryPending({ workspaceSlug, path: item.path, action })
      await refresh()
      toast.success(action === 'accept' ? '已接受候选记忆' : '已保留现有记忆')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '处理记忆失败')
    } finally {
      setBusyPendingId(null)
    }
  }

  const pendingItems = (snapshot?.pending ?? []).filter(
    (item) => item.status === 'open',
  )
  const pendingCount = snapshot?.counts.pending.total ?? pendingItems.length
  const memoryCount = snapshot?.counts.active ?? null
  const focusTotal = suggestions.length + pendingCount

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--lume-bg-app)]">
      <header className="shrink-0 px-6 pt-3 md:px-8 lg:px-10 lg:pt-4">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">记忆与洞察</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {focusTotal > 0 ? `${focusTotal} 件事需要处理` : '当前无需处理'}
            </p>
          </div>
          {(section === 'attention' || section === 'insights') && <Button onClick={analyze} disabled={analyzing} data-proactive-analyze>
            <Wand2 className={analyzing ? 'animate-spin' : undefined} size={16} />
            {analyzing ? '分析中…' : '分析工作模式'}
          </Button>}
        </div>
        <div className="lume-segmented mt-4 grid grid-cols-4 overflow-hidden">
          {([
            ['attention', '需要处理', Inbox],
            ['memory', '记忆', Brain],
            ['insights', '洞察', Sparkles],
            ['activity', '活动', History],
          ] as const).map(([id, label, Icon]) => (
            <Button
              key={id}
              variant="ghost"
              className={cn('lume-segmented-item min-h-10', section === id && 'lume-segmented-item-active')}
              onClick={() => setDeepLink({ section: id, workspaceSlug })}
              data-memory-center-section={id}
            >
              <Icon size={14} />
              {label}
            </Button>
          ))}
        </div>
      </header>

      <main className="agent-message-scrollbar w-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pb-6 pt-4 md:px-8 lg:px-10 lg:pb-8">
        {section === 'attention' && <>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label="待确认"
            value={pendingCount}
            data-proactive-stat="pending"
          />
          <StatTile
            label="待定建议"
            value={stats?.suggestedCount ?? 0}
            data-proactive-stat="suggested"
          />
          <StatTile
            label="长期记忆"
            value={memoryCount ?? '—'}
            data-proactive-stat="memory"
          />
          <StatTile
            label="今日采纳"
            value={stats?.todayAccepted ?? 0}
            data-proactive-stat="accepted"
          />
        </div>

        <Section title="Proma 建议" icon={<Sparkles size={15} />}>
          {suggestions.length === 0 ? (
            <EmptyState
              text="暂无待定建议"
              hint="点击右上角「分析工作模式」，让 Lume 回顾近期对话生成建议。"
            />
          ) : (
            <div className="space-y-2">
              {suggestions.map((record) => (
                <SuggestionRow
                  key={record.id}
                  record={record}
                  busy={busyId === record.id}
                  onAct={(feedback) => handleAct(record.id, feedback)}
                  onDelete={() => handleDelete(record.id)}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title="需要确认" icon={<Inbox size={15} />}>
          {pendingCount === 0 ? (
            <EmptyState
              text="暂无待确认记忆"
              hint="当 Lume 提取的记忆与现有内容冲突或置信度较低时会出现在这里。"
            />
          ) : (
            <div className="space-y-2">
              {pendingItems.length === 0 ? (
                <EmptyState
                  text={`${pendingCount} 条记忆待处理`}
                  hint="刷新后仍未显示时，请查看记忆活动中的任务状态。"
                />
              ) : (
                pendingItems.map((item) => (
                  <PendingMemoryRow
                    key={item.id}
                    item={item}
                    busy={busyPendingId === item.id}
                    onResolve={(action) => void handlePending(item, action)}
                  />
                ))
              )}
            </div>
          )}
        </Section>
        </>}

        {section === 'memory' && <MemoryCenterContent />}

        {section === 'insights' && workspaceSlug && (
          <div className="space-y-4">
            <PersonaCard workspaceSlug={workspaceSlug} />
            {snapshot?.workspaceBrief && (
              <section className="lume-panel p-4">
                <h2 className="text-sm font-semibold">当前工作区洞察</h2>
                <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                  {snapshot.workspaceBrief.markdown}
                </pre>
              </section>
            )}
            <Section title="工作模式建议" icon={<Sparkles size={15} />}>
              {suggestions.length === 0
                ? <EmptyState text="暂无待定建议" />
                : <div className="space-y-2">{suggestions.map((record) => (
                    <SuggestionRow key={record.id} record={record} busy={busyId === record.id} onAct={(feedback) => handleAct(record.id, feedback)} onDelete={() => handleDelete(record.id)} />
                  ))}</div>}
            </Section>
          </div>
        )}

        {section === 'activity' && <MemoryActivityContent />}
      </main>
    </div>
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
    <div
      className="rounded-xl border border-border/60 bg-[var(--surface-1)] px-4 py-3 shadow-sm"
      {...rest}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon: React.ReactNode
  children: React.ReactNode
}) {
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

function EmptyState({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/60 bg-muted/20 px-6 py-6 text-center">
      <div className="mb-2 flex size-9 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Inbox className="size-4" />
      </div>
      <div className="text-sm font-medium">{text}</div>
      {hint && (
        <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

function SuggestionRow({
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
        {record.reason && (
          <p className="text-[13px] leading-5 text-muted-foreground">
            {record.reason}
          </p>
        )}
        {record.evidence && (
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground/80">
            依据：{record.evidence}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <SuggestionButton
          action="accepted"
          recordId={record.id}
          onClick={() => onAct('accepted')}
          disabled={busy}
        >
          <Check size={13} />
          接受
        </SuggestionButton>
        <SuggestionButton
          action="ignored"
          recordId={record.id}
          aria-label="忽略此建议"
          onClick={() => onAct('ignored')}
          disabled={busy}
        >
          <X size={13} />
          忽略
        </SuggestionButton>
        <SuggestionButton
          action="never"
          recordId={record.id}
          aria-label="不再建议这类"
          onClick={() => onAct('never')}
          disabled={busy}
        >
          <Ban size={13} />
          不再建议这类
        </SuggestionButton>
        <Button
          variant="ghost"
          size="icon-sm"
          title="删除"
          aria-label="删除此建议"
          onClick={onDelete}
          disabled={busy}
          data-suggestion-delete={record.id}
        >
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
  className,
  children,
  'aria-label': ariaLabel,
}: {
  action: SuggestionFeedback
  recordId: number
  onClick: () => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
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
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full border border-border/60 px-2.5 text-[11px] font-semibold',
        className,
      )}
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
        <span
          className={cn(
            'rounded-md px-1.5 py-0.5 font-medium',
            item.type === 'conflict'
              ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
              : 'bg-muted',
          )}
        >
          {PENDING_LABEL[item.type]}
        </span>
        <span>{item.candidate.scope === 'global' ? '全局' : '工作区'}</span>
      </div>
      <p className="text-sm leading-5">{item.candidate.statement}</p>
      {item.reason && (
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
          {item.reason}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => onResolve('accept')} data-memory-pending-action="accept" data-memory-pending-id={item.id}>
          <Check size={14} />
          接受
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onResolve('reject')} data-memory-pending-action="reject" data-memory-pending-id={item.id}>
          <X size={14} />
          保留现有
        </Button>
      </div>
    </article>
  )
}

const PENDING_LABEL: Record<MemorySettingsPendingSummary['type'], string> = {
  conflict: '冲突',
  stale: '过期',
  'low-confidence': '低置信',
}
