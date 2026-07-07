import {
  DESKTOP_CONTEXT_IPC_CHANNELS,
  type DesktopContextTarget,
} from '@lume/shared'

type SidecarCall = (method: string, params: Record<string, unknown>) => Promise<unknown>

type DesktopContextCaptureResult = {
  status?: string
  snapshotId?: unknown
  app?: { id?: unknown; name?: unknown }
  window?: { id?: unknown; title?: unknown }
  capturedAt?: unknown
}

export async function captureAgentInputDesktopContextTarget(
  sidecarCall: SidecarCall,
): Promise<DesktopContextTarget | undefined> {
  const result = await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT, { userInitiated: true })
  return desktopContextCaptureToTarget(result)
}

export function createDesktopContextMessageMetadata(target: DesktopContextTarget): Record<string, unknown> {
  return {
    desktopContextSnapshotId: target.snapshotId,
    desktopApp: target.app,
    desktopWindow: target.window,
  }
}

function desktopContextCaptureToTarget(result: unknown): DesktopContextTarget | undefined {
  const value = result as DesktopContextCaptureResult | undefined
  if (
    value?.status !== 'ok'
    || typeof value.snapshotId !== 'string'
    || typeof value.app?.id !== 'string'
    || typeof value.app?.name !== 'string'
    || typeof value.window?.id !== 'string'
    || typeof value.window?.title !== 'string'
  ) return undefined
  return {
    snapshotId: value.snapshotId,
    app: { id: value.app.id, name: value.app.name },
    window: { id: value.window.id, title: value.window.title },
    ...(typeof value.capturedAt === 'number' ? { capturedAt: value.capturedAt } : {}),
  }
}
