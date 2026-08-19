import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  net,
  nativeImage,
  Notification,
  protocol,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  utilityProcess,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFileSync } from 'node:child_process'
import { detectMacSignatureStable } from './desktop-signature'
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  computeQuickInputBounds,
  computeDesktopActionHudBounds,
  computeStorageStats,
  computeToggleAction,
  copyDirRecursive,
  createDesktopProposalNotification,
  createDesktopProposalOpenRequest,
  createDesktopActionHudHtml,
  createDesktopActionHudView,
  createFileStatMetadata,
  createOpenFileDialogOptions,
  createOpenFolderDialogOptions,
  createUpdateDownloadProgressEvents,
  createUpdateFinishedEvent,
  createUpdateInfo,
  createWereadTipScript,
  decodeBase64Content,
  dirStats,
  ensureDir,
  ensureExistingPath,
  ensureFile,
  exportZip,
  getQuickInputUrl,
  parseJsonFile,
  readWindowBehaviorFromConfigDir,
  normalizeWindowBehavior,
  resolveWindowBehaviorAction,
  resolveQuickInputContextCapture,
  resolveRememberedDesktopTarget,
  resolveExistingPath,
  resolveConfigDirValue,
  restoreMainWindow,
  shouldCaptureRememberedDesktopTarget,
  validateExternalUrl,
  validateMigrationTarget,
  validateWereadUrl,
  writeLauncherConfigAt,
} from './desktop-core'
import { clampIslandHeight, createIslandWindow } from './agent-island-window'
import {
  AttachmentStageRegistry,
  attachmentStageIdFromPreviewUrl,
  attachmentStagePreviewUrl,
} from './attachment-staging'
import {
  createSecureWebPreferences,
  createWindowOpenAction,
  isAllowedMainFrameNavigation,
  resolveAppProtocolFilePath,
  resolveFileProtocolPath,
  validateIpcSender,
  validateRendererInvokeCommand,
  validateRendererSidecarMethod,
} from './electron-security'
import {
  createPreviewScopeRegistry,
  createPreviewProtocolResponse,
  isAllowedPreviewFrameNavigation,
  previewScopeUrl,
  previewTokenFromUrl,
} from './file-protocol'
import {
  createPluginAssetRegistry,
  pluginAssetTokenFromUrl,
  scopePluginAssetUrls,
} from './plugin-asset-registry'
import {
  createUtilityProcessSidecarForkConfig,
  getBundledRipgrepPath,
  getDesktopHostBinaryPath,
  getNativeBinaryPath,
  getNodeReplHostBinaryPath,
  getNodeReplRootPath,
  getSidecarScriptPath,
} from './sidecar-process'
import * as trayManager from './tray-manager'
import { PageRenderer } from './page-renderer'
import { createDesktopHostSupervisor, type DesktopHostState } from './desktop-host-supervisor'
import {
  createChromeNativeHostInstallPlan,
  writeChromeNativeHostRegistration,
} from './plugin-native-host-installer'
import { loadOrCreateDesktopContextKey } from './desktop-context-key'
import { AgentIslandService } from './agent-island-service'
import { isMacOS26NativeIslandCapable } from './macos-version'
import {
  startMacAgentIslandNativeHost,
  disposeMacAgentIslandNativeHost,
  isMacAgentIslandNativeHostReady,
  publishMacAgentIslandSnapshot,
} from './mac-agent-island-native-host'
import {
  autoUnlockConnectionVault,
  getConnectionVaultStatus,
  setupConnectionVault,
  unlockConnectionVaultWithPassword,
  verifyConnectionVaultPassword,
} from './connection-vault'
import { LoggingService } from './logging/logging-service'
import { DiagnosticContentStore } from './logging/diagnostic-content-store'
import { createLogContentDigest, createSidecarLogDigestPolicy, isSafeStorageSecure } from './logging/log-digest-policy'
import { SettingsBroker } from './settings/settings-broker'
import { createBrowserRuntime, type BrowserRuntime } from './browser-runtime'
import { createLinkRuntimeSupervisor } from './link-runtime-supervisor'
import { discoverChromeProfiles, importChromeProfile, importConnectedChromeCookies, type ImportedCookie } from './browser-import'
import type { LumeDiagnosticCaptureSettings, LumeLogDigestPolicy } from '../../../packages/shared/src/types/logging'
import { nativeEventToIntent } from '../../../packages/shared/src/types/agent-island'
import type { AgentIslandIntent, NativeAgentIslandSnapshot } from '../../../packages/shared/src/types/agent-island'
import {
  createAsyncSingleFlight,
  createEventRateLimiter,
  createMainWindowLifecycleState,
  destroyTrayWithFallback,
  isMainWindowSender,
  validateTrayStatePayload,
  waitForWindowReady,
} from './tray-window-runtime'

app.commandLine.appendSwitch('disable-quic')
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp')

const DESKTOP_ROOT = app.getAppPath()
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')
const DESKTOP_APP_ID = 'com.lume.desktop'
const APP_PROTOCOL = 'lume'
export const FILE_PROTOCOL = 'lume-file'
const APP_PROTOCOL_HOST = 'app'
const APP_PROTOCOL_ORIGIN = `${APP_PROTOCOL}://${APP_PROTOCOL_HOST}`
const HEALTHCHECK_TIMEOUT_MS = 45_000
const SIDECAR_READY_METHOD = 'system.ready'
const SIDECAR_LOG_METHOD = 'system.log'
const SIDECAR_LOG_BATCH_METHOD = 'system.log-batch'
const SIDECAR_LOG_ACK_METHOD = 'system.log-ack'
const SIDECAR_SETTINGS_REPLACE_METHOD = 'system.settings-replace'
const QUIET_SIDECAR_RPC_METHODS = new Set([
  'healthcheck',
  'general-settings:get',
  'agent:list-threads',
  'agent:list-subagent-runs',
  'agent:get-pending-interactive',
  'agent:list-workspaces',
  'channel:oauth-status',
  'model-meta:get',
])
const SLOW_RPC_MS = 2_000
const RENDERER_DELIVERY_ACK_TIMEOUT_MS = 10_000
const UPDATE_INSTALL_HANDOFF_TIMEOUT_MS = 15_000
const SIDE_CAR_EVENT_CHANNEL = 'sidecar:event'
const DATA_MIGRATE_PROGRESS_CHANNEL = 'data:migrate-progress'
const UPDATE_DOWNLOAD_CHANNEL = 'update:download'
const DESKTOP_CONTEXT_UNLOCK_METHOD = 'desktop-context:unlock'
const DESKTOP_CONTEXT_SET_SUSPENDED_METHOD = 'desktop-context:set-suspended'
const DESKTOP_CONTEXT_CAPTURE_METHOD = 'desktop-context:capture-current'
const DESKTOP_CONTEXT_GET_FOREGROUND_TARGET_METHOD = 'desktop-context:get-foreground-target'
const previewScopes = createPreviewScopeRegistry()
const pluginAssets = createPluginAssetRegistry()
const attachmentStages = new AttachmentStageRegistry({
  rootDir: join(app.getPath('temp'), 'lume-attachment-staging'),
})
const attachmentStageOwners = new Set<number>()
let previewOwnershipGateRegistered = false
const DESKTOP_CONTEXT_CAPTURE_WINDOW_METHOD = 'desktop-context:capture-window'
const DESKTOP_CONTEXT_PROPOSAL_CREATED_METHOD = 'desktop-context:proposal-created'
const DESKTOP_CONTEXT_PROPOSAL_OPEN_REQUEST_METHOD = 'desktop-context:proposal-open-request'
const DESKTOP_ACTION_HUD_SIZE = { width: 420, height: 86 }
const DESKTOP_ACTION_HUD_COMPLETED_MS = 1_600
const DESKTOP_ACTION_HUD_STALE_MS = 30_000

let mainWindow = null
let browserRuntime: BrowserRuntime | null = null
const pendingBrowserGuestAttachments = new Map<number, {
  ownerWebContentsId: number
  contents: Electron.WebContents
  timer: ReturnType<typeof setTimeout>
}>()
let agentBrowserPluginEnabled = false
const browserRpcSecret = randomBytes(32)
let browserRpcInboundSequence = 0
let browserRpcOutboundSequence = 0
const browserImportJobs = new Map<string, { cancelled: boolean }>()

async function setImportedBrowserCookie(cookie: ImportedCookie): Promise<() => Promise<void>> {
  const cookieStore = session.fromPartition('persist:lume-browser').cookies
  const existing = (await cookieStore.get({ url: cookie.url, name: cookie.name })).find((entry) => entry.path === cookie.path && (cookie.domain ? entry.domain === cookie.domain : !entry.domain.startsWith('.')))
  await cookieStore.set(cookie)
  return async () => {
    await cookieStore.remove(cookie.url, cookie.name)
    if (!existing) return
    await cookieStore.set({
      url: `${existing.secure ? 'https' : 'http'}://${existing.domain.replace(/^\./, '')}${existing.path}`,
      name: existing.name,
      value: existing.value,
      path: existing.path,
      ...(existing.domain.startsWith('.') ? { domain: existing.domain } : {}),
      ...(existing.expirationDate ? { expirationDate: existing.expirationDate } : {}),
      secure: existing.secure,
      httpOnly: existing.httpOnly,
      sameSite: existing.sameSite,
    })
  }
}
let pendingMacUpdatePath: string | null = null
const mainWindowCreation = createAsyncSingleFlight<any>()
const mainWindowLifecycle = createMainWindowLifecycleState<any>()
const trayWarningLimiter = createEventRateLimiter()
let recentTrayThreads: Array<{ id: string; title: string; updatedAt: number }> = []
let currentTrayThreadId: string | null = null
let trayRefreshTimer: ReturnType<typeof setTimeout> | null = null
let wereadWindow = null
// 隐藏渲染窗口复用实例：render:request 拦截后调用其 renderUrl 并经 render:result 回送 sidecar。
let pageRenderer: PageRenderer | null = null
let isQuitting = false
let windowBehavior = {
  minimizeToTray: false,
  closeToTray: false,
  showTray: true,
}

// 快速输入子窗口（Alt+L）；Task 5 之前始终为 null，此处仅占位以便 IPC 信任集合与事件广播先行就绪。
let quickInputWindow = null
// Agent 灵动岛悬浮窗：由 ensureIslandWindow() 按需创建，destroyIslandWindow() 销毁。
let islandWindow: BrowserWindow | null = null
// Agent 灵动岛 service（Task 6）：lazy 构造于 getAgentIslandService()；onNotification/start/quit 接线在 Task 7。
let agentIslandService: AgentIslandService | null = null
let actionHudWindow = null
let actionHudHideTimer: ReturnType<typeof setTimeout> | null = null
let actionHudGeneration = 0
let latestQuickInputContext: {
  status: string
  snapshotId?: string
  app?: { id: string; name: string }
  window?: { id: string; title: string }
  capturedAt?: number
  message?: string
} = { status: 'unavailable', message: 'desktop context has not been captured' }
let rememberedQuickInputDesktopTarget: {
  app: { id: string; name: string }
  window: { id: string; title: string }
  rememberedAt: number
} | null = null
let desktopHostSupervisor: ReturnType<typeof createDesktopHostSupervisor> | null = null
let linkRuntimeSupervisor: ReturnType<typeof createLinkRuntimeSupervisor> | null = null
let desktopHostState: DesktopHostState = { available: false, reason: 'desktop host has not started' }
let loggingService: LoggingService | null = null
let settingsBroker: SettingsBroker | null = null
let diagnosticContentStore: DiagnosticContentStore | null = null
let sidecarLogDigestPolicy: LumeLogDigestPolicy | null = null
let connectionVaultKey: Buffer | null = null
const pendingRendererDeliveries = new Map()
const rendererLogSubscriptions = new Map()

function getLoggingService() {
  if (!loggingService) {
    const persisted = getSettingsBroker().read()
    const logging = (persisted.generalSettings as { logging?: unknown } | undefined)?.logging
    loggingService = new LoggingService({
      configDir: resolveConfigDir(),
      ...(logging && typeof logging === 'object' ? { settings: logging } : {}),
    })
  }
  return loggingService
}

function getSettingsBroker() {
  if (!settingsBroker) settingsBroker = new SettingsBroker(resolveConfigDir())
  return settingsBroker
}

function getDiagnosticContentStore() {
  if (!diagnosticContentStore) {
    diagnosticContentStore = new DiagnosticContentStore(resolveConfigDir(), {
      isAvailable: () => isSafeStorageSecure(safeStorage),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    })
  }
  return diagnosticContentStore
}

function getSidecarLogDigestPolicy() {
  if (!sidecarLogDigestPolicy) {
    sidecarLogDigestPolicy = createSidecarLogDigestPolicy({
      rootKeyPath: join(resolveConfigDir(), 'logging', 'digest-root.bin'),
      safeStorage,
      allowPersistentKey: isSafeStorageSecure(safeStorage),
    })
  }
  return sidecarLogDigestPolicy
}

function getDiagnosticLease(): LumeDiagnosticCaptureSettings | null {
  const settings = getSettingsBroker().read()
  const logging = (settings.generalSettings as { logging?: { diagnosticCapture?: unknown } } | undefined)?.logging
  if (!logging?.diagnosticCapture || typeof logging.diagnosticCapture !== 'object') return null
  const lease = logging.diagnosticCapture as LumeDiagnosticCaptureSettings
  return lease.enabled && lease.expiresAt && Date.parse(lease.expiresAt) <= Date.now()
    ? { ...lease, enabled: false }
    : lease
}

function writeMainLog(level, context, event, message, extra = {}) {
  return getLoggingService().emit({
    level,
    source: 'main',
    context,
    event,
    message,
    ...extra,
  })
}

function writeRateLimitedTrayWarning(event, message, ownerWebContentsId, data = {}) {
  const generation = mainWindowLifecycle.getGeneration()
  const key = `${event}:${ownerWebContentsId ?? 'unknown'}:${generation}`
  const decision = trayWarningLimiter.record(key)
  if (!decision.allowed) return
  writeMainLog('warn', 'desktop.tray', event, message, {
    data: {
      ...data,
      ownerWebContentsId: ownerWebContentsId ?? null,
      generation,
      suppressedCount: decision.suppressedCount,
    },
  })
}

function requireMainWindowSender(context, command) {
  const mainWindowWebContentsId = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.id : null
  if (isMainWindowSender(mainWindowWebContentsId, context.ownerWebContentsId)) return
  writeRateLimitedTrayWarning(
    'tray.sender_rejected',
    'non-main renderer tray command rejected',
    context.ownerWebContentsId,
    { command },
  )
  throw new Error('main window sender required')
}

/** 当前受信任的渲染窗口集合：mainWindow 总在列；quickInputWindow / islandWindow 存在时纳入。 */
function getTrustedWindows() {
  return [mainWindow, quickInputWindow, islandWindow].filter(
    (w): w is BrowserWindow => !!w && !w.isDestroyed(),
  )
}

function resolveRendererTraceOrigin(ownerWebContentsId) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.id === ownerWebContentsId) return 'main_window'
  if (quickInputWindow && !quickInputWindow.isDestroyed() && quickInputWindow.webContents.id === ownerWebContentsId) return 'quick_input'
  throw new Error('cannot derive trace origin from untrusted renderer')
}

function createSafeMessageLogSummary(value) {
  const text = typeof value === 'string' ? value : ''
  const digestPolicy = getSidecarLogDigestPolicy()
  const preview = text
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gi, '[redacted]')
    .slice(0, 256)
  return {
    length: text.length,
    preview,
    truncated: text.length > 256,
    contentDigest: createLogContentDigest(digestPolicy, text, 'agent-content:user'),
    contentDigestAlgorithm: digestPolicy.algorithm,
    contentDigestKeyVersion: digestPolicy.keyVersion,
    contentDigestScope: digestPolicy.scope,
  }
}

function logDesktopStartup(message, event = 'app.lifecycle', level = 'info') {
  writeMainLog(level, 'desktop.lifecycle', event, message)
  const logPath = process.env.LUME_DESKTOP_STARTUP_LOG?.trim()
  if (!logPath) return
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // Startup diagnostics must never block application startup.
  }
}

logDesktopStartup('main module loaded', 'app.started')

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    scheme: FILE_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
])

