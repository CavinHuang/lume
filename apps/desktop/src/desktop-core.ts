import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { extname, isAbsolute, join, relative, resolve, dirname } from 'node:path'
import { zipSync } from 'fflate'
import type { OpenDialogOptions } from 'electron'
import electronLog from 'electron-log/node'

export const WEREAD_KEY_PAGE_URL = 'https://weread.qq.com/r/weread-skills'

export const supportedFileDialogExtensions = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'txt', 'md', 'json', 'csv', 'xml', 'html',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'odp', 'ods',
]

export const mediaTypesByExtension = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true })
  return path
}

export function parseJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function readLauncherConfigFrom(path) {
  return parseJsonFile(path)
}

export function writeLauncherConfigAt(path, config) {
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(config, null, 2))
}

export function resolveConfigDirValue(value, cwd = process.cwd()) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
}

export function shouldHideToTray({ eventType, trayAvailable, isQuitting, windowBehavior }) {
  if (!trayAvailable || isQuitting) return false
  if (eventType === 'minimize') return Boolean(windowBehavior?.minimizeToTray)
  if (eventType === 'close') return Boolean(windowBehavior?.closeToTray)
  return false
}

export function readWindowBehaviorFromConfigDir(configDir) {
  const settings = parseJsonFile(join(configDir, 'settings.json'))
  const behavior = settings?.generalSettings?.windowBehavior
  return {
    minimizeToTray: typeof behavior?.minimizeToTray === 'boolean' ? behavior.minimizeToTray : false,
    closeToTray: typeof behavior?.closeToTray === 'boolean' ? behavior.closeToTray : false,
  }
}

export function restoreMainWindow(win) {
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return true
}

const desktopProposalKindLabels = {
  reply: '回复',
  conflict: '冲突',
  prompt_rescue: '提示修复',
  daily_wrap: '每日回顾',
  follow_up: '跟进',
}

export function createDesktopProposalNotification(value) {
  const proposal = value?.proposal
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return null

  const kindLabel = desktopProposalKindLabels[proposal.kind]
  const app = proposal.app
  const appName = typeof app?.name === 'string' ? app.name.trim() : ''
  if (!kindLabel || !appName) return null

  return {
    title: 'Lume 桌面助手',
    body: `${appName} 中有一条可处理的${kindLabel}建议`,
  }
}

export function createDesktopProposalOpenRequest(value) {
  const proposal = value?.proposal
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return null

  const proposalId = typeof proposal.id === 'string' ? proposal.id.trim() : ''
  if (!proposalId) return null

  return { proposalId }
}

export function createOpenFileDialogOptions(): OpenDialogOptions {
  return {
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Supported Files',
        extensions: supportedFileDialogExtensions,
      },
    ],
  }
}

export function createOpenFolderDialogOptions(): OpenDialogOptions {
  return {
    properties: ['openDirectory'],
  }
}

export function mimeTypeForPath(filePath) {
  return mediaTypesByExtension[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

export function ensureFile(filePath, label) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`${label}: ${filePath}`)
  }
}

export function ensureExistingPath(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`路径不存在: ${filePath}`)
  }
  return filePath
}

export function resolveExistingPath(filePath) {
  ensureExistingPath(filePath)
  return realpathSync(filePath)
}

export function decodeBase64Content(value) {
  const text = String(value ?? '').replace(/\s/g, '')
  if (text === '') return Buffer.alloc(0)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error('图片数据解析失败: invalid base64')
  }
  return Buffer.from(text, 'base64')
}

export function createFileMetadata(filePath) {
  const stats = statSync(filePath)
  if (!stats.isFile()) {
    throw new Error(`path is not a file: ${filePath}`)
  }
  const mediaType = mimeTypeForPath(filePath)
  const payload = {
    filename: filePath.split(/[\\/]/).pop() || 'file',
    mediaType,
    size: stats.size,
    sourcePath: filePath,
  }

  if (!mediaType.startsWith('image/')) return payload

  return {
    ...payload,
    data: readFileSync(filePath).toString('base64'),
  }
}

export function validateExternalUrl(url) {
  if (!(url?.startsWith('http://') || url?.startsWith('https://'))) {
    throw new Error('only http/https urls are allowed')
  }
  return url
}

