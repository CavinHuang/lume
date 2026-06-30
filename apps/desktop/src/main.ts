import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  clipboard,
  dialog,
  ipcMain,
  net,
  nativeImage,
  protocol,
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
  computeStorageStats,
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
  validateIpcSender,
  validateRendererInvokeCommand,
} from './electron-security'
import {
  createUtilityProcessSidecarForkConfig,
  getNativeBinaryPath,
  getSidecarScriptPath,
} from './sidecar-process'

const DESKTOP_ROOT = app.getAppPath()
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')
const DESKTOP_APP_ID = 'com.lume.desktop'
const APP_PROTOCOL = 'lume'
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
let tray = null
let isQuitting = false
let windowBehavior = {
  minimizeToTray: false,
  closeToTray: false,
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
])

const sidecarHost = createSidecarHost({
  onNotification(method, params) {
    emitRendererEvent(SIDE_CAR_EVENT_CHANNEL, { method, params })
  },
})

function emitRendererEvent(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(`lume:event:${channel}`, payload)
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

function getAssetPath(fileName) {
  return resolve(DESKTOP_ROOT, 'assets', fileName)
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

function createTray() {
  if (tray) return tray

  const iconPath = getAssetPath(process.platform === 'darwin' ? 'icon.png' : 'icon.ico')
  const icon = nativeImage.createFromPath(iconPath)
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Lume',
      click: () => showMainWindow(),
    },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])

  tray = new Tray(icon)
  tray.setToolTip('Lume')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => showMainWindow())
  return tray
}

function shouldHideToTray(eventType) {
  return shouldHideToTrayCore({
    eventType,
    trayAvailable: Boolean(tray),
    isQuitting,
    windowBehavior,
  })
}

function showMainWindow() {
  restoreMainWindow(mainWindow)
}

function attachWindowBehavior(win) {
  win.on('minimize', (event) => {
    if (!shouldHideToTray('minimize')) return
    event.preventDefault()
    win.hide()
  })

  win.on('close', (event) => {
    if (!shouldHideToTray('close')) return
    event.preventDefault()
    win.hide()
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
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#111827',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: createSecureWebPreferences({
      preload: resolve(DESKTOP_ROOT, 'dist', 'preload', 'preload.cjs'),
    }),
  })

  attachWindowBehavior(win)
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

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  return win
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
    case 'desktop_sync_window_behavior':
      windowBehavior = payload.windowBehavior ?? windowBehavior
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
    ensureFile(sidecarScriptPath, 'missing sidecar bundle')
    ensureFile(nativeBinaryPath, 'missing native binary')
    env.LUME_NATIVES_PATH = nativeBinaryPath
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
  validateIpcSender(event, mainWindow)
  return dispatchCommand(validateRendererInvokeCommand(command), payload)
})
ipcMain.handle('lume:relaunch', async (event) => {
  validateIpcSender(event, mainWindow)
  setImmediate(() => {
    app.relaunch()
    app.exit(0)
  })
  return null
})
ipcMain.handle('lume:update:check', async (event) => {
  validateIpcSender(event, mainWindow)
  if (!app.isPackaged) return null
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  const result = await autoUpdater.checkForUpdates()
  return createUpdateInfo(result?.updateInfo, app.getVersion())
})
ipcMain.handle('lume:update:download', async (event) => {
  validateIpcSender(event, mainWindow)
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
  validateIpcSender(event, mainWindow)
  if (!app.isPackaged) return null
  autoUpdater.quitAndInstall(false, true)
  return null
})

app.whenReady().then(async () => {
  logDesktopStartup('app ready')
  app.setAppUserModelId(DESKTOP_APP_ID)
  registerAppProtocol()
  const configDir = applyLauncherConfig()
  windowBehavior = readWindowBehaviorFromConfigDir(configDir)
  createTray()
  logDesktopStartup('tray ready')
  await sidecarHost.start()
  logDesktopStartup('sidecar ready')
  mainWindow = await createMainWindow()
  logDesktopStartup('main window ready')
}).catch((error) => {
  logDesktopStartup(`startup failed: ${error.stack ?? error}`)
  app.exit(1)
})

app.on('activate', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = await createMainWindow()
    return
  }
  showMainWindow()
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) {
    app.quit()
  }
})

app.on('will-quit', async () => {
  await sidecarHost.stop()
})
