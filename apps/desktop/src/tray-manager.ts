import { Tray, Menu, nativeImage, type NativeImage } from 'electron'
import { buildTrayMenuTemplate, deriveTemplateImageBuffer, type TrayMenuAction } from './desktop-core'

let tray: Tray | null = null

export function isTrayAvailable(): boolean {
  return Boolean(tray)
}

function buildTrayIcon(iconPath: string): NativeImage {
  const source = nativeImage.createFromPath(iconPath)
  if (process.platform !== 'darwin') return source
  try {
    const size = source.getSize()
    const rgba = source.toBitmap()
    const templateRgba = deriveTemplateImageBuffer(rgba, size)
    // createFromBitmap 与 toBitmap 配对（raw 像素）；createFromBuffer 对 raw 数据解析不可靠，会得到空图像
    const icon = nativeImage.createFromBitmap(templateRgba, {
      width: size.width,
      height: size.height,
    })
    if (icon.isEmpty()) throw new Error('template icon empty after createFromBitmap')
    // resize 返回新对象；template 标记要打在最终（resize 后）的 image 上
    const sized = icon.resize({ width: 22, height: 22 })
    if (sized.isEmpty()) throw new Error('template icon empty after resize')
    sized.setTemplateImage(true)
    return sized
  } catch (error) {
    console.error('[tray] template icon derive failed, fallback to color:', error)
    // 派生失败回退：全彩图标 resize 到 22（resize 返回新对象，需接住）
    const fallback = nativeImage.createFromPath(iconPath)
    const sized = fallback.resize({ width: 22, height: 22 })
    return sized
  }
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