const sidecarHost = createSidecarHost({
  onNotification(method, params) {
    if (method === 'system.diagnostic-content') {
      const lease = getDiagnosticLease()
      if (!lease) return
      void getDiagnosticContentStore().capture(params, lease)
        .then((recordId) => {
          writeMainLog('info', 'logging.diagnostic', 'diagnostic.content_captured', 'encrypted diagnostic content captured', {
            kind: 'trace',
            status: 'ok',
            traceId: params.traceId,
            threadId: params.threadId,
            messageId: params.messageId,
            data: { recordId, captureType: params.captureType },
          })
        })
        .catch((error) => {
          writeMainLog('warn', 'logging.diagnostic', 'diagnostic.capture_rejected', 'diagnostic content capture rejected', {
            traceId: params?.traceId,
            threadId: params?.threadId,
            messageId: params?.messageId,
            data: { error },
          })
        })
      return
    }
    // render:request 是 reverse-RPC：sidecar 请求 main 渲染 URL。不转发给 renderer，
    // 而是交给 PageRenderer 处理，完成后经 render:result 把 html|error 回送 sidecar。
    if (method === 'render:request' && params && typeof params.reqId === 'string') {
      void handleRenderRequest(params)
      return
    }
    showDesktopProposalNotification(method, params)
    showPlanningReminderNotification(method, params)
    showDesktopActionHud(method, params)
    // Agent 灵动岛 service（Task 7）：先于 renderer 转发处理 sidecar 通知，
    // 确保即便主窗口隐藏也能触发 intent 刷新。
    getAgentIslandService().handleSidecarNotification(method, params)
    // Task 6（M-3）：planning 变更即时推送——sidecar 在 todo/calendar 任意变更时
    // 发 `planning-todo:changed`（planning-todo-handlers.ts:48-55），触发重拉 +
    // force push 绕过 5min 轮询让岛屿内容在 ~80ms 内更新。
    if (method === 'planning-todo:changed') {
      void getAgentIslandService().onPlanningChanged()
    }
    // thread 列表/标题变更：刷新 recent 投影 + title 缓存（force push 绕过节流）
    if (method === 'agent:thread-list-changed' || method === 'agent:title-updated') {
      void getAgentIslandService().onThreadListChanged()
    }
    emitRendererEvent(SIDE_CAR_EVENT_CHANNEL, { method, params })
  },
})

/**
 * 处理 sidecar 发来的 render:request：调用 PageRenderer 渲染 URL，成功/失败均经
 * render:result 回送 sidecar（成功带 html+finalUrl+status，失败带 error{code,message}）。
 * sidecarHost 为模块级 const，render 请求只在 sidecar 启动后才会到达，故闭包引用安全。
 */
async function handleRenderRequest(params: {
  reqId: string
  url: string
  options?: { timeoutMs?: number; waitForSelector?: string }
}) {
  const { reqId, url, options } = params
  try {
    if (!pageRenderer) throw new Error('renderer not ready')
    const result = await pageRenderer.renderUrl(url, options ?? {})
    await sidecarHost.call('render:result', {
      reqId,
      html: result.html,
      finalUrl: result.finalUrl,
      status: result.status,
    })
  } catch (err: any) {
    const code = String(err?.message || '').includes('timeout')
      ? 'render_timeout'
      : 'render_failed'
    await sidecarHost
      .call('render:result', {
        reqId,
        error: { code, message: err?.message ?? 'render error' },
      })
      .catch(() => {})
  }
}

function ensureDesktopActionHudWindow() {
  if (actionHudWindow && !actionHudWindow.isDestroyed()) return actionHudWindow
  const win = new BrowserWindow({
    width: DESKTOP_ACTION_HUD_SIZE.width,
    height: DESKTOP_ACTION_HUD_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: createSecureWebPreferences(),
  })
  actionHudWindow = win
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('data:text/html')) event.preventDefault()
  })
  win.on('closed', () => {
    if (actionHudWindow === win) actionHudWindow = null
  })
  return win
}

function showDesktopActionHud(method, params) {
  const view = createDesktopActionHudView(method, params)
  if (!view) return
  const win = ensureDesktopActionHudWindow()
  const display = view.point
    ? screen.getDisplayNearestPoint(view.point)
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setBounds(computeDesktopActionHudBounds(display.workArea, DESKTOP_ACTION_HUD_SIZE), false)
  if (actionHudHideTimer) clearTimeout(actionHudHideTimer)
  const generation = ++actionHudGeneration
  const html = createDesktopActionHudHtml(view)
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .then(() => {
      if (generation !== actionHudGeneration || win.isDestroyed()) return
      win.showInactive()
    })
    .catch((error) => {
      writeMainLog('error', 'desktop.action_hud', 'hud.render_failed', 'desktop action HUD failed', { data: { error } })
    })
  actionHudHideTimer = setTimeout(() => {
    if (generation === actionHudGeneration && !win.isDestroyed()) win.hide()
    actionHudHideTimer = null
  }, view.phase === 'started' ? DESKTOP_ACTION_HUD_STALE_MS : DESKTOP_ACTION_HUD_COMPLETED_MS)
}

function showDesktopProposalNotification(method, params) {
  if (method !== DESKTOP_CONTEXT_PROPOSAL_CREATED_METHOD) return

  const notification = createDesktopProposalNotification(params)
  if (!notification || !Notification.isSupported()) return

  try {
    const desktopNotification = new Notification(notification)
    desktopNotification.on('click', () => {
      const openRequest = createDesktopProposalOpenRequest(params)
      if (!openRequest) return
      emitRendererEvent(SIDE_CAR_EVENT_CHANNEL, {
        method: DESKTOP_CONTEXT_PROPOSAL_OPEN_REQUEST_METHOD,
        params: openRequest,
      })
      void showMainWindow().catch((error) => {
        writeMainLog('error', 'desktop.window', 'window.show_failed', 'show main window failed', { data: { error } })
      })
    })
    desktopNotification.show()
  } catch (error) {
    writeMainLog('error', 'desktop.notification', 'notification.show_failed', 'desktop proposal notification failed', { data: { error } })
  }
}

function showPlanningReminderNotification(method, params) {
  if (method !== 'planning-todo:reminder-due' || !Array.isArray(params) || !Notification.isSupported()) return
  for (const reminder of params.slice(0, 5)) {
    if (!reminder || typeof reminder.targetTitle !== 'string') continue
    try {
      const desktopNotification = new Notification({
        title: reminder.targetType === 'calendar_event' ? '日程提醒' : 'Todo 提醒',
        body: reminder.targetTitle,
        silent: true,
      })
      desktopNotification.on('click', () => { void showMainWindow() })
      desktopNotification.show()
    } catch (error) {
      writeMainLog('error', 'desktop.notification', 'planning_reminder.show_failed', 'planning reminder notification failed', { data: { error } })
    }
  }
}

function emitRendererEvent(channel, payload) {
  for (const win of [mainWindow, quickInputWindow]) {
    if (win && !win.isDestroyed()) {
      let deliveredPayload = payload
      const appended = channel === SIDE_CAR_EVENT_CHANNEL
        && payload?.method === 'agent:message-appended'
        && payload?.params?.message?.role === 'assistant'
        && typeof payload?.params?.traceId === 'string'
        ? payload.params
        : null
      if (appended) {
        const deliveryAttemptId = randomUUID()
        const origin = resolveRendererTraceOrigin(win.webContents.id)
        deliveredPayload = {
          ...payload,
          params: { ...appended, deliveryAttemptId },
        }
        const timeout = setTimeout(() => {
          const pending = pendingRendererDeliveries.get(deliveryAttemptId)
          if (!pending) return
          pendingRendererDeliveries.delete(deliveryAttemptId)
          writeMainLog('warn', 'agent.delivery', 'reply.delivery_unknown', 'renderer did not acknowledge committed reply', {
            kind: 'trace',
            status: 'unknown',
            traceId: pending.traceId,
            submissionId: pending.submissionId,
            deliveryAttemptId,
            threadId: pending.threadId,
            messageId: pending.messageId,
            origin: pending.origin,
            data: { webContentsId: pending.webContentsId },
          })
        }, RENDERER_DELIVERY_ACK_TIMEOUT_MS)
        pendingRendererDeliveries.set(deliveryAttemptId, {
          timeout,
          traceId: appended.traceId,
          submissionId: appended.submissionId,
          threadId: appended.threadId,
          messageId: appended.message.id,
          origin,
          webContentsId: win.webContents.id,
        })
        writeMainLog('info', 'agent.delivery', 'reply.forwarded', 'assistant reply forwarded to renderer', {
          kind: 'trace',
          status: 'ok',
          traceId: appended.traceId,
          submissionId: appended.submissionId,
          deliveryAttemptId,
          threadId: appended.threadId,
          messageId: appended.message.id,
          origin,
          data: { webContentsId: win.webContents.id },
        })
      }
      win.webContents.send(`lume:event:${channel}`, deliveredPayload)
    }
  }
}

function getPersistedBrowserSettings() {
  const value = getSettingsBroker().read().browser
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function persistBrowserSettings(settings: unknown): void {
  getSettingsBroker().mutate((current) => ({ ...current, browser: settings }))
}

function browserRpcMac(direction: 'sidecar->main' | 'main->sidecar', sequence: number, id: string, body: unknown): string {
  return createHmac('sha256', browserRpcSecret)
    .update(`${direction}|${sequence}|${id}|${JSON.stringify(body)}`)
    .digest('base64url')
}

function verifyBrowserRpcMac(direction: 'sidecar->main' | 'main->sidecar', sequence: number, id: string, body: unknown, mac: unknown): boolean {
  if (typeof mac !== 'string') return false
  const expected = browserRpcMac(direction, sequence, id, body)
  const actual = Buffer.from(mac)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function getLauncherPath() {
  return join(app.getPath('appData'), DESKTOP_APP_ID, 'launcher.json')
}

function readLauncherConfig() {
  return parseJsonFile(getLauncherPath())
}

function writeLauncherConfig(config) {
  writeLauncherConfigAt(getLauncherPath(), config)
}

function resolveConfigDir() {
  const fromEnv = resolveConfigDirValue(process.env.LUME_CONFIG_DIR)
  if (fromEnv) return ensureDir(fromEnv)

  const launcherConfig = readLauncherConfig()
  const fromLauncher = resolveConfigDirValue(launcherConfig?.configDir)
  if (fromLauncher) return ensureDir(fromLauncher)

  return ensureDir(join(homedir(), '.lume'))
}

function applyLauncherConfig() {
  const launcherPath = getLauncherPath()
  const current = readLauncherConfig()
  const resolvedConfigDir = resolveConfigDir()
  process.env.LUME_CONFIG_DIR = resolvedConfigDir

  const pendingDeleteOld = resolveConfigDirValue(current?.pendingDeleteOld)
  if (pendingDeleteOld && pendingDeleteOld !== resolvedConfigDir && existsSync(pendingDeleteOld)) {
    rmSync(pendingDeleteOld, { recursive: true, force: true })
    writeLauncherConfig({
      ...(current?.configDir ? { configDir: resolveConfigDirValue(current.configDir) } : {}),
      pendingDeleteOld: null,
    })
  } else if (existsSync(launcherPath) && current?.pendingDeleteOld) {
    writeLauncherConfig({
      ...(current?.configDir ? { configDir: resolveConfigDirValue(current.configDir) } : {}),
      pendingDeleteOld: null,
    })
  }

  return resolvedConfigDir
}

function getDevServerUrl() {
  return process.env.LUME_DESKTOP_DEV_SERVER_URL?.trim() || 'http://127.0.0.1:3000'
}

function getWebRootPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'web')
  }
  return resolve(REPO_ROOT, 'apps', 'web', 'dist')
}

function getWebEntryPath() {
  return join(getWebRootPath(), 'index.html')
}

function getPackagedAppUrl() {
  return `${APP_PROTOCOL_ORIGIN}/index.html`
}

function registerAppProtocol() {
  protocol.handle(APP_PROTOCOL, (request) => {
    const filePath = resolveAppProtocolFilePath(request.url, getWebRootPath(), {
      scheme: `${APP_PROTOCOL}:`,
      host: APP_PROTOCOL_HOST,
    })
    if (!filePath || !existsSync(filePath)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
}

function registerFileProtocol() {
  if (!previewOwnershipGateRegistered) {
    previewOwnershipGateRegistered = true
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: [`${FILE_PROTOCOL}://preview/*`, `${FILE_PROTOCOL}://attachment/*`, `${FILE_PROTOCOL}://plugin-asset/*`] },
      (details, callback) => {
        if (details.url.startsWith(`${FILE_PROTOCOL}://attachment/`)) {
          const stagedAttachmentId = attachmentStageIdFromPreviewUrl(details.url)
          callback({ cancel: !stagedAttachmentId || !attachmentStages.owns(stagedAttachmentId, details.webContentsId) })
          return
        }
        if (details.url.startsWith(`${FILE_PROTOCOL}://plugin-asset/`)) {
          const token = pluginAssetTokenFromUrl(details.url)
          callback({ cancel: !token || !pluginAssets.owns(token, details.webContentsId) })
          return
        }
        const token = previewTokenFromUrl(details.url)
        callback({ cancel: !token || !previewScopes.owns(token, details.webContentsId) })
      },
    )
  }
  protocol.handle(FILE_PROTOCOL, async (request) => {
    if (request.url.startsWith(`${FILE_PROTOCOL}://plugin-asset/`)) {
      const token = pluginAssetTokenFromUrl(request.url)
      const asset = token ? pluginAssets.get(token) : undefined
      if (!asset) return new Response('Not Found', { status: 404 })
      return new Response(new Uint8Array(asset.bytes), {
        headers: {
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; sandbox",
          'content-type': asset.mediaType,
          'x-content-type-options': 'nosniff',
        },
      })
    }
    if (request.url.startsWith(`${FILE_PROTOCOL}://attachment/`)) {
      const stagedAttachmentId = attachmentStageIdFromPreviewUrl(request.url)
      const stage = stagedAttachmentId ? attachmentStages.preview(stagedAttachmentId) : null
      if (!stage) return new Response('Not Found', { status: 404 })
      try {
        const response = await net.fetch(pathToFileURL(stage.path).toString())
        const headers = new Headers(response.headers)
        headers.set('content-type', stage.mediaType)
        return new Response(response.body, { status: response.status, headers })
      } catch {
        return new Response('Internal Error', { status: 500 })
      }
    }
    if (request.url.startsWith(`${FILE_PROTOCOL}://preview/`)) {
      const token = previewTokenFromUrl(request.url)
      const scope = token ? previewScopes.get(token) : null
      if (scope?.guardedRef) {
        try {
          const resolved = await sidecarHost.call('agent:resolve-guarded-file-ref', { guardedRef: scope.guardedRef }) as { path: string }
          if (resolve(resolved.path) !== resolve(scope.entryPath)) {
            previewScopes.revoke(scope.token)
            return new Response('Forbidden', { status: 403 })
          }
        } catch {
          previewScopes.revoke(scope.token)
          return new Response('Forbidden', { status: 403 })
        }
      }
      return createPreviewProtocolResponse(previewScopes, request)
    }
    const workspacesRoot = join(resolveConfigDir(), 'agent-workspaces')
    const resolved = resolveFileProtocolPath(request.url, workspacesRoot)
    if (resolved.kind === 'forbidden') return new Response('Forbidden', { status: 403 })
    if (resolved.kind === 'notfound') return new Response('Not Found', { status: 404 })
    try {
      return net.fetch(pathToFileURL(resolved.absPath).toString())
    } catch {
      return new Response('Internal Error', { status: 500 })
    }
  })
}

function getAssetPath(fileName) {
  return resolve(DESKTOP_ROOT, 'assets', fileName)
}

function getTrayIconPath() {
  if (process.platform !== 'darwin') return getAssetPath('icon.ico')
  return app.isPackaged
    ? join(process.resourcesPath, 'tray-icon.png')
    : resolve(REPO_ROOT, 'apps', 'web', 'src', 'assets', 'imgs', 'logo.png')
}

function createWindowIcon() {
  // Windows/Linux 任务栏与 Alt-Tab 图标取自窗口实例；开发模式下进程为 electron.exe，
  // 若不显式设置会回退到 Electron 默认图标。macOS 图标由 .app bundle 提供，无需设置。
  if (process.platform === 'darwin') return undefined
  return nativeImage.createFromPath(getAssetPath(process.platform === 'linux' ? 'icon.png' : 'icon.ico'))
}

function getDefaultSkillsArchivePath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'default-skills.tar')
  }
  return resolve(DESKTOP_ROOT, 'resources', 'default-skills.tar')
}

function getDefaultSkillsDirPath() {
  return resolve(REPO_ROOT, 'apps', 'sidecar', 'default-skills')
}

function getBundledPluginsDirPath() {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'bundled-plugins')
  }
  return resolve(REPO_ROOT, 'apps', 'sidecar', 'bundled-plugins')
}

function handleTrayAction(action, threadId?) {
  switch (action) {
    case 'show-window':
      ensureMainWindowVisible().catch(logTrayActionError)
      return
    case 'hide-window':
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide()
      refreshTrayMenu()
      return
    case 'quick-input':
      toggleQuickInput().catch((error) => writeMainLog('error', 'desktop.quick_input', 'quick_input.toggle_failed', 'quick input toggle failed', { data: { error } }))
      return
    case 'new-thread':
      showMainWindowThenSend({ action: 'new-thread' }).catch(logTrayActionError)
      return
    case 'open-thread':
      if (threadId) showMainWindowThenSend({ action: 'open-thread', threadId }).catch(logTrayActionError)
      return
    case 'open-settings':
      showMainWindowThenSend({ action: 'open-settings' }).catch(logTrayActionError)
      return
    case 'check-update':
      checkForUpdateNow()
      return
    case 'quit':
      isQuitting = true
      app.quit()
      return
  }
}

