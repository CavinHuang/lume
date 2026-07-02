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
    async minimize(): Promise<void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.minimize) {
        throw createDesktopUnavailableError('window.minimize')
      }
      await bridge.window.minimize()
    },
    async toggleMaximize(): Promise<void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.toggleMaximize) {
        throw createDesktopUnavailableError('window.toggleMaximize')
      }
      await bridge.window.toggleMaximize()
    },
    async close(): Promise<void> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.close) {
        throw createDesktopUnavailableError('window.close')
      }
      await bridge.window.close()
    },
    async isMaximized(): Promise<boolean> {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.isMaximized) {
        throw createDesktopUnavailableError('window.isMaximized')
      }
      return bridge.window.isMaximized()
    },
    onMaximizeStateChange(
      listener: (payload: { maximized: boolean }) => void
    ): () => void {
      const bridge = getDesktopBridge()
      if (!bridge?.window?.onMaximizeStateChange) return () => {}
      return bridge.window.onMaximizeStateChange(listener)
    },
  }
}
