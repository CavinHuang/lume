import { Tray, Menu, nativeImage } from 'electron'
import { buildTrayMenuTemplate, type TrayMenuAction } from './desktop-core'

let tray: Tray | null = null

export function isTrayAvailable(): boolean {
  return Boolean(tray)
}

export function createTray(options: {
  iconPath: string
  onClickToggle: () => void
  onAction: (action: TrayMenuAction) => void
}) {
  if (tray) return tray
  const source = nativeImage.createFromPath(options.iconPath)
  // nativeImage.resize 返回新对象（非 mutate），需接住返回值
  const icon = process.platform === 'darwin' ? source.resize({ width: 22, height: 22 }) : source
  tray = new Tray(icon)
  tray.setToolTip('Lume')
  tray.on('click', () => options.onClickToggle())
  rebuildMenu({ windowVisible: false }, options.onAction)
  return tray
}

export function rebuildMenu(
  state: { windowVisible: boolean },
  onAction: (action: TrayMenuAction) => void,
) {
  if (!tray) return
  const template = buildTrayMenuTemplate(state).map((item) => {
    if (item.type === 'separator') return { type: 'separator' as const }
    return {
      label: item.label,
      click: () => item.action && onAction(item.action as TrayMenuAction),
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
