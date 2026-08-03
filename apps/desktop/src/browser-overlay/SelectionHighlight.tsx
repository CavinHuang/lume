import type { Rect } from './useAnnotationInteraction'

// hover-box：comment 模式下描边鼠标下的页面元素。矩形铺满定位（left/top/width/height = rect，无 translate）。
export function SelectionHighlight({ rect }: { rect: Rect }) {
  return <div className="selection" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />
}
