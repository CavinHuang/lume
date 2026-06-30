import {
  createDesktopUnavailableError,
  filePathToFileUrl,
  getDesktopBridge,
} from './bridge'

export function isDesktopRuntime(): boolean {
  return getDesktopBridge() !== null
}

export async function invoke<T>(command: string, payload?: unknown): Promise<T> {
  const bridge = getDesktopBridge()
  if (!bridge) {
    throw createDesktopUnavailableError(`invoke(${command})`)
  }
  return bridge.invoke<T>(command, payload)
}

export function convertFileSrc(path: string): string {
  const bridge = getDesktopBridge()
  return bridge?.convertFileSrc?.(path) ?? filePathToFileUrl(path)
}
