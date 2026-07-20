import { Tray, Menu, nativeImage, type NativeImage } from 'electron'
import { buildTrayMenuTemplate, type TrayMenuAction } from './desktop-core'

let tray: Tray | null = null

export function isTrayAvailable(): boolean {
  return Boolean(tray)
}

function buildTrayIcon(iconPath: string): NativeImage {
  const source = nativeImage.createFromPath(iconPath)
  if (source.isEmpty()) throw new Error(`tray icon is empty: ${iconPath}`)
  if (process.platform !== 'darwin') return source
  const sized = source.resize({ width: 22, height: 22, quality: 'best' })
  if (sized.isEmpty()) throw new Error('tray icon is empty after resize')
  sized.setTemplateImage(true)
  return sized
}

export function createTray(options: {
  iconPath: string
  onClickShow: () => void
  onAction: (action: TrayMenuAction, threadId?: string) => void
}) {
  if (tray) return tray
  const icon = buildTrayIcon(options.iconPath)
  tray = new Tray(icon)
  tray.setToolTip('Lume')
  if (process.platform !== 'darwin') tray.on('click', () => options.onClickShow())
  rebuildMenu({ windowVisible: false }, options.onAction)
  return tray
}

export function rebuildMenu(
  state: Parameters<typeof buildTrayMenuTemplate>[0],
  onAction: (action: TrayMenuAction, threadId?: string) => void,
) {
  if (!tray) return
  const template = buildTrayMenuTemplate(state).map((item) => {
    if (item.type === 'separator') return { type: 'separator' as const }
    return {
      label: item.label,
      enabled: item.enabled,
      click: () => item.action && onAction(item.action as TrayMenuAction, item.threadId),
    }
  })
  tray.setContextMenu(Menu.buildFromTemplate(template))
}

export function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
