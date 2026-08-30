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

// 测试可观测：ipcRenderer.send 调用记录（push-on-send，清空由测试在 beforeEach 负责）。
export const ipcRendererSentMessages: Array<{ channel: string; args: unknown[] }> = []

// 测试可观测：ipcRenderer.sendSync 返回值映射（key=channel，未配置返回 undefined）。
// 测试在调用前赋值；建议在 beforeEach 清空（delete 已设 key）。
export const ipcRendererSendSyncReturns: Record<string, unknown> = {}

// 测试可观测：contextBridge.exposeInMainWorld 暴露记录（key=暴露键名，value=暴露对象）。
// 后写胜出（同键覆盖）；测试在 beforeEach 清空。
export const contextBridgeExposures = new Map<string, unknown>()

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

// 测试可观测：ipcMain.on/handle 注册的 handler（key=channel）。
// main.ts / browser-runtime.ts 构造期注册的 handler 可据此取出并模拟主进程事件。
export const ipcMainHandlers = new Map<string, (...args: unknown[]) => void>()
export const ipcMainSyncHandlers = new Map<string, (...args: unknown[]) => unknown>()
export const ipcMainInvokers = new Map<string, (...args: unknown[]) => unknown>()

export const electronMockStub = {
  ipcMain: {
    on(channel: string, handler: (...args: unknown[]) => void): void {
      ipcMainHandlers.set(channel, handler)
    },
    handle(channel: string, handler: (...args: unknown[]) => unknown): void {
      ipcMainInvokers.set(channel, handler)
    },
    once(channel: string, handler: (...args: unknown[]) => void): void {
      // 仅注册到 on 表（测试侧无需区分 once 语义）。
      ipcMainHandlers.set(channel, handler)
    },
    off(channel: string): void {
      ipcMainHandlers.delete(channel)
    },
    removeHandler(channel: string): void {
      ipcMainInvokers.delete(channel)
    },
  },
  ipcRenderer: {
    on(channel: string, handler: (...args: unknown[]) => void): void {
      ipcRendererHandlers.set(channel, handler)
    },
    off(channel: string): void {
      ipcRendererHandlers.delete(channel)
    },
    send(channel: string, ...args: unknown[]): void {
      // 仅记录副作用，无真实 IPC 行为（保留无返回值语义）。
      ipcRendererSentMessages.push({ channel, args })
    },
    sendSync(channel: string, ..._args: unknown[]): unknown {
      // 默认返回 undefined；测试通过 ipcRendererSendSyncReturns[channel] 配置期望值。
      return ipcRendererSendSyncReturns[channel]
    },
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
  contextBridge: {
    exposeInMainWorld(key: string, value: unknown): void {
      // 记录暴露（后写胜出）；无真实 contextBridge 行为。
      contextBridgeExposures.set(key, value)
    },
  },
  webUtils: {},
  // browser-runtime.ts 命名导入（clipboard/dialog/session/shell）仅在类方法内部使用，
  // 模块加载期不可达；提供 no-op stub 以满足 import 绑定。
  clipboard: {
    readText() { return '' },
    writeText() {},
    readHTML() { return '' },
    writeHTML() {},
    availableFormats() { return [] },
  },
  dialog: {
    showMessageBox() { return Promise.resolve({ response: 0 }) },
    showOpenDialog() { return Promise.resolve({ canceled: true, filePaths: [] }) },
    showSaveDialog() { return Promise.resolve({ canceled: true, filePath: undefined }) },
    showErrorBox() {},
  },
  session: {
    fromPartition() { return { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, off() {} } },
    defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, on() {}, off() {} },
  },
  shell: {
    openExternal() { return Promise.resolve() },
    openPath() { return '' },
    showItemInFolder() {},
    trashItem() { return Promise.resolve() },
  },
  ipcMainEvent: class {
    returnValue: unknown = undefined
    sender = { id: 0, isDestroyed() { return false }, send() {} }
  },
  app: { isPackaged: false, getPath() { return '' } },
  nativeTheme: {
    shouldUseDarkColors: false,
    on() {},
  },
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
