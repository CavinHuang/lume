import {
  DESKTOP_CONTEXT_IPC_CHANNELS,
  type DesktopContextTarget,
} from '@lume/shared'

type SidecarCall = (method: string, params: Record<string, unknown>) => Promise<unknown>
const LUME_SELF_CONTEXT_MESSAGE = '当前前台窗口是 Lume，请切回目标应用后再唤起或附加上下文。'

type DesktopContextCaptureResult = {
  status?: string
  snapshotId?: unknown
  app?: { id?: unknown; name?: unknown }
  window?: { id?: unknown; title?: unknown }
  capturedAt?: unknown
  message?: unknown
  permissionTarget?: unknown
  missingPermissions?: unknown
}

export type AgentInputDesktopContextCaptureState =
  | { status: 'ready'; target: DesktopContextTarget }
  | { status: 'unavailable'; message: string; permissionRequestAvailable?: boolean }

export async function captureAgentInputDesktopContextState(
  sidecarCall: SidecarCall,
  getPrecapturedContext?: () => Promise<unknown>,
): Promise<AgentInputDesktopContextCaptureState> {
  if (getPrecapturedContext) {
    const precaptured = desktopContextCaptureToTarget(await getPrecapturedContext().catch(() => undefined))
    if (precaptured) {
      return desktopContextTargetState(precaptured)
    }
  }
  try {
    const result = await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_CURRENT, { userInitiated: true })
    const target = desktopContextCaptureToTarget(result)
    if (target) return desktopContextTargetState(target)
    return {
      status: 'unavailable',
      message: desktopContextCaptureMessage(result),
      ...(desktopContextPermissionRequestAvailable(result) ? { permissionRequestAvailable: true } : {}),
    }
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

export async function refreshAgentInputDesktopContextState(
  sidecarCall: SidecarCall,
  target: DesktopContextTarget,
): Promise<AgentInputDesktopContextCaptureState> {
  try {
    const result = await sidecarCall(DESKTOP_CONTEXT_IPC_CHANNELS.CAPTURE_WINDOW, {
      windowId: target.window.id,
      userInitiated: true,
    })
    const refreshed = desktopContextCaptureToTarget(result)
    if (refreshed) return desktopContextTargetState(refreshed)
    return {
      status: 'unavailable',
      message: desktopContextCaptureMessage(result),
      ...(desktopContextPermissionRequestAvailable(result) ? { permissionRequestAvailable: true } : {}),
    }
  } catch (error) {
    return {
      status: 'unavailable',
      message: error instanceof Error && error.message.trim()
        ? error.message
        : '桌面上下文刷新失败',
    }
  }
}

export function createDesktopContextMessageMetadata(target: DesktopContextTarget): Record<string, unknown> {
  return {
    desktopContextSnapshotId: target.snapshotId,
    desktopApp: target.app,
    desktopWindow: target.window,
  }
}

export function resolveAgentInputDesktopMessageMetadata(input: {
  propTarget?: DesktopContextTarget
  localTarget?: DesktopContextTarget
  messageMetadata?: Record<string, unknown>
}): Record<string, unknown> | undefined {
  const target = input.localTarget ?? input.propTarget
  const targetMetadata = target ? createDesktopContextMessageMetadata(target) : undefined
  const merged = {
    ...(input.messageMetadata ?? {}),
    ...(targetMetadata ?? {}),
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export function desktopPermissionRequestMessage(result: unknown): string {
  const value = result && typeof result === 'object' && !Array.isArray(result)
    ? result as { message?: unknown; nextPermission?: { title?: unknown; instruction?: unknown }; permissionTarget?: { appBundleName?: unknown; appName?: unknown } }
    : undefined
  if (typeof value?.message === 'string' && value.message.trim()) return value.message.trim()
  const appName = permissionTargetName(value?.permissionTarget)
  if (typeof value?.nextPermission?.instruction === 'string' && value.nextPermission.instruction.trim()) {
    return `已打开授权引导：${value.nextPermission.instruction.trim()}`
  }
  if (typeof value?.nextPermission?.title === 'string' && value.nextPermission.title.trim()) {
    return `已打开授权引导，请在系统设置中允许 ${appName} 使用 ${value.nextPermission.title}；如果列表里同时看到 Lume，请选择 ${appName}，不要授权 Lume 主应用。`
  }
  return `已打开 ${appName} 授权引导，请在系统设置中选择 ${appName}，不要授权 Lume 主应用。`
}

export function desktopPermissionRequestToastMessage(result: unknown): string {
  const value = result && typeof result === 'object' && !Array.isArray(result)
    ? result as { status?: unknown; permissionTarget?: { appBundleName?: unknown; appName?: unknown } }
    : undefined
  const appName = permissionTargetName(value?.permissionTarget)
  return value?.status === 'ok'
    ? `${appName} 授权已完成`
    : `已启动 ${appName} 授权引导`
}

export function desktopPermissionRequestCompleted(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && !Array.isArray(result)
    && (result as { status?: unknown }).status === 'ok')
}

export function resolveAgentInputDesktopContextView(input: {
  propTarget?: DesktopContextTarget
  capturedTarget?: DesktopContextTarget
  localTarget?: DesktopContextTarget
  captureLoading: boolean
  captureMessage?: string
}): {
  selectedTarget?: DesktopContextTarget
  plusPanelTarget?: DesktopContextTarget
  showPlusPanelSection: boolean
} {
  const selectedTarget = input.propTarget ?? input.localTarget
  const plusPanelTarget = input.captureLoading || input.captureMessage
    ? undefined
    : input.capturedTarget ?? selectedTarget
  return {
    selectedTarget,
    plusPanelTarget,
    showPlusPanelSection: Boolean(plusPanelTarget) || input.captureLoading || Boolean(input.captureMessage) || Boolean(selectedTarget),
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

function desktopContextPermissionRequestAvailable(result: unknown): boolean {
  const value = result as DesktopContextCaptureResult | undefined
  if (!value || typeof value.permissionTarget !== 'object' || !Array.isArray(value.missingPermissions)) return false
  return value.missingPermissions.some((permission) => {
    const item = permission as { status?: unknown } | undefined
    return item?.status === 'missing'
  })
}

function permissionTargetName(value: DesktopContextCaptureResult['permissionTarget']): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Lume Computer Use.app'
  const target = value as { appBundleName?: unknown; appName?: unknown }
  if (typeof target.appBundleName === 'string' && target.appBundleName.trim()) return target.appBundleName.trim()
  if (typeof target.appName === 'string' && target.appName.trim()) return target.appName.trim()
  return 'Lume Computer Use.app'
}

function desktopContextTargetState(target: DesktopContextTarget): AgentInputDesktopContextCaptureState {
  return isLumeShellTarget(target)
    ? { status: 'unavailable', message: LUME_SELF_CONTEXT_MESSAGE }
    : { status: 'ready', target }
}

function isLumeShellTarget(target: DesktopContextTarget): boolean {
  const appId = normalizeSelfContextText(target.app.id)
  const appName = normalizeSelfContextText(target.app.name)
  const title = normalizeSelfContextText(target.window.title)
  const exactLumeApp = appId === 'lume' || appId === 'lume.exe' || appName === 'lume' || appName === 'lume.exe'
  const electronShell = appId === 'electron' || appId === 'electron.exe' || appName === 'electron' || appName === 'electron.exe'
  return exactLumeApp || (electronShell && title.includes('lume'))
}

function normalizeSelfContextText(value: string): string {
  return value.trim().toLowerCase()
}
