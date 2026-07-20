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
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
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
  createFileMetadata,
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
import {
  createSecureWebPreferences,
  createWindowOpenAction,
  isAllowedMainFrameNavigation,
  resolveAppProtocolFilePath,
  resolveFileProtocolPath,
  validateIpcSender,
  validateRendererInvokeCommand,
} from './electron-security'
import {
  createPreviewScopeRegistry,
  createPreviewProtocolResponse,
  isAllowedPreviewFrameNavigation,
  previewScopeUrl,
  previewTokenFromUrl,
} from './file-protocol'
import {
  createUtilityProcessSidecarForkConfig,
  getDesktopHostBinaryPath,
  getNativeBinaryPath,
  getNodeReplHostBinaryPath,
  getNodeReplRootPath,
  getSidecarScriptPath,
} from './sidecar-process'
import * as trayManager from './tray-manager'
import { PageRenderer } from './page-renderer'
import { createDesktopHostSupervisor, type DesktopHostState } from './desktop-host-supervisor'
import { loadOrCreateDesktopContextKey } from './desktop-context-key'
import { LoggingService } from './logging/logging-service'
import { DiagnosticContentStore } from './logging/diagnostic-content-store'
import { createLogContentDigest, createSidecarLogDigestPolicy, isSafeStorageSecure } from './logging/log-digest-policy'
import { SettingsBroker } from './settings/settings-broker'
import type { LumeDiagnosticCaptureSettings, LumeLogDigestPolicy } from '../../../packages/shared/src/types/logging'

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
  'model-meta:get',
])
const SLOW_RPC_MS = 2_000
const RENDERER_DELIVERY_ACK_TIMEOUT_MS = 10_000
const UPDATE_INSTALL_HANDOFF_TIMEOUT_MS = 15_000
const TEXT_FILE_LIMIT = 512 * 1024
const SIDE_CAR_EVENT_CHANNEL = 'sidecar:event'
const DATA_MIGRATE_PROGRESS_CHANNEL = 'data:migrate-progress'
const UPDATE_DOWNLOAD_CHANNEL = 'update:download'
const DESKTOP_CONTEXT_UNLOCK_METHOD = 'desktop-context:unlock'
const DESKTOP_CONTEXT_SET_SUSPENDED_METHOD = 'desktop-context:set-suspended'
const DESKTOP_CONTEXT_CAPTURE_METHOD = 'desktop-context:capture-current'
const DESKTOP_CONTEXT_GET_FOREGROUND_TARGET_METHOD = 'desktop-context:get-foreground-target'
const previewScopes = createPreviewScopeRegistry()
let previewOwnershipGateRegistered = false
const DESKTOP_CONTEXT_CAPTURE_WINDOW_METHOD = 'desktop-context:capture-window'
const DESKTOP_CONTEXT_PROPOSAL_CREATED_METHOD = 'desktop-context:proposal-created'
const DESKTOP_CONTEXT_PROPOSAL_OPEN_REQUEST_METHOD = 'desktop-context:proposal-open-request'
const DESKTOP_ACTION_HUD_SIZE = { width: 420, height: 86 }
const DESKTOP_ACTION_HUD_COMPLETED_MS = 1_600
const DESKTOP_ACTION_HUD_STALE_MS = 30_000

let mainWindow = null
let mainWindowCreationPromise: Promise<any> | null = null
let mainWindowGeneration = 0
let rendererReadyGeneration = 0
let acceptedWindowBehaviorRevision = -1
let pendingTrayNavigation: { generation: number; payload: any } | null = null
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
let desktopHostState: DesktopHostState = { available: false, reason: 'desktop host has not started' }
let loggingService: LoggingService | null = null
let settingsBroker: SettingsBroker | null = null
let diagnosticContentStore: DiagnosticContentStore | null = null
let sidecarLogDigestPolicy: LumeLogDigestPolicy | null = null
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

