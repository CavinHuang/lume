import { BrowserWindow, screen } from 'electron'
import { resolve } from 'node:path'
import { createSecureWebPreferences } from './electron-security'
import { getAgentIslandUrl } from './desktop-core'

const ISLAND_DEFAULT_WIDTH = 420
const ISLAND_DEFAULT_HEIGHT = 32
const ISLAND_MIN_WIDTH = 320
const ISLAND_MAX_WIDTH = 620
const ISLAND_MAX_HEIGHT = 640
const ISLAND_TOP_SNAP_DISTANCE = 60

export interface IslandWindowDeps {
  appIsPackaged: boolean
  appProtocolOrigin: string
  devServerUrl: string
  desktopRoot: string
  /**
   * 上次拖动后持久化的窗口左上角位置（桌面全局坐标）。
   * 缺省/已拔显示器时由 window 模块回退到光标屏中央默认吸附位。
   */
  savedPosition?: { x: number; y: number } | null
  /**
   * 窗口拖动后的存盘回调（已防抖 ~300ms）。main 在此经 settings broker 写回。
   * 不传则不持久化（用于测试或临时窗口）。
   */
  onWindowMove?: (position: { x: number; y: number }) => void
  /**
   * renderer 真正就绪回调：webContents `did-finish-load` 后再 +120ms buffer
   * （让 renderer 侧 IPC 监听器装好）触发。main 在此调 service.repush() 补推首帧，
   * 避免 service.start() 的 push(true) 因 webContents 未就绪而 webContents.send
   * 静默丢失（M-6 首推竞态）。对齐 Proma agent-island-window.ts:165-169。
   */
  onReady?: () => void
}

const MOVE_PERSIST_DEBOUNCE_MS = 300

function clampToWorkArea(
  value: number,
  min: number,
  max: number,
): number {
  if (max < min) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

function displayContains(bounds: Electron.Rectangle, point: { x: number; y: number }): boolean {
  return (
    point.x >= bounds.x &&
    point.x < bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y < bounds.y + bounds.height
  )
}

function resolveTopSnappedPosition(bounds: Electron.Rectangle): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2),
  })
  const top = display.workArea.y
  return {
    x: bounds.x,
    y: Math.abs(bounds.y - top) <= ISLAND_TOP_SNAP_DISTANCE ? top : bounds.y,
  }
}

/**
 * 解析窗口初始位置。saved 优先：按 `screen.getDisplayNearestPoint(saved)` 找到 saved
 * 所属显示器并钳到其 workArea；若该显示器已拔（saved 不在任何显示器 bounds 内）→
 * fallback 到 fallbackWorkArea（光标屏）的默认吸附位。
 */
function resolveWindowPosition(
  fallbackWorkArea: Electron.Rectangle,
  savedPosition: { x: number; y: number } | null | undefined,
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(Math.max(ISLAND_DEFAULT_WIDTH, ISLAND_MIN_WIDTH), ISLAND_MAX_WIDTH)
  const height = ISLAND_DEFAULT_HEIGHT

  if (
    savedPosition &&
    Number.isFinite(savedPosition.x) &&
    Number.isFinite(savedPosition.y)
  ) {
    const savedPoint = { x: Math.round(savedPosition.x), y: Math.round(savedPosition.y) }
    const savedDisplay = screen.getDisplayNearestPoint(savedPoint)
    // savedDisplay 永远非空（Electron 兜底返回最近显示器）；用 bounds 含 saved 验证显示器仍在线。
    if (savedDisplay && displayContains(savedDisplay.bounds, savedPoint)) {
      const wa = savedDisplay.workArea
      return {
        x: clampToWorkArea(savedPoint.x, wa.x, wa.x + Math.max(0, wa.width - width)),
        y: clampToWorkArea(savedPoint.y, wa.y, wa.y + Math.max(0, wa.height - height)),
        width,
        height,
      }
    }
  }

  // fallback：光标显示器居中。Windows/Linux 避让任务栏；macOS 贴顶（bounds.y）。
  const x = Math.round(fallbackWorkArea.x + (fallbackWorkArea.width - width) / 2)
  const y = process.platform === 'darwin' ? fallbackWorkArea.y : fallbackWorkArea.y + 12
  return { x, y, width, height }
}

export function createIslandWindow(deps: IslandWindowDeps): BrowserWindow {
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const bounds = resolveWindowPosition(cursorDisplay.workArea, deps.savedPosition)
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: process.platform !== 'darwin',
    closable: process.platform !== 'win32',
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: createSecureWebPreferences({
      preload: resolve(deps.desktopRoot, 'dist', 'preload', 'preload.cjs'),
    }),
  })
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'pop-up-menu' : 'screen-saver')
  if (process.platform !== 'win32') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // M-6 首推竞态：`did-finish-load` 是 renderer DOM/脚本就绪的权威信号（比
  // BrowserWindow 的 ready-to-show 晚——后者只表示首帧已 paint，IPC 监听器未必
  // 装好）。+120ms buffer 给 renderer 内 lume:event 监听器一个 tick 注册；之后
  // 调 onReady → service.repush() 强制再推一次，绕过 webContents.send 在未就绪时
  // 静默丢失导致的"启动后短暂空白"。对齐 Proma agent-island-window.ts:165-169。
  if (typeof deps.onReady === 'function') {
    const onReady = deps.onReady
    win.webContents.once('did-finish-load', () => {
      setTimeout(onReady, 120)
    })
  }
  void win.loadURL(getAgentIslandUrl({
    appIsPackaged: deps.appIsPackaged,
    appProtocolOrigin: deps.appProtocolOrigin,
    devServerUrl: deps.devServerUrl,
  }))

  // 拖动停止 300ms 后，若窗口接近当前显示器工作区上沿则吸附；随后持久化最终位置。
  // 复用原有 move 防抖，避免拖动过程中反复 setPosition 或频繁写 settings.json。
  let moveTimer: ReturnType<typeof setTimeout> | null = null
  let pendingPosition: { x: number; y: number } | null = null
  win.on('move', () => {
    if (win.isDestroyed()) return
    const current = win.getBounds()
    if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) return
    pendingPosition = { x: current.x, y: current.y }
    if (moveTimer) clearTimeout(moveTimer)
    moveTimer = setTimeout(() => {
      moveTimer = null
      if (win.isDestroyed()) return
      const currentBounds = win.getBounds()
      const snapped = resolveTopSnappedPosition(currentBounds)
      pendingPosition = null
      if (snapped.y !== currentBounds.y) win.setPosition(snapped.x, snapped.y)
      deps.onWindowMove?.(snapped)
    }, MOVE_PERSIST_DEBOUNCE_MS)
  })
  // close 时仅 flush 最近一次实际位置；不在关闭流程中移动窗口。
  win.on('close', () => {
    if (!moveTimer) return
    clearTimeout(moveTimer)
    moveTimer = null
    const snapshot = pendingPosition
    pendingPosition = null
    if (snapshot) deps.onWindowMove?.(snapshot)
  })

  return win
}

export function clampIslandHeight(win: BrowserWindow, expandedHeight: number) {
  if (win.isDestroyed()) return
  const h = Math.min(Math.max(expandedHeight, ISLAND_DEFAULT_HEIGHT), ISLAND_MAX_HEIGHT)
  const [width] = win.getSize()
  const [x, y] = win.getPosition()
  win.setBounds({ x, y, width, height: h }, false)
}

export { ISLAND_DEFAULT_WIDTH, ISLAND_DEFAULT_HEIGHT }