function logTrayActionError(error) {
  writeMainLog('error', 'desktop.tray', 'tray.action_failed', 'tray action failed', { data: { error } })
}

async function showMainWindowThenSend(payload) {
  const { win, generation } = await ensureMainWindowVisible()
  if (mainWindowLifecycle.isRendererReady(generation)) {
    win.webContents.send('lume:event:tray-action', { ...payload, generation })
  } else {
    const queued = mainWindowLifecycle.queueNavigation(generation, payload)
    if (queued.replaced) {
      writeMainLog('info', 'desktop.lifecycle', 'navigation.replaced', 'pending navigation intent replaced')
    }
  }
}

function checkForUpdateNow() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.checkForUpdates().catch((error) => writeMainLog('warn', 'desktop.update', 'update.check_failed', 'update check failed', { data: { error } }))
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function downloadMacUpdateAsset(url: string, sender: any): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('应用内 DMG 更新仅支持 macOS')
  const parsed = new URL(validateExternalUrl(url))
  const allowedHosts = new Set([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com',
  ])
  if (parsed.protocol !== 'https:' || !allowedHosts.has(parsed.hostname) || !parsed.pathname.toLowerCase().endsWith('.dmg')) {
    throw new Error('无效的 macOS 更新安装包地址')
  }

  const response = await fetch(parsed)
  if (!response.ok || !response.body) {
    throw new Error(`下载 macOS 更新失败：HTTP ${response.status}`)
  }

  const targetDir = ensureDir(join(app.getPath('temp'), 'lume-update'))
  const sourceName = basename(parsed.pathname).replace(/[^a-zA-Z0-9._-]/g, '_') || `Lume-${Date.now()}.dmg`
  const targetPath = join(targetDir, sourceName)
  const contentLength = Number(response.headers.get('content-length'))
  const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null
  const output = createWriteStream(targetPath)
  const reader = response.body.getReader()
  let transferred = 0

  const emit = (payload: unknown) => {
    if (!sender.isDestroyed()) sender.send(`lume:event:${UPDATE_DOWNLOAD_CHANNEL}`, payload)
  }

  emit({ event: 'Started', data: { contentLength: total } })
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      transferred += chunk.value.byteLength
      if (!output.write(chunk.value)) await once(output, 'drain')
      emit({
        event: 'Progress',
        data: { chunkLength: chunk.value.byteLength, transferred, contentLength: total },
      })
    }
    await new Promise<void>((resolveOutput, rejectOutput) => {
      output.once('error', rejectOutput)
      output.end(resolveOutput)
    })
  } catch (error) {
    output.destroy()
    rmSync(targetPath, { force: true })
    throw error
  }

  pendingMacUpdatePath = targetPath
  emit({ event: 'Finished', data: {} })
}

