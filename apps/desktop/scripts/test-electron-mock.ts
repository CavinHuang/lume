// 所有 desktop 测试共享的 electron mock stub（superset）。
//
// 背景：bun:test 默认（共享全局）模式下 mock.module 是首写胜出且跨文件共享的。
// 若各测试注册形态各异的 stub，先注册者的 stub 会被全局复用；其缺失的命名导出
// 会让后续文件的 `import { X } from 'electron'` 落到真实 electron 上 → SyntaxError。
// 因此所有 mock electron 的测试必须注册同一个 stub 对象。本 stub 汇总测试运行期
// 可达模块的全部命名导入（manager 的 BrowserWindow/screen、guest-state 的 ipcRenderer、
// tray-manager 的 Tray/Menu/nativeImage、各 preload 的 contextBridge/webUtils 等）。
//
// 两个测试需要"可观测"的副作用，已内建到 stub 中，避免各文件自定义覆盖（会被首写胜出忽略）：
//   1. ipcRenderer.on 将 handler 记入 ipcRendererHandlers——AnnotationOverlay 测试据此
//      取出 createGuestBridge 注册的 'lume:browser-annotation-guest' handler 来模拟主进程推送。
//   2. Tray 构造时记入 latestTray.current，destroy 在 throwOnDestroy 置位时抛错——
//      tray-manager 测试据此验证 destroyTray 的失败语义。

export const ipcRendererHandlers = new Map<string, (...args: unknown[]) => void>()

// tray-manager 测试通过 latestTray.current.throwOnDestroy 控制析构失败。
export const latestTray: {
  current: {
    throwOnDestroy: boolean
    setToolTip(): void
    on(): void
    setContextMenu(): void
    destroy(): void
  } | null
} = { current: null }

export const electronMockStub = {
  ipcRenderer: {
    on(channel: string, handler: (...args: unknown[]) => void): void {
      ipcRendererHandlers.set(channel, handler)
    },
    off(channel: string): void {
      ipcRendererHandlers.delete(channel)
    },
    send(): void {},
    invoke(): Promise<unknown> {
      return Promise.resolve(undefined)
    },
  },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
    getContentBounds() {
      return { x: 0, y: 0, width: 0, height: 0 }
    }
    isDestroyed() {
      return true
    }
    on() {}
    once() {}
    close() {}
    show() {}
    setPosition() {}
    setBounds() {}
    webContents = {
      id: 0,
      on() {},
      once() {},
      send() {},
      setWindowOpenHandler() {},
      loadURL() {
        return Promise.resolve()
      },
    }
  },
  screen: {
    getDisplayNearestPoint() {
      return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }
    },
  },
  contextBridge: { exposeInMainWorld() {} },
  webUtils: {},
  app: { isPackaged: false, getPath() { return '' } },
  safeStorage: {
    encryptString() { return Buffer.alloc(0) },
    decryptString() { return '' },
    isEncryptionAvailable() { return false },
  },
  Menu: { buildFromTemplate(template: unknown) { return template } },
  nativeImage: {
    createFromPath() {
      return {
        isEmpty: () => false,
        resize() {
          return { isEmpty: () => false, resize() { return this }, setTemplateImage() {} }
        },
        setTemplateImage() {},
      }
    },
  },
  Tray: class {
    throwOnDestroy = false
    constructor() {
      latestTray.current = this
    }
    setToolTip() {}
    on() {}
    setContextMenu() {}
    destroy() {
      if (this.throwOnDestroy) throw new Error('native destroy failed')
    }
  },
}
