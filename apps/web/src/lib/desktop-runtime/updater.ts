import {
  type DesktopDownloadEvent,
  type DesktopUpdateHandle,
  getDesktopBridge,
} from './bridge'

export type DownloadEvent = DesktopDownloadEvent
export type Update = DesktopUpdateHandle

export async function check(): Promise<Update | null> {
  const bridge = getDesktopBridge()
  if (!bridge?.checkForUpdate) return null
  return bridge.checkForUpdate()
}
