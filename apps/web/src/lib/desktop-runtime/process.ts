import {
  createDesktopUnavailableError,
  getDesktopBridge,
} from './bridge'

export async function relaunch(): Promise<void> {
  const bridge = getDesktopBridge()
  if (!bridge?.relaunch) {
    throw createDesktopUnavailableError('relaunch')
  }

  await bridge.relaunch()
}
