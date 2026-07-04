import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import { agentRuntimeEventsFamily } from '@/atoms'
import { projectRuntimeEventMessages } from '@/components/agent/runtime-event-message-projection'
import { getRecentThreadMessages } from '@/lib/desktop-api'
import type { RuntimeMessageView } from '@/components/agent/runtime-message-view'

const PREVIEW_LIMIT = 12
const HOVER_DELAY_MS = 600
const LEAVE_DELAY_MS = 160
const PREVIEW_TEXT_MAX = 220

/**
 * 把任意消息文本折叠为单行预览：合并空白 + 截断。
 * 纯函数，便于单测（不依赖 DOM/jotai）。
 */
export function summarizeMessageForPreview(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.slice(0, PREVIEW_TEXT_MAX)
}

interface PreviewItem {
  role: string
  text: string
}

function roleLabelFromView(view: RuntimeMessageView): string {
  if (view.type === 'user') return 'user'
  if (view.type === 'assistant') return 'assistant'
  return 'system'
}

/**
 * hover 防抖：进入 ≥delayMs 才弹；离开延迟 LEAVE_DELAY_MS 关闭（避免抖动跨入 popup）。
 * editing 时禁用（重命名输入态不应弹预览）。
 */
export function useThreadMiniMapHover(delayMs: number = HOVER_DELAY_MS, disabled: boolean = false) {
  const [open, setOpen] = useState(false)
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearEnter = () => {
    if (enterTimer.current) {
      clearTimeout(enterTimer.current)
      enterTimer.current = null
    }
  }
  const clearLeave = () => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current)
      leaveTimer.current = null
    }
  }
  const cancelAll = () => {
    clearEnter()
    clearLeave()
  }

  useEffect(() => () => cancelAll(), [])
  useEffect(() => {
    if (disabled) {
      cancelAll()
      setOpen(false)
    }
  }, [disabled])

  const onMouseEnter = () => {
    if (disabled) return
    clearLeave()
    if (open) return
    clearEnter()
    enterTimer.current = setTimeout(() => setOpen(true), delayMs)
  }
  const onMouseLeave = () => {
    clearEnter()
    clearLeave()
    leaveTimer.current = setTimeout(() => setOpen(false), LEAVE_DELAY_MS)
  }
  const cancelNow = () => {
    cancelAll()
    setOpen(false)
  }

  return { open, setOpen, onMouseEnter, onMouseLeave, cancelNow }
}

/**
 * 双源取最近消息：
 * - 已打开 thread（runtime events 非空）→ projectRuntimeEventMessages 投影，取尾部 PREVIEW_LIMIT 条。
 * - 未打开（events 为空/未缓存）→ getRecentThreadMessages IPC，取返回 messages。
 */
export function useThreadPreviewItems(threadId: string, open: boolean): { items: PreviewItem[]; loading: boolean } {
  const eventState = useAtomValue(agentRuntimeEventsFamily(threadId))
  const events = eventState?.events ?? []
  const cached = events.length > 0

  const [items, setItems] = useState<PreviewItem[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return

    if (cached) {
      const views = projectRuntimeEventMessages(events)
      const tail = views.slice(-PREVIEW_LIMIT)
      setItems(
        tail
          .filter((v) => v.type !== 'system')
          .map((v) => ({
            role: roleLabelFromView(v),
            text: summarizeMessageForPreview(typeof v.text === 'string' ? v.text : ''),
          })),
      )
      setLoading(false)
      return
    }

    setLoading(true)
    let cancelled = false
    getRecentThreadMessages(threadId, PREVIEW_LIMIT)
      .then((res) => {
        if (cancelled) return
        const messages = res?.messages ?? []
        setItems(
          messages.map((m) => ({
            role: m.role ?? 'user',
            text: summarizeMessageForPreview(typeof m.content === 'string' ? m.content : ''),
          })),
        )
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // events 引用随流式更新变化；cached 仅在首次切换时影响，eventState 整体作为依赖
  }, [open, cached, threadId, eventState])

  return { items, loading }
}

interface PopoverPosition {
  left: number
  top: number
}

function useAnchorPosition(anchorRef: React.RefObject<HTMLElement | null>, open: boolean): PopoverPosition | null {
  const [pos, setPos] = useState<PopoverPosition | null>(null)
  useEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const el = anchorRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // 锚点右侧、垂直顶对齐；右侧空间不足时贴右边界
    const left = Math.min(rect.right + 8, window.innerWidth - 326)
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - 240))
    setPos({ left, top })
  }, [open, anchorRef])
  return pos
}

export function ThreadMiniMapPopover({
  threadId,
  open,
  anchorRef,
}: {
  threadId: string
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
}) {
  const { items, loading } = useThreadPreviewItems(threadId, open)
  const pos = useAnchorPosition(anchorRef, open)
  if (!open || !pos) return null

  return createPortal(
    <div
      className="fixed z-[9999] w-[318px] max-h-[240px] overflow-auto rounded-lg border bg-popover p-2 text-[var(--text-1)] shadow-lg"
      style={{ left: pos.left, top: pos.top }}
      role="tooltip"
    >
      <div className="mb-1 text-[11px] text-muted-foreground">{items.length} 条</div>
      {loading ? (
        <div className="text-xs text-muted-foreground">加载中…</div>
      ) : items.length === 0 ? (
        <div className="text-xs text-muted-foreground">暂无消息</div>
      ) : (
        items.map((it, i) => (
          <div key={i} className="flex gap-1 truncate text-xs leading-5">
            <span className="flex-shrink-0 text-[var(--text-3)]">{it.role}:</span>
            <span className="truncate">{it.text}</span>
          </div>
        ))
      )}
    </div>,
    document.body,
  )
}
