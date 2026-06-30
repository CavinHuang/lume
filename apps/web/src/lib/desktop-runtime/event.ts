import {
  type DesktopListenerEvent,
  getDesktopBridge,
} from './bridge'

export async function listen<T>(
  channel: string,
  listener: (event: DesktopListenerEvent<T>) => void
): Promise<() => void> {
  const bridge = getDesktopBridge()
  if (!bridge) return () => {}

  return Promise.resolve(
    bridge.listen<T>(channel, (payload) => {
      listener({ payload })
    })
  )
}
