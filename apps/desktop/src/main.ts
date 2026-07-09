import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  net,
  nativeImage,
  protocol,
  screen,
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
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  computeQuickInputBounds,
  computeStorageStats,
  computeToggleAction,
  copyDirRecursive,
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
  resolveExistingPath,
  resolveConfigDirValue,
  restoreMainWindow,
  shouldHideToTray as shouldHideToTrayCore,
  validateExternalUrl,
  validateMigrationTarget,
  validateWereadUrl,
  writeDesktopLogRecord,
  writeLauncherConfigAt,
  writeWebLogRecord,
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
  createUtilityProcessSidecarForkConfig,
  getNativeBinaryPath,
  getNodeReplHostBinaryPath,
  getNodeReplRootPath,
  getSidecarScriptPath,
} from './sidecar-process'
import * as trayManager from './tray-manager'

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
const TEXT_FILE_LIMIT = 512 * 1024
const SIDE_CAR_EVENT_CHANNEL = 'sidecar:event'
const DATA_MIGRATE_PROGRESS_CHANNEL = 'data:migrate-progress'
const UPDATE_DOWNLOAD_CHANNEL = 'update:download'

let mainWindow = null
let wereadWindow = null
let isQuitting = false
let windowBehavior = {
  minimizeToTray: false,
  closeToTray: false,
  showTray: true,
}

// 快速输入子窗口（Alt+L）；Task 5 之前始终为 null，此处仅占位以便 IPC 信任集合与事件广播先行就绪。
let quickInputWindow = null

/** 当前受信任的渲染窗口集合：mainWindow 总在列；quickInputWindow 存在时纳入。 */
function getTrustedWindows() {
  return [mainWindow, quickInputWindow].filter(Boolean)
}

function logDesktopStartup(message) {
  console.error(`[desktop] ${message}`)
  try {
    writeDesktopLogRecord(resolveConfigDir(), {
      level: 'info',
      source: 'main',
      context: 'startup',
      message,
    })
  } catch {
    // Startup diagnostics must never block application startup.
  }
  const logPath = process.env.LUME_DESKTOP_STARTUP_LOG?.trim()
  if (!logPath) return
  try {
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // Startup diagnostics must never block application startup.
  }
}

logDesktopStartup('main module loaded')

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
    },
  },
])

const sidecarHost = createSidecarHost({
  onNotification(method, params) {
    emitRendererEvent(SIDE_CAR_EVENT_CHANNEL, { method, params })
  },
})

