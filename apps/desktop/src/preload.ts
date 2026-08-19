import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
// IPC 命令/事件白名单与主进程共享单源（renderer-ipc-contract.ts，零依赖纯 TS 可进 sandbox preload）
import { validateRendererInvokeCommand, validateRendererEventChannel } from './renderer-ipc-contract'

// 注入平台类到 <html>，供岛屿 CSS 键控形态（mac 圆角 vs 默认浮动矩形）。
// renderer 无 Node 访问，preload 才能读到 process.platform。仅影响 island CSS，全局注入无副作用。
if (typeof document !== 'undefined' && typeof process !== 'undefined' && process.platform && document.documentElement) {
  document.documentElement.classList.add(process.platform)
}

type RendererEventListener = (payload: unknown) => void
type RendererEventSubscription = {
  handler: (event: IpcRendererEvent, payload: unknown) => void
  listeners: Set<RendererEventListener>
}

const rendererEventSubscriptions = new Map<string, RendererEventSubscription>()

function subscribeRendererEvent(eventName: string, listener: RendererEventListener) {
  let subscription = rendererEventSubscriptions.get(eventName)
  if (!subscription) {
    const listeners = new Set<RendererEventListener>()
    const handler = (_event: IpcRendererEvent, payload: unknown) => {
      for (const current of [...listeners]) current(payload)
    }
    subscription = { handler, listeners }
    rendererEventSubscriptions.set(eventName, subscription)
    ipcRenderer.on(eventName, handler)
  }

  subscription.listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    subscription.listeners.delete(listener)
    if (subscription.listeners.size > 0) return
    ipcRenderer.removeListener(eventName, subscription.handler)
    if (rendererEventSubscriptions.get(eventName) === subscription) {
      rendererEventSubscriptions.delete(eventName)
    }
  }
}

function filePathToFileUrl(path) {
  if (/^(data:|https?:|file:)/i.test(path)) return path
  const normalized = path.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return encodeURI(`file://${withLeadingSlash}`)
}

function createWindowBridge() {
  return {
    async startDragging() {
      // Electron window dragging is driven by -webkit-app-region: drag.
      // Keep this API as a no-op bridge so the current renderer contract stays stable.
      return null
    },
    async onDragDropEvent(listener) {
      const emit = (payload) => listener(payload)

      const dragEnter = (event: DragEvent) => {
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => webUtils.getPathForFile(file))
          .filter(Boolean)
        emit({ type: 'enter', paths })
      }

      const dragOver = (event: DragEvent) => {
        event.preventDefault()
        emit({ type: 'over' })
      }

      const dragLeave = () => {
        emit({ type: 'leave' })
      }

      const drop = (event: DragEvent) => {
        event.preventDefault()
        const paths = Array.from(event.dataTransfer?.files ?? [])
          .map((file) => webUtils.getPathForFile(file))
          .filter(Boolean)
        emit({ type: 'drop', paths })
      }

      window.addEventListener('dragenter', dragEnter)
      window.addEventListener('dragover', dragOver)
      window.addEventListener('dragleave', dragLeave)
      window.addEventListener('drop', drop)

      return () => {
        window.removeEventListener('dragenter', dragEnter)
        window.removeEventListener('dragover', dragOver)
        window.removeEventListener('dragleave', dragLeave)
        window.removeEventListener('drop', drop)
      }
    },
    async minimize() {
      return ipcRenderer.invoke('lume:window-control', 'minimize')
    },
    async toggleMaximize() {
      return ipcRenderer.invoke('lume:window-control', 'toggleMaximize')
    },
    async close() {
      return ipcRenderer.invoke('lume:window-control', 'close')
    },
    async isMaximized() {
      return ipcRenderer.invoke('lume:window-control', 'isMaximized')
    },
    onMaximizeStateChange(listener) {
      const handler = (_event, payload) => listener(payload)
      ipcRenderer.on('lume:event:window-state', handler)
      return () => {
        ipcRenderer.removeListener('lume:event:window-state', handler)
      }
    },
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  invoke(command, payload) {
    return ipcRenderer.invoke('lume:invoke', validateRendererInvokeCommand(command), payload)
  },
  listen(channel, listener) {
    const safeChannel = validateRendererEventChannel(channel)
    const eventName = `lume:event:${safeChannel}`
    return subscribeRendererEvent(eventName, listener)
  },
  convertFileSrc(path) {
    return filePathToFileUrl(path)
  },
  // Electron 32+ 移除 File.path，同步换取拖入文件的绝对路径（File 可跨 contextBridge 传递）
  getPathForFile(file) {
    return webUtils.getPathForFile(file)
  },
  relaunch() {
    return ipcRenderer.invoke('lume:relaunch')
  },
  async checkForUpdate() {
    const info = await ipcRenderer.invoke('lume:update:check')
    if (!info) return null
    return {
      ...info,
      async download(onEvent) {
        const handler = (_event, payload) => onEvent?.(payload)
        ipcRenderer.on('lume:event:update:download', handler)
        try {
          await ipcRenderer.invoke('lume:update:download')
        } finally {
          ipcRenderer.removeListener('lume:event:update:download', handler)
        }
      },
      async install() {
        await ipcRenderer.invoke('lume:update:install')
      },
    }
  },
  async downloadUpdateAsset(url, onEvent) {
    const handler = (_event, payload) => onEvent?.(payload)
    ipcRenderer.on('lume:event:update:download', handler)
    try {
      await ipcRenderer.invoke('lume:update:download-asset', { url })
    } finally {
      ipcRenderer.removeListener('lume:event:update:download', handler)
    }
  },
  async installUpdate() {
    await ipcRenderer.invoke('lume:update:install')
  },
  async getAppSignature() {
    return ipcRenderer.invoke('lume:app:signature')
  },
  window: createWindowBridge(),
})
