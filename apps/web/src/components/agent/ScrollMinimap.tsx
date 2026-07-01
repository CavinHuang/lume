/**
 * ScrollMinimap — 用户消息 minimap（消息级）
 *
 * 右侧显示一列按用户 turn 排列的细横线锚点：
 * - 每个锚点只对应一条用户输入消息
 * - hover 显示单条预览卡
 * - click 直接跳到对应消息
 */

import * as React from 'react'
import type { RefObject } from 'react'
import { cn } from '@/lib/utils'
import { useThreadMiniMapHover } from '@/components/app-shell/ThreadMiniMapPopover'

export interface MinimapItem {
  id: string
  title: string
  preview: string
}

interface ScrollMinimapProps {
  items: MinimapItem[]
  scrollContainerRef: RefObject<HTMLDivElement | null>
  /** 用户通过 minimap 主动跳转/拖拽时触发，宿主应停止“自动滚到底部”并释放程序化滚动锁 */
  onNavigate?: () => void
}

/** 最少消息数才显示迷你地图 */
const MIN_ITEMS = 1
/** 消息级 hover 展开延迟（ms），比会话级 popover 更短，操作更跟手 */
const HOVER_OPEN_DELAY_MS = 120
/** 预览卡距离上下边缘的最小安全距离 */
const PREVIEW_EDGE_PADDING_PX = 64
const PREVIEW_CARD_WIDTH = 404
const MINIMAP_HIT_WIDTH = 34
const RAIL_RIGHT_INSET = 12
const PREVIEW_GAP = 16
const OVERLAY_WIDTH = PREVIEW_CARD_WIDTH + PREVIEW_GAP + MINIMAP_HIT_WIDTH + RAIL_RIGHT_INSET
/** 横杠高度（px）—— 对齐 Proma 极简刻度的纤细感，恒定不波动 */
const BAR_HEIGHT = 2
/** 每行行高（px）；横杠垂直居中其中，形成均匀刻度 */
const BAR_ROW_HEIGHT = 10
/**
 * 宽度波纹分档：焦点处最宽，按距离向外递减。高度始终统一，
 * 波纹只体现在横向长度 —— 鼠标移动时宽度从指针位置平滑扩散。
 */
const BAR_WIDTH_FOCUS = 18
const BAR_WIDTH_NEAR = 12
const BAR_WIDTH_MID = 9
const BAR_WIDTH_BASE = 6
/** 边缘渐隐距离上限（px）—— rail 顶/底部横杠向视口边缘柔和淡出 */
const EDGE_FADE_DISTANCE_PX = 40
/**
 * rail 上下边缘渐隐遮罩。stop 取「40px」与「22% 高度」的较小值：
 * 多条时固定 40px 淡出；少条（rail 矮）时按比例收缩，避免把仅有的几根横杠完全虚化。
 * 仅视觉效果，不裁剪命中区。
 */
const EDGE_FADE_STOP = `min(${EDGE_FADE_DISTANCE_PX}px, 22%)`
const EDGE_FADE_MASK = `linear-gradient(to bottom, transparent, #000 ${EDGE_FADE_STOP}, #000 calc(100% - ${EDGE_FADE_STOP}), transparent)`

// ── 辅助函数 ──

/** 计算 node 相对于 container 的实际顶部偏移（递归累积 offsetTop） */
function getOffsetTopRelativeTo(node: HTMLElement, container: HTMLElement): number {
  let top = 0
  let el: HTMLElement | null = node
  while (el && el !== container) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  return top
}

/** 命中检测：用 scrollHeight + scrollTop 映射，保证 rail 可滚动时也精确 */
function getBarIndex(clientY: number, rail: HTMLElement, barCount: number): number {
  if (barCount <= 1) return 0
  const rect = rail.getBoundingClientRect()
  const totalHeight = rail.scrollHeight
  if (totalHeight <= 0) return 0
  const relY = clientY - rect.top + rail.scrollTop
  const idx = Math.round((relY / totalHeight) * (barCount - 1))
  return Math.max(0, Math.min(barCount - 1, idx))
}

