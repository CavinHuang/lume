import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useAtomValue } from 'jotai'
import { XMarkdown } from '@ant-design/x-markdown'
import { AlertTriangle, Bot, Loader2, User } from 'lucide-react'
import { agentRuntimeEventsFamily } from '@/atoms'
import { projectRuntimeEventMessages } from '@/components/agent/runtime-event-message-projection'
import { getRecentThreadMessages } from '@/lib/desktop-api'
import { cn } from '@/lib/utils'
import type { RuntimeMessageView } from '@/components/agent/runtime-message-view'

const HOVER_DELAY_MS = 600
const LEAVE_DELAY_MS = 160
const FADE_DELAY_MS = 90
const PREVIEW_LIMIT = 12
const PREVIEW_TEXT_MAX = 220

const PANEL_WIDTH = 318
const PANEL_MIN_HEIGHT = 132
const PANEL_MAX_HEIGHT = 420
const PANEL_GAP = 8
const VIEWPORT_MARGIN = 8

type PreviewRole = 'user' | 'assistant' | 'status'

interface PreviewItem {
  id: string
  role: PreviewRole
  text: string
}

interface ThreadMiniMapPopoverProps {
  threadId: string
  title: string
  workspaceName?: string
  open: boolean
  isLeaving: boolean
  anchorRef: RefObject<HTMLElement | null>
  onMouseEnter: () => void
  onMouseLeave: () => void
}

/** 与 RuntimeEventContentBlock 的 useIsDark 一致；未来可提取共享 */
function useIsDark(): boolean {
  return useSyncExternalStore(
    (callback) => {
      if (typeof document === 'undefined') return () => {}
      const observer = new MutationObserver(callback)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => observer.disconnect()
    },
    () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark'),
    () => false,
  )
}

/**
 * 把任意消息文本折叠为单行预览：合并空白 + 截断。
 * 纯函数，便于单测（不依赖 DOM/jotai）。
 */
export function summarizeMessageForPreview(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed.slice(0, PREVIEW_TEXT_MAX)
}

function roleLabelFromView(view: RuntimeMessageView): PreviewRole {
  if (view.type === 'user') return 'user'
  if (view.type === 'assistant') return 'assistant'
  return 'status'
}

function ipcRole(role: string): PreviewRole {
  if (role === 'user') return 'user'
  if (role === 'assistant') return 'assistant'
  return 'status'
}

/**
 * hover 防抖：进入 ≥delayMs 才弹；离开 LEAVE_DELAY_MS 进入淡出态，再 FADE_DELAY_MS 关闭。
 * open 在淡出期间保持 true（浮层仍在 DOM，可显示退出动画，无需 deferred unmount）。
 * 鼠标移入浮层（handlePanelMouseEnter）取消关闭；disabled 时立即关闭（编辑/菜单打开/显式禁用）。
 */
export function useThreadMiniMapHover(delayMs: number = HOVER_DELAY_MS, disabled: boolean = false) {
  const [open, setOpen] = useState(false)
  const [isLeaving, setIsLeaving] = useState(false)
  const enterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearEnter = () => {
    if (enterTimer.current) { clearTimeout(enterTimer.current); enterTimer.current = null }
  }
  const clearLeave = () => {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null }
  }
  const clearFade = () => {
    if (fadeTimer.current) { clearTimeout(fadeTimer.current); fadeTimer.current = null }
  }
  const cancelAll = () => { clearEnter(); clearLeave(); clearFade() }

  useEffect(() => () => cancelAll(), [])

  useEffect(() => {
    if (!disabled) return
    cancelAll()
    setOpen(false)
    setIsLeaving(false)
  }, [disabled])

  const onMouseEnter = () => {
    if (disabled) return
    clearLeave()
    clearFade()
    setIsLeaving(false)
    if (open) return
    clearEnter()
    enterTimer.current = setTimeout(() => setOpen(true), delayMs)
  }

  const closeWithDelay = () => {
    clearEnter()
    clearLeave()
    clearFade()
    leaveTimer.current = setTimeout(() => {
      setIsLeaving(true)
      fadeTimer.current = setTimeout(() => {
        setOpen(false)
        setIsLeaving(false)
      }, FADE_DELAY_MS)
    }, LEAVE_DELAY_MS)
  }

  const handlePanelMouseEnter = () => {
    clearLeave()
    clearFade()
    setIsLeaving(false)
  }

  const cancelNow = () => {
    cancelAll()
    setOpen(false)
    setIsLeaving(false)
  }

  // 立即打开（清掉所有延迟定时器），供 Cmd+F 等快捷键即时唤起消息级 minimap
  const openNow = () => {
    cancelAll()
    setOpen(true)
    setIsLeaving(false)
  }

  return {
    open,
    isLeaving,
    onMouseEnter,
    onMouseLeave: closeWithDelay,
    handlePanelMouseEnter,
    handlePanelMouseLeave: closeWithDelay,
    cancelNow,
    openNow,
  }
}

