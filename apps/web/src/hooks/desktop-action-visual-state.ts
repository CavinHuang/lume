import type { DesktopActionKind, DesktopActionVisualRuntimeEvent } from '@lume/shared'

export interface DesktopActionVisualOverlayState {
  id: string
  threadId: string
  phase: DesktopActionVisualRuntimeEvent['phase']
  action: DesktopActionKind
  appName: string
  targetLabel?: string
  point?: { x: number; y: number }
  status?: DesktopActionVisualRuntimeEvent['status']
  updatedAt: number
}

export function projectDesktopActionVisualEvent(
  event: DesktopActionVisualRuntimeEvent,
): DesktopActionVisualOverlayState {
  const timestamp = Date.parse(event.createdAt)
  return {
    id: event.id,
    threadId: event.threadId,
    phase: event.phase,
    action: event.action,
    appName: event.app.name,
    ...(event.targetLabel ? { targetLabel: event.targetLabel } : {}),
    ...(event.point ? { point: { x: event.point.x, y: event.point.y } } : {}),
    ...(event.status ? { status: event.status } : {}),
    updatedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
  }
}
