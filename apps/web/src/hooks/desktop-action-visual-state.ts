import type { DesktopActionKind, DesktopActionVisualRuntimeEvent } from '@lume/shared'

export interface DesktopActionVisualOverlayState {
  id: string
  threadId: string
  phase: DesktopActionVisualRuntimeEvent['phase']
  action: DesktopActionKind
  appName: string
  targetLabel?: string
  point?: { x: number; y: number }
  path?: Array<{ x: number; y: number }>
  status?: DesktopActionVisualRuntimeEvent['status']
  updatedAt: number
}

export function projectDesktopActionVisualEvent(
  event: DesktopActionVisualRuntimeEvent,
): DesktopActionVisualOverlayState {
  const timestamp = Date.parse(event.createdAt)
  const path = safeVisualPath(event.path)
  return {
    id: event.id,
    threadId: event.threadId,
    phase: event.phase,
    action: event.action,
    appName: event.app.name,
    ...(event.targetLabel ? { targetLabel: event.targetLabel } : {}),
    ...(event.point ? { point: { x: event.point.x, y: event.point.y } } : {}),
    ...(path.length ? { path } : {}),
    ...(event.status ? { status: event.status } : {}),
    updatedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
  }
}

function safeVisualPath(value: DesktopActionVisualRuntimeEvent['path']): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return []
  return value
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({ x: point.x, y: point.y }))
    .slice(0, 8)
}
