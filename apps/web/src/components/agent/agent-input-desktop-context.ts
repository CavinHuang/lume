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
  message?: unknown
}

export type AgentInputDesktopContextCaptureState =
  | { status: 'ready'; target: DesktopContextTarget }
  | { status: 'unavailable'; message: string }

export async function captureAgentInputDesktopContextState(
  sidecarCall: SidecarCall,
  getPrecapturedContext?: () => Promise<unknown>,
): Promise<AgentInputDesktopContextCaptureState> {
  if (getPrecapturedContext) {
    const precaptured = desktopContextCaptureToTarget(await getPrecapturedContext().catch(() => undefined))
    if (precaptured) return { status: 'ready', target: precaptured }
  }
  try {
    const result = await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT, { userInitiated: true })
    const target = desktopContextCaptureToTarget(result)
    if (target) return { status: 'ready', target }
    return { status: 'unavailable', message: desktopContextCaptureMessage(result) }
  } catch (error) {
    return {
      status: 'unavailable',
      message: error instanceof Error && error.message.trim()
        ? error.message
        : '桌面上下文服务暂不可用',
    }
  }
}

export async function captureAgentInputDesktopContextTarget(
  sidecarCall: SidecarCall,
): Promise<DesktopContextTarget | undefined> {
  const state = await captureAgentInputDesktopContextState(sidecarCall)
  return state.status === 'ready' ? state.target : undefined
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

function desktopContextCaptureMessage(result: unknown): string {
  const value = result as DesktopContextCaptureResult | undefined
  return typeof value?.message === 'string' && value.message.trim()
    ? value.message.trim()
    : '未能读取当前应用窗口'
}
