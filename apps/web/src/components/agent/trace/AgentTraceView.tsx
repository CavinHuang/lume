import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAgentEventBus } from '@/hooks/useAgentEventBus'
import type { SdkEventEnvelope } from '@lume/shared'
import { buildTraceRecords, type TraceRecord, type TraceRecordKind } from './build-trace-records'

/**
 * Trace 视图（参考 dsh Trajectory）：turn 分组的事件账本 + 顶部时间概览条 + 行选中详情面板。
 * 数据直接消费线程事件总线快照与推送，与消息视图互不影响。
 * 概览条支持拖拽选区间过滤账本（右键/Esc 清除）、500ms 悬停浮层、assistant span 的 TTFT/解码双色调。
 */

const MAX_ENVELOPES = 8000 // ponytail: 超长线程截断最旧事件；update 折叠后 update 不再堆积，8000 条≈纯生命周期事件的量级；虚拟滚动留待实测卡顿时再加

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
  const dragRef = useRef<{ startPct: number; moved: boolean } | null>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [hoverVisible, setHoverVisible] = useState(false)
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const domainStart = records[0]?.startedAt ?? 0
  let domainEnd = records[records.length - 1]?.endedAt ?? domainStart
  for (const r of records) if (r.startedAt > domainEnd) domainEnd = r.startedAt
  const span = Math.max(1, domainEnd - domainStart)
  // 超长账本按步长抽样渲染概览段，防 DOM 规模失控；被跳过的记录仍可从账本选中
  // （ponytail: 按 span 分桶聚合的保真度更高，实测需要时再换）
  const stride = Math.max(1, Math.ceil(records.length / 400))
  const sampled = records.map((record, i) => ({ record, i }))
    .filter(({ record, i }) => i % stride === 0 || record.id === selectedId)

  useEffect(() => () => {
    if (hoverTimerRef.current != null) clearTimeout(hoverTimerRef.current)
  }, [])

  const pctFromEvent = (e: React.PointerEvent): number => {
    const rect = containerRef.current!.getBoundingClientRect()
    return Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
  }

  const activeRange = draft ?? range
  const hovered = sampled.find(({ record }) => record.id === hoverId)?.record ?? null
  const hoverAnchorPct = hovered
    ? (((hovered.startedAt - domainStart) / span) * 100) +
      ((hovered.durationMs != null ? (hovered.durationMs / span) * 100 : 0.5) / 2)
    : 0

  return (
    <div
      ref={containerRef}
      role="group"
      aria-label="轨迹时间概览"
      className="relative h-7 shrink-0 touch-none border-b border-[var(--lume-border-subtle)] bg-[var(--lume-bg-panel)]"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const startPct = pctFromEvent(e)
        dragRef.current = { startPct, moved: false }
        e.currentTarget.setPointerCapture(e.pointerId)
        setDraft({ startMs: domainStart + (startPct / 100) * span, endMs: domainStart + (startPct / 100) * span })
      }}
      onPointerMove={(e) => {
        const drag = dragRef.current
        if (!drag) return
        const pct = pctFromEvent(e)
        if (Math.abs(pct - drag.startPct) > 0.5) drag.moved = true
        const a = domainStart + (Math.min(drag.startPct, pct) / 100) * span
        const b = domainStart + (Math.max(drag.startPct, pct) / 100) * span
        setDraft({ startMs: a, endMs: b })
      }}
      onPointerUp={(e) => {
        const drag = dragRef.current
        if (!drag) return
        dragRef.current = null
        e.currentTarget.releasePointerCapture(e.pointerId)
        const committed = draft
        setDraft(null)
        // 位移过小视为点击（交给段自身的 onClick 选中），只有真正的拖拽才落区间
        if (committed && drag.moved && committed.endMs - committed.startMs > span * 0.002) {
          onRangeCommit(committed)
        } else {
          onRangeClear()
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onRangeClear()
      }}
    >
      {/* 已生效区间高亮 */}
      {activeRange && (
        <div
          aria-hidden
          className="absolute inset-y-0 bg-[var(--lume-accent)]/10 ring-1 ring-inset ring-[var(--lume-accent)]/40"
          style={{
            left: `${((activeRange.startMs - domainStart) / span) * 100}%`,
            width: `${((activeRange.endMs - activeRange.startMs) / span) * 100}%`,
          }}
        />
      )}
      {sampled.map(({ record }) => {
        const left = ((record.startedAt - domainStart) / span) * 100
        const width = record.durationMs != null ? (record.durationMs / span) * 100 : 0.5
        const durationPct = record.durationMs != null ? (record.durationMs / span) * 100 : 0.5
        // assistant span 双色调：前段浅色为 TTFT（等待首字），后段实色为解码
        const twoTone = record.kind === 'assistant' && record.ttftMs != null && durationPct > 0.8
        const ttftFrac = twoTone ? Math.min(0.95, (record.ttftMs! / (record.durationMs ?? 1)) ) : 0
        return (
          <button
            key={record.id}
            type="button"
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
                ? record.isError ? 'bg-[var(--lume-danger)]/30' : 'bg-[var(--lume-accent)]/30'
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
      {/* 500ms 悬停浮层：精确时刻与耗时 */}
      {hovered && hoverVisible && (
        <div
          className="pointer-events-none absolute top-full z-20 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--lume-border-subtle)] bg-[var(--lume-bg-elevated)] px-2 py-1 text-micro text-foreground shadow-md"
          style={{ left: `${Math.min(90, Math.max(10, hoverAnchorPct))}%` }}
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
              首字 {fmtDuration(hovered.ttftMs)} · 解码 {fmtDuration(Math.max(0, (hovered.durationMs ?? 0) - hovered.ttftMs))}
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

function Inspector({ record, onClose }: { record: TraceRecord; onClose: () => void }) {
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
    ...(record.numTurns != null ? [['轮数', String(record.numTurns)] as [string, string]] : []),
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

  // 尾部跟随：新记录到达时贴底，用户上滚即暂停（对齐 dsh tail-follow 行为）
  useEffect(() => {
    const el = scrollRef.current
    if (el && followTailRef.current) el.scrollTop = el.scrollHeight
  }, [visibleRecords.length])

  // Esc 清除区间过滤与搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setRange(null)
        setQuery('')
      }
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
              className="h-6 min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-[var(--lume-text-muted)]"
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
                return (
                  <div key={record.id}>
                    {showTurnHeader && (
                      <div className="border-t-2 border-[var(--lume-border-strong)] px-3 pb-1 pt-2 text-micro font-semibold uppercase tracking-wider text-[var(--lume-text-muted)]">
                        Turn {record.turnNumber}
                      </div>
                    )}
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
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {selected && <Inspector record={selected} onClose={() => setSelectedId(null)} />}
      </div>
    </div>
  )
}
