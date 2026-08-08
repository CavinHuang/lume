import { useCallback, useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import {
  Ban,
  Check,
  Inbox,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  agentWorkspacesAtom,
  currentWorkspaceIdAtom,
  suggestionsVersionAtom,
} from '@/atoms'
import { Button } from '@/components/ui/button'
import { listAutomationJobs } from '@/lib/desktop-api/automation'
import { getMemorySettingsSnapshot } from '@/lib/desktop-api'
import {
  actOnSuggestion,
  deleteSuggestion,
  getSuggestionStats,
  listSuggestions,
  runSuggestionAnalysis,
} from '@/lib/desktop-api/suggestion'
import { cn } from '@/lib/utils'
import type {
  AutomationJob,
  AutomationSchedule,
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
  /** 打开「设置 → 记忆」面板。由 Task 17 父组件注入；未提供时隐藏「管理记忆」按钮。 */
  onOpenMemorySettings?: () => void
}

export function ProactiveHub({ onOpenMemorySettings }: ProactiveHubProps) {
  const version = useAtomValue(suggestionsVersionAtom)
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom)
  const workspaces = useAtomValue(agentWorkspacesAtom)
  const workspaceSlug =
    workspaces.find((w) => w.id === currentWorkspaceId)?.slug ??
    workspaces[0]?.slug

  const [suggestions, setSuggestions] = useState<SuggestionRecord[]>([])
  const [automations, setAutomations] = useState<AutomationJob[]>([])
  const [snapshot, setSnapshot] = useState<MemorySettingsSnapshot | null>(null)
  const [stats, setStats] = useState<SuggestionStats | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)

  /**
   * 并发拉取四个独立数据源；每个源各自 catch → 失败仅降级为该 section 的空状态，
   * 不影响其它 section 展示（Promise.all + per-task catch 等价 allSettled 但更直白）。
   */
  const refresh = useCallback(async () => {
    await Promise.all([
      listSuggestions('suggested')
        .then(setSuggestions)
        .catch((err) => {
          console.error('[ProactiveHub] listSuggestions failed', err)
        }),
      listAutomationJobs()
        .then((jobs) => setAutomations(jobs.filter((job) => job.enabled)))
        .catch((err) => {
          console.error('[ProactiveHub] listAutomationJobs failed', err)
          setAutomations([])
        }),
      getSuggestionStats()
        .then(setStats)
        .catch((err) => {
          console.error('[ProactiveHub] getSuggestionStats failed', err)
        }),
      workspaceSlug
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
  }, [workspaceSlug])

  useEffect(() => {
    void refresh()
  }, [refresh, version])

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

  const pendingItems = (snapshot?.pending ?? []).filter(
    (item) => item.status === 'open',
  )
  const pendingCount = snapshot?.counts.pending.total ?? pendingItems.length
  const memoryCount = snapshot?.counts.active ?? null
  const focusTotal =
    automations.length + suggestions.length + pendingCount

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-[var(--lume-bg-app)]">
      <header className="shrink-0 px-6 pt-3 md:px-8 lg:px-10 lg:pt-4">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">主动中心</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              关注 {focusTotal} 件事 + {suggestions.length} 条建议待定
            </p>
          </div>
          <Button onClick={analyze} disabled={analyzing} data-proactive-analyze>
            <Wand2 className={analyzing ? 'animate-spin' : undefined} size={16} />
            {analyzing ? '分析中…' : '分析工作模式'}
          </Button>
        </div>
      </header>

      <main className="agent-message-scrollbar w-full min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pb-6 pt-4 md:px-8 lg:px-10 lg:pb-8">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile
            label="主动任务"
            value={automations.length}
            data-proactive-stat="automation"
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

        <Section title="正在关注" icon={<Check size={15} />}>
          {automations.length === 0 ? (
            <EmptyState
              text="暂无活跃的自动化任务"
              hint="到「自动化」页面创建定时任务，让 Lume 持续跟进。"
            />
          ) : (
            <div className="space-y-2">
              {automations.map((job) => (
                <AutomationRow key={job.id} job={job} />
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
                  hint="打开记忆设置查看全部。"
                />
              ) : (
                pendingItems.map((item) => (
                  <PendingMemoryRow key={item.id} item={item} />
                ))
              )}
              {onOpenMemorySettings && (
                <div className="pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onOpenMemorySettings}
                    data-proactive-open-memory
                  >
                    <Sparkles size={14} />
                    管理记忆
                  </Button>
                </div>
              )}
            </div>
          )}
        </Section>

        <Section title="用户画像" icon={<Sparkles size={15} />}>
          <EmptyState
            text="用户画像即将上线"
            hint="下一阶段会基于长期记忆生成你的工作风格画像。"
          />
        </Section>
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

function AutomationRow({ job }: { job: AutomationJob }) {
  return (
    <article className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-[var(--surface-1)] px-4 py-3 shadow-sm">
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold">{job.name}</div>
        {job.description && (
          <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
            {job.description}
          </p>
        )}
      </div>
      <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        {formatSchedule(job.schedule)}
      </span>
    </article>
  )
}

function PendingMemoryRow({ item }: { item: MemorySettingsPendingSummary }) {
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
    </article>
  )
}

const PENDING_LABEL: Record<MemorySettingsPendingSummary['type'], string> = {
  conflict: '冲突',
  stale: '过期',
  'low-confidence': '低置信',
}

/**
 * 把 AutomationSchedule 渲染为人类可读的简短文案。
 * cron → 「每天 09:00」「每周一 09:00」等常见模式；非常规 cron 直接显示表达式。
 */
export function formatSchedule(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case 'manual':
      return '手动'
    case 'once':
      return schedule.runAt
        ? `单次 · ${new Date(schedule.runAt).toLocaleString()}`
        : '单次'
    case 'interval':
      return schedule.intervalMs
        ? `每 ${formatInterval(schedule.intervalMs)}`
        : '固定间隔'
    case 'cron':
      return describeCron(schedule.cronExpr ?? '')
    default:
      return '—'
  }
}

function formatInterval(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

/** 仅覆盖最常见 cron 模式；未识别时回退到原始表达式。 */
function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [minute, hour, , , weekday] = parts
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return expr
  const hh = Number(hour).toString().padStart(2, '0')
  const mm = Number(minute).toString().padStart(2, '0')
  if (weekday === '*') return `每天 ${hh}:${mm}`
  if (/^\d+$/.test(weekday)) return `每${WEEKDAY_LABEL[weekday] ?? weekday} ${hh}:${mm}`
  if (weekday === '1-5') return `工作日 ${hh}:${mm}`
  return expr
}

const WEEKDAY_LABEL: Record<string, string> = {
  '0': '周日',
  '1': '周一',
  '2': '周二',
  '3': '周三',
  '4': '周四',
  '5': '周五',
  '6': '周六',
  '7': '周日',
}