/**
 * 双源取最近消息：
 * - 已打开 thread（runtime events 非空）→ projectRuntimeEventMessages 投影，取尾部 PREVIEW_LIMIT 条。
 * - 未打开（events 为空/未缓存）→ getRecentThreadMessages IPC，取返回 messages。
 */
export function useThreadPreviewItems(threadId: string, open: boolean): {
  items: PreviewItem[]
  loading: boolean
  error: string | null
} {
  const eventState = useAtomValue(agentRuntimeEventsFamily(threadId))
  const events = eventState?.events ?? []
  const cached = events.length > 0

  const [items, setItems] = useState<PreviewItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)

    if (cached) {
      const views = projectRuntimeEventMessages(events)
      setItems(
        views
          .slice(-PREVIEW_LIMIT)
          .map((v) => ({
            id: v.id,
            role: roleLabelFromView(v),
            text: summarizeMessageForPreview(typeof v.text === 'string' ? v.text : ''),
          }))
          .filter((it) => it.text.length > 0),
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
          messages
            .map((m) => ({
              id: m.id,
              role: ipcRole(m.role),
              text: summarizeMessageForPreview(typeof m.content === 'string' ? m.content : ''),
            }))
            .filter((it) => it.text.length > 0),
        )
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setError('无法加载会话内容')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
    // events 引用随流式更新变化；cached 仅在首次切换时影响，eventState 整体作为依赖
  }, [open, cached, threadId, eventState])

  return { items, loading, error }
}

function getPreferredPanelHeight({
  loading,
  error,
  itemCount,
}: {
  loading: boolean
  error: string | null
  itemCount: number
}): number {
  if (loading) return 260
  if (error || itemCount === 0) return PANEL_MIN_HEIGHT
  const visibleItems = Math.min(itemCount, 8)
  return Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, 54 + visibleItems * 42))
}

export interface HoverBridgeRect {
  top: number
  left: number
  width: number
  height: number
}

/**
 * 计算「锚点↔面板」之间的不可见悬停桥接区：鼠标穿越间隙时落入桥接即视为仍在浮层内，
 * 避免触发 160ms 关闭倒计时（hover bridge 模式，对鼠标速度不敏感）。
 * 水平填补锚点与面板的间隙，垂直覆盖二者并集以容忍斜向移动；
 * 面板与锚点水平重叠（窄屏 clamp）时返回 null（无间隙无需桥接）。
 */
export function computeHoverBridge(
  anchor: { top: number; bottom: number; left: number; right: number },
  panel: { top: number; left: number; width: number; height: number },
): HoverBridgeRect | null {
  const panelRight = panel.left + panel.width
  let bridgeLeft: number
  let bridgeWidth: number
  if (panel.left >= anchor.right) {
    bridgeLeft = anchor.right
    bridgeWidth = panel.left - anchor.right
  } else if (panelRight <= anchor.left) {
    bridgeLeft = panelRight
    bridgeWidth = anchor.left - panelRight
  } else {
    return null
  }
  if (bridgeWidth <= 0) return null
  const bridgeTop = Math.min(anchor.top, panel.top)
  const bridgeBottom = Math.max(anchor.bottom, panel.top + panel.height)
  return { top: bridgeTop, left: bridgeLeft, width: bridgeWidth, height: bridgeBottom - bridgeTop }
}

function usePopoverPosition(
  anchorRef: RefObject<HTMLElement | null>,
  open: boolean,
  preferredHeight: number,
): { top: number; left: number; height: number; bridge: HoverBridgeRect | null } | null {
  const [position, setPosition] = useState<{ top: number; left: number; height: number; bridge: HoverBridgeRect | null } | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const update = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const availableHeight = Math.max(120, viewportHeight - VIEWPORT_MARGIN * 2)
      const height = Math.min(preferredHeight, availableHeight)
      let left = rect.right + PANEL_GAP
      if (left + PANEL_WIDTH > viewportWidth - VIEWPORT_MARGIN) {
        left = rect.left - PANEL_WIDTH - PANEL_GAP
      }
      if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN
      const preferredTop = rect.top + rect.height / 2 - height / 2
      const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - height - VIEWPORT_MARGIN)
      const top = Math.min(Math.max(VIEWPORT_MARGIN, preferredTop), maxTop)
      const bridge = computeHoverBridge(
        { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right },
        { top, left, width: PANEL_WIDTH, height },
      )
      setPosition({ top, left, height, bridge })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef, open, preferredHeight])

  return position
}

function getMessageBubbleClass(role: PreviewRole): string {
  if (role === 'user') return 'bg-primary/[0.06]'
  if (role === 'status') return 'bg-amber-500/[0.08]'
  return ''
}

const previewHeading = ({ children }: { children?: ReactNode }) => (
  <p className="my-0.5 text-[11px] font-semibold">{children}</p>
)

/**
 * 紧凑 markdown 渲染组件：去除大 margin、统一 11px 字号（覆盖 h1-h6 默认大字号），适配预览。
 * 不用 agent-message-markdown，那个是为 15px 主消息设计的。
 */