/** 按「到焦点索引的距离」取横杠宽度：焦点最宽，邻近递减，远处为基础宽度 */
function barWidthForDistance(distance: number): number {
  if (distance === 0) return BAR_WIDTH_FOCUS
  if (distance === 1) return BAR_WIDTH_NEAR
  if (distance === 2) return BAR_WIDTH_MID
  return BAR_WIDTH_BASE
}

// ── 主组件 ──

export function ScrollMinimap({ items, scrollContainerRef, onNavigate }: ScrollMinimapProps): React.ReactElement | null {
  const disabled = items.length < MIN_ITEMS
  const {
    open: hovered,
    isLeaving,
    onMouseEnter,
    onMouseLeave,
    handlePanelMouseEnter,
    handlePanelMouseLeave,
  } = useThreadMiniMapHover(HOVER_OPEN_DELAY_MS, disabled)
  const [visibleIds, setVisibleIds] = React.useState<Set<string>>(new Set())
  /** 主区视口几何中心当前对应的消息 id —— 面板打开时作为列表居中锚点 */
  const [centerVisibleId, setCenterVisibleId] = React.useState<string | undefined>(undefined)
  const [canScroll, setCanScroll] = React.useState(false)
  /** 当前鼠标悬停的消息索引；离开 rail 时清空 */
  const [hoveredBarIndex, setHoveredBarIndex] = React.useState<number | null>(null)

  // ── 可见消息 + 滚动指标追踪 ──

  React.useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const update = (): void => {
      const { scrollTop, scrollHeight, clientHeight } = el
      setCanScroll(scrollHeight > clientHeight + 10)
      if (scrollHeight <= 0) return

      const viewportCenter = scrollTop + clientHeight / 2
      const nodes = el.querySelectorAll<HTMLElement>('[data-message-id]')
      const ids = new Set<string>()
      let centerId: string | undefined
      for (const node of nodes) {
        const top = getOffsetTopRelativeTo(node, el)
        const bottom = top + node.offsetHeight
        if (bottom > scrollTop && top < scrollTop + clientHeight) {
          const id = node.getAttribute('data-message-id')
          if (id) ids.add(id)
        }
        if (centerId === undefined && top <= viewportCenter && bottom > viewportCenter) {
          centerId = node.getAttribute('data-message-id') ?? undefined
        }
      }
      setVisibleIds(ids)
      setCenterVisibleId(centerId)
    }

    update()
    el.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(el)

    return () => {
      el.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [scrollContainerRef])

  // ── 跳转到指定消息（直接操作 scrollTop，绕过 scrollIntoView） ──

  const scrollToMessage = React.useCallback((id: string) => {
    const el = scrollContainerRef.current
    if (!el) return
    const target = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (node) => node.getAttribute('data-message-id') === id,
    )
    if (!target) return

    onNavigate?.()

    const offsetTop = getOffsetTopRelativeTo(target, el)
    const targetHeight = target.offsetHeight
    const viewportHeight = el.clientHeight
    const scrollTarget = targetHeight < viewportHeight
      ? offsetTop - (viewportHeight - targetHeight) / 2
      : offsetTop - 32
    el.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' })
  }, [scrollContainerRef, onNavigate])

  /** 主区当前最该强调的用户锚点：优先几何中心，否则退回首个可见用户消息 */
  const anchorId = React.useMemo(() => {
    if (centerVisibleId && items.some((item) => item.id === centerVisibleId)) {
      return centerVisibleId
    }
    return items.find((item) => visibleIds.has(item.id))?.id
  }, [centerVisibleId, items, visibleIds])

  const focusIndex = React.useMemo(() => {
    if (hoveredBarIndex !== null) return hoveredBarIndex
    if (!anchorId) return -1
    return items.findIndex((item) => item.id === anchorId)
  }, [anchorId, hoveredBarIndex, items])

  // 鼠标在横杠区移动 → 实时更新波纹中心索引（连续跟随，而非逐条命中）
  const handleBarsMouseMove = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (items.length === 0) return
    setHoveredBarIndex(getBarIndex(e.clientY, e.currentTarget, items.length))
  }, [items.length])

  const handleBarsClick = React.useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (items.length === 0) return
    const item = items[getBarIndex(e.clientY, e.currentTarget, items.length)]
    if (!item) return
    scrollToMessage(item.id)
  }, [items, scrollToMessage])

  const previewIndex = React.useMemo(() => {
    if (hoveredBarIndex !== null) return hoveredBarIndex
    return focusIndex >= 0 ? focusIndex : null
  }, [focusIndex, hoveredBarIndex])

  const previewItem = previewIndex !== null ? items[previewIndex] ?? null : null
  const previewTop = previewIndex !== null && items.length > 0
    ? ((previewIndex + 0.5) / items.length) * 100
    : 50

  if (items.length < MIN_ITEMS || !canScroll) return null

  return (
    <div
      className="pointer-events-none absolute right-0 top-1/2 z-30 flex -translate-y-1/2 flex-col items-end"
      style={{ width: OVERLAY_WIDTH, paddingRight: RAIL_RIGHT_INSET }}
    >
      {hovered && previewItem && (
        <div
          className={cn(
            'absolute rounded-2xl bg-popover/95 px-3 py-2 text-left text-popover-foreground shadow-[0_10px_28px_rgba(0,0,0,0.15)] ring-1 ring-border/60 backdrop-blur-sm pointer-events-auto dark:bg-foreground/[0.16] dark:ring-white/[0.08]',
            isLeaving
              ? 'animate-out fade-out-0 zoom-out-95 duration-75'
              : 'animate-in fade-in-0 zoom-in-95 duration-150',
          )}
          style={{
            right: `${MINIMAP_HIT_WIDTH + PREVIEW_GAP + RAIL_RIGHT_INSET}px`,
            width: PREVIEW_CARD_WIDTH,
            maxWidth: `min(${PREVIEW_CARD_WIDTH}px, calc(100vw - 96px))`,
            top: `clamp(${PREVIEW_EDGE_PADDING_PX}px, ${previewTop}%, calc(100% - ${PREVIEW_EDGE_PADDING_PX}px))`,
            transform: 'translateY(-50%)',
          }}
          onMouseEnter={handlePanelMouseEnter}
          onMouseLeave={handlePanelMouseLeave}
        >
          <div className="line-clamp-1 text-[13px] font-semibold leading-5 text-popover-foreground dark:text-foreground">{previewItem.title}</div>
          <div className="mt-1.5">
            <PreviewSnippet text={previewItem.preview} />
          </div>
        </div>
      )}

      <div
        className="scrollbar-none pointer-events-auto flex cursor-pointer flex-col overflow-y-auto overscroll-contain"
        style={{
          width: MINIMAP_HIT_WIDTH,
          maxHeight: 'min(70vh, 40rem)',
          WebkitMaskImage: EDGE_FADE_MASK,
          maskImage: EDGE_FADE_MASK,
        }}
        onMouseEnter={onMouseEnter}
        onMouseLeave={() => {
          onMouseLeave()
          setHoveredBarIndex(null)
        }}
        onMouseMove={handleBarsMouseMove}
        onClick={handleBarsClick}
        role="navigation"
        aria-label="用户消息 minimap"
      >
        {items.map((item, i) => {
          const distance = focusIndex >= 0 ? Math.abs(i - focusIndex) : Number.POSITIVE_INFINITY
          const isHovered = hoveredBarIndex === i
          const isHovering = hoveredBarIndex !== null
          const isFocus = distance === 0
          const toneClass = isHovered
            ? 'bg-foreground'
            : isFocus
              ? 'bg-foreground/60'
              : 'bg-foreground/40'
          // 静止态统一最窄宽度（干净刻度）；仅 hover 时从指针位置波纹撑开
          const width = isHovering ? barWidthForDistance(distance) : BAR_WIDTH_BASE
          return (
            <div key={item.id} aria-hidden className="flex h-2.5 w-full shrink-0 items-center justify-end">
              <div
                className={cn('transition-[width,background-color] duration-150 ease-out', toneClass)}
                style={{ width, height: BAR_HEIGHT }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PreviewSnippet({ text }: { text: string }): React.ReactElement {
  if (!text) {
    return <span className="text-[12px] text-muted-foreground dark:text-foreground/42">(暂无回复)</span>
  }

  return <p className="line-clamp-3 whitespace-pre-wrap text-[12px] leading-5 text-muted-foreground dark:text-foreground/72">{text}</p>
}
