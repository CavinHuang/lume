/**
 * 语音听写指示条窗口：无焦点（focusable:false）悬浮条，system-cursor 输出模式下
 * 从外部应用唤起听写时展示状态，不抢占当前应用焦点。
 *
 * 窗口复用而非销毁：会话结束 hide，下次唤起 showInactive（renderer 状态由
 * ?view=voice-indicator 视图自行归零）。
 */

import { BrowserWindow, screen } from 'electron'
import { resolve } from 'node:path'
import { createSecureWebPreferences } from './electron-security'
import { getVoiceIndicatorUrl } from './desktop-core'

export interface VoiceIndicatorWindowDeps {
  appIsPackaged: boolean
  appProtocolOrigin: string
  devServerUrl: string
  desktopRoot: string
  /** 挂载 will-navigate/windowOpenHandler 安全闸（main.ts 的 attachWebContentsSecurity）。 */
  attachSecurity: (win: BrowserWindow) => void
}

export interface VoiceIndicatorManager {
  /** 唤起/切换听写：新建窗口时等 renderer 监听器装好再派发，并去重连按。 */
  sendToggle(): void
  hide(): void
  /** 供 main 把窗口纳入受信 sender 集合（lume:invoke 的 validateIpcSender）。 */
  getWindow(): BrowserWindow | null
}

const INDICATOR_WIDTH = 380
const INDICATOR_HEIGHT = 84
// did-finish-load 后给 renderer 注册 IPC 监听器的缓冲（同岛窗 M-6 首推竞态处理）。
const READY_SEND_BUFFER_MS = 120

export function createVoiceIndicatorManager(deps: VoiceIndicatorWindowDeps): VoiceIndicatorManager {
  let win: BrowserWindow | null = null
  let pendingToggle = false

  const ensure = (): BrowserWindow => {
    if (win && !win.isDestroyed()) return win
    const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const workArea = cursorDisplay.workArea
    const next = new BrowserWindow({
      width: INDICATOR_WIDTH,
      height: INDICATOR_HEIGHT,
      x: workArea.x + Math.round((workArea.width - INDICATOR_WIDTH) / 2),
      y: workArea.y + workArea.height - INDICATOR_HEIGHT - 48,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: createSecureWebPreferences({
        preload: resolve(deps.desktopRoot, 'dist', 'preload', 'preload.cjs'),
      }),
    })
    next.setAlwaysOnTop(true, process.platform === 'darwin' ? 'pop-up-menu' : 'screen-saver')
    next.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    deps.attachSecurity(next)
    next.on('closed', () => {
      pendingToggle = false
      if (win === next) win = null
    })
    void next.loadURL(getVoiceIndicatorUrl({
      appIsPackaged: deps.appIsPackaged,
      appProtocolOrigin: deps.appProtocolOrigin,
      devServerUrl: deps.devServerUrl,
    }))
    win = next
    return next
  }

  const repositionToCursorDisplay = (target: BrowserWindow): void => {
    // 复用窗口跨显示器唤起时重新贴靠光标所在屏底部。
    if (target.isDestroyed()) return
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const workArea = display.workArea
    target.setPosition(
      workArea.x + Math.round((workArea.width - INDICATOR_WIDTH) / 2),
      workArea.y + workArea.height - INDICATOR_HEIGHT - 48,
    )
  }

  return {
    sendToggle(): void {
      const current = ensure()
      const show = (): void => {
        if (current.isDestroyed()) return
        repositionToCursorDisplay(current)
        current.showInactive()
        current.webContents.send('lume:event:voice-dictation:indicator-toggle')
      }
      if (current.webContents.isLoading()) {
        if (pendingToggle) return
        pendingToggle = true
        current.webContents.once('did-finish-load', () => setTimeout(show, READY_SEND_BUFFER_MS))
      } else {
        show()
      }
    },
    hide(): void {
      pendingToggle = false
      if (win && !win.isDestroyed()) win.hide()
    },
    getWindow(): BrowserWindow | null {
      return win && !win.isDestroyed() ? win : null
    },
  }
}
