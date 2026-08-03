type Rect = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

export function positionBrowserAnnotationPopup(input: {
  parent: Rect
  surface: Rect
  point: Point
  popup: { width: number; height: number }
  viewport?: { width?: number; height?: number }
  display: Rect
}): Point {
  const surface = {
    x: input.parent.x + input.surface.x,
    y: input.parent.y + input.surface.y,
    width: input.surface.width,
    height: input.surface.height,
  }
  const scaleX = positiveRatio(input.surface.width, input.viewport?.width)
  const scaleY = positiveRatio(input.surface.height, input.viewport?.height)
  const markerInset = 29
  const marker = {
    x: surface.x + clamp(input.point.x * scaleX, markerInset, Math.max(markerInset, surface.width - markerInset)),
    y: surface.y + clamp(input.point.y * scaleY, markerInset, Math.max(markerInset, surface.height - markerInset)),
  }
  const available = intersect(surface, input.display)
  const gap = 12
  const inset = 8
  const right = marker.x + gap
  const left = marker.x - input.popup.width - gap
  const x = left >= available.x + inset
    ? left
    : right + input.popup.width <= available.x + available.width - inset
      ? right
      : clamp(right, available.x + inset, available.x + available.width - input.popup.width - inset)
  const inputCenterInset = 36
  const y = clamp(marker.y - input.popup.height + inputCenterInset, available.y + inset, available.y + available.height - input.popup.height - inset)
  return { x: Math.round(x), y: Math.round(y) }
}

function positiveRatio(surfaceSize: number, viewportSize: number | undefined): number {
  return typeof viewportSize === 'number' && Number.isFinite(viewportSize) && viewportSize > 0
    ? surfaceSize / viewportSize
    : 1
}

function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return b
  return { x, y, width: right - x, height: bottom - y }
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.max(min, Math.min(max, value))
}
