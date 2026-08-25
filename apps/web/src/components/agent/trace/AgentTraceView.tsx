import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { Bot, ChevronRight, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentSubagentRunsFamily } from '@/atoms'
import { useAgentEventBus } from '@/hooks/useAgentEventBus'
import type { SdkEventEnvelope, NormalizedProviderUsage, SubagentRunRecord } from '@lume/shared'
import { buildTraceRecords, type TraceRecord, type TraceRecordKind } from './build-trace-records'

/**
 * Trace 视图（参考 dsh Trajectory）：turn 分组的事件账本 + 顶部时间概览条 + 行选中详情面板。
 * 数据直接消费线程事件总线快照与推送，与消息视图互不影响。
 * 概览条支持拖拽选区间过滤账本（右键/Esc 清除）、500ms 悬停浮层、assistant span 的 TTFT/解码双色调。
 */

const MAX_ENVELOPES = 8000 // ponytail: 超长线程截断最旧事件；update 折叠后 update 不再堆积；账本行经 content-visibility 跳过屏外布局/绘制，若实测 reconcile 仍高再换窗口化列表

const FLUSH_INTERVAL_MS = 100

/** 累计语义的流式帧：同 runId+turnId 的相邻 update 只需保留最新一条。 */
function isCumulativeUpdate(event: SdkEventEnvelope): boolean {
  return event.kind === 'message' && event.phase === 'update'
}