const PREVIEW_MD_COMPONENTS = {
  p: ({ children }: { children?: ReactNode }) => <p className="my-0">{children}</p>,
  h1: previewHeading,
  h2: previewHeading,
  h3: previewHeading,
  h4: previewHeading,
  h5: previewHeading,
  h6: previewHeading,
  ul: ({ children }: { children?: ReactNode }) => <ul className="my-0 pl-3">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="my-0 pl-3">{children}</ol>,
  li: ({ children }: { children?: ReactNode }) => <li className="my-0">{children}</li>,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="my-0 border-l-2 border-border/50 pl-2">{children}</blockquote>
  ),
  pre: ({ children }: { children?: ReactNode }) => <pre className="my-0 truncate text-[11px] opacity-70">{children}</pre>,
  code: ({ children }: { children?: ReactNode }) => <code className="rounded bg-muted/50 px-0.5 text-[11px]">{children}</code>,
  img: () => null,
  a: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}

export function PreviewText({ text }: { text: string }) {
  const isDark = useIsDark()
  if (!text) {
    return <span className="text-[11px] text-muted-foreground/60">(空消息)</span>
  }
  return (
    <div className="line-clamp-2 overflow-hidden text-[11px] leading-4 text-popover-foreground/72 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <XMarkdown
        className="x-markdown"
        rootClassName={isDark ? 'x-markdown-dark' : 'x-markdown-light'}
        components={PREVIEW_MD_COMPONENTS as never}
      >
        {text}
      </XMarkdown>
    </div>
  )
}

function ItemIcon({ role }: { role: PreviewRole }) {
  if (role === 'user') return <User className="mt-0.5 size-4 shrink-0 text-muted-foreground/70" />
  if (role === 'assistant') return <Bot className="mt-0.5 size-4 shrink-0 text-[var(--lume-accent)] opacity-70" />
  return <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--lume-warning)] opacity-70" />
}

export function ThreadMiniMapPopover({
  threadId,
  title,
  workspaceName,
  open,
  isLeaving,
  anchorRef,
  onMouseEnter,
  onMouseLeave,
}: ThreadMiniMapPopoverProps) {
  const { items, loading, error } = useThreadPreviewItems(threadId, open)
  const preferredHeight = getPreferredPanelHeight({ loading, error, itemCount: items.length })
  const position = usePopoverPosition(anchorRef, open, preferredHeight)

  if (!open || !position) return null

  return createPortal(
    <>
      {position.bridge && (
        <div
          className="fixed z-[9998] pointer-events-auto"
          style={{
            top: position.bridge.top,
            left: position.bridge.left,
            width: position.bridge.width,
            height: position.bridge.height,
          }}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
        />
      )}
      <div
        className="fixed z-[9999] pointer-events-auto transition-[top,height] duration-150 ease-out"
        style={{ top: position.top, left: position.left, width: PANEL_WIDTH, height: position.height }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
      <div
        className={cn(
          'flex h-full flex-col overflow-hidden rounded-xl bg-popover shadow-xl ring-1 ring-black/[0.05] dark:ring-white/[0.08]',
          isLeaving
            ? 'animate-out fade-out-0 zoom-out-95 duration-75'
            : 'animate-in fade-in-0 zoom-in-95 duration-150',
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/35 bg-muted/35 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-xs font-medium text-popover-foreground/85">{title}</span>
            {workspaceName && (
              <span className="max-w-[92px] shrink-0 truncate rounded-full bg-primary/10 px-1.5 text-[10px] font-medium leading-4">
                {workspaceName}
              </span>
            )}
          </div>
          <span className="w-[44px] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {loading ? '加载中' : `${items.length} 条`}
          </span>
        </div>

        {/* Body */}
        <div className="relative min-h-0 flex-1 overflow-hidden bg-popover p-1.5">
          {loading && (
            <div className="absolute inset-1.5 rounded-md bg-muted/30 p-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 size={13} className="animate-spin" />
                <span>正在读取会话...</span>
              </div>
              <div className="mt-4 space-y-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <div className="mt-0.5 size-4 animate-pulse rounded bg-muted/70" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-2.5 w-full animate-pulse rounded bg-muted/70" />
                      <div className="h-2.5 w-2/3 animate-pulse rounded bg-muted/50" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="flex h-full items-center justify-center rounded-md bg-muted/30 px-4 text-center text-xs text-muted-foreground">
              {error}
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div className="flex h-full items-center justify-center rounded-md bg-muted/30 px-4 text-center text-xs text-muted-foreground">
              暂无可预览内容
            </div>
          )}

          {!loading && !error && items.length > 0 && (
            <div className="agent-message-scrollbar h-full animate-in fade-in-0 space-y-1 overflow-y-auto duration-150">
              {items.map((item, index) => (
                <div key={`${item.id}-${index}`} className="flex w-full items-start gap-2 px-2 py-1 text-left">
                  <ItemIcon role={item.role} />
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        'w-fit max-w-full rounded-md py-1',
                        item.role === 'assistant' ? 'px-0' : 'px-2',
                        getMessageBubbleClass(item.role),
                      )}
                    >
                      <PreviewText text={item.text} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      </div>
    </>,
    document.body,
  )
}