function scheduleMacUpdateInstall(dmgPath: string): void {
  const appBundlePath = dirname(dirname(dirname(process.execPath)))
  if (!appBundlePath.endsWith('.app')) throw new Error('无法定位当前 macOS 应用目录')

  const mountPath = join(app.getPath('temp'), `lume-update-mount-${randomUUID()}`)
  const temporaryBundlePath = `${appBundlePath}.lume-update-${randomUUID()}`
  const script = [
    'set -eu',
    `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
    `mkdir -p ${shellQuote(mountPath)}`,
    `hdiutil attach -nobrowse -readonly -mountpoint ${shellQuote(mountPath)} ${shellQuote(dmgPath)} >/dev/null`,
    `cleanup() { hdiutil detach ${shellQuote(mountPath)} -quiet >/dev/null 2>&1 || true; rm -rf ${shellQuote(mountPath)} ${shellQuote(temporaryBundlePath)}; rm -f ${shellQuote(dmgPath)}; }`,
    'trap cleanup EXIT',
    `source_app=$(find ${shellQuote(mountPath)} -type d -name '*.app' -prune -print | head -n 1)`,
    '[ -n "$source_app" ]',
    `ditto "$source_app" ${shellQuote(temporaryBundlePath)}`,
    `rm -rf ${shellQuote(appBundlePath)}`,
    `mv ${shellQuote(temporaryBundlePath)} ${shellQuote(appBundlePath)}`,
    `open -a ${shellQuote(appBundlePath)}`,
  ].join('\n')

  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' })
  child.unref()
}

function ensureTray() {
  if (trayManager.isTrayAvailable()) return
  try {
    trayManager.createTray({
      iconPath: getTrayIconPath(),
      onClickShow: () => ensureMainWindowVisible().catch(logTrayActionError),
      onAction: handleTrayAction,
    })
  } catch (error) {
    writeMainLog('warn', 'desktop.tray', 'tray.create_failed', 'tray creation failed', { data: { error } })
  }
}

function destroyTraySafely() {
  destroyTrayWithFallback(
    () => trayManager.destroyTray(),
    (error) => {
      writeMainLog('warn', 'desktop.tray', 'tray.destroy_failed', 'tray destruction failed', { data: { error } })
    },
  )
}

async function showMainWindow() {
  await captureQuickInputContext()
  await ensureMainWindowVisible()
}

function refreshTrayMenu(immediate = false) {
  if (!immediate) {
    if (trayRefreshTimer) clearTimeout(trayRefreshTimer)
    trayRefreshTimer = setTimeout(() => { trayRefreshTimer = null; refreshTrayMenu(true) }, 100)
    return
  }
  const windowVisible = Boolean(mainWindow) && !mainWindow.isDestroyed() && mainWindow.isVisible()
  try {
    trayManager.rebuildMenu({ windowVisible, recentThreads: recentTrayThreads, currentThreadId: currentTrayThreadId }, handleTrayAction)
  } catch (error) {
    writeMainLog('warn', 'desktop.tray', 'tray.menu_rebuild_failed', 'tray menu rebuild failed', { data: { error } })
  }
}

function attachWindowBehavior(win) {
  win.on('minimize', (event) => {
    if (resolveWindowBehaviorAction({ platform: process.platform, eventType: 'minimize', trayAvailable: trayManager.isTrayAvailable(), isQuitting, windowBehavior }) === 'hide-to-tray') {
      event.preventDefault(); win.hide(); refreshTrayMenu()
    }
  })

  win.on('close', (event) => {
    const action = resolveWindowBehaviorAction({ platform: process.platform, eventType: 'close', trayAvailable: trayManager.isTrayAvailable(), isQuitting, windowBehavior })
    if (action === 'hide-to-tray') { event.preventDefault(); win.hide(); refreshTrayMenu(); return }
    if (action === 'quit-app') {
      event.preventDefault()
      if (!isQuitting) { isQuitting = true; queueMicrotask(() => app.quit()) }
    }
  })

  win.on('blur', () => {
    const timer = setTimeout(() => {
      rememberForegroundDesktopTarget().catch((error) => {
        writeMainLog('warn', 'desktop.context', 'desktop_target.remember_failed', 'remember foreground desktop target failed', { data: { error } })
      })
    }, 120)
    timer.unref?.()
  })
}

export function attachWebContentsSecurity(win, { allowNavigation }) {
  const ownerWebContentsId = win.webContents.id
  win.webContents.on('will-navigate', (event, url) => {
    if (allowNavigation(url)) return
    event.preventDefault()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    const result = createWindowOpenAction(url)
    if (result.externalUrl) {
      shell.openExternal(result.externalUrl).catch((error) => {
        writeMainLog('warn', 'desktop.security', 'external_url.open_failed', 'failed to open external URL', { data: { error } })
      })
    }
    return { action: result.action }
  })

  win.webContents.on('will-frame-navigate', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) return
    if (isAllowedPreviewFrameNavigation(previewScopes, url, win.webContents.id)) return
    event.preventDefault()
  })
  win.webContents.once('destroyed', () => {
    previewScopes.revokeOwner(ownerWebContentsId)
    pluginAssets.revokeOwner(ownerWebContentsId)
  })

  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

async function createMainWindow() {
  return mainWindowCreation.run(async () => {
    if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
    const generation = mainWindowLifecycle.beginGeneration()
    try {
      return await createMainWindowForGeneration(generation)
    } catch (error) {
      if (mainWindowLifecycle.isCurrent(generation) && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy()
        mainWindow = null
      }
      writeMainLog('error', 'desktop.lifecycle', 'window.create_failed', 'main window creation failed', { data: { generation, error } })
      throw error
    }
  })
}

async function ensureMainWindowVisible() {
  const win = await createMainWindow()
  if (win.isDestroyed() || mainWindow !== win) throw new Error('main window became unavailable')
  restoreMainWindow(win)
  refreshTrayMenu()
  return { win, generation: mainWindowLifecycle.getGeneration() }
}

function attachBrowserGuestSecurity(win: BrowserWindow) {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const bootstrapUrl = typeof params.src === 'string' ? params.src : ''
    const requestedPartition = typeof params.partition === 'string' ? params.partition : ''
    const grant = browserRuntime?.authorizeGuestMount(win.webContents.id, bootstrapUrl, requestedPartition)
    if (!grant) {
      event.preventDefault()
      writeMainLog('warn', 'browser.guest', 'guest.attach_rejected', 'rejected unauthorized browser guest mount', {
        data: browserRuntime?.guestMountRejectionDetails(win.webContents.id, bootstrapUrl, requestedPartition),
      })
      return
    }
    webPreferences.preload = resolve(DESKTOP_ROOT, 'dist', 'preload', 'browser-guest-preload.cjs')
    webPreferences.sandbox = true
    webPreferences.contextIsolation = true
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    params.partition = grant.partition
    params.allowpopups = ''
    delete params.preload
  })
  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    const existing = pendingBrowserGuestAttachments.get(guestContents.id)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      const pending = pendingBrowserGuestAttachments.get(guestContents.id)
      if (!pending || pending.contents !== guestContents) return
      pendingBrowserGuestAttachments.delete(guestContents.id)
      writeMainLog('warn', 'browser.guest', 'guest.attach_timeout', 'browser guest did not report its mount token')
      if (!guestContents.isDestroyed()) guestContents.close()
    }, 10_000)
    pendingBrowserGuestAttachments.set(guestContents.id, { ownerWebContentsId: win.webContents.id, contents: guestContents, timer })
    guestContents.once('destroyed', () => {
      const pending = pendingBrowserGuestAttachments.get(guestContents.id)
      if (!pending || pending.contents !== guestContents) return
      clearTimeout(pending.timer)
      pendingBrowserGuestAttachments.delete(guestContents.id)
    })
  })
}

function stripBrowserGuestMountToken(url: string): string {
  return url.startsWith('about:blank#lume-browser-mount=') ? 'about:blank#lume-browser-mount=[redacted]' : url
}

async function createMainWindowForGeneration(generation) {
  const win = new BrowserWindow({
    title: 'Lume',
    icon: createWindowIcon(),
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#111827',
    show: false,
    // macOS 保留原生交通灯（hiddenInset）；Windows/Linux 仅隐藏标题栏，
    // 保留原生窗口边框、阴影与 resize 命中区，由渲染层自绘控制按钮。
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: createSecureWebPreferences({
      preload: resolve(DESKTOP_ROOT, 'dist', 'preload', 'preload.cjs'),
      webviewTag: true,
    }),
  })
  mainWindow = win
  attachBrowserGuestSecurity(win)

  win.on('closed', () => {
    const closedCurrentGeneration = mainWindowLifecycle.closeGeneration(generation)
    if (mainWindow === win && closedCurrentGeneration) {
      mainWindow = null
      refreshTrayMenu()
    }
  })

  attachWindowBehavior(win)
  // 最大化/还原态变化推送给渲染层，驱动按钮图标切换。
  win.on('maximize', () => emitRendererEvent('window-state', { maximized: true }))
  win.on('unmaximize', () => emitRendererEvent('window-state', { maximized: false }))
  attachWebContentsSecurity(win, {
    allowNavigation: (url) => isAllowedMainFrameNavigation(url, {
      appIsPackaged: app.isPackaged,
      appProtocolOrigin: APP_PROTOCOL_ORIGIN,
      devServerUrl: getDevServerUrl(),
      webEntryPath: getWebEntryPath(),
    }),
  })
  win.setMenuBarVisibility(false)

  const windowUrl = app.isPackaged
    ? (() => {
        const webEntry = getWebEntryPath()
        ensureFile(webEntry, 'missing packaged web entry')
        return getPackagedAppUrl()
      })()
    : getDevServerUrl()
  const readyPromise = waitForWindowReady(win)
  await Promise.all([win.loadURL(windowUrl), readyPromise])

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  if (mainWindow !== win || !mainWindowLifecycle.isCurrent(generation) || win.isDestroyed()) {
    writeMainLog('warn', 'desktop.lifecycle', 'window.stale_generation', 'discarded stale main window ready event')
    throw new Error('stale main window generation')
  }
  win.show()
  refreshTrayMenu()
  return win
}

async function createQuickInputWindow() {
  const win = new BrowserWindow({
    title: 'Lume Quick Input',
    icon: createWindowIcon(),
    ...computeQuickInputBounds(screen.getPrimaryDisplay().workAreaSize),
    minWidth: 520,
    minHeight: 400,
    backgroundColor: '#111827',
    show: false,
    frame: false,
    alwaysOnTop: false,
    webPreferences: createSecureWebPreferences({
      preload: resolve(DESKTOP_ROOT, 'dist', 'preload', 'preload.cjs'),
    }),
  })
  // 关键：先注册到信任集合，再加载渲染层（加载即可能调 IPC）
  quickInputWindow = win

  attachWebContentsSecurity(win, {
    allowNavigation: (url) => isAllowedMainFrameNavigation(url, {
      appIsPackaged: app.isPackaged,
      appProtocolOrigin: APP_PROTOCOL_ORIGIN,
      devServerUrl: getDevServerUrl(),
      webEntryPath: getWebEntryPath(),
    }),
  })

  // 隐藏而非关闭：复用 isQuitting 模式，应用退出时才真关闭
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (quickInputWindow === win) quickInputWindow = null
  })

  await win.loadURL(getQuickInputUrl({
    appIsPackaged: app.isPackaged,
    appProtocolOrigin: APP_PROTOCOL_ORIGIN,
    devServerUrl: getDevServerUrl(),
  }))

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  return win
}

/** 获取当前岛屿窗口（可能为 null/已销毁）。 */
export function getIslandWindow() {
  return islandWindow
}

/** 按需创建岛屿悬浮窗：已存在且未销毁则直接复用。窗口注册在 loadURL 之前，保证首个 IPC 可被信任。 */
export function ensureIslandWindow() {
  if (islandWindow && !islandWindow.isDestroyed()) return islandWindow
  const win = createIslandWindow({
    appIsPackaged: app.isPackaged,
    appProtocolOrigin: APP_PROTOCOL_ORIGIN,
    devServerUrl: getDevServerUrl(),
    desktopRoot: DESKTOP_ROOT,
    savedPosition: readIslandWindowPosition(),
    onWindowMove: (position) => persistIslandWindowPosition(position),
    // M-6 首推竞态：start() 的 push(true) 可能早于 webContents 就绪 → send 静默丢失。
    // renderer did-finish-load +120ms 后清 lastStateJson + force push 强制再推一次。
    onReady: () => getAgentIslandService().repush(),
  })
  islandWindow = win
  win.on('closed', () => {
    if (islandWindow === win) islandWindow = null
  })
  win.once('ready-to-show', () => {
    if (islandWindow === win && !win.isDestroyed()) win.showInactive()
  })
  return win
}

/**
 * 读 settings.islandWindowPosition（Windows/Linux 持久化位置）。
 * 缺省/非有限值返回 null → window 模块走默认吸附逻辑。
 */
function readIslandWindowPosition(): { x: number; y: number } | null {
  const raw = getSettingsBroker().read().generalSettings as
    | { islandWindowPosition?: { x?: unknown; y?: unknown } | null }
    | undefined
  const pos = raw?.islandWindowPosition
  if (
    pos &&
    typeof pos.x === 'number' && Number.isFinite(pos.x) &&
    typeof pos.y === 'number' && Number.isFinite(pos.y)
  ) {
    return { x: pos.x, y: pos.y }
  }
  return null
}

/**
 * 经 settings broker 把拖动后的 {x,y} 写回 generalSettings.islandWindowPosition。
 * 与 sidecar settings-replace 是同一条 settings.json 写路径（broker.mutate → replace），
 * 不绕过既有持久化链。值未变时跳过，避免 clampIslandHeight 等程序化 setBounds
 * 触发的 noop move 事件频繁写盘。
 */
function persistIslandWindowPosition(position: { x: number; y: number }): void {
  try {
    const current = readIslandWindowPosition()
    if (current && current.x === position.x && current.y === position.y) return
    getSettingsBroker().mutate((prev) => ({
      ...prev,
      generalSettings: {
        ...((prev.generalSettings as Record<string, unknown> | undefined) ?? {}),
        islandWindowPosition: { x: position.x, y: position.y },
      },
    }))
  } catch (error) {
    writeMainLog('warn', 'desktop.agent-island', 'position.persist_failed', 'failed to persist island window position', {
      data: { error },
    })
  }
}

/** 销毁岛屿窗口并清空模块级引用。 */
export function destroyIslandWindow() {
  if (islandWindow && !islandWindow.isDestroyed()) islandWindow.destroy()
  islandWindow = null
}

// Phase 2：macOS 26+ 启用原生灵动岛面（NSPanel/SwiftUI）时为真。native 激活期间禁止
// 创建 Electron 岛屿 BrowserWindow（参见 getAgentIslandService 的 deps.ensureIslandWindow 包装）。
let nativeSurfaceActive = false

/**
 * Phase 2：macOS 26+ 优先起 native 面；4s 未 ready / fatal / exit 则回退 Electron 窗。
 * 非 macOS 26（含 Windows/Linux 与 darwin<26）直接走 Phase 1 的 Electron 透明窗路径。
 */
function startAgentIslandSurface(): void {
  if (!isMacOS26NativeIslandCapable()) {
    ensureIslandWindow()
    return
  }
  const started = startMacAgentIslandNativeHost({
    onReady: () => {
      nativeSurfaceActive = true
      destroyIslandWindow()
      agentIslandService?.repush()
    },
    onEvent: (event) => {
      if (event.type === 'intent') {
        agentIslandService?.handleIntent(nativeEventToIntent(event))
      }
    },
    onUnavailable: () => {
      nativeSurfaceActive = false
      ensureIslandWindow()
    },
  })
  if (!started) ensureIslandWindow()
}

/** Phase 2：停用灵动岛渲染面（native host + Electron 窗均释放）。 */
function stopAgentIslandSurface(): void {
  disposeMacAgentIslandNativeHost()
  nativeSurfaceActive = false
  destroyIslandWindow()
}

/**
 * Lazy 构造 Agent 灵动岛 service（Task 6）。onNotification 路由、whenReady 启动、will-quit 销毁
 * 在 Task 7 接线；此处仅保证 `agentIslandService` 符号存在，让 dispatchCommand 的
 * `agent_island_intent` 处理与 tsc 通过。
 */
function getAgentIslandService(): AgentIslandService {
  if (!agentIslandService) {
    agentIslandService = new AgentIslandService({
      isEnabled: () => {
        const s = getSettingsBroker().read()
        const enabled = (s.generalSettings as { agentIsland?: { enabled?: boolean } } | undefined)
          ?.agentIsland?.enabled
        return enabled !== false
      },
      getIslandWindow: () => islandWindow,
      // 退出中或 Phase 2 native 激活时返回 null（不创建 BrowserWindow），避免销毁后被异步推送重建，
      // 以及 native 模式冒 Electron 窗。
      // service push() 的 win 检查已对 null 友好（`if (win && !win.isDestroyed())`）；service
      // 类型签名仍是 `() => BrowserWindow`，这里用 as 收窄 `BrowserWindow | null` 为合同类型。
      ensureIslandWindow: (() => (isQuitting || nativeSurfaceActive ? null : ensureIslandWindow())) as () => BrowserWindow,
      callSidecar: <T,>(method: string, params?: unknown) => sidecarHost.call(method, params ?? null) as Promise<T>,
      openMain: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
      // 复用 tray 的导航路径（showMainWindowThenSend({action:'open-thread',threadId})）。
      openSession: (threadId) => {
        showMainWindowThenSend({ action: 'open-thread', threadId }).catch((error) => {
          writeMainLog(
            'warn',
            'desktop.agent_island',
            'agent_island.open_session_failed',
            'agent island open-session failed',
            { data: { error } },
          )
        })
      },
      // 复用 tray 导航路径打开待办面板；todoId 缺省打开列表，传 id 则定位（renderer LeftSidebar openTodos 处理）。
      openTodo: (todoId) => {
        showMainWindowThenSend({ action: 'open-todo', todoId }).catch((error) => {
          writeMainLog(
            'warn',
            'desktop.agent_island',
            'agent_island.open_todo_failed',
            'agent island open-todo failed',
            { data: { error } },
          )
        })
      },
      // 复用 tray new-thread 导航：打开主窗并新建会话（聚焦 composer）。
      newSession: () => {
        showMainWindowThenSend({ action: 'new-thread' }).catch((error) => {
          writeMainLog(
            'warn',
            'desktop.agent_island',
            'agent_island.new_session_failed',
            'agent island new-session failed',
            { data: { error } },
          )
        })
      },
      // 高度反馈环（spec §3.2）：renderer 测得展开高度后回传，main 调整 BrowserWindow 高度。
      setExpandedHeight: (height) => {
        const w = islandWindow
        if (w && !w.isDestroyed()) clampIslandHeight(w, height)
      },
      // Phase 2：native host ready 时同步推送快照；intent 走 onEvent → handleIntent。
      isNativeReady: () => nativeSurfaceActive && isMacAgentIslandNativeHostReady(),
      publishNativeSnapshot: (snap: NativeAgentIslandSnapshot) => {
        publishMacAgentIslandSnapshot(snap)
      },
    })
  }
  return agentIslandService
}

async function toggleQuickInput() {
  const exists = Boolean(quickInputWindow) && !quickInputWindow.isDestroyed()
  const action = computeToggleAction({
    exists,
    visible: exists && quickInputWindow.isVisible(),
    destroyed: exists ? quickInputWindow.isDestroyed() : undefined,
  })
  if (action === 'create') {
    await captureQuickInputContext()
    await createQuickInputWindow()
    return
  }
  if (action === 'hide') {
    quickInputWindow.hide()
    return
  }
  await captureQuickInputContext()
  quickInputWindow.show()
  quickInputWindow.focus()
}

function requireAttachmentStageOwner(context: { ownerWebContentsId?: number }): number {
  if (!Number.isSafeInteger(context.ownerWebContentsId)) throw new Error('附件暂存缺少可信窗口身份')
  return context.ownerWebContentsId!
}

function stageExistingAttachment(filePath: string, ownerWebContentsId: number) {
  const metadata = createFileStatMetadata(filePath)
  const attachmentId = randomUUID()
  const stage = attachmentStages.grantPath({
    ownerWebContentsId,
    attachmentId,
    sourcePath: filePath,
    filename: metadata.filename,
    mediaType: metadata.mediaType,
  })
  return {
    id: attachmentId,
    filename: stage.filename,
    mediaType: stage.mediaType,
    size: stage.size,
    sourcePath: stage.path,
    stagedAttachmentId: stage.stagedAttachmentId,
    ...(stage.mediaType.startsWith('image/') ? { previewUrl: attachmentStagePreviewUrl(stage) } : {}),
  }
}

function resolveStagedAttachmentParams(params: unknown, ownerWebContentsId?: number) {
  const input = params && typeof params === 'object' ? params as Record<string, any> : {}
  if (!Array.isArray(input.files)) return params ?? null
  if (input.files.some((file) => !file?.stagedAttachmentId)) {
    throw new Error('线程附件必须通过受控暂存协议提交')
  }
  const owner = requireAttachmentStageOwner({ ownerWebContentsId })
  return {
    ...input,
    files: input.files.map((file: Record<string, any>) => {
      if (!file.stagedAttachmentId) return file
      const { stagedAttachmentId, ...rest } = file
      const sourcePath = attachmentStages.resolve({
        ownerWebContentsId: owner,
        stagedAttachmentId: String(stagedAttachmentId),
        attachmentId: String(file.id ?? ''),
      })
      return { ...rest, sourcePath }
    }),
  }
}

async function dispatchCommand(command, payload: Record<string, any> = {}, context: { ownerWebContentsId?: number } = {}) {
  switch (command) {
    case 'connection_vault_status': {
      requireMainWindowSender(context, 'connection_vault_status')
      const status = getConnectionVaultStatus({ path: getConnectionVaultKeyPath(), safeStorage })
      if (status.configured && status.secureStorageAvailable && !connectionVaultKey) {
        await unlockConnectionVaultStore()
      }
      return {
        ...status,
        unlocked: connectionVaultKey !== null,
      }
    }
    case 'connection_vault_setup': {
      requireMainWindowSender(context, 'connection_vault_setup')
      const password = typeof payload.password === 'string' ? payload.password : ''
      const key = setupConnectionVault({ path: getConnectionVaultKeyPath(), password, safeStorage })
      try {
        await installConnectionVaultKeyInSidecar(key)
        connectionVaultKey?.fill(0)
        connectionVaultKey = Buffer.from(key)
      } finally {
        key.fill(0)
      }
      return { configured: true, secureStorageAvailable: true, unlocked: true }
    }
    case 'connection_vault_unlock': {
      requireMainWindowSender(context, 'connection_vault_unlock')
      const password = typeof payload.password === 'string' ? payload.password : ''
      const key = unlockConnectionVaultWithPassword({ path: getConnectionVaultKeyPath(), password })
      try {
        await installConnectionVaultKeyInSidecar(key)
        connectionVaultKey?.fill(0)
        connectionVaultKey = Buffer.from(key)
      } finally {
        key.fill(0)
      }
      const status = getConnectionVaultStatus({ path: getConnectionVaultKeyPath(), safeStorage })
      return { ...status, unlocked: true }
    }
    case 'connection_vault_verify': {
      requireMainWindowSender(context, 'connection_vault_verify')
      const password = typeof payload.password === 'string' ? payload.password : ''
      return { valid: verifyConnectionVaultPassword({ path: getConnectionVaultKeyPath(), password }) }
    }
    case 'connection_vault_reveal_key': {
      requireMainWindowSender(context, 'connection_vault_reveal_key')
      const password = typeof payload.password === 'string' ? payload.password : ''
      const channelId = typeof payload.channelId === 'string' ? payload.channelId : ''
      if (!channelId || !verifyConnectionVaultPassword({ path: getConnectionVaultKeyPath(), password })) {
        throw new Error('connection_vault_password_invalid')
      }
      return { apiKey: await sidecarHost.call('channel:privileged-decrypt-key', { channelId }) }
    }
    case 'browser_runtime': {
      if (!browserRuntime) throw new Error('browser runtime unavailable')
      const browserContext = payload.context && typeof payload.context === 'object'
        ? payload.context
        : { browserSessionId: 'renderer', browserTurnId: 'renderer', actor: 'user' }
      if (context.ownerWebContentsId !== undefined && browserContext.actor !== 'user') {
        throw new Error('renderer browser requests must use actor=user')
      }
      if (context.ownerWebContentsId !== undefined) requireMainWindowSender(context, 'browser_runtime')
      if (browserContext.actor === 'agent' && context.ownerWebContentsId !== undefined) throw new Error('agent browser requests require sidecar ingress')
      return browserRuntime.dispatch({
        requestId: typeof payload.requestId === 'string' ? payload.requestId : randomUUID(),
        context: browserContext,
        method: String(payload.method ?? ''),
        params: payload.params && typeof payload.params === 'object' ? payload.params : {},
        ...(typeof payload.idempotencyKey === 'string' ? { idempotencyKey: payload.idempotencyKey } : {}),
      })
    }
    case 'browser_settings:get':
      requireMainWindowSender(context, 'browser_settings:get')
      if (!browserRuntime) throw new Error('browser runtime unavailable')
      return browserRuntime.getSettings()
    case 'browser_settings:update':
      requireMainWindowSender(context, 'browser_settings:update')
      if (!browserRuntime) throw new Error('browser runtime unavailable')
      {
        if (payload.advancedCdpEnabled === true && browserRuntime.getSettings().advancedCdpEnabled !== true) {
          if (!mainWindow || mainWindow.isDestroyed()) throw new Error('confirmation_unavailable')
          const confirmation = await dialog.showMessageBox(mainWindow, { type: 'warning', buttons: ['启用隔离完整 CDP', '取消'], defaultId: 1, cancelId: 1, title: '完整 CDP 风险确认', message: '完整 CDP 只允许在新建的隔离空白浏览器会话中使用。', detail: '它不会接触保存的 Cookie、密码、外部 Chrome 或其他 target；每个来源和每次 CDP 动作仍需单独批准。' })
          if (confirmation.response !== 0) return browserRuntime.getSettings()
        }
        const settings = browserRuntime.updateSettings(payload as any)
        void sidecarHost.notifyBrowserSettings?.(settings)
        return settings
      }
    case 'browser_import:discover':
      requireMainWindowSender(context, 'browser_import:discover')
      {
        const connected = await sidecarHost.call('browser:chrome-import-status', null).catch(() => ({ available: false })) as { available?: unknown }
        return [
          ...(connected.available === true ? [{ id: 'connected-chrome', name: '当前已连接的 Chrome', platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'win32', source: 'connected', hasCookies: true, hasPasswords: false }] : []),
          ...discoverChromeProfiles(),
        ]
      }
    case 'browser_import:start': {
      requireMainWindowSender(context, 'browser_import:start')
      if (payload.acknowledged !== true) throw new Error('import_acknowledgement_required')
      const profileId = typeof payload.profileId === 'string' ? payload.profileId : ''
      const jobId = randomUUID()
      const job = { cancelled: false }
      browserImportJobs.set(jobId, job)
      if (profileId === 'connected-chrome') {
        if (payload.cookies === false) {
          browserImportJobs.delete(jobId)
          throw new Error('connected_chrome_cookie_import_required')
        }
        void sidecarHost.call('browser:export-chrome-cookies', null).then((cookies) => {
          if (!Array.isArray(cookies)) throw new Error('connected_chrome_export_invalid')
          return importConnectedChromeCookies({
            cookies,
            configDir: resolveConfigDir(),
            cancelled: () => job.cancelled,
            emit: (params) => emitRendererEvent('browser:event', { method: 'browser:import-progress', params: { jobId, ...params } }),
            onCookie: setImportedBrowserCookie,
          })
        }).then((report) => emitRendererEvent('browser:event', { method: 'browser:import-complete', params: { jobId, report } })).catch((error) => emitRendererEvent('browser:event', { method: 'browser:import-complete', params: { jobId, error: error instanceof Error ? error.message : 'import failed' } })).finally(() => browserImportJobs.delete(jobId))
        return { jobId }
      }
      void importChromeProfile({
          profileId,
          cookies: payload.cookies !== false,
          passwords: payload.passwords !== false,
          acknowledged: payload.acknowledged === true,
          configDir: resolveConfigDir(),
          safeStorage,
          cancelled: () => job.cancelled,
          emit: (params) => emitRendererEvent('browser:event', { method: 'browser:import-progress', params: { jobId, ...params } }),
          onCookie: setImportedBrowserCookie,
        }).then((report) => emitRendererEvent('browser:event', { method: 'browser:import-complete', params: { jobId, report } })).catch((error) => emitRendererEvent('browser:event', { method: 'browser:import-complete', params: { jobId, error: error instanceof Error ? error.message : 'import failed' } })).finally(() => browserImportJobs.delete(jobId))
      return { jobId }
    }
    case 'browser_import:cancel': {
      requireMainWindowSender(context, 'browser_import:cancel')
      if (typeof payload.jobId === 'string') {
        const job = browserImportJobs.get(payload.jobId)
        if (job) job.cancelled = true
      }
      return { ok: true }
    }
    case 'healthcheck': {
      await sidecarHost.call('healthcheck', null)
      return {
        ok: true,
        source: 'desktop',
        sidecar: 'ready',
        desktopHost: sanitizeDesktopHostState(desktopHostState),
      }
    }
    case 'sidecar_healthcheck':
      return sidecarHost.call('healthcheck', null)
    case 'agent_island_intent': {
      await agentIslandService?.handleIntent(payload as AgentIslandIntent)
      return null
    }
    case 'link_runtime_state':
      requireMainWindowSender(context, 'link_runtime_state')
      return linkRuntimeSupervisor?.getState() ?? { enabled: false, mode: 'local', phase: 'disabled', port: null, origin: null, remoteOrigin: null, adminTokenConfigured: false, runtimeTokenConfigured: false, version: '1.3.5', dataDirectory: join(resolveConfigDir(), 'link-runtime', 'openconnector', 'data'), restartCount: 0 }
    case 'link_runtime_enable':
      requireMainWindowSender(context, 'link_runtime_enable')
      if (!linkRuntimeSupervisor) throw new Error('link_runtime_unavailable')
      return linkRuntimeSupervisor.enable()
    case 'link_runtime_disable':
      requireMainWindowSender(context, 'link_runtime_disable')
      if (!linkRuntimeSupervisor) throw new Error('link_runtime_unavailable')
      return linkRuntimeSupervisor.disable()
    case 'link_runtime_restart':
      requireMainWindowSender(context, 'link_runtime_restart')
      if (!linkRuntimeSupervisor) throw new Error('link_runtime_unavailable')
      return linkRuntimeSupervisor.restart()
    case 'link_runtime_diagnose':
      requireMainWindowSender(context, 'link_runtime_diagnose')
      if (!linkRuntimeSupervisor) throw new Error('link_runtime_unavailable')
      return linkRuntimeSupervisor.diagnose()
    case 'link_runtime_change_port':
      requireMainWindowSender(context, 'link_runtime_change_port')
      if (!linkRuntimeSupervisor) throw new Error('link_runtime_unavailable')
      return linkRuntimeSupervisor.changePort(Number(payload.port))
    case 'link_runtime_configure':
      requireMainWindowSender(context, 'link_runtime_configure')
      if (!linkRuntimeSupervisor) throw new Error('link_runtime_unavailable')
      return linkRuntimeSupervisor.configure({
        mode: payload.mode,
        ...(typeof payload.origin === 'string' ? { origin: payload.origin } : {}),
        ...(typeof payload.adminToken === 'string' ? { adminToken: payload.adminToken } : {}),
        ...(typeof payload.runtimeToken === 'string' ? { runtimeToken: payload.runtimeToken } : {}),
        ...(payload.clearAdminToken === true ? { clearAdminToken: true } : {}),
        ...(payload.clearRuntimeToken === true ? { clearRuntimeToken: true } : {}),
      })
    case 'sidecar_call': {
      validateRendererSidecarMethod(payload.method)
      if (payload.method !== 'agent:send-thread-message') {
        const params = payload.method === 'agent:save-files-to-thread'
          ? resolveStagedAttachmentParams(payload.params, context.ownerWebContentsId)
          : payload.params ?? null
        const result = await sidecarHost.call(payload.method, params)
        return context.ownerWebContentsId === undefined
          ? result
          : scopePluginAssetUrls(pluginAssets, payload.method, result, context.ownerWebContentsId)
      }
      const origin = resolveRendererTraceOrigin(context.ownerWebContentsId)
      const incoming = payload.params && typeof payload.params === 'object' ? payload.params : {}
      const suppliedSubmissionId = incoming.traceContext?.submissionId
      const submissionId = typeof suppliedSubmissionId === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedSubmissionId)
        ? suppliedSubmissionId
        : randomUUID()
      const traceId = randomUUID()
      const traceContext = {
        submissionId,
        ...(typeof incoming.traceContext?.clientEventId === 'string' ? { clientEventId: incoming.traceContext.clientEventId } : {}),
        traceId,
        origin,
      }
      writeMainLog('info', 'agent.dispatch', 'message.accepted', 'agent message accepted by desktop main', {
        kind: 'trace',
        status: 'ok',
        traceId,
        submissionId,
        threadId: incoming.threadId,
        origin,
        data: createSafeMessageLogSummary(incoming.userMessage),
      })
      const clientSubmissionId = typeof incoming.clientSubmissionId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(incoming.clientSubmissionId)
        ? incoming.clientSubmissionId
        : submissionId
      const result = await sidecarHost.call('agent:send-thread-message:trusted', {
        input: {
          ...incoming,
          clientSubmissionId,
          traceContext,
        },
        trustedSurface: {
          surface: origin === 'quick_input' ? 'quick-input' : 'main',
          clientSubmissionId,
          threadId: incoming.threadId,
        }
      }, traceContext)
      return { ...(result && typeof result === 'object' ? result : {}), traceId, submissionId }
    }
    case 'desktop:save-plugin-package': {
      requireMainWindowSender(context, command)
      const input = payload && typeof payload === 'object' ? payload : {}
      if (typeof input.workspaceSlug !== 'string' || typeof input.catalogItemKey !== 'string' || typeof input.setupStepId !== 'string') {
        throw new Error('invalid plugin package request')
      }
      if (!mainWindow || mainWindow.isDestroyed() || context.ownerWebContentsId === undefined) throw new Error('main window unavailable')
      const ownerWebContentsId = context.ownerWebContentsId
      const ownerGeneration = mainWindowLifecycle.getGeneration()
      const owner = { ownerWebContentsId, ownerGeneration }
      const prepared = await sidecarHost.callPluginPackagePrivileged('plugin-package:privileged-prepare', { ...input, ...owner }) as {
        token: string
        kind: 'file' | 'directory'
        suggestedFilename: string
        size: number
        source: string
        verification: 'verified' | 'unverified'
        sha256: string
        finalOrigin?: string
        originChanged?: boolean
      }
      let consumed = false
      const revoke = async () => {
        if (consumed) return
        await sidecarHost.callPluginPackagePrivileged('plugin-package:privileged-revoke', { token: prepared.token, ...owner }).catch(() => undefined)
      }
      try {
        if (prepared.verification === 'unverified' || prepared.originChanged) {
          const warning = await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: prepared.verification === 'unverified' ? '未验证的配套包' : '下载来源已跳转',
            message: prepared.verification === 'unverified'
              ? '该配套包没有可校验的 SHA-256。是否仍要保存？'
              : '配套包下载跳转到了其他站点。是否仍要保存已校验的文件？',
            detail: `来源：${prepared.finalOrigin ?? prepared.source}\nSHA-256：${prepared.sha256}\n大小：${prepared.size} 字节`,
            buttons: ['取消', '继续保存'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          if (warning.response !== 1) {
            await revoke()
            return { status: 'cancelled' }
          }
        }

        let targetPath
        let overwrite = false
        if (prepared.kind === 'file') {
          const selected = await dialog.showSaveDialog(mainWindow, {
            title: '保存插件配套包',
            defaultPath: prepared.suggestedFilename,
            properties: ['createDirectory', 'showOverwriteConfirmation'],
          })
          if (selected.canceled || !selected.filePath) {
            await revoke()
            return { status: 'cancelled' }
          }
          targetPath = selected.filePath
          overwrite = existsSync(targetPath)
        } else {
          const selected = await dialog.showOpenDialog(mainWindow, {
            title: '选择插件包导出位置',
            properties: ['openDirectory', 'createDirectory'],
          })
          if (selected.canceled || !selected.filePaths[0]) {
            await revoke()
            return { status: 'cancelled' }
          }
          targetPath = join(selected.filePaths[0], prepared.suggestedFilename)
          if (existsSync(targetPath)) {
            const confirmation = await dialog.showMessageBox(mainWindow, {
              type: 'warning',
              title: '替换已有目录',
              message: `“${prepared.suggestedFilename}”已存在，是否整体替换？`,
              detail: '原目录会在新目录完整写入后被替换。',
              buttons: ['取消', '整体替换'],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
            if (confirmation.response !== 1) {
              await revoke()
              return { status: 'cancelled' }
            }
            overwrite = true
          }
        }

        if (!mainWindowLifecycle.isCurrent(ownerGeneration) || mainWindow.isDestroyed() || mainWindow.webContents.id !== ownerWebContentsId) {
          await revoke()
          return { status: 'cancelled' }
        }
        const saved = await sidecarHost.callPluginPackagePrivileged('plugin-package:privileged-finalize', {
          token: prepared.token,
          ...owner,
          targetPath,
          overwrite,
        }) as { savedPath: string }
        consumed = true
        return { status: 'saved', savedPath: saved.savedPath, verification: prepared.verification }
      } catch (error) {
        await revoke()
        throw error
      }
    }
    case 'desktop:install-plugin-package': {
      requireMainWindowSender(context, command)
      const input = payload && typeof payload === 'object' ? payload : {}
      if (typeof input.workspaceSlug !== 'string' || typeof input.catalogItemKey !== 'string' || typeof input.setupStepId !== 'string') {
        throw new Error('invalid plugin package install request')
      }
      if (!mainWindow || mainWindow.isDestroyed() || context.ownerWebContentsId === undefined) throw new Error('main window unavailable')
      const ownerWebContentsId = context.ownerWebContentsId
      const ownerGeneration = mainWindowLifecycle.getGeneration()
      const owner = { ownerWebContentsId, ownerGeneration }
      const prepared = await sidecarHost.callPluginPackagePrivileged('plugin-package:privileged-prepare', { ...input, ...owner }) as {
        token: string
        kind: 'file' | 'directory'
        suggestedFilename: string
        version?: string
        verification: 'verified' | 'unverified'
        originChanged?: boolean
        installer?: {
          kind: 'chrome-native-host'
          hostName: string
          extensionId: string
          appServerUrl: string
        }
      }
      let consumed = false
      const revoke = async () => {
        if (consumed) return
        await sidecarHost.callPluginPackagePrivileged('plugin-package:privileged-revoke', { token: prepared.token, ...owner }).catch(() => undefined)
      }
      try {
        if (prepared.kind !== 'file' || prepared.verification !== 'verified' || prepared.originChanged) {
          throw new Error('本机安装器必须是来源稳定且通过校验的单文件产物')
        }
        if (!prepared.installer || !prepared.version) throw new Error('插件没有声明可执行的本机安装器')
        const plan = createChromeNativeHostInstallPlan({
          installer: prepared.installer,
          version: prepared.version,
          configRoot: resolveConfigDir(),
          homeDir: homedir(),
          localAppData: process.env.LOCALAPPDATA,
        })
        if (!mainWindowLifecycle.isCurrent(ownerGeneration) || mainWindow.isDestroyed() || mainWindow.webContents.id !== ownerWebContentsId) {
          await revoke()
          throw new Error('安装窗口已失效，请重试')
        }
        await sidecarHost.callPluginPackagePrivileged('plugin-package:privileged-finalize', {
          token: prepared.token,
          ...owner,
          targetPath: plan.hostPath,
          overwrite: true,
        })
        consumed = true
        writeChromeNativeHostRegistration(plan)
        if (plan.registry) execFileSync(plan.registry.command, plan.registry.args, { windowsHide: true, stdio: 'ignore' })
        return {
          status: 'installed',
          hostName: plan.hostName,
          hostPath: plan.hostPath,
          manifestPath: plan.manifestPath,
        }
      } catch (error) {
        await revoke()
        throw error
      }
    }
    case 'desktop_wiki_get_proposal_summary':
      requireMainWindowSender(context, command)
      return sidecarHost.callWikiPrivileged('wiki:privileged-get-proposal-summary', { draftId: payload.draftId })
    case 'desktop_wiki_apply_draft':
      requireMainWindowSender(context, command)
      return sidecarHost.callWikiPrivileged('wiki:privileged-apply-draft', payload)
    case 'desktop_wiki_resolve_pending':
      requireMainWindowSender(context, command)
      return sidecarHost.callWikiPrivileged('wiki:privileged-resolve-pending', payload)
    case 'desktop_wiki_get_undo_summary':
      requireMainWindowSender(context, command)
      return sidecarHost.callWikiPrivileged('wiki:privileged-get-undo-summary', { batchId: payload.batchId })
    case 'desktop_wiki_undo_batch':
      requireMainWindowSender(context, command)
      return sidecarHost.callWikiPrivileged('wiki:privileged-undo-batch', payload)
    case 'desktop_sync_window_behavior': {
      requireMainWindowSender(context, 'desktop_sync_window_behavior')
      if (!mainWindowLifecycle.acceptWindowBehaviorRevision(payload?.generation, payload?.revision)) return null
      const previous = windowBehavior
      windowBehavior = normalizeWindowBehavior(payload.windowBehavior ?? windowBehavior)
      if (previous?.showTray !== windowBehavior?.showTray) {
        if (windowBehavior?.showTray) ensureTray()
        else destroyTraySafely()
      }
      return null
    }
    case 'desktop_get_main_window_generation': {
      requireMainWindowSender(context, 'desktop_get_main_window_generation')
      return { generation: mainWindowLifecycle.getGeneration() }
    }
    case 'desktop_renderer_ready': {
      requireMainWindowSender(context, 'desktop_renderer_ready')
      const ready = mainWindowLifecycle.markRendererReady(payload?.generation)
      if (!ready.accepted) return null
      if (ready.payload) mainWindow.webContents.send('lume:event:tray-action', { ...ready.payload, generation: payload.generation })
      return null
    }
    case 'desktop_sync_tray_state': {
      requireMainWindowSender(context, 'desktop_sync_tray_state')
      const validated = validateTrayStatePayload(payload, mainWindowLifecycle.getGeneration())
      if (validated.ok === false) {
        writeRateLimitedTrayWarning('tray.sync_rejected', 'invalid tray state rejected', context.ownerWebContentsId, { reason: validated.reason })
        return null
      }
      recentTrayThreads = validated.value.threads
      currentTrayThreadId = validated.value.currentThreadId
      refreshTrayMenu()
      return null
    }
    case 'desktop_report_tray_navigation_confirmation_failed': {
      requireMainWindowSender(context, 'desktop_report_tray_navigation_confirmation_failed')
      if (payload?.generation !== mainWindowLifecycle.getGeneration()) return null
      if (typeof payload?.threadId !== 'string' || payload.threadId.length < 1 || payload.threadId.length > 128) throw new Error('invalid tray thread id')
      if (payload?.reason !== 'timeout' && payload?.reason !== 'query_failed') throw new Error('invalid tray navigation failure reason')
      writeRateLimitedTrayWarning(
        'tray.navigation_confirmation_failed',
        'tray navigation authority confirmation failed',
        context.ownerWebContentsId,
        { threadId: payload.threadId, reason: payload.reason },
      )
      return null
    }
    case 'quick_input_hide':
      if (quickInputWindow && !quickInputWindow.isDestroyed()) {
        quickInputWindow.hide()
      }
      return null
    case 'quick_input_get_context':
      return prepareQuickInputContext()
    case 'ack_renderer_delivery': {
      const pending = pendingRendererDeliveries.get(payload.deliveryAttemptId)
      if (!pending || pending.webContentsId !== context.ownerWebContentsId) return { ok: false }
      if (pending.messageId !== payload.messageId || pending.threadId !== payload.threadId) return { ok: false }
      clearTimeout(pending.timeout)
      pendingRendererDeliveries.delete(payload.deliveryAttemptId)
      writeMainLog('info', 'agent.delivery', 'reply.committed', 'assistant reply committed by renderer', {
        kind: 'trace',
        status: 'ok',
        traceId: pending.traceId,
        submissionId: pending.submissionId,
        deliveryAttemptId: payload.deliveryAttemptId,
        threadId: pending.threadId,
        messageId: pending.messageId,
        origin: pending.origin,
        data: { webContentsId: pending.webContentsId },
      })
      return { ok: true }
    }
    case 'open_file_dialog': {
      const ownerWebContentsId = requireAttachmentStageOwner(context)
      const result = await dialog.showOpenDialog(mainWindow, createOpenFileDialogOptions())
      return {
        files: result.canceled ? [] : result.filePaths.map((filePath) => stageExistingAttachment(filePath, ownerWebContentsId)),
      }
    }
    case 'stat_file_paths': {
      const ownerWebContentsId = requireAttachmentStageOwner(context)
      return {
        files: (payload.paths ?? []).map((filePath) => stageExistingAttachment(filePath, ownerWebContentsId)),
      }
    }
    case 'attachment_stage_begin': {
      const ownerWebContentsId = requireAttachmentStageOwner(context)
      const stage = attachmentStages.begin({
        ownerWebContentsId,
        attachmentId: String(payload.attachmentId ?? ''),
        filename: String(payload.filename ?? ''),
        mediaType: String(payload.mediaType ?? 'application/octet-stream'),
        size: Number(payload.size),
      })
      return { stagedAttachmentId: stage.stagedAttachmentId }
    }
    case 'attachment_stage_append': {
      const ownerWebContentsId = requireAttachmentStageOwner(context)
      return attachmentStages.append({
        ownerWebContentsId,
        stagedAttachmentId: String(payload.stagedAttachmentId ?? ''),
        offset: Number(payload.offset),
        chunk: payload.chunk,
      })
    }
    case 'attachment_stage_finish': {
      const ownerWebContentsId = requireAttachmentStageOwner(context)
      const stage = attachmentStages.finish({
        ownerWebContentsId,
        stagedAttachmentId: String(payload.stagedAttachmentId ?? ''),
      })
      return {
        stagedAttachmentId: stage.stagedAttachmentId,
        previewUrl: stage.mediaType.startsWith('image/') ? attachmentStagePreviewUrl(stage) : undefined,
      }
    }
    case 'attachment_stage_abort': {
      const ownerWebContentsId = requireAttachmentStageOwner(context)
      attachmentStages.abort({ ownerWebContentsId, stagedAttachmentId: String(payload.stagedAttachmentId ?? '') })
      return null
    }
    case 'open_folder_dialog': {
      const result = await dialog.showOpenDialog(mainWindow, createOpenFolderDialogOptions())
      return {
        path: result.canceled ? null : result.filePaths[0] ?? null,
      }
    }
    case 'open_external':
      await shell.openExternal(validateExternalUrl(payload.url))
      return null
    case 'read_clipboard_text':
      return clipboard.readText()
    case 'write_clipboard_text':
      clipboard.writeText(payload.text ?? '')
      return null
    case 'write_clipboard_image': {
      if (typeof payload.dataUrl === 'string') {
        if (!payload.dataUrl.startsWith('data:image/png;base64,')) throw new Error('仅支持 PNG 图片数据')
        const image = nativeImage.createFromDataURL(payload.dataUrl)
        if (image.isEmpty()) throw new Error('无法读取图片内容')
        clipboard.writeImage(image)
        return null
      }
      const resolved = payload.guardedRef
        ? await sidecarHost.call('agent:resolve-guarded-file-ref', { guardedRef: payload.guardedRef }) as { path: string }
        : payload.ref
          ? await sidecarHost.call('agent:resolve-file-ref', { ref: payload.ref }) as { path: string }
          : { path: resolveExistingPath(payload.path) }
      ensureFile(resolved.path, '图片文件不存在')
      const image = nativeImage.createFromPath(resolved.path)
      if (image.isEmpty()) throw new Error('无法读取图片内容')
      clipboard.writeImage(image)
      return null
    }
    case 'write_web_log':
      getLoggingService().emit({
        level: payload.level ?? 'info',
        source: 'renderer',
        context: payload.context ?? 'app',
        event: payload.event ?? 'log.message',
        message: payload.message ?? '',
        data: payload.data ?? undefined,
      })
      return null
    case 'write_web_log_batch':
      return {
        accepted: getLoggingService().ingestBatch(payload as any, 'renderer'),
        batchId: payload.batchId,
      }
    case 'desktop_list_log_files':
      return getLoggingService().listFiles()
    case 'desktop_read_log_file':
      return getLoggingService().query({
        fileName: payload.fileName,
        levels: payload.levels,
        query: payload.keyword,
        maxLines: payload.maxLines,
        traceId: payload.traceId,
        source: payload.source,
        kind: payload.kind,
        context: payload.context,
        event: payload.event,
        status: payload.status,
      })
    case 'desktop_open_logs_dir':
      await shell.openPath(getLoggingService().logsDir)
      return { ok: true }
    case 'desktop_export_logs': {
      const result = await getLoggingService().exportAll()
      shell.showItemInFolder(join(getLoggingService().logsDir, 'exports', result.fileName))
      return result
    }
    case 'desktop_delete_logs':
      return { deleted: await getLoggingService().clear() }
    case 'desktop_log_live_subscribe': {
      rendererLogSubscriptions.get(context.ownerWebContentsId)?.()
      const target = getTrustedWindows().find((win) => win.webContents.id === context.ownerWebContentsId)
      if (!target) throw new Error('trusted renderer is unavailable')
      const unsubscribe = getLoggingService().subscribe((events) => {
        if (target.isDestroyed() || target.webContents.isDestroyed()) {
          rendererLogSubscriptions.get(context.ownerWebContentsId)?.()
          rendererLogSubscriptions.delete(context.ownerWebContentsId)
          return
        }
        target.webContents.send('lume:event:logs:live', { events })
      })
      rendererLogSubscriptions.set(context.ownerWebContentsId, unsubscribe)
      return { ok: true }
    }
    case 'desktop_log_live_unsubscribe':
      rendererLogSubscriptions.get(context.ownerWebContentsId)?.()
      rendererLogSubscriptions.delete(context.ownerWebContentsId)
      return { ok: true }
    case 'desktop_diagnostic_status':
      return {
        available: getDiagnosticContentStore().isAvailable(),
        lease: getDiagnosticLease(),
      }
    case 'desktop_diagnostic_start': {
      if (!getDiagnosticContentStore().isAvailable()) throw new Error('系统安全存储不可用，无法开启诊断正文捕获')
      const threadId = typeof payload.threadId === 'string' ? payload.threadId : undefined
      const traceId = typeof payload.traceId === 'string' ? payload.traceId : undefined
      if (!threadId && !traceId) throw new Error('必须指定 threadId 或 traceId')
      const durationMinutes = Math.max(1, Math.min(24 * 60, Number(payload.durationMinutes) || 60))
      const current = getDiagnosticLease()
      const diagnosticCapture = {
        enabled: true,
        configVersion: Math.max(1, Number(current?.configVersion) || 1) + 1,
        expiresAt: new Date(Date.now() + durationMinutes * 60_000).toISOString(),
        scope: { ...(threadId ? { threadId } : {}), ...(traceId ? { traceId } : {}) },
      }
      await sidecarHost.call('general-settings:update', { logging: { diagnosticCapture } })
      return { available: true, lease: diagnosticCapture }
    }
    case 'desktop_diagnostic_stop': {
      const current = getDiagnosticLease()
      const diagnosticCapture = {
        enabled: false,
        configVersion: Math.max(1, Number(current?.configVersion) || 1) + 1,
        expiresAt: null,
        scope: null,
      }
      await sidecarHost.call('general-settings:update', { logging: { diagnosticCapture } })
      const deleted = payload.deleteContent === true ? await getDiagnosticContentStore().clear() : 0
      return { available: getDiagnosticContentStore().isAvailable(), lease: diagnosticCapture, deleted }
    }
    case 'desktop_diagnostic_decrypt':
      return getDiagnosticContentStore().decrypt(payload.recordId)
    case 'desktop_diagnostic_delete':
      return { deleted: await getDiagnosticContentStore().clear() }
    case 'save_text_file_dialog': {
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: payload.filename,
      })
      if (result.canceled || !result.filePath) {
        throw new Error('用户取消了保存')
      }
      writeFileSync(result.filePath, payload.content ?? '', 'utf8')
      return { path: result.filePath }
    }
    case 'save_binary_file_dialog': {
      const filters = Array.isArray(payload.filters) && payload.filters.length > 0 ? payload.filters : undefined
      const result = await dialog.showSaveDialog(mainWindow, { defaultPath: payload.filename, ...(filters ? { filters } : {}) })
      if (result.canceled || !result.filePath) return { path: null }
      // 用户手输文件名可能不带扩展名（各平台 dialog 自动补全行为不一致），按需补全
      const extension = typeof payload.ensureExtension === 'string' && payload.ensureExtension.length > 0 ? payload.ensureExtension : null
      const filePath = extension && !result.filePath.toLowerCase().endsWith(extension.toLowerCase())
        ? `${result.filePath}.${extension}`
        : result.filePath
      writeFileSync(filePath, decodeBase64Content(payload.base64Content))
      return { path: filePath }
    }
    case 'save_file_path_dialog': {
      const filters = Array.isArray(payload.filters) && payload.filters.length > 0
        ? payload.filters
        : [{ name: 'SVG 图片', extensions: ['svg'] }]
      const result = await dialog.showSaveDialog(mainWindow, {
        defaultPath: payload.filename,
        filters,
      })
      return { path: result.canceled ? null : result.filePath ?? null }
    }
    case 'save_path_as': {
      ensureFile(payload.source, '源文件不存在')
      const filters = Array.isArray(payload.filters) && payload.filters.length > 0 ? payload.filters : undefined
      const result = await dialog.showSaveDialog(mainWindow, { defaultPath: payload.filename, ...(filters ? { filters } : {}) })
      if (result.canceled || !result.filePath) return { path: null }
      copyFileSync(payload.source, result.filePath)
      return { path: result.filePath }
    }
    case 'open_in_system': {
      ensureExistingPath(payload.path)
      const error = await shell.openPath(payload.path)
      if (error) throw new Error(error)
      return null
    }
    case 'reveal_path_in_system':
      shell.showItemInFolder(resolveExistingPath(payload.path))
      return null
    case 'open_file_ref': {
      const resolved = await sidecarHost.call('agent:resolve-file-ref', { ref: payload.ref }) as { path: string }
      const error = await shell.openPath(resolved.path)
      if (error) throw new Error(error)
      return null
    }
    case 'reveal_file_ref': {
      const resolved = await sidecarHost.call('agent:resolve-file-ref', { ref: payload.ref }) as { path: string }
      shell.showItemInFolder(resolved.path)
      return null
    }
    case 'open_guarded_file_ref': {
      const resolved = await sidecarHost.call('agent:resolve-guarded-file-ref', { guardedRef: payload.guardedRef }) as { path: string }
      const error = await shell.openPath(resolved.path)
      if (error) throw new Error(error)
      return null
    }
    case 'reveal_guarded_file_ref': {
      const resolved = await sidecarHost.call('agent:resolve-guarded-file-ref', { guardedRef: payload.guardedRef }) as { path: string }
      shell.showItemInFolder(resolved.path)
      return null
    }
    case 'save_guarded_file_ref_as': {
      const filters = Array.isArray(payload.filters) && payload.filters.length > 0 ? payload.filters : undefined
      const result = await dialog.showSaveDialog(mainWindow, { defaultPath: payload.filename, ...(filters ? { filters } : {}) })
      if (result.canceled || !result.filePath) return { path: null }
      const resolved = await sidecarHost.call('agent:resolve-guarded-file-ref', { guardedRef: payload.guardedRef }) as { path: string }
      ensureFile(resolved.path, '源文件不存在')
      copyFileSync(resolved.path, result.filePath)
      return { path: result.filePath }
    }
    case 'create_file_preview_scope': {
      if (!context.ownerWebContentsId) throw new Error('preview scope owner is missing')
      const resolved = await sidecarHost.call('agent:resolve-file-ref', { ref: payload.ref }) as { path: string }
      const scope = previewScopes.create({
        kind: payload.kind,
        ownerWebContentsId: context.ownerWebContentsId,
        entryRef: payload.ref,
        absolutePath: resolved.path,
        generation: payload.generation,
      })
      return { token: scope.token, url: previewScopeUrl(scope), expiresAt: scope.expiresAt }
    }
    case 'create_guarded_file_preview_scope': {
      if (!context.ownerWebContentsId) throw new Error('preview scope owner is missing')
      const resolved = await sidecarHost.call('agent:resolve-guarded-file-ref', { guardedRef: payload.guardedRef }) as { path: string }
      const scope = previewScopes.create({
        kind: payload.kind,
        ownerWebContentsId: context.ownerWebContentsId,
        entryRef: payload.guardedRef.ref,
        guardedRef: payload.guardedRef,
        absolutePath: resolved.path,
        generation: payload.generation,
      })
      return { token: scope.token, url: previewScopeUrl(scope), expiresAt: scope.expiresAt }
    }
    case 'revoke_file_preview_scope':
      previewScopes.revoke(String(payload.token ?? ''))
      return null
    case 'open_weread_key_webview': {
      const targetUrl = validateWereadUrl(payload.url)
      if (wereadWindow && !wereadWindow.isDestroyed()) {
        await wereadWindow.loadURL(targetUrl)
        wereadWindow.show()
        wereadWindow.focus()
        return null
      }
      wereadWindow = new BrowserWindow({
        icon: createWindowIcon(),
        width: 1000,
        height: 720,
        show: false,
        autoHideMenuBar: true,
        webPreferences: createSecureWebPreferences(),
      })
      attachWebContentsSecurity(wereadWindow, {
        allowNavigation: (url) => {
          try {
            validateWereadUrl(url)
            return true
          } catch {
            return false
          }
        },
      })
      wereadWindow.on('closed', () => {
        wereadWindow = null
      })
      await wereadWindow.loadURL(targetUrl)
      await wereadWindow.webContents.executeJavaScript(createWereadTipScript())
      wereadWindow.show()
      return null
    }
    case 'data_get_storage_stats':
      return computeStorageStats(resolveConfigDir(), payload.categories ?? [])
    case 'data_export_zip':
      return exportZip(resolveConfigDir(), payload)
    case 'data_migrate_to_dir': {
      const sourcePath = resolveConfigDir()
      const destinationPath = payload.dest
      validateMigrationTarget(sourcePath, destinationPath)
      await sidecarHost.stop()
      const sourceStats = dirStats(sourcePath)
      try {
        const { copiedFiles, copiedBytes } = copyDirRecursive(sourcePath, destinationPath, (progress) => {
          emitRendererEvent(DATA_MIGRATE_PROGRESS_CHANNEL, progress)
        })
        const targetStats = dirStats(destinationPath)
        if (sourceStats.files !== targetStats.files || sourceStats.bytes !== targetStats.bytes) {
          rmSync(destinationPath, { recursive: true, force: true })
          throw new Error(`校验失败：源 ${sourceStats.files} 文件/${sourceStats.bytes} 字节 vs 目标 ${targetStats.files} 文件/${targetStats.bytes} 字节`)
        }
        return {
          destPath: destinationPath,
          fileCount: copiedFiles,
          bytesCopied: copiedBytes,
          verified: true,
        }
      } catch (error) {
        rmSync(destinationPath, { recursive: true, force: true })
        throw error
      }
    }
    case 'data_apply_migration': {
      const oldPath = resolveConfigDir()
      writeLauncherConfig({
        configDir: payload.destPath,
        pendingDeleteOld: payload.deleteOld ? oldPath : null,
      })
      return { ok: true }
    }
    default:
      throw new Error(`unsupported desktop command: ${command}`)
  }
}

function readChromeBridgeConfig(): { endpoint: string; pairingId: string; generation: number; hostPath: string; hostSha256: string } | null {
  const environmentEndpoint = process.env.LUME_CHROME_BRIDGE_ENDPOINT
  const environmentPairingId = process.env.LUME_CHROME_BRIDGE_PAIRING_ID
  const environmentGeneration = Number(process.env.LUME_CHROME_BRIDGE_GENERATION)
  const environmentHostPath = process.env.LUME_CHROME_BRIDGE_HOST_PATH
  const environmentHostSha256 = process.env.LUME_CHROME_BRIDGE_HOST_SHA256
  const fromEnvironment = environmentEndpoint && environmentPairingId && Number.isSafeInteger(environmentGeneration) && environmentGeneration > 0 && environmentHostPath && environmentHostSha256
    ? { endpoint: environmentEndpoint, pairingId: environmentPairingId, generation: environmentGeneration, hostPath: environmentHostPath, hostSha256: environmentHostSha256 }
    : null
  let candidate = fromEnvironment

  if (!candidate) {
    const platformRoot = process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : join(homedir(), '.config')
    const configPath = join(platformRoot, 'Lume', 'ChromeNativeMessaging', 'bridge-config.json')
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { schemaVersion?: unknown; endpoint?: unknown; pairingId?: unknown; generation?: unknown; hostPath?: unknown; hostSha256?: unknown }
      if (parsed.schemaVersion === 3 && typeof parsed.endpoint === 'string' && typeof parsed.pairingId === 'string' && typeof parsed.generation === 'number' && typeof parsed.hostPath === 'string' && typeof parsed.hostSha256 === 'string') {
        candidate = { endpoint: parsed.endpoint, pairingId: parsed.pairingId, generation: parsed.generation, hostPath: parsed.hostPath, hostSha256: parsed.hostSha256 }
      }
    } catch {
      return null
    }
  }

  if (!candidate) return null
  const endpointRoot = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Lume')
    : join(homedir(), '.config', 'Lume')
  const validEndpoint = process.platform === 'win32'
    ? /^\\\\\.\\pipe\\lume-browser-[a-zA-Z0-9_-]{8,80}$/.test(candidate.endpoint)
    : candidate.endpoint.startsWith(endpointRoot + sep) && candidate.endpoint.endsWith('.sock')
  const expectedHostName = process.platform === 'win32' ? 'lume-chrome-host.exe' : 'lume-chrome-host'
  const validHost = resolve(candidate.hostPath) === candidate.hostPath && basename(candidate.hostPath) === expectedHostName && existsSync(candidate.hostPath) && /^[a-f0-9]{64}$/i.test(candidate.hostSha256)
  const validPairing = /^[A-Za-z0-9_-]{8,96}$/.test(candidate.pairingId) && Number.isSafeInteger(candidate.generation) && candidate.generation > 0
  return validEndpoint && validHost && validPairing ? candidate : null
}

function createSidecarHost({ onNotification }) {
  let child = null
  let started = null
  let nextId = 1
  let pending = new Map()
  let stopRequested = false
  let wikiPrivilegedCredential = null

  function rejectAllPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout)
      entry.reject(error)
    }
    pending = new Map()
  }

  function createSpawnConfig() {
    const configDir = resolveConfigDir()
    const chromeBridge = readChromeBridgeConfig()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LUME_CONFIG_DIR: configDir,
      LUME_DEFAULT_SKILLS_AUTOSTART: 'true',
      LUME_BROWSER_RPC_SECRET: browserRpcSecret.toString('base64url'),
      ...(chromeBridge ? {
        LUME_CHROME_BRIDGE_ENDPOINT: chromeBridge.endpoint,
        LUME_CHROME_BRIDGE_PAIRING_ID: chromeBridge.pairingId,
        LUME_CHROME_BRIDGE_GENERATION: String(chromeBridge.generation),
        LUME_CHROME_BRIDGE_HOST_PATH: chromeBridge.hostPath,
        LUME_CHROME_BRIDGE_HOST_SHA256: chromeBridge.hostSha256,
      } : {}),
    }

    if (desktopHostState.available) {
      env.LUME_DESKTOP_HOST_ENDPOINT = desktopHostState.endpoint
      env.LUME_DESKTOP_HOST_TOKEN = desktopHostState.token
    }

    const defaultSkillsArchive = getDefaultSkillsArchivePath()
    if (existsSync(defaultSkillsArchive)) {
      env.LUME_DEFAULT_SKILLS_ARCHIVE = defaultSkillsArchive
    }

    const defaultSkillsDir = getDefaultSkillsDirPath()
    if (existsSync(defaultSkillsDir)) {
      env.LUME_DEFAULT_SKILLS_DIR = defaultSkillsDir
    }

    const bundledPluginsDir = getBundledPluginsDirPath()
    if (existsSync(bundledPluginsDir)) {
      env.LUME_BUNDLED_PLUGINS_DIR = bundledPluginsDir
    }

    const sidecarScriptPath = getSidecarScriptPath({
      appIsPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: DESKTOP_ROOT,
    })
    const nativeBinaryPath = getNativeBinaryPath({
      appIsPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: DESKTOP_ROOT,
    })
    const bundledRipgrepPath = getBundledRipgrepPath({
      appIsPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: DESKTOP_ROOT,
    })
    const nodeReplRootPath = getNodeReplRootPath({
      appIsPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: DESKTOP_ROOT,
    })
    const nodeReplHostBinaryPath = getNodeReplHostBinaryPath({
      appIsPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: DESKTOP_ROOT,
    })
    ensureFile(sidecarScriptPath, 'missing sidecar bundle')
    ensureFile(nativeBinaryPath, 'missing native binary')
    ensureFile(bundledRipgrepPath, 'missing bundled ripgrep binary')
    ensureExistingPath(nodeReplRootPath)
    ensureFile(nodeReplHostBinaryPath, 'missing node_repl host binary')
    env.LUME_NATIVES_PATH = nativeBinaryPath
    env.LUME_RIPGREP_PATH = bundledRipgrepPath
    prependPath(env, dirname(bundledRipgrepPath))
    env.LUME_NODE_REPL_ROOT = nodeReplRootPath
    env.LUME_NODE_REPL_HOST = nodeReplHostBinaryPath
    env.LUME_NODE_REPL_ELECTRON = process.execPath
    return createUtilityProcessSidecarForkConfig({
      sidecarScriptPath,
      env,
    })
  }

  async function start() {
    if (started) {
      await started
      return
    }
    if (child?.pid !== undefined) return

    started = new Promise<void>((resolveStarted, rejectStarted) => {
      stopRequested = false
      browserRpcInboundSequence = 0
      browserRpcOutboundSequence = 0
      const forkConfig = createSpawnConfig()
      const runningChild = utilityProcess.fork(
        forkConfig.modulePath,
        forkConfig.args,
        forkConfig.options,
      )
      let didReady = false
      let startSettled = false
      child = runningChild
      logDesktopStartup(`starting sidecar utility process: ${forkConfig.modulePath}`, 'sidecar.starting')
      let readyTimeout: ReturnType<typeof setTimeout> | undefined
      const settleStart = (error?: Error) => {
        if (startSettled) return
        startSettled = true
        if (readyTimeout) clearTimeout(readyTimeout)
        if (error) {
          rejectStarted(error)
        } else {
          resolveStarted()
        }
      }
      readyTimeout = setTimeout(() => {
        const error = new Error(`sidecar ready timed out after ${HEALTHCHECK_TIMEOUT_MS}ms`)
        logDesktopStartup(error.message, 'sidecar.ready_timeout', 'error')
        rejectAllPending(error)
        if (child === runningChild) {
          child = null
          started = null
          wikiPrivilegedCredential = null
        }
        runningChild.kill()
        settleStart(error)
      }, HEALTHCHECK_TIMEOUT_MS)

      runningChild.on('message', (message) => {
        const trimmed = typeof message === 'string' ? message.trim() : ''
        if (!trimmed) return

        let payload
        try {
          payload = JSON.parse(trimmed)
        } catch {
          return
        }

        if (payload && payload.method === SIDECAR_READY_METHOD && payload.id === undefined) {
          didReady = true
          try {
            wikiPrivilegedCredential = randomBytes(32).toString('base64url')
            runningChild.postMessage(JSON.stringify({
              method: 'system.wiki-privileged-credential',
              params: { credential: wikiPrivilegedCredential },
            }))
          } catch (error) {
            wikiPrivilegedCredential = null
            writeMainLog('error', 'desktop.wiki.security', 'credential.delivery_failed', 'failed to initialize Wiki privileged channel', {
              data: { error },
            })
          }
          try {
            runningChild.postMessage(JSON.stringify({
              method: 'system.logging-policy',
              params: getSidecarLogDigestPolicy(),
            }))
          } catch (error) {
            writeMainLog('warn', 'desktop.sidecar.logging', 'logging.policy_delivery_failed', 'failed to deliver log digest policy', {
              data: { error },
            })
          }
          if (connectionVaultKey) {
            try {
              runningChild.postMessage(JSON.stringify({
                method: 'system.connection-vault-key',
                params: { key: connectionVaultKey.toString('base64') },
              }))
            } catch (error) {
              writeMainLog('error', 'desktop.connection-vault', 'key.delivery_failed', 'failed to unlock connection vault in sidecar', {
                data: { error },
              })
            }
          }
          void linkRuntimeSupervisor?.syncBootstrap().catch((error) => {
            writeMainLog('warn', 'desktop.link', 'bootstrap.delivery_failed', 'failed to deliver Link bootstrap to sidecar', { data: { error } })
          })
          logDesktopStartup('sidecar reported system.ready', 'sidecar.ready')
          settleStart()
          return
        }

        if (payload && payload.method === SIDECAR_LOG_BATCH_METHOD && payload.id === undefined) {
          let accepted = 0
          try {
            accepted = getLoggingService().ingestBatch(payload.params, 'sidecar')
          } catch (error) {
            writeMainLog('warn', 'desktop.sidecar.logging', 'logging.batch_rejected', 'rejected sidecar log batch', {
              data: { error },
            })
          } finally {
            const batchId = payload.params?.batchId
            if (typeof batchId === 'string') {
              try {
                runningChild.postMessage(JSON.stringify({
                  method: SIDECAR_LOG_ACK_METHOD,
                  params: { batchId, accepted },
                }))
              } catch {
                // The sidecar retry timer handles a lost acknowledgement.
              }
            }
          }
          return
        }

        if (payload && payload.method === SIDECAR_SETTINGS_REPLACE_METHOD && payload.id === undefined) {
          const mutationId = typeof payload.params?.mutationId === 'string' ? payload.params.mutationId : null
          try {
            const settings = getSettingsBroker().replace(mutationId ? payload.params.settings : payload.params)
            const logging = (settings.generalSettings as { logging?: unknown } | undefined)?.logging
            if (logging && typeof logging === 'object') getLoggingService().updateSettings(logging)
            // Agent 灵动岛 §5.3：设置开关"关闭后立即生效"。settings-replace 是所有设置写入
            // （含 renderer toggle → sidecar general-settings:update）的唯一汇聚点，故在此处
            // 检测 agentIsland.enabled 翻为 false 即停整个渲染面（native host + Electron 窗）；
            // 反向翻转（重新开启）若发现渲染面已停，重启以恢复 macOS26 原生优先语义。
            const agentIslandEnabled = (settings.generalSettings as { agentIsland?: { enabled?: boolean } } | undefined)
              ?.agentIsland?.enabled
            if (agentIslandEnabled === false) {
              stopAgentIslandSurface()
            } else if (!nativeSurfaceActive && (!islandWindow || islandWindow.isDestroyed())) {
              startAgentIslandSurface()
            }
            if (mutationId) {
              runningChild.postMessage(JSON.stringify({
                method: 'system.settings-ack',
                params: { mutationId, ok: true },
              }))
            }
          } catch (error) {
            writeMainLog('error', 'desktop.settings', 'settings.persist_failed', 'failed to persist sidecar settings snapshot', {
              data: { mutationId, error },
            })
            if (mutationId) {
              try {
                runningChild.postMessage(JSON.stringify({
                  method: 'system.settings-ack',
                  params: {
                    mutationId,
                    ok: false,
                    error: error instanceof Error ? error.message : 'settings persistence failed',
                  },
                }))
              } catch {
                // The sidecar mutation timeout reports the failed acknowledgement.
              }
            }
          }
          return
        }

        if (payload && payload.method === 'browser:request' && payload.id !== undefined) {
          const requestSequence = payload.browserRpc?.sequence
          if (typeof requestSequence !== 'number'
            || requestSequence !== browserRpcInboundSequence + 1
            || !verifyBrowserRpcMac('sidecar->main', requestSequence, String(payload.id), payload.params ?? null, payload.browserRpc.mac)) return
          browserRpcInboundSequence = requestSequence
          void dispatchCommand('browser_runtime', payload.params ?? {}, {})
            .then((result) => {
              const sequence = ++browserRpcOutboundSequence
              const body = { ok: true, result }
              runningChild.postMessage(JSON.stringify({ id: payload.id, result, browserRpc: { sequence, mac: browserRpcMac('main->sidecar', sequence, String(payload.id), body) } }))
            })
            .catch((error) => {
              const sequence = ++browserRpcOutboundSequence
              const body = { ok: false, error: typeof error?.code === 'string' ? error.code : 'browser_internal_error' }
              runningChild.postMessage(JSON.stringify({ id: payload.id, error: { code: body.error }, browserRpc: { sequence, mac: browserRpcMac('main->sidecar', sequence, String(payload.id), body) } }))
            })
          return
        }

        if (payload && payload.method === 'browser:plugin-state' && payload.id === undefined) {
          agentBrowserPluginEnabled = payload.params?.browserEnabled === true || payload.params?.enabled === true
          browserRuntime?.setAgentPluginEnabled(agentBrowserPluginEnabled)
          return
        }

        if (payload && payload.method === 'browser:backend-state' && payload.id === undefined) {
          if (payload.params?.hostConnected === false) browserRuntime?.resetAgentCursor()
          emitRendererEvent('browser:event', { method: payload.method, params: payload.params ?? {} })
          return
        }

        if (payload && payload.method === SIDECAR_LOG_METHOD && payload.id === undefined) {
          try {
            getLoggingService().ingestLegacy(payload.params, 'sidecar')
          } catch {
            // Sidecar stderr remains the fallback for malformed or unwritable log events.
          }
          return
        }

        if (payload && typeof payload.method === 'string' && payload.id === undefined) {
          onNotification(payload.method, payload.params)
          return
        }

        if (payload && payload.id !== undefined) {
          const request = pending.get(payload.id)
          if (!request) return
          pending.delete(payload.id)
          clearTimeout(request.timeout)
          const durationMs = performance.now() - request.startedAt
          if (payload.error) {
            writeMainLog('error', 'desktop.sidecar.rpc', 'rpc.failed', `sidecar RPC failed: ${request.method}`, {
              status: 'error',
              durationMs,
              rpcRequestId: String(payload.id),
              ...request.correlation,
              data: { method: request.method, error: payload.error },
            })
            request.reject(new Error(payload.error.message || 'sidecar rpc failed'))
          } else {
            if (durationMs >= SLOW_RPC_MS) {
              writeMainLog('warn', 'desktop.sidecar.rpc', 'rpc.slow', `slow sidecar RPC: ${request.method}`, {
                durationMs,
                rpcRequestId: String(payload.id),
                ...request.correlation,
                data: { method: request.method },
              })
            } else if (!QUIET_SIDECAR_RPC_METHODS.has(request.method)) {
              writeMainLog('debug', 'desktop.sidecar.rpc', 'rpc.completed', `sidecar RPC completed: ${request.method}`, {
                status: 'ok',
                durationMs,
                rpcRequestId: String(payload.id),
                ...request.correlation,
                data: { method: request.method },
              })
            }
            request.resolve(payload.result)
          }
        }
      })

      let stdoutBuffer = ''
      let stderrBuffer = ''
      const ingestRawOutput = (stream, chunk) => {
        const current = (stream === 'stdout' ? stdoutBuffer : stderrBuffer) + String(chunk)
        const lines = current.split(/\r?\n/)
        const remainder = lines.pop() ?? ''
        if (stream === 'stdout') stdoutBuffer = remainder
        else stderrBuffer = remainder
        for (const line of lines) {
          if (!line.trim()) continue
          writeMainLog('warn', 'desktop.sidecar.process', 'process.raw_output', 'unstructured sidecar process output', {
            data: { stream, line },
          })
        }
      }
      runningChild.stdout?.on('data', (chunk) => ingestRawOutput('stdout', chunk))
      runningChild.stderr?.on('data', (chunk) => ingestRawOutput('stderr', chunk))

      runningChild.once('spawn', () => {
        logDesktopStartup(`sidecar utility process spawned (pid=${runningChild.pid})`, 'sidecar.started')
      })

      runningChild.once('error', (type, location, report) => {
        const error = new Error(`sidecar utility process error: ${type} at ${location}\n${report}`)
        logDesktopStartup(error.message, 'sidecar.process_error', 'error')
        rejectAllPending(error)
        settleStart(error)
      })

      runningChild.once('exit', (code) => {
        const error = new Error(`sidecar exited (code=${code})`)
        if (stdoutBuffer.trim()) ingestRawOutput('stdout', '\n')
        if (stderrBuffer.trim()) ingestRawOutput('stderr', '\n')
        if (stopRequested && code === 0) {
          writeMainLog('debug', 'desktop.sidecar.lifecycle', 'sidecar.stopped', error.message, { status: 'ok' })
        } else {
          writeMainLog(didReady ? 'warn' : 'error', 'desktop.sidecar.lifecycle', 'sidecar.exited', error.message, {
            status: 'error',
            data: { code, expected: stopRequested, ready: didReady },
          })
        }
        rejectAllPending(error)
        if (!didReady) settleStart(error)
        if (child === runningChild) {
          child = null
          started = null
          wikiPrivilegedCredential = null
        }
      })
    })

    try {
      await started
    } finally {
      if (child === null) started = null
    }
  }

  async function call(method, params, correlation = {}) {
    await start()
    const requestId = nextId++
    const payload = JSON.stringify({
      id: requestId,
      method,
      params,
    })

    return new Promise((resolveCall, rejectCall) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId)
        writeMainLog('error', 'desktop.sidecar.rpc', 'rpc.timeout', `sidecar RPC timed out: ${method}`, {
          status: 'error',
          durationMs: HEALTHCHECK_TIMEOUT_MS,
          rpcRequestId: String(requestId),
          ...correlation,
          data: { method },
        })
        rejectCall(new Error(`sidecar request timed out: ${method}`))
      }, HEALTHCHECK_TIMEOUT_MS)

      pending.set(requestId, {
        resolve: resolveCall,
        reject: rejectCall,
        timeout,
        method,
        startedAt: performance.now(),
        correlation,
      })

      try {
        child.postMessage(payload)
      } catch (error) {
        clearTimeout(timeout)
        pending.delete(requestId)
        rejectCall(error)
      }
    })
  }

  async function callWikiPrivileged(method, request) {
    await start()
    if (!wikiPrivilegedCredential) throw new Error('Wiki privileged channel unavailable')
    return call(method, { credential: wikiPrivilegedCredential, request })
  }

  async function callPluginPackagePrivileged(method, request) {
    await start()
    if (!wikiPrivilegedCredential) throw new Error('Plugin package privileged channel unavailable')
    if (typeof method !== 'string' || !method.startsWith('plugin-package:privileged-')) {
      throw new Error('Invalid plugin package privileged method')
    }
    return call(method, { credential: wikiPrivilegedCredential, request })
  }

  async function notifyBrowserSettings(settings) {
    await start()
    child.postMessage(JSON.stringify({ method: 'browser:settings', params: { extensionBackendEnabled: settings?.extensionBackendEnabled === true } }))
  }

  async function stop() {
    if (!child || child.pid === undefined) return
    stopRequested = true
    const runningChild = child
    child = null
    started = null
    wikiPrivilegedCredential = null
    rejectAllPending(new Error('sidecar stopped'))
    await new Promise<void>((resolveStop) => {
      const timeout = setTimeout(resolveStop, 3_000)
      runningChild.once('exit', () => {
        clearTimeout(timeout)
        resolveStop()
      })
      if (!runningChild.kill()) {
        clearTimeout(timeout)
        resolveStop()
      }
    })
  }

  return {
    start,
    call,
    callWikiPrivileged,
    callPluginPackagePrivileged,
    notifyBrowserSettings,
    stop,
  }
}

function prependPath(env: NodeJS.ProcessEnv, directory: string): void {
  const pathKey = Object.keys(env).find((key) => key.toLocaleLowerCase() === 'path') || (process.platform === 'win32' ? 'Path' : 'PATH')
  const current = env[pathKey] || ''
  const entries = current.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  if (!entries.some((entry) => entry.toLocaleLowerCase() === directory.toLocaleLowerCase())) {
    env[pathKey] = [directory, ...entries].join(process.platform === 'win32' ? ';' : ':')
  }
}

ipcMain.on('lume:browser-guest-mounted', (event, bootstrapUrl) => {
  const pending = pendingBrowserGuestAttachments.get(event.sender.id)
  if (!pending || pending.contents !== event.sender) return
  clearTimeout(pending.timer)
  pendingBrowserGuestAttachments.delete(event.sender.id)
  const validUrl = typeof bootstrapUrl === 'string' ? bootstrapUrl : ''
  if (!validUrl || !browserRuntime?.attachGuest(pending.ownerWebContentsId, validUrl, pending.contents)) {
    writeMainLog('warn', 'browser.guest', 'guest.attach_invalid', 'destroyed browser guest after failed mount validation', {
      data: { bootstrapUrl: stripBrowserGuestMountToken(validUrl) },
    })
    if (!pending.contents.isDestroyed()) pending.contents.close()
  }
})

// Task 83：Web MCP 主进程侧。
//
// guest-preload qe() 通过 contextBridge.exposeInMainWorld('__lumeWebMcpModelContext', shim)
// 注入 main-world 句柄，并在 shim onToolsChanged 回调中 ipcRenderer.send
// ('lume:browser-page-event', { type:'webmcp_changed', version:1 })。此处监听该通道，
// 转发给 browser-runtime（反查 sender→tab，emit browser:webmcp-changed 让 agent 刷新 webmcp:list）。
ipcMain.on('lume:browser-page-event', (event, payload) => {
  browserRuntime?.handlePageEvent(event.sender, payload)
})

// guest-preload qe() 启动时 sendSync('lume:get-browser-webmcp-enabled') 询问开关。
// 默认 true（BrowserRuntime.descriptor() 已默认暴露 webmcp capability；后续如需 settings
// 开关，可在此读 browserRuntime?.getSettings()）。未注册时 sendSync 返回 undefined → qe() 视为关闭。
ipcMain.on('lume:get-browser-webmcp-enabled', (event) => {
  event.returnValue = true
})

ipcMain.handle('lume:invoke', async (event, command, payload) => {
  validateIpcSender(event, getTrustedWindows())
  const ownerWebContentsId = event.sender.id
  if (!attachmentStageOwners.has(ownerWebContentsId)) {
    attachmentStageOwners.add(ownerWebContentsId)
    event.sender.once('destroyed', () => {
      attachmentStageOwners.delete(ownerWebContentsId)
      attachmentStages.cleanupOwner(ownerWebContentsId)
      pluginAssets.revokeOwner(ownerWebContentsId)
    })
  }
  return dispatchCommand(validateRendererInvokeCommand(command), payload, { ownerWebContentsId })
})
ipcMain.handle('lume:window-control', async (event, op) => {
  // 操作 sender 对应的受信任窗口（主窗口或快速输入子窗口）。
  // 子窗口 close 会命中 createQuickInputWindow 的 close 拦截 → hide（除非退出中）。
  const target = [mainWindow, quickInputWindow].find(
    (win) => win && !win.isDestroyed() && win.webContents === event.sender,
  )
  if (!target) throw new Error('no trusted window for window-control sender')
  switch (op) {
    case 'minimize':
      target.minimize()
      return null
    case 'toggleMaximize':
      if (target.isMaximized()) target.unmaximize()
      else target.maximize()
      return null
    case 'close':
      target.close()
      return null
    case 'isMaximized':
      return target.isMaximized()
    default:
      throw new Error(`unsupported window-control op: ${String(op)}`)
  }
})
ipcMain.handle('lume:relaunch', async (event) => {
  validateIpcSender(event, getTrustedWindows())
  setImmediate(() => {
    app.relaunch()
    app.exit(0)
  })
  return null
})
ipcMain.handle('lume:update:check', async (event) => {
  validateIpcSender(event, getTrustedWindows())
  if (!app.isPackaged) return null
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  const result = await autoUpdater.checkForUpdates()
  return createUpdateInfo(result?.updateInfo, app.getVersion())
})
ipcMain.handle('lume:update:download', async (event) => {
  validateIpcSender(event, getTrustedWindows())
  if (!app.isPackaged) return null
  const sender = event.sender
  const progressState = { previousTransferred: 0, started: false }

  return new Promise((resolveDownload, rejectDownload) => {
    let finished = false
    const cleanup = () => {
      autoUpdater.removeListener('download-progress', onProgress)
      autoUpdater.removeListener('update-downloaded', onDownloaded)
      autoUpdater.removeListener('error', onError)
    }
    const emitDownloadEvent = (payload) => {
      if (!sender.isDestroyed()) {
        sender.send(`lume:event:${UPDATE_DOWNLOAD_CHANNEL}`, payload)
      }
    }
    const onProgress = (progress) => {
      for (const payload of createUpdateDownloadProgressEvents(progressState, progress)) {
        emitDownloadEvent(payload)
      }
    }
    const onDownloaded = () => {
      finished = true
      cleanup()
      emitDownloadEvent(createUpdateFinishedEvent())
      resolveDownload(null)
    }
    const onError = (error) => {
      cleanup()
      rejectDownload(error)
    }

    autoUpdater.on('download-progress', onProgress)
    autoUpdater.once('update-downloaded', onDownloaded)
    autoUpdater.once('error', onError)
    autoUpdater.downloadUpdate().then(() => {
      if (!finished) onDownloaded()
    }).catch(onError)
  })
})
ipcMain.handle('lume:update:download-asset', async (event, payload) => {
  validateIpcSender(event, getTrustedWindows())
  if (!app.isPackaged) return null
  if (!payload || typeof payload.url !== 'string') throw new Error('缺少更新安装包地址')
  await downloadMacUpdateAsset(payload.url, event.sender)
  return null
})
ipcMain.handle('lume:update:install', async (event) => {
  validateIpcSender(event, getTrustedWindows())
  if (!app.isPackaged) return null
  if (pendingMacUpdatePath) {
    const dmgPath = pendingMacUpdatePath
    pendingMacUpdatePath = null
    scheduleMacUpdateInstall(dmgPath)
    isQuitting = true
    setImmediate(() => app.quit())
    return null
  }
  return new Promise<never>((_resolveInstall, rejectInstall) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      autoUpdater.removeListener('error', onError)
    }
    const onError = (error) => {
      cleanup()
      isQuitting = false
      rejectInstall(error instanceof Error ? error : new Error(String(error)))
    }

    autoUpdater.once('error', onError)
    timeout = setTimeout(() => {
      onError(new Error('更新安装器未能接管应用退出'))
    }, UPDATE_INSTALL_HANDOFF_TIMEOUT_MS)
    timeout.unref?.()

    // quitAndInstall 会自行启动安装器并退出应用。保持 IPC pending，避免调用方在
    // 安装器接管前继续执行普通 relaunch，从而再次启动尚未替换的旧实例。
    isQuitting = true
    try {
      // Windows 静默安装会让应用退出后出现一段不可见的空白期；显示安装器进度，
      // 并在安装完成后自动启动新版本。
      autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      onError(error)
    }
  })
})

ipcMain.handle('lume:app:signature', async (event) => {
  validateIpcSender(event, getTrustedWindows())
  const macSignatureStable = await detectMacSignatureStable({
    platform: process.platform,
    isPackaged: app.isPackaged,
    execPath: process.execPath,
  })
  return { macSignatureStable }
})

// Windows 任务栏图标/分组依赖 AppUserModelId，必须在 ready 事件前设置；
// 否则任务栏会回退到承载进程 exe 的图标——dev 下即 electron.exe 的默认图标。
app.setAppUserModelId(DESKTOP_APP_ID)

app.on('child-process-gone', (_event, details) => {
  writeMainLog('error', 'browser.guest', 'child_process.gone', 'Electron child process exited', {
    data: { type: details.type, reason: details.reason, exitCode: details.exitCode, serviceName: details.serviceName },
  })
})

app.whenReady().then(async () => {
  logDesktopStartup('app ready', 'app.ready')
  registerAppProtocol()
  registerFileProtocol()
  const configDir = applyLauncherConfig()
  browserRuntime = createBrowserRuntime({
    getWindow: () => mainWindow,
    configDir: () => configDir,
    emit: (event) => emitRendererEvent('browser:event', event),
    initialSettings: getPersistedBrowserSettings() as Partial<import('../../../packages/shared/src/types/browser-runtime').BrowserSettings>,
    persistSettings: persistBrowserSettings,
    isAgentPluginEnabled: () => agentBrowserPluginEnabled,
    journalEncryption: {
      available: safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    },
    credentialStorage: safeStorage,
    authPreloadPath: resolve(DESKTOP_ROOT, 'dist', 'preload', 'browser-auth-preload.cjs'),
    onInternalError: ({ method, actor, tabId, message }) => {
      writeMainLog('error', 'browser.runtime', 'runtime.dispatch_failed', 'browser runtime action failed', {
        data: { method, actor, ...(tabId ? { tabId } : {}), message },
      })
    },
  })
  windowBehavior = readWindowBehaviorFromConfigDir(configDir)
  if (windowBehavior?.showTray !== false) ensureTray()
  logDesktopStartup('tray ready')
  // dev 模式 macOS Dock 默认显示 Electron 图标；显式设为 Lume（打包后由 bundle 内 icns 接管）
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(getAssetPath('icon.png')))
  }
  desktopHostState = await startDesktopHost()
  await sidecarHost.start()
  await unlockConnectionVaultStore()
  linkRuntimeSupervisor = createLinkRuntimeSupervisor({
    configDir,
    resourceDir: app.isPackaged ? join(process.resourcesPath, 'openconnector') : join(DESKTOP_ROOT, 'resources', 'openconnector'),
    getMasterKey: () => connectionVaultKey,
    fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
    emit: (state) => emitRendererEvent('link:runtime', state),
    installBootstrap: async (bootstrap) => { await sidecarHost.call('system.link-bootstrap', bootstrap) },
    killProcessTree: (pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else { try { process.kill(pid, 'SIGKILL') } catch {} }
    },
  })
  await sidecarHost.notifyBrowserSettings?.(browserRuntime.getSettings())
  logDesktopStartup('sidecar ready', 'sidecar.ready')
  pageRenderer = new PageRenderer()
  await unlockDesktopContextStore()
  registerDesktopContextPowerEvents()
  await captureQuickInputContext()
  await createMainWindow()
  void linkRuntimeSupervisor.initialize().catch((error) => {
    writeMainLog('warn', 'desktop.link', 'runtime.autostart_failed', 'Link runtime autostart failed', { data: { error } })
  })
  // Agent 灵动岛 service（Task 7）：主窗口就绪后启动，开始响应 sidecar intent。
  await getAgentIslandService().start()
  // Phase 2：启动渲染面（macOS 26+ 优先 native，否则 Electron 窗）。native 4s 未 ready 由 host 回退。
  startAgentIslandSurface()
  logDesktopStartup('main window ready')
  // 检查 Alt+L 注册结果：被系统或其他程序占用时 register 返回 false，记录但不中断启动
  const quickInputShortcutRegistered = globalShortcut.register('Alt+L', () => {
    toggleQuickInput().catch((error) => {
      writeMainLog('error', 'desktop.quick_input', 'quick_input.toggle_failed', 'quick input toggle failed', { data: { error } })
    })
  })
  if (!quickInputShortcutRegistered) {
    writeMainLog('error', 'desktop.quick_input', 'shortcut.registration_failed', 'globalShortcut Alt+L 注册失败（可能被其他程序占用）')
  }
}).catch((error) => {
  logDesktopStartup(`startup failed: ${error.stack ?? error}`, 'app.start_failed', 'fatal')
  app.exit(1)
})

app.on('activate', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await captureQuickInputContext()
    await createMainWindow()
    return
  }
  await showMainWindow()
})

app.on('before-quit', () => {
  isQuitting = true
  // Windows 灵动岛窗口设置了 closable=false，不能依赖 app.quit() 的常规 close 流程。
  // 在同步退出阶段主动 destroy，且先停 service，避免异步推送在退出过程中重建窗口。
  agentIslandService?.destroy()
  agentIslandService = null
  stopAgentIslandSurface()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !trayManager.isTrayAvailable()) {
    app.quit()
  }
})

app.on('will-quit', async () => {
  for (const pending of pendingBrowserGuestAttachments.values()) clearTimeout(pending.timer)
  pendingBrowserGuestAttachments.clear()
  browserRuntime?.destroy()
  browserRuntime = null
  desktopHostSupervisor?.stop()
  await linkRuntimeSupervisor?.stop('offline')
  await sidecarHost.stop()
  writeMainLog('info', 'desktop.lifecycle', 'app.stopping', 'app stopping')
  await loggingService?.close()
  settingsBroker?.close()
  globalShortcut.unregisterAll()
  connectionVaultKey?.fill(0)
  connectionVaultKey = null
})

async function startDesktopHost(): Promise<DesktopHostState> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return { available: false, reason: `desktop host is unsupported on ${process.platform}` }
  }
  try {
    const binaryPath = getDesktopHostBinaryPath({
      appIsPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: DESKTOP_ROOT,
    })
    desktopHostSupervisor = createDesktopHostSupervisor({
      binaryPath,
      log: logDesktopStartup,
    })
    const state = await desktopHostSupervisor.start()
    logDesktopStartup(state.available ? 'desktop host started' : ('reason' in state ? state.reason : 'desktop host unavailable'))
    return state
  } catch (error) {
    const reason = `desktop host unavailable: ${error instanceof Error ? error.message : String(error)}`
    logDesktopStartup(reason)
    return { available: false, reason }
  }
}

function sanitizeDesktopHostState(state: DesktopHostState) {
  return state.available
    ? { available: true, endpoint: state.endpoint }
    : { available: false, reason: 'reason' in state ? state.reason : 'desktop host unavailable' }
}

async function unlockDesktopContextStore() {
  let key = null
  try {
    key = loadOrCreateDesktopContextKey({
      path: join(resolveConfigDir(), 'desktop-context', 'key.bin'),
      safeStorage,
    })
    await sidecarHost.call(DESKTOP_CONTEXT_UNLOCK_METHOD, { key: key.toString('base64') })
    logDesktopStartup('desktop context store unlocked')
  } catch (error) {
    logDesktopStartup(`desktop context store unavailable: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    key?.fill(0)
  }
}

