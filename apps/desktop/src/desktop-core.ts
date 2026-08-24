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
import {
  readdir as readdirAsync,
  realpath as realpathAsync,
  stat as statAsync,
} from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, dirname } from 'node:path'
import { zipSync } from 'fflate'
import type { OpenDialogOptions } from 'electron'

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

export type WindowBehaviorAction = 'native-minimize' | 'hide-to-tray' | 'close-window' | 'quit-app'

export function normalizeWindowBehavior(behavior) {
  const showTray = typeof behavior?.showTray === 'boolean' ? behavior.showTray : true
  return {
    minimizeToTray: showTray && Boolean(behavior?.minimizeToTray),
    closeToTray: showTray && Boolean(behavior?.closeToTray),
    showTray,
  }
}

export function resolveWindowBehaviorAction({ platform, eventType, trayAvailable, isQuitting, windowBehavior }): WindowBehaviorAction {
  if (isQuitting) return eventType === 'minimize' ? 'native-minimize' : 'close-window'
  const canHide = trayAvailable && windowBehavior?.showTray !== false
  if (eventType === 'minimize') {
    return canHide && windowBehavior?.minimizeToTray ? 'hide-to-tray' : 'native-minimize'
  }
  if (eventType === 'close') {
    if (canHide && windowBehavior?.closeToTray) return 'hide-to-tray'
    return platform === 'darwin' ? 'close-window' : 'quit-app'
  }
  return 'close-window'
}

export function shouldHideToTray(input) {
  return resolveWindowBehaviorAction({ platform: process.platform, ...input }) === 'hide-to-tray'
}

