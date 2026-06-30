import {
  createDesktopUnavailableError,
  getDesktopBridge,
  type DesktopListenerEvent,
} from './bridge'

export function getCurrentWindow() {
  return {
    async startDragging(): Promise<void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.startDragging) {
        throw createDesktopUnavailableError('window.startDragging')
      }
      await bridge.window.startDragging()
    },
    async onDragDropEvent(
      listener: (event: DesktopListenerEvent<unknown>) => void
    ): Promise<() => void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.onDragDropEvent) return () => {}

      return Promise.resolve(
        bridge.window.onDragDropEvent((payload) => {
          listener({ payload })
        })
      )
    },
  }
}