export function createWereadTipScript() {
  const message = JSON.stringify('请关闭快捷登录弹窗，用微信扫码登录；获取 API KEY 后 Lume 会自动读取并填入。')
  return `(function () {
    if (document.getElementById('lume-weread-key-tip')) return;
    var tip = document.createElement('div');
    tip.id = 'lume-weread-key-tip';
    tip.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:10px 16px;background:#ecfdf3;color:#166534;font-size:14px;text-align:center;border-bottom:1px solid #bbf7d0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    tip.textContent = ${message};
    document.body && document.body.appendChild(tip);
  })();`
}

export function validateWereadUrl(url) {
  const parsed = new URL(url)
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'weread.qq.com'
    || parsed.pathname !== '/r/weread-skills'
  ) {
    throw new Error(`only ${WEREAD_KEY_PAGE_URL} is allowed`)
  }
  return parsed.toString()
}

export function normalizeReleaseNotes(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        return [item.version, item.note].filter(Boolean).join('\n')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function createUpdateInfo(updateInfo, currentVersion) {
  if (!updateInfo?.version) return null
  return {
    currentVersion,
    version: updateInfo.version,
    date: updateInfo.releaseDate,
    body: normalizeReleaseNotes(updateInfo.releaseNotes),
  }
}

export function createUpdateDownloadProgressEvents(state, progress) {
  const total = Number.isFinite(progress.total) ? progress.total : null
  const events = []

  if (!state.started) {
    state.started = true
    events.push({ event: 'Started', data: { contentLength: total } })
  }

  const transferred = Number.isFinite(progress.transferred) ? progress.transferred : state.previousTransferred
  const chunkLength = Math.max(0, transferred - state.previousTransferred)
  state.previousTransferred = transferred
  events.push({ event: 'Progress', data: { chunkLength, contentLength: total } })

  return events
}

export function createUpdateFinishedEvent() {
  return { event: 'Finished', data: {} }
}

const desktopLogLevels = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
const desktopLogSources = new Set(['main', 'sidecar', 'renderer'])
const desktopElectronLogger = electronLog.create({ logId: 'lume-desktop-ndjson' })

desktopElectronLogger.transports.console.level = false
desktopElectronLogger.transports.file.format = '{text}'
desktopElectronLogger.transports.file.maxSize = 0

function normalizeLogTimestamp(value, fallbackDate) {
  return typeof value === 'string' && value.trim() ? value : fallbackDate.toISOString()
}

function getRecordDateFromMessage(message) {
  try {
    const raw = message?.data?.[0]
    if (typeof raw !== 'string') return new Date()
    const parsed = JSON.parse(raw)
    const value = parsed?.timestamp ?? parsed?.ts
    return typeof value === 'string' ? new Date(value) : new Date()
  } catch {
    return new Date()
  }
}

function configureDesktopLogFile(configDir) {
  desktopElectronLogger.transports.file.resolvePathFn = (_variables, message) => {
    const date = getRecordDateFromMessage(message)
    return join(configDir, 'logs', `lume-${date.toISOString().slice(0, 10)}.ndjson`)
  }
}

export function createDesktopLogRecord(input, date = new Date()) {
  const level = input?.level ?? 'info'
  if (!desktopLogLevels.has(level)) {
    throw new Error(`invalid log level: ${level}`)
  }

  const source = input?.source ?? 'main'
  if (!desktopLogSources.has(source)) {
    throw new Error(`invalid log source: ${source}`)
  }

  const timestamp = normalizeLogTimestamp(input?.timestamp ?? input?.ts, date)
  const data = input?.data == null ? undefined : redactValue(input.data)
  return {
    ts: timestamp,
    timestamp,
    level,
    source,
    context: input?.context ?? 'app',
    message: input?.message ?? '',
    ...(input?.sessionId ? { sessionId: input.sessionId } : {}),
    ...(data == null ? {} : { data }),
  }
}

export function writeDesktopLogRecord(configDir, input, date = new Date()) {
  const record = createDesktopLogRecord(input, date)
  configureDesktopLogFile(configDir)
  desktopElectronLogger.info(JSON.stringify(record))
  return record
}

export function writeWebLogRecord(configDir, input, date = new Date()) {
  return writeDesktopLogRecord(configDir, {
    level: input?.level,
    source: 'renderer',
    context: input?.context,
    message: input?.message,
    data: input?.data,
  }, date)
}

function normalizeSensitiveKey(key) {
  return key.toLowerCase().replace(/[-_\s]/g, '')
}

export function redactValue(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
    }
  }
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen))
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      const normalized = normalizeSensitiveKey(key)
      out[key] = (
        normalized.includes('token')
        || normalized.includes('secret')
        || normalized.includes('password')
        || normalized.includes('apikey')
        || normalized.includes('authorization')
      )
        ? '[REDACTED]'
        : redactValue(child, seen)
    }
    return out
  }
  return value
}