export function readWindowBehaviorFromConfigDir(configDir) {
  const settings = parseJsonFile(join(configDir, 'settings.json'))
  const behavior = settings?.generalSettings?.windowBehavior
  return normalizeWindowBehavior({
    minimizeToTray: typeof behavior?.minimizeToTray === 'boolean' ? behavior.minimizeToTray : false,
    closeToTray: typeof behavior?.closeToTray === 'boolean' ? behavior.closeToTray : false,
    showTray: typeof behavior?.showTray === 'boolean' ? behavior.showTray : true,
  })
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

const desktopActionHudLabels = {
  launch_app: '启动应用',
  activate_window: '切换窗口',
  move_pointer: '移动鼠标',
  click: '点击',
  press_key: '按键',
  type_text: '输入内容',
  scroll: '滚动页面',
  set_value: '填写内容',
  drag: '拖拽',
  perform_secondary_action: '执行更多操作',
}

const desktopActionHudPhases = {
  started: 'Lume 正在操作',
  completed: '操作完成',
  failed: '操作未完成',
}

function boundedLabel(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

export function createDesktopActionHudView(method, params) {
  if (method !== 'agent:runtime-event') return null
  const event = params?.event
  if (!event || event.type !== 'desktop.action_visual') return null
  const title = desktopActionHudPhases[event.phase]
  const actionLabel = desktopActionHudLabels[event.action]
  const appName = boundedLabel(event.app?.name, 80)
  if (!title || !actionLabel || !appName) return null
  const targetLabel = boundedLabel(event.targetLabel, 120)
  const status = boundedLabel(event.status, 32)
  const x = Number.isFinite(event.point?.x) ? event.point.x : null
  const y = Number.isFinite(event.point?.y) ? event.point.y : null
  return {
    phase: event.phase,
    title,
    actionLabel,
    appName,
    ...(targetLabel ? { targetLabel } : {}),
    ...(status ? { status } : {}),
    ...(x !== null && y !== null ? { point: { x, y } } : {}),
  }
}

export function computeDesktopActionHudBounds(workArea, size = { width: 420, height: 86 }) {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.min(28, Math.max(0, workArea.height - height))),
    width,
    height,
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function createDesktopActionHudHtml(view) {
  const phase = view.phase === 'completed' || view.phase === 'failed' ? view.phase : 'started'
  const detail = `${view.actionLabel}${view.targetLabel ? ` · ${view.targetLabel}` : ''}`
  const status = view.status ? `<span class="status">${escapeHtml(view.status)}</span>` : ''
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:"Avenir Next","Microsoft YaHei UI","Segoe UI",sans-serif}
body{display:flex;align-items:flex-start;justify-content:center;padding:1px}.hud{width:100%;height:76px;display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid rgba(158,233,216,.72);border-radius:18px;color:#fff;background:rgba(16,42,42,.96);box-shadow:0 18px 55px rgba(3,34,32,.4);backdrop-filter:blur(18px)}
.hud.completed{border-color:rgba(167,243,208,.72);background:rgba(16,42,32,.96)}.hud.failed{border-color:rgba(252,165,165,.72);background:rgba(50,21,21,.96)}
.mark{width:40px;height:40px;flex:0 0 40px;display:grid;place-items:center;border-radius:13px;background:#caffec;color:#0d574c;font-weight:800;font-size:16px;box-shadow:0 0 24px rgba(127,255,218,.3)}.failed .mark{background:#fee2e2;color:#b91c1c}.copy{min-width:0;flex:1}.title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;letter-spacing:.01em}.app{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.1);color:#d6fff2;font-size:11px;font-weight:600}.detail{margin-top:4px;display:flex;align-items:center;gap:8px;color:rgba(255,255,255,.68);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.status{padding:2px 6px;border:1px solid rgba(255,255,255,.12);border-radius:999px;background:rgba(0,0,0,.2);font:10px ui-monospace,SFMono-Regular,Consolas,monospace;color:rgba(255,255,255,.75)}
</style></head><body><div class="hud ${phase}"><div class="mark">L</div><div class="copy"><div class="title">${escapeHtml(view.title)}<span class="app">${escapeHtml(view.appName)}</span></div><div class="detail">${escapeHtml(detail)}${status}</div></div></div></body></html>`
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

export function createFileStatMetadata(filePath) {
  const stats = statSync(filePath)
  if (!stats.isFile()) throw new Error(`path is not a file: ${filePath}`)
  return {
    filename: filePath.split(/[\\/]/).pop() || 'file',
    mediaType: mimeTypeForPath(filePath),
    size: stats.size,
  }
}

export function validateExternalUrl(url) {
  let protocol
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error('only http/https/weread/obsidian urls are allowed')
  }
  if (!['http:', 'https:', 'weread:', 'obsidian:'].includes(protocol)) {
    throw new Error('only http/https/weread/obsidian urls are allowed')
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

  const transferred = Number.isFinite(progress.transferred) ? Math.max(0, progress.transferred) : state.previousTransferred
  const chunkLength = Math.max(0, transferred - state.previousTransferred)
  state.previousTransferred = transferred
  events.push({ event: 'Progress', data: { chunkLength, transferred, contentLength: total } })

  return events
}

export function createUpdateFinishedEvent() {
  return { event: 'Finished', data: {} }
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
        || normalized.includes('grant')
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

async function walkFileSizesAsync(path, state) {
  if (shouldSkipWalkPath(path, state.skipPaths)) return 0

  let stats
  try {
    stats = await statAsync(path)
  } catch {
    return 0
  }

  let realPath
  try {
    realPath = await realpathAsync(path)
  } catch {
    realPath = resolve(path)
  }

  if (stats.isFile()) {
    if (state.visitedFiles.has(realPath)) return 0
    state.visitedFiles.add(realPath)
    return stats.size
  }
  if (!stats.isDirectory() || state.visitedDirectories.has(realPath)) return 0
  state.visitedDirectories.add(realPath)

  let entries
  try {
    entries = await readdirAsync(path, { withFileTypes: true })
  } catch {
    return 0
  }

  let bytes = 0
  for (const entry of entries) {
    bytes += await walkFileSizesAsync(join(path, entry.name), state)
  }
  return bytes
}

export async function computeStorageStats(configDir, categories) {
  const categoryStats = []

  for (const category of categories) {
    const skipPaths = category.skipSubdirs.flatMap((pattern) => expandRelativePattern(configDir, pattern))
    const state = {
      skipPaths,
      visitedFiles: new Set(),
      visitedDirectories: new Set(),
    }
    let bytes = 0

    for (const scanPath of category.scanPaths.flatMap((pattern) => expandRelativePattern(configDir, pattern))) {
      bytes += await walkFileSizesAsync(scanPath, state)
    }
    categoryStats.push({ key: category.key, bytes })
  }

  return {
    total: categoryStats.reduce((sum, item) => sum + item.bytes, 0),
    configDir,
    categories: categoryStats,
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

/** 计算快速输入窗口尺寸与位置：高度与主窗口一致（920，小屏取工作区高度），宽度保持窄列，水平+垂直居中。 */
export function computeQuickInputBounds(workArea: { width: number; height: number }): {
  width: number
  height: number
  x: number
  y: number
} {
  const width = 760
  const height = Math.min(workArea.height, 920)
  const x = Math.max(0, Math.round((workArea.width - width) / 2))
  const y = Math.max(0, Math.round((workArea.height - height) / 2))
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

/** 构建岛屿窗口加载 URL：dev 走 dev server，packaged 走 app 协议入口，均带 ?view=agent-island。 */
export function getAgentIslandUrl(opts: {
  appIsPackaged: boolean
  appProtocolOrigin: string
  devServerUrl: string
}): string {
  if (opts.appIsPackaged) {
    return `${opts.appProtocolOrigin}/index.html?view=agent-island`
  }
  return `${opts.devServerUrl}/?view=agent-island`
}

/** 构建语音听写指示条窗口加载 URL，带 ?view=voice-indicator。 */
export function getVoiceIndicatorUrl(opts: {
  appIsPackaged: boolean
  appProtocolOrigin: string
  devServerUrl: string
}): string {
  if (opts.appIsPackaged) {
    return `${opts.appProtocolOrigin}/index.html?view=voice-indicator`
  }
  return `${opts.devServerUrl}/?view=voice-indicator`
}

export type TrayMenuAction = 'show-window' | 'hide-window' | 'quick-input' | 'new-thread' | 'open-thread' | 'open-settings' | 'check-update' | 'quit'

export interface RecentTrayThread {
  id: string
  title: string
  updatedAt: number
}

export interface TrayMenuItem {
  label?: string
  action?: TrayMenuAction
  threadId?: string
  enabled?: boolean
  type?: 'separator'
}

export function truncateTrayTitle(value: string, maxColumns = 28): string {
  const title = value.trim() || '未命名对话'
  let columns = 0
  let result = ''
  for (const char of title) {
    const code = char.codePointAt(0) ?? 0
    const width = code >= 0x2e80 ? 2 : 1
    if (columns + width > maxColumns) return `${result}…`
    result += char
    columns += width
  }
  return result
}

export function buildTrayMenuTemplate({
  windowVisible,
  recentThreads = [],
  currentThreadId = null,
}: {
  windowVisible: boolean
  recentThreads?: RecentTrayThread[]
  currentThreadId?: string | null
}): TrayMenuItem[] {
  const recentItems: TrayMenuItem[] = recentThreads.length > 0
    ? recentThreads.slice(0, 5).map((thread) => ({
      label: `${thread.id === currentThreadId ? '✓ ' : ''}${truncateTrayTitle(thread.title)}`,
      action: 'open-thread',
      threadId: thread.id,
    }))
    : [{ label: '暂无最近对话', enabled: false }]
  return [
    { label: windowVisible ? '隐藏 Lume' : '打开 Lume', action: windowVisible ? 'hide-window' : 'show-window' },
    { type: 'separator' },
    { label: '新建对话', action: 'new-thread' },
    { label: '快速输入', action: 'quick-input' },
    { type: 'separator' },
    { label: '最近对话', enabled: false },
    ...recentItems,
    { type: 'separator' },
    { label: '打开设置', action: 'open-settings' },
    { label: '检查更新', action: 'check-update' },
    { type: 'separator' },
    { label: '退出 Lume', action: 'quit' },
  ]
}

const QUICK_INPUT_CONTEXT_FALLBACK_TTL_MS = 60_000

export function resolveQuickInputContextCapture(previous, value, now = Date.now()) {
  const next = normalizeQuickInputContextCapture(value)
  if (previous?.status === 'ok' && isLumeSelfContextCapture(next) && isFreshQuickInputContext(previous, now)) return previous
  return next
}

export function resolveRememberedDesktopTarget(previous, value, rememberedAt = Date.now()) {
  const next = normalizeRememberedDesktopTarget(value, rememberedAt)
  if (next) return next
  if (isLumeSelfContextCapture(normalizeQuickInputContextCapture(value))) return previous ?? null
  return null
}

export function shouldCaptureRememberedDesktopTarget(latest, remembered) {
  if (!remembered) return false
  if (latest?.status !== 'ok') return true
  if (latest.window?.id !== remembered.window.id) return true
  return typeof latest.capturedAt !== 'number' || remembered.rememberedAt > latest.capturedAt
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

function normalizeRememberedDesktopTarget(value, rememberedAt) {
  const result = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  if (result.status !== 'ok') return null
  const target = sanitizeQuickInputContextTarget(result)
  if (!target.app || !target.window) return null
  return {
    app: target.app,
    window: target.window,
    rememberedAt,
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

function isFreshQuickInputContext(value, now) {
  return typeof value?.capturedAt === 'number'
    && now - value.capturedAt <= QUICK_INPUT_CONTEXT_FALLBACK_TTL_MS
}
