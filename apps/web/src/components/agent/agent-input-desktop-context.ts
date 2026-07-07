import {
  DESKTOP_CONTEXT_IPC_CHANNELS,
  type DesktopContextTarget,
} from '@lume/shared'

type SidecarCall = (method: string, params: Record<string, unknown>) => Promise<unknown>
const DEFAULT_MAX_PRECAPTURED_CONTEXT_AGE_MS = 60_000
const LUME_SELF_CONTEXT_MESSAGE = '当前前台窗口是 Lume，请切回目标应用后再唤起或附加上下文。'

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
  options: { nowMs?: number; maxPrecapturedAgeMs?: number } = {},
): Promise<AgentInputDesktopContextCaptureState> {
  if (getPrecapturedContext) {
    const precaptured = desktopContextCaptureToTarget(await getPrecapturedContext().catch(() => undefined))
    if (precaptured && isFreshPrecapturedContext(precaptured, options)) {
      return desktopContextTargetState(precaptured)
    }
  }
  try {
    const result = await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT, { userInitiated: true })
    const target = desktopContextCaptureToTarget(result)
    if (target) return desktopContextTargetState(target)
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

function isFreshPrecapturedContext(
  target: DesktopContextTarget,
  options: { nowMs?: number; maxPrecapturedAgeMs?: number },
): boolean {
  if (typeof target.capturedAt !== 'number') return true
  const nowMs = options.nowMs ?? Date.now()
  const maxAgeMs = options.maxPrecapturedAgeMs ?? DEFAULT_MAX_PRECAPTURED_CONTEXT_AGE_MS
  return nowMs - target.capturedAt <= maxAgeMs
}

function desktopContextTargetState(target: DesktopContextTarget): AgentInputDesktopContextCaptureState {
  return isLumeShellTarget(target)
    ? { status: 'unavailable', message: LUME_SELF_CONTEXT_MESSAGE }
    : { status: 'ready', target }
}

function isLumeShellTarget(target: DesktopContextTarget): boolean {
  const appText = `${target.app.id} ${target.app.name}`.toLowerCase()
  const title = target.window.title.toLowerCase()
  return appText.includes('lume') || (appText.includes('electron') && title.includes('lume'))
}