function getConnectionVaultKeyPath(): string {
  return join(resolveConfigDir(), 'connection-vault-key.json')
}

async function installConnectionVaultKeyInSidecar(key: Buffer): Promise<void> {
  await sidecarHost.call('system.connection-vault-key', { key: key.toString('base64') })
}

async function unlockConnectionVaultStore(): Promise<void> {
  let key: Buffer | undefined
  try {
    key = autoUnlockConnectionVault({ path: getConnectionVaultKeyPath(), safeStorage })
    if (!key) return
    await installConnectionVaultKeyInSidecar(key)
    connectionVaultKey?.fill(0)
    connectionVaultKey = Buffer.from(key)
    logDesktopStartup('connection vault unlocked')
  } catch (error) {
    logDesktopStartup(`connection vault unavailable: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    key?.fill(0)
  }
}

function registerDesktopContextPowerEvents() {
  const update = (reason: 'screen_locked' | 'system_suspended', suspended: boolean) => {
    void sidecarHost.call(DESKTOP_CONTEXT_SET_SUSPENDED_METHOD, { reason, suspended })
      .catch((error) => logDesktopStartup(
        `desktop context suspension update failed: ${error instanceof Error ? error.message : String(error)}`,
      ))
  }
  powerMonitor.on('lock-screen', () => update('screen_locked', true))
  powerMonitor.on('unlock-screen', () => update('screen_locked', false))
  powerMonitor.on('suspend', () => update('system_suspended', true))
  powerMonitor.on('resume', () => update('system_suspended', false))
}

async function captureQuickInputContext() {
  try {
    const value = await sidecarHost.call(DESKTOP_CONTEXT_CAPTURE_METHOD, { userInitiated: true })
    latestQuickInputContext = resolveQuickInputContextCapture(latestQuickInputContext, value)
  } catch (error) {
    latestQuickInputContext = resolveQuickInputContextCapture(latestQuickInputContext, {
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function prepareQuickInputContext() {
  if (!shouldCaptureRememberedDesktopTarget(latestQuickInputContext, rememberedQuickInputDesktopTarget)) {
    return latestQuickInputContext
  }
  const target = rememberedQuickInputDesktopTarget
  if (!target) return latestQuickInputContext
  rememberedQuickInputDesktopTarget = null
  try {
    const value = await sidecarHost.call(DESKTOP_CONTEXT_CAPTURE_WINDOW_METHOD, {
      windowId: target.window.id,
      userInitiated: true,
    })
    latestQuickInputContext = resolveQuickInputContextCapture(latestQuickInputContext, value)
  } catch (error) {
    latestQuickInputContext = resolveQuickInputContextCapture(latestQuickInputContext, {
      status: 'unavailable',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return latestQuickInputContext
}

async function rememberForegroundDesktopTarget() {
  const value = await sidecarHost.call(DESKTOP_CONTEXT_GET_FOREGROUND_TARGET_METHOD, {})
  rememberedQuickInputDesktopTarget = resolveRememberedDesktopTarget(
    rememberedQuickInputDesktopTarget,
    value,
    Date.now(),
  )
}