/** 当前受信任的渲染窗口集合：mainWindow 总在列；quickInputWindow 存在时纳入。 */
function getTrustedWindows() {
  return [mainWindow, quickInputWindow].filter(Boolean)
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
    showDesktopActionHud(method, params)
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
      { urls: [`${FILE_PROTOCOL}://preview/*`] },
      (details, callback) => {
        const token = previewTokenFromUrl(details.url)
        callback({ cancel: !token || !previewScopes.owns(token, details.webContentsId) })
      },
    )
  }
  protocol.handle(FILE_PROTOCOL, async (request) => {
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
  if (rendererReadyGeneration === generation) {
    win.webContents.send('lume:event:tray-action', payload)
  } else {
    if (pendingTrayNavigation?.generation === generation) {
      writeMainLog('info', 'desktop.lifecycle', 'navigation.replaced', 'pending navigation intent replaced')
    }
    pendingTrayNavigation = { generation, payload }
  }
}

function checkForUpdateNow() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.checkForUpdates().catch((error) => writeMainLog('warn', 'desktop.update', 'update.check_failed', 'update check failed', { data: { error } }))
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
  trayManager.rebuildMenu({ windowVisible, recentThreads: recentTrayThreads, currentThreadId: currentTrayThreadId }, handleTrayAction)
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
  win.webContents.once('destroyed', () => previewScopes.revokeOwner(ownerWebContentsId))

  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

async function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  if (mainWindowCreationPromise) return mainWindowCreationPromise
  const generation = ++mainWindowGeneration
  acceptedWindowBehaviorRevision = -1
  rendererReadyGeneration = 0
  mainWindowCreationPromise = createMainWindowForGeneration(generation)
  try {
    return await mainWindowCreationPromise
  } catch (error) {
    if (mainWindowGeneration === generation && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy()
      mainWindow = null
    }
    writeMainLog('error', 'desktop.lifecycle', 'window.create_failed', 'main window creation failed', { data: { generation, error } })
    throw error
  } finally {
    mainWindowCreationPromise = null
  }
}

async function ensureMainWindowVisible() {
  const win = await createMainWindow()
  if (win.isDestroyed() || mainWindow !== win) throw new Error('main window became unavailable')
  restoreMainWindow(win)
  refreshTrayMenu()
  return { win, generation: mainWindowGeneration }
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
    }),
  })
  mainWindow = win

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

  const readyPromise = new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => rejectReady(new Error('main window ready timeout')), 15_000)
    win.once('ready-to-show', () => { clearTimeout(timeout); resolveReady() })
    win.once('closed', () => { clearTimeout(timeout); rejectReady(new Error('main window closed before ready')) })
  })

  if (app.isPackaged) {
    const webEntry = getWebEntryPath()
    ensureFile(webEntry, 'missing packaged web entry')
    await win.loadURL(getPackagedAppUrl())
  } else {
    await win.loadURL(getDevServerUrl())
  }

  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' })
  }

  win.on('closed', () => {
    if (mainWindow === win && mainWindowGeneration === generation) {
      mainWindow = null
      rendererReadyGeneration = 0
      if (pendingTrayNavigation?.generation === generation) pendingTrayNavigation = null
      refreshTrayMenu()
    }
  })
  await readyPromise
  if (mainWindow !== win || mainWindowGeneration !== generation || win.isDestroyed()) {
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

async function dispatchCommand(command, payload: Record<string, any> = {}, context: { ownerWebContentsId?: number } = {}) {
  switch (command) {
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
    case 'sidecar_call': {
      if (payload.method !== 'agent:send-thread-message') {
        return sidecarHost.call(payload.method, payload.params ?? null)
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
      const result = await sidecarHost.call(payload.method, { ...incoming, traceContext }, traceContext)
      return { ...(result && typeof result === 'object' ? result : {}), traceId, submissionId }
    }
    case 'desktop_sync_window_behavior': {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== context.ownerWebContentsId) throw new Error('main window sender required')
      if (payload?.generation !== mainWindowGeneration || !Number.isSafeInteger(payload?.revision) || payload.revision <= acceptedWindowBehaviorRevision) return null
      const previous = windowBehavior
      windowBehavior = normalizeWindowBehavior(payload.windowBehavior ?? windowBehavior)
      acceptedWindowBehaviorRevision = payload.revision
      if (previous?.showTray !== windowBehavior?.showTray) {
        if (windowBehavior?.showTray) ensureTray()
        else trayManager.destroyTray()
      }
      return null
    }
    case 'desktop_get_main_window_generation': {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== context.ownerWebContentsId) throw new Error('main window sender required')
      return { generation: mainWindowGeneration }
    }
    case 'desktop_renderer_ready': {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== context.ownerWebContentsId) throw new Error('main window sender required')
      if (payload?.generation !== mainWindowGeneration) return null
      rendererReadyGeneration = mainWindowGeneration
      if (pendingTrayNavigation?.generation === mainWindowGeneration) {
        const pending = pendingTrayNavigation
        pendingTrayNavigation = null
        mainWindow.webContents.send('lume:event:tray-action', pending.payload)
      }
      return null
    }
    case 'desktop_sync_tray_state': {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.id !== context.ownerWebContentsId) throw new Error('main window sender required')
      if (payload?.generation !== mainWindowGeneration) return null
      const serialized = JSON.stringify(payload)
      const rejectTrayState = () => {
        writeMainLog('warn', 'desktop.tray', 'tray.sync_rejected', 'invalid tray state rejected')
        throw new Error('invalid tray state')
      }
      if (Buffer.byteLength(serialized, 'utf8') > 8_192 || !Array.isArray(payload.threads) || payload.threads.length > 5) rejectTrayState()
      const ids = new Set<string>()
      const threads = payload.threads.map((thread) => {
        if (!thread || typeof thread.id !== 'string' || thread.id.length < 1 || thread.id.length > 128 || ids.has(thread.id)
          || typeof thread.title !== 'string' || thread.title.length > 256
          || !Number.isFinite(thread.updatedAt) || thread.updatedAt < 0) rejectTrayState()
        ids.add(thread.id)
        return { id: thread.id, title: thread.title, updatedAt: thread.updatedAt }
      })
      if (payload.currentThreadId != null && (typeof payload.currentThreadId !== 'string' || payload.currentThreadId.length < 1 || payload.currentThreadId.length > 128)) rejectTrayState()
      recentTrayThreads = threads
      currentTrayThreadId = payload.currentThreadId ?? null
      refreshTrayMenu()
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
      const result = await dialog.showOpenDialog(mainWindow, createOpenFileDialogOptions())
      return {
        files: result.canceled ? [] : result.filePaths.map((filePath) => createFileMetadata(filePath)),
      }
    }
    case 'stat_file_paths':
      return {
        files: (payload.paths ?? []).map((filePath) => createFileMetadata(filePath)),
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
    case 'read_text_file': {
      const text = readFileSync(payload.path, 'utf8')
      const truncated = text.length > TEXT_FILE_LIMIT
      return {
        content: truncated ? text.slice(0, TEXT_FILE_LIMIT) : text,
        truncated,
      }
    }
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
    case 'write_binary_file':
      writeFileSync(payload.path, decodeBase64Content(payload.base64Content))
      return { path: payload.path }
    case 'copy_file':
      ensureFile(payload.source, `源文件不存在`)
      copyFileSync(payload.source, payload.target)
      return null
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

function createSidecarHost({ onNotification }) {
  let child = null
  let started = null
  let nextId = 1
  let pending = new Map()
  let stopRequested = false

  function rejectAllPending(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timeout)
      entry.reject(error)
    }
    pending = new Map()
  }

  function createSpawnConfig() {
    const configDir = resolveConfigDir()
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LUME_CONFIG_DIR: configDir,
      LUME_DEFAULT_SKILLS_AUTOSTART: 'true',
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
    ensureExistingPath(nodeReplRootPath)
    ensureFile(nodeReplHostBinaryPath, 'missing node_repl host binary')
    env.LUME_NATIVES_PATH = nativeBinaryPath
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
            runningChild.postMessage(JSON.stringify({
              method: 'system.logging-policy',
              params: getSidecarLogDigestPolicy(),
            }))
          } catch (error) {
            writeMainLog('warn', 'desktop.sidecar.logging', 'logging.policy_delivery_failed', 'failed to deliver log digest policy', {
              data: { error },
            })
          }
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

  async function stop() {
    if (!child || child.pid === undefined) return
    stopRequested = true
    const runningChild = child
    child = null
    started = null
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
    stop,
  }
}