export function redactJsonBuffer(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString('utf8'))
    return Buffer.from(JSON.stringify(redactValue(parsed), null, 2))
  } catch {
    return buffer
  }
}

const generatedConfigSnapshotDirName = '.lume-config'

function statOrNull(path, ignoreErrors = false) {
  if (!existsSync(path)) return null
  try {
    return statSync(path)
  } catch (error) {
    if (!ignoreErrors) throw error
    return null
  }
}

function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

function hasPathSegment(path, segment) {
  return resolve(path).split(/[\\/]+/).includes(segment)
}

export function expandRelativePattern(root, relativePattern) {
  if (!relativePattern.includes('*')) {
    return [resolve(root, relativePattern)]
  }

  const [prefix, suffix = ''] = relativePattern.split('*')
  const baseDir = resolve(root, prefix.replace(/[\\/]+$/, ''))
  if (!statOrNull(baseDir, true)?.isDirectory()) return []

  const normalizedSuffix = suffix.replace(/^[\\/]+/, '')
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolve(baseDir, entry.name, normalizedSuffix))
  } catch {
    return []
  }
}

export function isSameOrInsidePath(parentPath, candidatePath) {
  const parent = resolve(parentPath)
  const candidate = resolve(candidatePath)
  if (parent === candidate) return true
  const rel = relative(parent, candidate)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

function shouldSkipWalkPath(path, skipPaths) {
  return hasPathSegment(path, generatedConfigSnapshotDirName)
    || skipPaths.some((skipPath) => isSameOrInsidePath(skipPath, path))
}

function walkFilesWithState(path, visit, state) {
  if (shouldSkipWalkPath(path, state.skipPaths)) return
  const stats = statOrNull(path, state.ignoreErrors)
  if (!stats) return
  if (stats.isFile()) {
    visit(path, stats)
    return
  }
  if (!stats.isDirectory()) return

  const directoryKey = safeRealpath(path)
  if (state.visitedDirectories.has(directoryKey)) return
  state.visitedDirectories.add(directoryKey)

  let entries = []
  try {
    entries = readdirSync(path, { withFileTypes: true })
  } catch (error) {
    if (!state.ignoreErrors) throw error
    return
  }
  for (const entry of entries) {
    walkFilesWithState(join(path, entry.name), visit, state)
  }
}

export function walkFiles(
  path,
  visit,
  options: { skipPaths?: string[]; visitedDirectories?: Set<string>; ignoreErrors?: boolean } = {},
) {
  walkFilesWithState(path, visit, {
    skipPaths: options.skipPaths ?? [],
    visitedDirectories: options.visitedDirectories ?? new Set(),
    ignoreErrors: options.ignoreErrors ?? false,
  })
}

export function computeStorageStats(configDir, categories) {
  const stats = categories.map((category) => {
    const skipPaths = category.skipSubdirs.flatMap((pattern) => expandRelativePattern(configDir, pattern))
    const visitedFiles = new Set()
    const visitedDirectories = new Set<string>()
    let bytes = 0

    for (const scanPath of category.scanPaths.flatMap((pattern) => expandRelativePattern(configDir, pattern))) {
      walkFiles(scanPath, (filePath, fileStats) => {
        const fileKey = safeRealpath(filePath)
        if (visitedFiles.has(fileKey)) return
        visitedFiles.add(fileKey)
        bytes += fileStats.size
      }, {
        skipPaths,
        visitedDirectories,
        ignoreErrors: true,
      })
    }

    return { key: category.key, bytes }
  })

  return {
    total: stats.reduce((sum, item) => sum + item.bytes, 0),
    configDir,
    categories: stats,
  }
}

export function gatherFiles(root) {
  const files = []
  walkFiles(root, (filePath) => {
    files.push(filePath)
  })
  return files
}

export function exportZip(configDir, input) {
  const files = gatherFiles(configDir)
  const archiveEntries = {}

  for (const filePath of files) {
    const relativePath = relative(configDir, filePath).replaceAll('\\', '/')
    const raw = readFileSync(filePath)
    archiveEntries[relativePath] = (
      !input.includeCredentials && extname(filePath).toLowerCase() === '.json'
        ? redactJsonBuffer(raw)
        : raw
    )
  }

  const zipped = zipSync(archiveEntries, { level: 6 })
  writeFileSync(input.destPath, Buffer.from(zipped))

  return {
    path: input.destPath,
    bytes: zipped.byteLength,
    fileCount: files.length,
    credentialsStripped: !input.includeCredentials,
  }
}

export function validateMigrationTarget(sourcePath, destinationPath) {
  if (!isAbsolute(destinationPath)) throw new Error('目标必须是绝对路径')
  if (resolve(destinationPath) === resolve(sourcePath)) throw new Error('目标不能与当前数据目录相同')
  if (isSameOrInsidePath(sourcePath, destinationPath)) throw new Error('目标不能在当前数据目录内')
  if (isSameOrInsidePath(destinationPath, sourcePath)) throw new Error('目标不能包含当前数据目录')

  if (!existsSync(destinationPath)) return
  if (!statSync(destinationPath).isDirectory()) throw new Error('目标已存在且不是目录')
  if (readdirSync(destinationPath).length > 0) throw new Error('目标目录必须为空')
}

export function dirStats(path) {
  let files = 0
  let bytes = 0
  walkFiles(path, (_filePath, stats) => {
    files += 1
    bytes += stats.size
  })
  return { files, bytes }
}

export function copyDirRecursive(sourcePath, destinationPath, onProgress) {
  const files = gatherFiles(sourcePath)
  let copiedFiles = 0
  let copiedBytes = 0

  for (const filePath of files) {
    const relativePath = relative(sourcePath, filePath)
    const targetPath = join(destinationPath, relativePath)
    ensureDir(dirname(targetPath))
    copyFileSync(filePath, targetPath)
    const stats = statSync(filePath)
    copiedFiles += 1
    copiedBytes += stats.size
    onProgress?.({ done: copiedFiles, total: files.length })
  }

  return { copiedFiles, copiedBytes }
}

/** 快速输入窗口 toggle 状态机：根据窗口当前存在性/可见性决定下一步动作。 */
export function computeToggleAction(state: {
  exists: boolean
  visible: boolean
  destroyed?: boolean
}): 'create' | 'hide' | 'show' {
  if (!state.exists || state.destroyed) return 'create'
  if (state.visible) return 'hide'
  return 'show'
}

/** 计算快速输入窗口尺寸与位置：水平居中，垂直落在工作区上 1/3 附近（Spotlight 风格）。 */
export function computeQuickInputBounds(workArea: { width: number; height: number }): {
  width: number
  height: number
  x: number
  y: number
} {
  const width = 760
  const height = 600
  const x = Math.max(0, Math.round((workArea.width - width) / 2))
  const y = Math.max(0, Math.round(workArea.height / 3 - height / 2))
  return { width, height, x, y }
}

/** 构建快速输入窗口加载 URL：dev 走 dev server，packaged 走 app 协议入口，均带 ?view=quick-input。 */
export function getQuickInputUrl(opts: {
  appIsPackaged: boolean
  appProtocolOrigin: string
  devServerUrl: string
}): string {
  if (opts.appIsPackaged) {
    return `${opts.appProtocolOrigin}/index.html?view=quick-input`
  }
  return `${opts.devServerUrl}/?view=quick-input`
}

export function resolveQuickInputContextCapture(previous, value) {
  const next = normalizeQuickInputContextCapture(value)
  if (previous?.status === 'ok' && isLumeSelfContextCapture(next)) return previous
  return next
}

function normalizeQuickInputContextCapture(value) {
  const result = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  if (result.status === 'ok' && typeof result.snapshotId === 'string') {
    return {
      status: 'ok',
      snapshotId: result.snapshotId,
      ...sanitizeQuickInputContextTarget(result),
    }
  }
  return {
    status: typeof result.status === 'string' ? result.status : 'unavailable',
    message: typeof result.message === 'string' ? result.message : 'desktop context is unavailable',
  }
}

function sanitizeQuickInputContextTarget(input) {
  const app = input.app && typeof input.app === 'object' && !Array.isArray(input.app)
    ? input.app
    : {}
  const window = input.window && typeof input.window === 'object' && !Array.isArray(input.window)
    ? input.window
    : {}
  return {
    ...(typeof app.id === 'string' && typeof app.name === 'string'
      ? { app: { id: app.id, name: app.name } }
      : {}),
    ...(typeof window.id === 'string' && typeof window.title === 'string'
      ? { window: { id: window.id, title: window.title } }
      : {}),
    ...(typeof input.capturedAt === 'number' ? { capturedAt: input.capturedAt } : {}),
  }
}

function isLumeSelfContextCapture(value) {
  return value?.status !== 'ok'
    && typeof value?.message === 'string'
    && value.message.includes('当前前台窗口是 Lume')
}
