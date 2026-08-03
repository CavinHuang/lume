import { useMemo } from 'react'
import { locateAnchor, rectOf, type Rect } from './anchor'
import type { Rect as AnchorRect } from './useAnnotationInteraction'

type MarkerProps = {
  comment: Record<string, unknown>
  index: number
  viewportSize?: { width: number; height: number }
  win: Window
  onHoverEnter?: (body: string, annotationId: string, markerRect: AnchorRect) => void
  onHoverLeave?: () => void
  onClickAnchor?: (annotationId: string, anchor: Record<string, unknown>) => void
}

// 单个评论 pin。定位到 anchor（element/text/region）；状态：attached/stale/detached。
export function Marker({ comment, index, viewportSize, win, onHoverEnter, onHoverLeave, onClickAnchor }: MarkerProps) {
  const anchor = comment.anchor as Record<string, unknown> | undefined
  const located = useMemo(() => (anchor ? locateAnchor(anchor as never, document, win) : undefined), [anchor, win])

  if (!anchor) return null
  const fallback = (anchor.rect as Rect | undefined) ?? { x: 8, y: 8 + index * 28, width: 1, height: 1 }
  const rect = located?.rect ?? fallback
  const left = Math.max(12, Math.min((viewportSize?.width ?? win.innerWidth) - 12, rect.x + rect.width))
  const top = Math.max(12, Math.min((viewportSize?.height ?? win.innerHeight) - 12, rect.y))

  const stateClass = located ? (located.status === 'degraded' ? 'detached' : '') : 'stale detached'
  const annotationId = String(comment.id ?? '')
  const body = String(comment.body ?? '')
  return (
    <button
      type="button"
      className={`marker saved-marker${stateClass ? ` ${stateClass}` : ''}`}
      data-selected="false"
      style={{ left, top }}
      aria-label={located ? `批注 ${index + 1}` : `批注 ${index + 1} 已失效`}
      onMouseEnter={() => onHoverEnter?.(body, annotationId, { x: left, y: top, width: 24, height: 24 })}
      onMouseLeave={() => onHoverLeave?.()}
      onClick={(e) => { e.stopPropagation(); onClickAnchor?.(annotationId, anchor) }}
    >
      <span className="marker-label">{index + 1}</span>
    </button>
  )
}