function emitRendererEvent(channel, payload) {
  for (const win of [mainWindow, quickInputWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(`lume:event:${channel}`, payload)
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
  protocol.handle(FILE_PROTOCOL, async (request) => {
    const workspacesRoot = join(resolveConfigDir(), 'agent-workspaces')
    const resolved = resolveFileProtocolPath(request.url, workspacesRoot)
    if (resolved.kind === 'forbidden') return new Response('Forbidden', { status: 403 })
    if (resolved.kind === 'notfound') return new Response('Not Found', { status: 404 })
    try {
      return net.fetch(pathToFileURL(resolved.absPath))
    } catch {
      return new Response('Internal Error', { status: 500 })
    }
  })
}

function getAssetPath(fileName) {
  return resolve(DESKTOP_ROOT, 'assets', fileName)
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

function handleTrayAction(action) {
  switch (action) {
    case 'toggle-window':
      toggleMainWindow()
      return
    case 'quick-input':
      toggleQuickInput().catch((error) => console.error(`[desktop] quick input toggle failed: ${error.message}`))
      return
    case 'new-note':
      showMainWindowThenSend({ action: 'new-note' })
      return
    case 'open-settings':
      showMainWindowThenSend({ action: 'open-settings' })
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

function showMainWindowThenSend(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!mainWindow.isVisible()) restoreMainWindow(mainWindow)
  mainWindow.webContents.send('lume:event:tray-action', payload)
  refreshTrayMenu()
}

function checkForUpdateNow() {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.checkForUpdates().catch((error) => console.error(`[desktop] update check failed: ${error.message}`))
}

function ensureTray() {
  if (trayManager.isTrayAvailable()) return
  trayManager.createTray({
    iconPath: getAssetPath(process.platform === 'darwin' ? 'icon.png' : 'icon.ico'),
    onClickToggle: () => toggleMainWindow(),
    onAction: handleTrayAction,
  })
}

function shouldHideToTray(eventType) {
  return shouldHideToTrayCore({
    eventType,
    trayAvailable: trayManager.isTrayAvailable(),
    isQuitting,
    windowBehavior,
  })
}

function showMainWindow() {
  restoreMainWindow(mainWindow)
  refreshTrayMenu()
}

function refreshTrayMenu() {
  const windowVisible = Boolean(mainWindow) && !mainWindow.isDestroyed() && mainWindow.isVisible()
  trayManager.rebuildMenu({ windowVisible }, handleTrayAction)
}

function toggleMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const visible = mainWindow.isVisible() && mainWindow.isFocused()
  if (visible) mainWindow.hide()
  else restoreMainWindow(mainWindow)
  refreshTrayMenu()
}

function attachWindowBehavior(win) {
  win.on('minimize', (event) => {
    if (!shouldHideToTray('minimize')) return
    event.preventDefault()
    win.hide()
    refreshTrayMenu()
  })

  win.on('close', (event) => {
    if (!shouldHideToTray('close')) return
    event.preventDefault()
    win.hide()
    refreshTrayMenu()
  })
}

function attachWebContentsSecurity(win, { allowNavigation }) {
  win.webContents.on('will-navigate', (event, url) => {
    if (allowNavigation(url)) return
    event.preventDefault()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    const result = createWindowOpenAction(url)
    if (result.externalUrl) {
      shell.openExternal(result.externalUrl).catch((error) => {
        console.error(`[desktop-security] failed to open external url: ${error.message}`)
      })
    }
    return { action: result.action }
  })

  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
}

async function createMainWindow() {
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

  win.once('ready-to-show', () => {
    win.show()
    refreshTrayMenu()
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

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
    await createQuickInputWindow()
    return
  }
  if (action === 'hide') {
    quickInputWindow.hide()
    return
  }
  quickInputWindow.show()
  quickInputWindow.focus()
}

async function dispatchCommand(command, payload: Record<string, any> = {}) {
  switch (command) {
    case 'healthcheck': {
      await sidecarHost.call('healthcheck', null)
      return {
        ok: true,
        source: 'desktop',
        sidecar: 'ready',
      }
    }
    case 'sidecar_healthcheck':
      return sidecarHost.call('healthcheck', null)
    case 'sidecar_call':
      return sidecarHost.call(payload.method, payload.params ?? null)
    case 'desktop_sync_window_behavior': {
      const previous = windowBehavior
      windowBehavior = payload.windowBehavior ?? windowBehavior
      if (previous?.showTray !== windowBehavior?.showTray) {
        if (windowBehavior?.showTray) ensureTray()
        else trayManager.destroyTray()
      }
      return null
    }
    case 'quick_input_hide':
      if (quickInputWindow && !quickInputWindow.isDestroyed()) {
        quickInputWindow.hide()
      }
      return null
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
    case 'write_web_log':
      writeWebLogRecord(resolveConfigDir(), payload)
      return null
    case 'desktop_list_log_files':
      return sidecarHost.call('general-settings:list-log-files', null)
    case 'desktop_read_log_file':
      return sidecarHost.call('general-settings:read-log-file', {
        fileName: payload.fileName,
        levels: payload.levels,
        query: payload.keyword,
        maxLines: payload.maxLines,
      })
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

    const defaultSkillsArchive = getDefaultSkillsArchivePath()
    if (existsSync(defaultSkillsArchive)) {
      env.LUME_DEFAULT_SKILLS_ARCHIVE = defaultSkillsArchive
    }

    const defaultSkillsDir = getDefaultSkillsDirPath()
    if (existsSync(defaultSkillsDir)) {
      env.LUME_DEFAULT_SKILLS_DIR = defaultSkillsDir
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
      const forkConfig = createSpawnConfig()
      const runningChild = utilityProcess.fork(
        forkConfig.modulePath,
        forkConfig.args,
        forkConfig.options,
      )
      let didReady = false
      let startSettled = false
      child = runningChild
      logDesktopStartup(`starting sidecar utility process: ${forkConfig.modulePath}`)
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
        logDesktopStartup(error.message)
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
          logDesktopStartup('sidecar reported system.ready')
          settleStart()
          return
        }

        if (payload && payload.method === SIDECAR_LOG_METHOD && payload.id === undefined) {
          try {
            writeDesktopLogRecord(resolveConfigDir(), payload.params)
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
          if (payload.error) {
            request.reject(new Error(payload.error.message || 'sidecar rpc failed'))
          } else {
            request.resolve(payload.result)
          }
        }
      })

      runningChild.stdout?.on('data', (chunk) => {
        process.stderr.write(chunk)
      })
      runningChild.stderr?.on('data', (chunk) => {
        process.stderr.write(chunk)
      })

      runningChild.once('spawn', () => {
        logDesktopStartup(`sidecar utility process spawned (pid=${runningChild.pid})`)
      })

      runningChild.once('error', (type, location, report) => {
        const error = new Error(`sidecar utility process error: ${type} at ${location}\n${report}`)
        logDesktopStartup(error.message)
        rejectAllPending(error)
        settleStart(error)
      })

      runningChild.once('exit', (code) => {
        const error = new Error(`sidecar exited (code=${code})`)
        logDesktopStartup(error.message)
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

  async function call(method, params) {
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
        rejectCall(new Error(`sidecar request timed out: ${method}`))
      }, HEALTHCHECK_TIMEOUT_MS)

      pending.set(requestId, {
        resolve: resolveCall,
        reject: rejectCall,
        timeout,
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
  return dispatchCommand(validateRendererInvokeCommand(command), payload)
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
  autoUpdater.quitAndInstall(false, true)
  return null
})

app.whenReady().then(async () => {
  logDesktopStartup('app ready')
  app.setAppUserModelId(DESKTOP_APP_ID)
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
  await sidecarHost.start()
  logDesktopStartup('sidecar ready')
  await createMainWindow()
  logDesktopStartup('main window ready')
  // 检查 Alt+L 注册结果：被系统或其他程序占用时 register 返回 false，记录但不中断启动
  const quickInputShortcutRegistered = globalShortcut.register('Alt+L', () => {
    toggleQuickInput().catch((error) => {
      console.error(`[desktop] quick input toggle failed: ${error.message}`)
    })
  })
  if (!quickInputShortcutRegistered) {
    const message = '[desktop] globalShortcut Alt+L 注册失败（可能被其他程序占用）'
    console.error(message)
    try {
      writeDesktopLogRecord(resolveConfigDir(), {
        level: 'error',
        source: 'main',
        context: 'quick-input-shortcut',
        message,
      })
    } catch {
      // 日志写入失败不能阻断启动流程
    }
  }
}).catch((error) => {
  logDesktopStartup(`startup failed: ${error.stack ?? error}`)
  app.exit(1)
})

app.on('activate', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createMainWindow()
    return
  }
  showMainWindow()
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
  await sidecarHost.stop()
  globalShortcut.unregisterAll()
})