ipcMain.handle('lume:invoke', async (event, command, payload) => {
  validateIpcSender(event, getTrustedWindows())
  return dispatchCommand(validateRendererInvokeCommand(command), payload, { ownerWebContentsId: event.sender.id })
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
    autoUpdater.downloadUpdate().catch(onError)
  })
})
ipcMain.handle('lume:update:install', async (event) => {
  validateIpcSender(event, getTrustedWindows())
  if (!app.isPackaged) return null
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
      autoUpdater.quitAndInstall(true, true)
    } catch (error) {
      onError(error)
    }
  })
})

// Windows 任务栏图标/分组依赖 AppUserModelId，必须在 ready 事件前设置；
// 否则任务栏会回退到承载进程 exe 的图标——dev 下即 electron.exe 的默认图标。
app.setAppUserModelId(DESKTOP_APP_ID)

app.whenReady().then(async () => {
  logDesktopStartup('app ready', 'app.ready')
  registerAppProtocol()
  registerFileProtocol()
  const configDir = applyLauncherConfig()
  windowBehavior = readWindowBehaviorFromConfigDir(configDir)
  if (windowBehavior?.showTray !== false) ensureTray()
  logDesktopStartup('tray ready')
  // dev 模式 macOS Dock 默认显示 Electron 图标；显式设为 Lume（打包后由 bundle 内 icns 接管）
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(getAssetPath('icon.png')))
  }
  desktopHostState = await startDesktopHost()
  await sidecarHost.start()
  logDesktopStartup('sidecar ready', 'sidecar.ready')
  pageRenderer = new PageRenderer()
  await unlockDesktopContextStore()
  registerDesktopContextPowerEvents()
  await captureQuickInputContext()
  await createMainWindow()
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
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !trayManager.isTrayAvailable()) {
    app.quit()
  }
})

app.on('will-quit', async () => {
  desktopHostSupervisor?.stop()
  await sidecarHost.stop()
  writeMainLog('info', 'desktop.lifecycle', 'app.stopping', 'app stopping')
  await loggingService?.close()
  settingsBroker?.close()
  globalShortcut.unregisterAll()
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
