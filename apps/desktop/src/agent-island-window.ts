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
}

function resolveWindowPosition(workArea: Electron.Rectangle) {
  const width = Math.min(Math.max(ISLAND_DEFAULT_WIDTH, ISLAND_MIN_WIDTH), ISLAND_MAX_WIDTH)
  const x = Math.round(workArea.x + (workArea.width - width) / 2)
  // Windows/Linux 避让任务栏；macOS 贴顶（bounds.y）
  const y = process.platform === 'darwin' ? workArea.y : workArea.y + 12
  return { x, y, width, height: ISLAND_DEFAULT_HEIGHT }
}

export function createIslandWindow(deps: IslandWindowDeps): BrowserWindow {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const bounds = resolveWindowPosition(display.workArea)
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