const KIND_META: Record<TraceRecordKind, { label: string; badge: string; segment: string }> = {
  user: { label: '用户', badge: 'text-[var(--lume-text-muted)]', segment: 'bg-[var(--lume-text-muted)]/50' },
  assistant: { label: '助手', badge: 'text-[var(--lume-accent)]', segment: 'bg-[var(--lume-accent)]' },
  tool: { label: '工具', badge: 'text-[var(--lume-accent-2)]', segment: 'bg-[var(--lume-accent-2)]' },
  compaction: { label: '压缩', badge: 'text-[var(--lume-warning)]', segment: 'bg-[var(--lume-warning)]' },
  run: { label: '运行', badge: 'text-[var(--lume-success)]', segment: 'bg-[var(--lume-success)]' },
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`
}

/** 概览条上的选中区间（线程时间域内的毫秒）。 */
export interface TraceTimeRange {
  startMs: number
  endMs: number
}

const HOVER_DELAY_MS = 500 // 对齐 dsh：悬停半秒才出浮层，避免扫过时闪烁

const SUBAGENT_STATUS_META: Record<string, { label: string; cls: string }> = {
  accepted: { label: '已受理', cls: 'text-[var(--lume-text-muted)]' },
  running: { label: '运行中', cls: 'text-[var(--lume-accent)]' },
  completed: { label: '完成', cls: 'text-[var(--lume-success)]' },
  errored: { label: '失败', cls: 'text-[var(--lume-danger)]' },
  // 中止与排队语义不同终局，暗色下不能用同 muted 色（评审⑧）
  aborted: { label: '已中止', cls: 'text-[var(--lume-danger)]/80' },
  timed_out: { label: '超时', cls: 'text-[var(--lume-warning)]' },
}

const EMPTY_SUBAGENT_RUNS: SubagentRunRecord[] = []

function fmtTokens(n?: number): string {
  return n == null ? '—' : n.toLocaleString('zh-CN')
}

/** 单条用量摘要行（assistant inspector 用）。 */
function fmtUsageSummary(usage: NormalizedProviderUsage): string {
  const parts = [`输入 ${fmtTokens(usage.inputTokens)}`, `输出 ${fmtTokens(usage.outputTokens)}`]
  if (usage.cacheReadInputTokens > 0) parts.push(`缓存读 ${fmtTokens(usage.cacheReadInputTokens)}`)
  if (usage.cacheCreationInputTokens > 0) parts.push(`缓存写 ${fmtTokens(usage.cacheCreationInputTokens)}`)
  return parts.join(' · ')
}

function OverviewBar({
  records,
  selectedId,
  onSelect,
  range,
  onRangeCommit,
  onRangeClear,
}: {
  records: TraceRecord[]
  selectedId: string | null
  onSelect: (id: string) => void
  range: TraceTimeRange | null
  onRangeCommit: (range: TraceTimeRange) => void
  onRangeClear: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<TraceTimeRange | null>(null)
  const dragRef = useRef<{ startPct: number; pointerId: number; captured: boolean; moved: boolean } | null>(null)
  // 缩放后的可视时间窗（null = 全域）。滚轮缩放以光标为锚，右键拖拽平移，双击/Esc 重置。
  const [view, setView] = useState<TraceTimeRange | null>(null)
  const panRef = useRef<{ anchorX: number; orig: TraceTimeRange; moved: boolean; pointerId: number; captured: boolean } | null>(null)
  // 平移发生过则紧随的 contextmenu 不再视为"右键单击清除"
  const panMovedRef = useRef(false)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hoverVisible, setHoverVisible] = useState(false)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // 手势事件（wheel/平移/拖拽）最高可达触控板惯性频率：先写 ref，rAF 每帧应用一次，
  // 避免 120Hz+ 输入直接打满 React 渲染
  const pendingViewRef = useRef<((prev: TraceTimeRange | null) => TraceTimeRange | null) | null>(null)
  const pendingDraftRef = useRef<TraceTimeRange | null | ((prev: TraceTimeRange | null) => TraceTimeRange | null)>(null)
  const rafRef = useRef<number | null>(null)
  const scheduleGestureFlush = () => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const viewUpdate = pendingViewRef.current
      pendingViewRef.current = null
      if (viewUpdate) setView(viewUpdate)
      setDraft(pendingDraftRef.current)
      pendingDraftRef.current = null
    })
  }
  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
  }, [])

  /** 视图与全域重合时归一化为 null，避免出现假的「已缩放」态。 */
  const normalizeView = (next: TraceTimeRange): TraceTimeRange | null => {
    const { startMs: dStart, endMs: dEnd } = domainRef.current
    return next.startMs <= dStart + 1 && next.endMs >= dEnd - 1 ? null : next
  }

  const domainStart = records[0]?.startedAt ?? 0
  let domainEnd = records[records.length - 1]?.endedAt ?? domainStart
  for (const r of records) if (r.startedAt > domainEnd) domainEnd = r.startedAt
  const domain = { startMs: domainStart, endMs: domainEnd }
  const domainRef = useRef(domain)
  domainRef.current = domain
  const viewStart = view?.startMs ?? domainStart
  const viewEnd = view?.endMs ?? domainEnd
  const span = Math.max(1, viewEnd - viewStart)

  // 缩放态下的贴尾跟随：视图右缘原本贴近域尾时，新记录到达随域扩展平移视图
  const prevDomainEndRef = useRef(domainEnd)
  useEffect(() => {
    const prevEnd = prevDomainEndRef.current
    prevDomainEndRef.current = domainEnd
    if (domainEnd <= prevEnd) return
    setView((prev) => {
      if (!prev || prev.endMs < prevEnd - 1) return prev
      const shift = domainEnd - prevEnd
      return { startMs: prev.startMs + shift, endMs: prev.endMs + shift }
    })
  }, [domainEnd])

  // 滚轮缩放：React 的 onWheel 是被动监听，preventDefault 需原生绑定
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const anchorPct = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
      pendingViewRef.current = (prev) => {
        const { startMs: dStart, endMs: dEnd } = domainRef.current
        const curStart = prev?.startMs ?? dStart
        const curEnd = prev?.endMs ?? dEnd
        const curSpan = curEnd - curStart
        const anchorMs = curStart + (anchorPct / 100) * curSpan
        const factor = e.deltaY < 0 ? 0.8 : 1.25
        const nextSpan = Math.min(Math.max(curSpan * factor, 1000), dEnd - dStart)
        let nextStart = anchorMs - (anchorPct / 100) * nextSpan
        nextStart = Math.min(Math.max(nextStart, dStart), dEnd - nextSpan)
        return normalizeView({ startMs: nextStart, endMs: nextStart + nextSpan })
      }
      scheduleGestureFlush()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      setView(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  // 超长账本按步长抽样渲染概览段，防 DOM 规模失控；被跳过的记录仍可从账本选中
  // （ponytail: 按 span 分桶聚合的保真度更高，实测需要时再换）
  const sampled = useMemo(() => {
    const stride = Math.max(1, Math.ceil(records.length / 400))
    return records
      .map((record, i) => ({ record, i }))
      .filter(({ record, i }) => i % stride === 0 || record.id === selectedId)
  }, [records, selectedId])

  useEffect(() => () => {
    if (hoverTimerRef.current != null) clearTimeout(hoverTimerRef.current)
  }, [])

  const pctFromEvent = (clientX: number): number => {
    const rect = containerRef.current!.getBoundingClientRect()
    return Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100))
  }

  const activeRange = draft ?? range
  const hovered = sampled.find(({ record }) => record.id === hoverId)?.record ?? null
  const hoverAnchorPct = hovered
    ? (((hovered.startedAt - viewStart) / span) * 100) +
      ((hovered.durationMs != null ? (hovered.durationMs / span) * 100 : 0.5) / 2)
    : 0

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="轨迹时间概览"
      className="relative h-7 shrink-0 touch-none border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)]"
      onPointerDown={(e) => {
        if (e.button === 2) {
          // 右键按下：进入平移（仅缩放态有实际效果）；惰性捕获——移动超阈值才捕获，
          // 未移动时让 contextmenu 正常走"单击清除"
          panMovedRef.current = false
          panRef.current = {
            anchorX: e.clientX,
            orig: view ?? { startMs: domainStart, endMs: domainEnd },
            moved: false,
            pointerId: e.pointerId,
            captured: false,
          }
          return
        }
        if (e.button !== 0) return
        // 左键：不立即捕获——立即捕获会把最终 click 重定向到容器，段的 onClick 永远收不到；
        // 移动超阈值后再捕获转入拖拽选区间
        dragRef.current = {
          startPct: pctFromEvent(e.clientX),
          pointerId: e.pointerId,
          captured: false,
          moved: false,
        }
        pendingDraftRef.current = {
          startMs: viewStart + (pctFromEvent(e.clientX) / 100) * span,
          endMs: viewStart + (pctFromEvent(e.clientX) / 100) * span,
        }
        scheduleGestureFlush()
      }}
      onPointerMove={(e) => {
        if (panRef.current) {
          const pan = panRef.current
          if (Math.abs(e.clientX - pan.anchorX) > 3) {
            pan.moved = true
            panMovedRef.current = true
            if (!pan.captured) {
              e.currentTarget.setPointerCapture(pan.pointerId)
              pan.captured = true
            }
          }
          if (!pan.moved) return
          const rect = containerRef.current!.getBoundingClientRect()
          const msPerPx = (pan.orig.endMs - pan.orig.startMs) / Math.max(1, rect.width)
          let nextStart = pan.orig.startMs - (e.clientX - pan.anchorX) * msPerPx
          nextStart = Math.min(Math.max(nextStart, domainStart), domainEnd - (pan.orig.endMs - pan.orig.startMs))
          pendingViewRef.current = () =>
            normalizeView({ startMs: nextStart, endMs: nextStart + (pan.orig.endMs - pan.orig.startMs) })
          scheduleGestureFlush()
          return
        }
        const drag = dragRef.current
        if (!drag) return
        const pct = pctFromEvent(e.clientX)
        if (Math.abs(pct - drag.startPct) > 0.5) {
          drag.moved = true
          if (!drag.captured) {
            e.currentTarget.setPointerCapture(drag.pointerId)
            drag.captured = true
          }
        }
        if (!drag.moved) return
        const a = viewStart + (Math.min(drag.startPct, pct) / 100) * span
        const b = viewStart + (Math.max(drag.startPct, pct) / 100) * span
        pendingDraftRef.current = { startMs: a, endMs: b }
        scheduleGestureFlush()
      }}
      onPointerUp={(e) => {
        if (panRef.current) {
          const wasPanClick = !panRef.current.moved
          if (panRef.current.captured) e.currentTarget.releasePointerCapture(e.pointerId)
          panRef.current = null
          // 右键单击（未拖动）= 清除区间过滤，对齐 dsh；平移后松开不清除
          if (wasPanClick) onRangeClear()
          return
        }
        const drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        if (drag.captured) e.currentTarget.releasePointerCapture(e.pointerId)
        const committed = draft
        pendingDraftRef.current = null
        setDraft(null)
        // 真拖拽才落区间；位移过小视为点击——交给段自身的 onClick 选中，不清除已有过滤
        if (committed && drag.moved && committed.endMs - committed.startMs > span * 0.002) {
          onRangeCommit(committed)
        }
      }}
      onPointerCancel={() => {
        // 触摸/系统抢占中断手势：清残留状态，防止幽灵选区
        dragRef.current = null
        panRef.current = null
        panMovedRef.current = false
        pendingDraftRef.current = null
        setDraft(null)
      }}
      onDoubleClick={() => setView(null)}
      onContextMenu={(e) => {
        e.preventDefault()
        if (!panMovedRef.current) onRangeClear()
      }}
    >
      {/* 段渲染层：独立裁剪（缩放态段可能越出容器），不影响向下伸出的浮层 */}
      <div className="absolute inset-0 overflow-hidden">
        {/* 已生效区间高亮 */}
        {activeRange && (
          <div
            aria-hidden
            className="absolute inset-y-0 bg-[var(--lume-accent)]/10 ring-1 ring-inset ring-[var(--lume-accent)]/40"
            style={{
              left: `${((activeRange.startMs - viewStart) / span) * 100}%`,
              width: `${((activeRange.endMs - activeRange.startMs) / span) * 100}%`,
            }}
          />
        )}
        {sampled.map(({ record }) => {
          // 完全落在可视窗外的段不渲染（缩放态）
          if (record.startedAt > viewEnd || (record.endedAt ?? record.startedAt) < viewStart) return null
          const left = ((record.startedAt - viewStart) / span) * 100
          const width = record.durationMs != null ? (record.durationMs / span) * 100 : 0.5
          const durationPct = record.durationMs != null ? (record.durationMs / span) * 100 : 0.5
          // assistant span 双色调：前段浅色为 TTFT（等待首字），后段实色为解码
          const twoTone = record.kind === 'assistant' && record.ttftMs != null && durationPct > 0.8
          const ttftFrac = twoTone ? Math.min(0.95, (record.ttftMs! / (record.durationMs ?? 1)) ) : 0
          return (
            <button
              key={record.id}
              type="button"
              aria-label={`概览采样 #${record.index} ${KIND_META[record.kind].label}${record.toolName ? ` ${record.toolName}` : ''} ${fmtClock(record.startedAt)} 耗时${fmtDuration(record.durationMs)}`}
              title={`#${record.index} ${KIND_META[record.kind].label} · ${fmtClock(record.startedAt)} · ${fmtDuration(record.durationMs)}`}
              onClick={() => onSelect(record.id)}
              onMouseEnter={() => {
                if (hoverTimerRef.current != null) clearTimeout(hoverTimerRef.current)
                setHoverId(record.id)
                setHoverVisible(false)
                hoverTimerRef.current = setTimeout(() => setHoverVisible(true), HOVER_DELAY_MS)
              }}
              onMouseLeave={() => {
                if (hoverTimerRef.current != null) clearTimeout(hoverTimerRef.current)
                setHoverId(null)
                setHoverVisible(false)
              }}
              className={cn(
                'absolute top-1/2 h-2 hover:h-3 -translate-y-1/2 rounded-sm min-w-[2px] cursor-pointer',
                twoTone
                  ? record.isError ? 'bg-[var(--lume-danger)]/50' : 'bg-[var(--lume-accent)]/50'
                  : KIND_META[record.kind].segment,
                record.isError && !twoTone && 'bg-[var(--lume-danger)]',
                record.running && 'animate-pulse motion-reduce:animate-none',
                selectedId === record.id && 'ring-1 ring-[var(--lume-accent)] ring-offset-1 ring-offset-[var(--lume-bg-panel)]',
              )}
              // 宽度下限 0.4%：零时长记录在概览条上至少留一个可点像素带
              style={{ left: `${left}%`, width: `${Math.max(width, 0.4)}%` }}
            >
              {twoTone && (
                <span
                  aria-hidden
                  className={cn('absolute inset-y-0 right-0 rounded-sm', record.isError ? 'bg-[var(--lume-danger)]' : 'bg-[var(--lume-accent)]')}
                  style={{ width: `${(1 - ttftFrac) * 100}%` }}
                />
              )}
            </button>
          )
        })}
      </div>
      {/* 缩放态显式重置（键盘可达；双击/Esc 亦可） */}
      {view && (
        <button
          type="button"
          onClick={() => setView(null)}
          className="absolute right-2 top-1/2 z-20 -translate-y-1/2 rounded-full border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-2 py-0.5 text-micro text-[var(--lume-text-muted)] hover:text-foreground"
        >
          已缩放 · 重置
        </button>
      )}
      {/* 500ms 悬停浮层：精确时刻与耗时（在裁剪层之外，top-full 才可见） */}
      {hovered && hoverVisible && (
        <div
          className="pointer-events-none absolute top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-2 py-1 text-micro text-foreground shadow-md"
          style={{ left: `${Math.min(85, Math.max(15, hoverAnchorPct))}%` }}
        >
          <div className="font-medium">#{hovered.index} · {KIND_META[hovered.kind].label}{hovered.toolName ? ` · ${hovered.toolName}` : ''}</div>
          <div className="text-[var(--lume-text-muted)]">
            {fmtClock(hovered.startedAt)}
            {hovered.endedAt != null ? ` – ${fmtClock(hovered.endedAt)}` : ' – 运行中'}
            {' · '}
            {fmtDuration(hovered.durationMs)}
          </div>
          {hovered.kind === 'assistant' && hovered.ttftMs != null && (
            <div className="text-[var(--lume-text-muted)]">
              首字延迟 {fmtDuration(hovered.ttftMs)} · 解码 {fmtDuration(Math.max(0, (hovered.durationMs ?? 0) - hovered.ttftMs))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const MAX_DETAIL_CHARS = 20_000

function DetailSection({ title, content }: { title: string; content?: string }) {
  if (!content?.trim()) return null
  // 大输出（工具结果可达 MB 级）截断后再进 DOM：max-h 只是视觉裁剪，text node 全量参与布局
  const truncated = content.length > MAX_DETAIL_CHARS
  return (
    <div className="flex min-h-0 flex-col gap-1">
      <div className="text-micro font-medium uppercase tracking-wide text-[var(--lume-text-muted)]">{title}</div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] p-2 text-caption leading-relaxed text-foreground">
        {truncated ? `${content.slice(0, MAX_DETAIL_CHARS)}\n…（已截断）` : content}
      </pre>
    </div>
  )
}

function Inspector({
  record,
  subagentRuns,
  onClose,
}: {
  record: TraceRecord
  subagentRuns?: SubagentRunRecord[]
  onClose: () => void
}) {
  const meta: Array<[string, string]> = [
    ['开始', fmtClock(record.startedAt)],
    ['耗时', fmtDuration(record.durationMs)],
    ...(record.ttftMs != null
      ? [
          ['首字延迟', fmtDuration(record.ttftMs)] as [string, string],
          ...(!record.running ? [['解码', fmtDuration(Math.max(0, (record.durationMs ?? 0) - record.ttftMs))] as [string, string]] : []),
        ]
      : []),
    ['状态', record.running ? '运行中' : record.isError ? '失败' : '完成'],
    ...(record.toolName ? [['工具', record.toolName] as [string, string]] : []),
    ...(record.usage ? [['Token', fmtUsageSummary(record.usage)] as [string, string]] : []),
    ...(record.numTurns != null ? [['Turn', String(record.numTurns)] as [string, string]] : []),
    ...(record.stopReason ? [['停止原因', record.stopReason] as [string, string]] : []),
  ]
  return (
    <aside className="flex w-[360px] max-w-[45%] shrink-0 flex-col gap-3 overflow-y-auto border-l border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-ui font-medium text-foreground">
          #{record.index} · {KIND_META[record.kind].label}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-[var(--lume-text-muted)] hover:bg-[var(--lume-bg-elevated)] hover:text-foreground"
          aria-label="关闭详情"
        >
          <X size={13} />
        </button>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-caption">
        {meta.map(([key, value]) => (
          <div key={key} className="col-span-2 grid grid-cols-subgrid">
            <span className="text-[var(--lume-text-muted)]">{key}</span>
            <span className="truncate text-foreground">{value}</span>
          </div>
        ))}
      </div>
      <DetailSection title={record.kind === 'user' ? '消息原文' : '输入'} content={record.input} />
      <DetailSection title="思考" content={record.thinking} />
      <DetailSection title="输出" content={record.output} />
      {subagentRuns && subagentRuns.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-micro font-medium uppercase tracking-wide text-[var(--lume-text-muted)]">
            子代理 ({subagentRuns.length})
          </div>
          {subagentRuns.map((run) => {
            const status = SUBAGENT_STATUS_META[run.status]
            return (
              <div key={run.runId} className="flex flex-col gap-1 rounded-md border border-[var(--lume-border-subtle)] p-2">
                <div className="flex items-center gap-1.5 text-caption">
                  <Bot size={12} className="shrink-0 text-[var(--lume-accent-2)]" />
                  <span className="min-w-0 flex-1 truncate text-foreground">{run.label ?? run.task}</span>
                  <span className={cn('shrink-0 font-medium', status?.cls)}>{status?.label ?? run.status}</span>
                </div>
                {run.startedAt != null && (
                  <div className="text-micro text-[var(--lume-text-muted)]">
                    耗时 {fmtDuration(run.endedAt != null ? Math.max(0, run.endedAt - run.startedAt) : null)}
                  </div>
                )}
                {run.task && run.label && (
                  <div className="text-caption leading-relaxed text-[var(--lume-text-muted)]">{run.task}</div>
                )}
                <DetailSection title="子代理输出" content={run.outcome?.output} />
                <DetailSection title="子代理错误" content={run.outcome?.error} />
              </div>
            )
          })}
        </div>
      )}
    </aside>
  )
}

export function AgentTraceView({ threadId }: { threadId: string }) {
  const [events, setEvents] = useState<SdkEventEnvelope[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [range, setRange] = useState<TraceTimeRange | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const followTailRef = useRef(true)
  // 子代理 run 由全局监听同步进 atom；按 parentToolUseId 挂到对应 Task 工具记录下（dsh 嵌套 Subtool 行）
  const subagentRuns = useAtomValue(agentSubagentRunsFamily(threadId)) ?? EMPTY_SUBAGENT_RUNS
  const runsByParentTool = useMemo(() => {
    const map = new Map<string, SubagentRunRecord[]>()
    for (const run of subagentRuns) {
      if (!run.parentToolUseId) continue
      const list = map.get(run.parentToolUseId) ?? []
      list.push(run)
      map.set(run.parentToolUseId, list)
    }
    return map
  }, [subagentRuns])

  // 总线逐条投递（快照回放是同步循环）：直接 setState 会造成 O(n²) 拷贝与流式高频 commit。
  // 缓冲后按 FLUSH_INTERVAL_MS 合并成一次 append，并折叠连续累计 update（同 runId+turnId 留最新）。
  const pendingRef = useRef<SdkEventEnvelope[]>([])
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (flushTimerRef.current != null) clearTimeout(flushTimerRef.current)
  }, [])

  useAgentEventBus(threadId, {
    enabled: true,
    onEvent: (event) => {
      pendingRef.current.push(event)
      if (flushTimerRef.current == null) {
        flushTimerRef.current = setTimeout(() => {
          flushTimerRef.current = null
          const batch = pendingRef.current
          pendingRef.current = []
          if (batch.length === 0) return
          setEvents((prev) => {
            let next = prev.concat(batch)
            let write = 0
            for (let read = 0; read < next.length; read++) {
              const current = next[read]
              const tail = write > 0 ? next[write - 1] : undefined
              if (
                tail && isCumulativeUpdate(tail) && isCumulativeUpdate(current)
                && tail.runId === current.runId && tail.turnId === current.turnId
              ) {
                next[write - 1] = current // 折叠：累计 partial 只留最新
              } else {
                next[write++] = current
              }
            }
            next = next.slice(0, write)
            return next.length > MAX_ENVELOPES ? next.slice(next.length - MAX_ENVELOPES) : next
          })
        }, FLUSH_INTERVAL_MS)
      }
    },
  })

  // 推送侧高频到达：投影走低优先级渲染，避免流式期间账本全量重算卡输入
  const deferredEvents = useDeferredValue(events)
  const records = useMemo(() => buildTraceRecords(deferredEvents), [deferredEvents])
  const normalizedQuery = query.trim().toLowerCase()
  const visibleRecords = useMemo(() => {
    let list = records
    if (range) {
      // dsh 语义：保留区间内任意时刻处于活动状态的记录
      list = list.filter((r) => r.startedAt <= range.endMs && (r.endedAt ?? Number.MAX_SAFE_INTEGER) >= range.startMs)
    }
    if (normalizedQuery) {
      list = list.filter((r) =>
        r.summary.toLowerCase().includes(normalizedQuery) || (r.toolName ?? '').toLowerCase().includes(normalizedQuery))
    }
    return list
  }, [records, range, normalizedQuery])
  const selected = records.find((r) => r.id === selectedId) ?? null

  // turn 分组折叠（dsh folding）：点分组头收起/展开该轮全部记录
  const [collapsedTurns, setCollapsedTurns] = useState<Set<number>>(new Set())
  const turnCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const r of visibleRecords) {
      if (r.turnNumber != null) counts.set(r.turnNumber, (counts.get(r.turnNumber) ?? 0) + 1)
    }
    return counts
  }, [visibleRecords])

  // 尾部跟随：内容高度变化（新增记录/流式增高/过滤收缩）时贴底；用户上滚即暂停。
  // 用 ResizeObserver 而非 records.length——折叠 update 只增高末行时 length 不变。
  useEffect(() => {
    const scroller = scrollRef.current
    const content = scroller?.firstElementChild
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (followTailRef.current) scroller.scrollTop = scroller.scrollHeight
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [])

  // Esc 清除区间过滤与搜索（defaultPrevented 守卫：不抢上层组件的 Esc 语义）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      setRange(null)
      setQuery('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selectAndReveal = (id: string) => {
    setSelectedId(id)
    followTailRef.current = false
    scrollRef.current
      ?.querySelector(`[data-record-id="${id}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }

  let lastTurnNumber: number | null | undefined = undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {records.length > 0 && (
        <>
          <OverviewBar
            records={records}
            selectedId={selectedId}
            onSelect={selectAndReveal}
            range={range}
            onRangeCommit={setRange}
            onRangeClear={() => setRange(null)}
          />
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)] px-3">
            <Search size={12} className="shrink-0 text-[var(--lume-text-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索摘要或工具名"
              className="h-6 min-w-0 flex-1 rounded bg-transparent text-ui text-foreground outline-none placeholder:text-[var(--lume-text-muted)] focus-visible:ring-1 focus-visible:ring-[var(--lume-focus-ring)]"
              aria-label="搜索轨迹记录"
            />
            {(query || range) && (
              <button
                type="button"
                onClick={() => { setQuery(''); setRange(null) }}
                className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--lume-bg-elevated)] px-2 py-0.5 text-micro text-[var(--lume-text-muted)] hover:text-foreground"
              >
                {visibleRecords.length}/{records.length} 条 · 清除(Esc)
              </button>
            )}
          </div>
        </>
      )}
      <div className="flex min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget
            // 距底不足一行行高（约 48px）视为贴底，恢复尾部跟随
            followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
          className="min-w-0 flex-1 overflow-y-auto"
        >
          {records.length === 0 ? (
            <div className="flex h-full items-center justify-center text-caption text-[var(--lume-text-muted)]">
              暂无轨迹记录 — 发送一条消息后这里会显示执行轨迹
            </div>
          ) : visibleRecords.length === 0 ? (
            <div className="flex h-full items-center justify-center text-caption text-[var(--lume-text-muted)]">
              无匹配记录 — 调整搜索词或按 Esc 清除过滤
            </div>
          ) : (
            <div className="pb-2">
              {visibleRecords.map((record) => {
                const showTurnHeader = record.turnNumber != null && record.turnNumber !== lastTurnNumber
                lastTurnNumber = record.turnNumber
                const collapsed = record.turnNumber != null && collapsedTurns.has(record.turnNumber)
                if (collapsed && !showTurnHeader) return null
                const childRuns = record.toolCallId ? runsByParentTool.get(record.toolCallId) : undefined
                return (
                  <div key={record.id} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 36px' }}>
                    {showTurnHeader && (
                      <button
                        type="button"
                        onClick={() => {
                          const turn = record.turnNumber!
                          setCollapsedTurns((prev) => {
                            const next = new Set(prev)
                            if (next.has(turn)) next.delete(turn)
                            else next.add(turn)
                            return next
                          })
                        }}
                        aria-expanded={!collapsed}
                        className="flex w-full items-center gap-1 border-t-2 border-[var(--lume-border-strong)] px-3 pb-1 pt-2 text-left text-micro font-semibold uppercase tracking-wider text-[var(--lume-text-muted)] hover:text-foreground"
                      >
                        <ChevronRight size={11} className={cn('shrink-0 transition-transform', !collapsed && 'rotate-90')} />
                        Turn {record.turnNumber}
                        {collapsed && ` · ${turnCounts.get(record.turnNumber!) ?? 0} 条已折叠`}
                      </button>
                    )}
                    {!collapsed && (
                    <button
                      type="button"
                      data-record-id={record.id}
                      onClick={() => {
                        setSelectedId(record.id)
                        followTailRef.current = false
                      }}
                      className={cn(
                        'grid w-full grid-cols-[2.8rem_3rem_1fr_4rem] items-center gap-2 px-3 py-1 text-left',
                        'hover:bg-[var(--lume-bg-elevated)]',
                        selectedId === record.id && 'bg-[var(--lume-bg-elevated)]',
                      )}
                    >
                      <span className="text-micro tabular-nums text-[var(--lume-text-muted)]">#{record.index}</span>
                      <span className={cn('truncate text-micro font-medium', KIND_META[record.kind].badge)}>
                        {KIND_META[record.kind].label}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5">
                        {record.running && (
                          <span className="size-1.5 shrink-0 animate-pulse motion-reduce:animate-none rounded-full bg-[var(--lume-accent)]" />
                        )}
                        <span
                          className={cn(
                            'truncate text-ui',
                            record.isError ? 'text-[var(--lume-danger)]' : 'text-foreground',
                          )}
                          title={record.summary}
                        >
                          {record.summary}
                        </span>
                      </span>
                      <span className="text-right text-micro tabular-nums text-[var(--lume-text-muted)]">
                        {fmtDuration(record.durationMs)}
                      </span>
                    </button>
                    )}
                    {childRuns?.map((run) => {
                      const status = SUBAGENT_STATUS_META[run.status]
                      return (
                        <button
                          key={run.runId}
                          type="button"
                          onClick={() => setSelectedId(record.id)}
                          aria-label={`${record.summary} 的子代理：${run.label ?? run.task}，${status?.label ?? run.status}`}
                          className="ml-[7.55rem] flex w-[calc(100%-7.55rem)] items-center gap-1.5 py-1 pr-3 text-left hover:bg-[var(--lume-bg-elevated)]"
                        >
                          <Bot size={11} className="shrink-0 text-[var(--lume-accent-2)]" />
                          <span className="min-w-0 flex-1 truncate text-micro text-[var(--lume-text-muted)]">
                            {run.label ?? run.task}
                          </span>
                          <span className={cn('shrink-0 text-micro font-medium', status?.cls)}>
                            {status?.label ?? run.status}
                          </span>
                          <span className="shrink-0 text-micro tabular-nums text-[var(--lume-text-muted)]">
                            {fmtDuration(run.startedAt != null && run.endedAt != null ? Math.max(0, run.endedAt - run.startedAt) : null)}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {selected && (
          <Inspector
            record={selected}
            subagentRuns={selected.toolCallId ? runsByParentTool.get(selected.toolCallId) : undefined}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  )
}
