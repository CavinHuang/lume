import { BrowserWindow, screen } from 'electron'
import { resolve } from 'node:path'
import { createSecureWebPreferences } from './electron-security'
import { getAgentIslandUrl } from './desktop-core'

const ISLAND_DEFAULT_WIDTH = 420
const ISLAND_DEFAULT_HEIGHT = 32
const ISLAND_MIN_WIDTH = 320
const ISLAND_MAX_WIDTH = 620
const ISLAND_MAX_HEIGHT = 640

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
    movable: true,
    minimizable: false,
    maximizable: false,
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
  void win.loadURL(getAgentIslandUrl({
    appIsPackaged: deps.appIsPackaged,
    appProtocolOrigin: deps.appProtocolOrigin,
    devServerUrl: deps.devServerUrl,
  }))

  // 拖动后防抖存盘：避免拖动过程中频繁写 settings.json。
  // close 时 flush 最近一次 pending，防止退出前丢失最后一次拖动。
  if (typeof deps.onWindowMove === 'function') {
    const onMove = deps.onWindowMove
    let timer: ReturnType<typeof setTimeout> | null = null
    let pending: { x: number; y: number } | null = null
    win.on('move', () => {
      if (win.isDestroyed()) return
      const current = win.getBounds()
      if (!Number.isFinite(current.x) || !Number.isFinite(current.y)) return
      pending = { x: current.x, y: current.y }
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        const snapshot = pending
        pending = null
        if (snapshot) onMove(snapshot)
      }, MOVE_PERSIST_DEBOUNCE_MS)
    })
    win.on('close', () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
        const snapshot = pending
        pending = null
        if (snapshot) onMove(snapshot)
      }
    })
  }

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
