import type { Point } from './useAnnotationInteraction'

// 光标徽章：评论 SVG 图标，偏移跟随鼠标（left/top = pos，无 translate，无居中）。
// 对齐 guest cursor-badge（评论气泡图标，不显示元素元数据）。
export function CursorBadge({ pos }: { pos: Point }) {
  return (
    <div className="cursor-badge" style={{ left: pos.x, top: pos.y }}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-5.2 3.2A.5.5 0 0 1 3 20.8V7a3 3 0 0 1 2-3Z" />
      </svg>
    </div>
  )
}
