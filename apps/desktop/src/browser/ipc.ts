/**
 * 浏览器 renderer↔main IPC 层 —— `lume:browser-view-*` 通道注册 + webview guest 加固。
 *
 * 来源:.zcode/analysis/extracted/06-ipc-and-wiring.source.js
 * (E_e 窗口校验与载荷解析、eh 对话框 sendSync 通道、_ve 弹窗拦截、eV will/did-attach 加固)。
 *
 * ZCode 原名对照:
 *   E_e  = registerBrowserViewIpcHandlers            → createBrowserIpc(通道注册段)
 *   CD   = parseBrowserTabScope                      → parseBrowserTabScope
 *   lt   = tab 标识 zod schema(非空字符串)           → parseBrowserViewKey
 *   T$   = viewport zod schema                       → parseViewportOrNull
 *   eh   = EmbeddedBrowserJavaScriptDialogController 通道段 → IpcChannels.dialog(注入 port)
 *   _ve  = attachEmbeddedBrowserWindowOpenHandler    → attachBrowserGuestWindowOpenControls
 *   vve  = 弹窗外开修饰键按下判定(Ctrl/Cmd)          → isExternalModifierDown
 *   kve  = 弹窗外开修饰键抬起判定                    → isExternalModifierUp
 *   bve  = 弹窗外开判定(修饰键/后台 tab disposition) → shouldOpenPopupExternally
 *   Vq   = 弹窗 URL 白名单(http/https)              → isAllowedBrowserPopupUrl
 *   eV   = createBrowserWindow 的 will/did-attach 段  → hardenWindowForBrowserGuests
 *   yve  = webview src 协议白名单                    → isAllowedBrowserViewSrc
 *
 * 语义偏差(命名/平台前缀之外):
 *   1. 通道前缀 `zcode:browser-view-*` → `lume:browser-view-*`;`zcode:open-browser-url`
 *      → `lume:open-browser-url`;`zcode:embedded-browser-javascript-dialog` →
 *      `lume:embedded-browser-javascript-dialog`。
 *   2. 新增 `handleRendererCommand` 漏斗适配:Lume 的 sandbox preload 只暴露
 *      `lume:invoke` 白名单漏斗,renderer 无法直发裸 `ipcMain.handle` 通道。集成者在
 *      main 的 dispatchCommand 里把 `lume:browser-view-*` 命令转发到本层;裸通道注册
 *      保留(ZCode 逐字等价,guest/集成调试路径可直接 invoke)。两条路径共用同一校验实现。
 *   3. `_ve` 的 coding-plan 专属分支(就地 loadURL、will-navigate 白名单放行)不移植
 *      ——Lume 无 coding-plan guest;will-navigate 守卫在 ZCode 中对 browser guest 亦为
 *      空操作,故不注册。
 *   4. will-attach 增加注入式 mountToken 校验钩子(Lume 增强项,设计文档 §2.3):
 *      `mountAuthorizer.authorizeGuestMount` 返回 null 时 preventDefault;未注入时
 *      退化为仅协议白名单 + 分区强制(ZCode 行为)。
 *   5. 对话框控制不再由本层构造(集成者注入 `EmbeddedBrowserJavaScriptDialogController`
 *      port);ZCode 原为模块级单例 `d$`。
 *   6. `lume:open-browser-url` 的送达路径:ZCode 直发 hostWebContents(裸通道,
 *      renderer 以裸 ipcRenderer.on 监听);Lume 的 sandbox preload 只暴露
 *      `lume:event:*` 白名单 listen 面,集成者注入 `deps.emit` 后改经统一事件漏斗
 *      (`lume:event:lume:open-browser-url`)送达;未注入时保留直发行为。
 */

import { BrowserWindow, ipcMain } from "electron"
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron"

/* ── 通道名表(types.ts 事件面 §2.2 的 renderer→main 半边 + 对话框) ───── */

/** renderer→main invoke 通道名集合(`lume:browser-view-*`)。 */
export const BROWSER_VIEW_IPC_CHANNELS = {
  attachGuest: "lume:browser-view-attach-guest",
  detachGuest: "lume:browser-view-detach-guest",
  updateViewport: "lume:browser-view-update-viewport",
  screenshotSurfaceReady: "lume:browser-view-screenshot-surface-ready",
  closeTabFromRenderer: "lume:browser-view-close-tab-from-renderer",
  reportResidency: "lume:browser-view-report-residency",
  suspendReady: "lume:browser-view-suspend-ready",
  ensureResident: "lume:browser-view-ensure-resident",
  restoreTabs: "lume:browser-view-restore-tabs",
} as const

/** guest preload → main 的 sendSync JS 对话框通道(ZCode I.EmbeddedBrowserJavaScriptDialog)。 */
export const BROWSER_EMBEDDED_DIALOG_CHANNEL = "lume:embedded-browser-javascript-dialog"

/** main→renderer:弹窗拦截后请 renderer 开新面板 tab(ZCode I.OpenBrowserUrl)。 */
export const BROWSER_OPEN_BROWSER_URL_CHANNEL = "lume:open-browser-url"

/** webview 默认分区(PORTING.md 平台常量)。 */
export const BROWSER_GUEST_PARTITION = "persist:lume-browser"

/* ── 管理器端口(BrowserGuestManager 形状由集成者装配,类型在本文件声明) ──── */

/** attach 载荷(attach-guest;ZCode E_e 解析后的形态,含解析出的 windowId)。 */
export interface BrowserGuestAttachRequest {
  tabId: string
  webContentsId: number
  active?: boolean
  workspaceKey?: string
  remoteSessionId?: string
  sessionId?: string
  residencyGeneration?: number
  windowId: number
}

/** attach 结果(ZCode attachGuest 返回;undefined 按 not-found 处理)。 */
export interface BrowserGuestAttachResult {
  ok: boolean
  reason?: string
  recoveryRequested?: boolean
  guestGeneration?: number
}

/** renderer 上报的 tab 五元组作用域(ZCode CD = parseBrowserTabScope)。 */
export interface BrowserTabScope {
  tabId: string
  workspaceKey: string
  sessionId: string
  remoteSessionId?: string
}

/** renderer 上报的驻留运行态(report-residency 载荷,ZCode o.reportBrowserTabResidency 入参)。 */
export interface BrowserResidencyReport extends BrowserTabScope {
  selected: boolean
  visible: boolean
  currentTask: boolean
  loading: boolean
  restoreUrl: string | null
  title: string | null
  faviconUrl?: string | null
  windowId: number
}

/** restore-tabs 查询载荷(窗口重建拉 shell 列表)。 */
export interface BrowserRestoreTabsQuery {
  workspaceKey: string
  remoteSessionId?: string
  sessionId?: string
  windowId: number
}

/**
 * BrowserGuestManager 的 IPC 可见面。main 侧 BrowserGuestManager(guest-manager.ts,
 * 集成者装配)实现本接口;全部方法按 ZCode E_e 的委托形状声明。
 */
export interface BrowserViewManagerPort {
  attachGuest(request: BrowserGuestAttachRequest): Promise<BrowserGuestAttachResult | undefined>
  detachGuest(tabId: string, webContentsId: number, windowId: number): Promise<boolean>
  closeTabFromRenderer(scope: BrowserTabScope & { windowId: number }): Promise<void>
  reportResidency(report: BrowserResidencyReport): Promise<void>
  acknowledgeSuspend(ack: { tabId: string; generation: number; windowId: number }): Promise<void>
  ensureResident(scope: BrowserTabScope & { windowId: number }): Promise<void>
  restoreTabs(query: BrowserRestoreTabsQuery): Promise<readonly unknown[]>
  updateViewport(tabId: string, viewport: { width: number; height: number } | null, windowId: number, zoomFactor: number): Promise<void>
}

/** JS 对话框控制器 port(实现见 core/dialog-controller.ts;ZCode 原名 EmbeddedBrowserJavaScriptDialogController)。 */
export interface BrowserDialogControllerPort {
  handleDialogRequest(senderWebContentsId: number, frameUrl: string, payload: unknown): { handled: boolean; value?: boolean }
}

/** 截图表面协调器 ready 入口(实现见 core/screenshot-surface.ts 的 handleReady)。 */
export interface BrowserScreenshotSurfaceReadyPort {
  handleReady(payload: unknown, senderWebContentsId: number): void
}

/** mountToken 签发校验钩子(Lume 增强项;旧实现 authorizeGuestMount 同形状)。 */
export interface BrowserGuestMountAuthorizer {
  authorizeGuestMount(input: { ownerWebContentsId: number; src: string; partition: string }): { partition: string } | null
}

/** createBrowserIpc 依赖注入。 */
export interface BrowserIpcDeps {
  manager: BrowserViewManagerPort
  screenshotSurface: BrowserScreenshotSurfaceReadyPort
  dialog: BrowserDialogControllerPort
  log: (message: string) => void
  warn: (message: string, error?: unknown) => void
  /** guest preload 编译产物路径(integrator 写 .cjs 后传入)。 */
  guestPreloadPath: string
  /** event.sender.id → 宿主 BrowserWindow(ZCode BrowserWindow.fromWebContents)。 */
  resolveSenderWindow(senderWebContentsId: number): BrowserWindow | null
  /** 系统浏览器外开(ZCode JO.openExternal / shell.openExternal)。 */
  openExternal(url: string): void | Promise<void>
  /** mountToken 校验钩子;缺省时仅协议白名单 + 分区强制(见头部偏差 4)。 */
  mountAuthorizer?: BrowserGuestMountAuthorizer
  /** webview 分区,缺省 persist:lume-browser。 */
  browserPartition?: string
  /**
   * 可选:main→renderer 事件转发(见头部偏差 6)。注入后 `lume:open-browser-url`
   * 经此发出(集成者统一加 `lume:event:` 前缀以过 preload listen 白名单);
   * 缺省保持 ZCode 行为直发 hostWebContents(sandbox renderer 无裸通道监听面)。
   */
  emit?: (method: string, params: Record<string, unknown>) => void
}

export interface BrowserIpc {
  /**
   * `lume:invoke` 漏斗适配(见头部偏差 2):集成者从 main 的 dispatchCommand 把
   * `lume:browser-view-*` 命令转发进来;未知命令抛错。
   */
  handleRendererCommand(command: string, payload: unknown, senderWebContentsId: number): Promise<unknown>
  /** 对指定窗口挂 will/did-attach-webview 加固;返回该窗口的卸载函数。 */
  hardenWindowForBrowserGuests(win: BrowserWindow): () => void
  dispose(): void
}

/* ── 载荷解析(ZCode zod schema 的手工等价;非法一律抛 TypeError 由 ipc reject) ── */

/** 非空字符串 tab/作用域标识(ZCode lt.parse)。 */
function parseBrowserViewKey(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value
}

/** 可选非空字符串。 */
function parseOptionalKey(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  return parseBrowserViewKey(value, field)
}

/** 正的 安全整数 webContentsId(ZCode:Number.isSafeInteger && > 0)。 */
function parseWebContentsId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new TypeError("webContentsId must be a positive safe integer")
  }
  return value as number
}

/** 非负 安全整数 代数(residencyGeneration/suspend generation)。 */
function parseGeneration(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return value as number
}

/** viewport 载荷:null 或正有限宽高(ZCode T$.parse,i.viewport === null ? null : parse)。 */
function parseViewportOrNull(value: unknown): { width: number; height: number } | null {
  if (value === null) return null
  if (typeof value !== "object" || value === null) {
    throw new TypeError("viewport must be null or { width, height }")
  }
  const viewport = value as { width?: unknown; height?: unknown }
  if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || (viewport.width as number) <= 0 || (viewport.height as number) <= 0) {
    throw new TypeError("viewport must be null or { width, height } with positive finite numbers")
  }
  return { width: viewport.width as number, height: viewport.height as number }
}

/** tab 五元组作用域(ZCode CD = parseBrowserTabScope:tabId/workspaceKey/sessionId + 可选 remoteSessionId)。 */
function parseBrowserTabScope(payload: Record<string, unknown>): BrowserTabScope {
  const scope: BrowserTabScope = {
    tabId: parseBrowserViewKey(payload.tabId, "tabId"),
    workspaceKey: parseBrowserViewKey(payload.workspaceKey, "workspaceKey"),
    sessionId: parseBrowserViewKey(payload.sessionId, "sessionId"),
  }
  if (payload.remoteSessionId) scope.remoteSessionId = parseBrowserViewKey(payload.remoteSessionId, "remoteSessionId")
  return scope
}

/** 渲染层载荷 → Record 视图(非对象按空载荷处理)。 */
function asPayload(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {}
}

/** webview src 协议白名单(ZCode yve:about:/data:/http:/https:/lume-browser-restore:)。 */
export function isAllowedBrowserViewSrc(src: string): boolean {
  try {
    const parsed = new URL(src)
    return ["about:", "data:", "http:", "https:", "lume-browser-restore:"].includes(parsed.protocol)
  } catch {
    return false
  }
}

/** 弹窗 URL 白名单(ZCode Vq:仅 http/https 可外开/转开新 tab)。 */
function isAllowedBrowserPopupUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/** Ctrl/Cmd 按下(ZCode vve:Control/Meta 且 keyDown 非 Repeat)。 */
function isExternalModifierDown(input: { type: string; control?: boolean; meta?: boolean }): boolean {
  return input.type === "keyDown" && !!(input.control || input.meta)
}

/** Ctrl/Cmd 抬起(ZCode kve:Control/Meta 的 keyUp)。 */
function isExternalModifierUp(input: { type: string; control?: boolean; meta?: boolean }): boolean {
  return input.type === "keyUp" && !!(input.control || input.meta)
}

/** 弹窗外开判定(ZCode bve:修饰键激活或 background-tab disposition)。 */
function shouldOpenPopupExternally(input: { disposition: string; externalBrowserModifierActive: boolean }): boolean {
  return input.externalBrowserModifierActive || input.disposition === "background-tab"
}

/* ── createBrowserIpc ─────────────────────────────────────────────────── */

/**
 * 注册全部 `lume:browser-view-*` renderer→main 通道并返回窗口加固/漏斗适配入口。
 *
 * 行为对齐 ZCode E_e(registerBrowserViewIpcHandlers):
 *  - 全部 invoke 型通道先经 `resolveSenderWindow` 校验宿主窗口(不存在/已销毁按
 *    window-mismatch 拒绝);
 *  - attach-guest 缺 manager 结果时回 `{ ok:false, reason:"not-found", recoveryRequested:false }`;
 *  - detach-guest 回布尔(detachBrowserGuest ?? false);
 *  - screenshot-surface-ready 是唯一 send 型(经 `ipcMain.on` 直入协调器 handleReady);
 *  - embedded-browser-javascript-dialog 经 `ipcMain.on` 以 `event.returnValue` 同步应答。
 */
export function createBrowserIpc(deps: BrowserIpcDeps): BrowserIpc {
  const windowMismatch = (): BrowserGuestAttachResult => ({ ok: false, reason: "window-mismatch", recoveryRequested: false })
  const requireWindow = (senderWebContentsId: number): BrowserWindow | null => {
    const win = deps.resolveSenderWindow(senderWebContentsId)
    return win && !win.isDestroyed() ? win : null
  }

  /* 逐通道实现(裸通道与漏斗共用)。 */

  async function handleAttachGuest(payload: unknown, senderWebContentsId: number): Promise<BrowserGuestAttachResult> {
    const win = requireWindow(senderWebContentsId)
    if (!win) return windowMismatch()
    const input = asPayload(payload)
    const tabId = parseBrowserViewKey(input.key, "key")
    const webContentsId = parseWebContentsId(input.webContentsId)
    if (input.active !== undefined && typeof input.active !== "boolean") {
      throw new TypeError("active must be a boolean")
    }
    const residencyGeneration = input.residencyGeneration === undefined ? undefined : parseGeneration(input.residencyGeneration, "residencyGeneration")
    const result = await deps.manager.attachGuest({
      tabId,
      webContentsId,
      ...(input.active === undefined ? {} : { active: input.active === true }),
      ...(input.workspaceKey === undefined ? {} : { workspaceKey: parseBrowserViewKey(input.workspaceKey, "workspaceKey") }),
      ...(input.remoteSessionId === undefined ? {} : { remoteSessionId: parseBrowserViewKey(input.remoteSessionId, "remoteSessionId") }),
      ...(input.sessionId === undefined ? {} : { sessionId: parseBrowserViewKey(input.sessionId, "sessionId") }),
      ...(residencyGeneration === undefined ? {} : { residencyGeneration }),
      windowId: win.id,
    })
    return result ?? { ok: false, reason: "not-found", recoveryRequested: false }
  }

  async function handleDetachGuest(payload: unknown, senderWebContentsId: number): Promise<boolean> {
    if (!requireWindow(senderWebContentsId)) return false
    const input = asPayload(payload)
    return (
      (await deps.manager.detachGuest(
        parseBrowserViewKey(input.key, "key"),
        parseWebContentsId(input.webContentsId),
        senderWebContentsId,
      )) ?? false
    )
  }

  async function handleUpdateViewport(payload: unknown, senderWebContentsId: number): Promise<void> {
    const win = requireWindow(senderWebContentsId)
    if (!win) return
    const input = asPayload(payload)
    await deps.manager.updateViewport(
      parseBrowserViewKey(input.tabId, "tabId"),
      parseViewportOrNull(input.viewport),
      win.id,
      win.webContents.getZoomFactor(),
    )
  }

  function handleScreenshotSurfaceReady(payload: unknown, senderWebContentsId: number): void {
    if (!requireWindow(senderWebContentsId)) return
    deps.screenshotSurface.handleReady(payload, senderWebContentsId)
  }

  async function handleCloseTabFromRenderer(payload: unknown, senderWebContentsId: number): Promise<void> {
    const win = requireWindow(senderWebContentsId)
    if (!win) return
    await deps.manager.closeTabFromRenderer({ ...parseBrowserTabScope(asPayload(payload)), windowId: win.id })
  }

  async function handleReportResidency(payload: unknown, senderWebContentsId: number): Promise<void> {
    const win = requireWindow(senderWebContentsId)
    if (!win) return
    const input = asPayload(payload)
    await deps.manager.reportResidency({
      ...parseBrowserTabScope(input),
      selected: input.selected === true,
      visible: input.visible === true,
      currentTask: input.currentTask === true,
      loading: input.loading === true,
      restoreUrl: typeof input.restoreUrl === "string" ? input.restoreUrl : null,
      title: typeof input.title === "string" ? input.title : null,
      ...(input.faviconUrl === undefined ? {} : { faviconUrl: typeof input.faviconUrl === "string" ? input.faviconUrl : null }),
      windowId: win.id,
    })
  }

  async function handleSuspendReady(payload: unknown, senderWebContentsId: number): Promise<void> {
    const win = requireWindow(senderWebContentsId)
    if (!win) return
    const input = asPayload(payload)
    await deps.manager.acknowledgeSuspend({
      tabId: parseBrowserViewKey(input.tabId, "tabId"),
      generation: parseGeneration(input.generation, "generation"),
      windowId: win.id,
    })
  }

  async function handleEnsureResident(payload: unknown, senderWebContentsId: number): Promise<void> {
    const win = requireWindow(senderWebContentsId)
    if (!win) return
    await deps.manager.ensureResident({ ...parseBrowserTabScope(asPayload(payload)), windowId: win.id })
  }

  async function handleRestoreTabs(payload: unknown, senderWebContentsId: number): Promise<readonly unknown[]> {
    const win = requireWindow(senderWebContentsId)
    if (!win) return []
    const input = asPayload(payload)
    return (
      (await deps.manager.restoreTabs({
        workspaceKey: parseBrowserViewKey(input.workspaceKey, "workspaceKey"),
        ...(input.remoteSessionId ? { remoteSessionId: parseBrowserViewKey(input.remoteSessionId, "remoteSessionId") } : {}),
        ...(input.sessionId ? { sessionId: parseBrowserViewKey(input.sessionId, "sessionId") } : {}),
        windowId: win.id,
      })) ?? []
    )
  }

  /** 裸通道注册(逐字对齐 ZCode E_e;dispose 时逐一移除)。 */
  const invokeHandlers: Record<string, (payload: unknown, senderWebContentsId: number) => Promise<unknown>> = {
    [BROWSER_VIEW_IPC_CHANNELS.attachGuest]: handleAttachGuest,
    [BROWSER_VIEW_IPC_CHANNELS.detachGuest]: handleDetachGuest,
    [BROWSER_VIEW_IPC_CHANNELS.updateViewport]: handleUpdateViewport,
    [BROWSER_VIEW_IPC_CHANNELS.closeTabFromRenderer]: handleCloseTabFromRenderer,
    [BROWSER_VIEW_IPC_CHANNELS.reportResidency]: handleReportResidency,
    [BROWSER_VIEW_IPC_CHANNELS.suspendReady]: handleSuspendReady,
    [BROWSER_VIEW_IPC_CHANNELS.ensureResident]: handleEnsureResident,
    [BROWSER_VIEW_IPC_CHANNELS.restoreTabs]: handleRestoreTabs,
  }
  for (const [channel, handler] of Object.entries(invokeHandlers)) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => handler(payload, event.sender.id))
  }
  ipcMain.on(BROWSER_VIEW_IPC_CHANNELS.screenshotSurfaceReady, (event: IpcMainEvent, payload: unknown) => {
    handleScreenshotSurfaceReady(payload, event.sender.id)
  })
  ipcMain.on(BROWSER_EMBEDDED_DIALOG_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
    // sendSync 同步应答(ZCode: e.returnValue = d$.handleDialogRequest(...))。
    event.returnValue = deps.dialog.handleDialogRequest(event.sender.id, event.senderFrame?.url ?? "", payload)
  })

  /* ── 窗口级 webview guest 加固(ZCode eV 的 will/did-attach 段 + _ve) ──── */

  function hardenWindowForBrowserGuests(win: BrowserWindow): () => void {
    const onWillAttach = (
      event: Electron.Event,
      webPreferences: Electron.WebPreferences,
      params: Record<string, unknown>,
    ): void => {
      const src = typeof params.src === "string" ? params.src : "about:blank"
      const requestedPartition = typeof params.partition === "string" ? params.partition : ""
      if (!isAllowedBrowserViewSrc(src)) {
        deps.warn(`[browser-pane] blocked unsupported webview url: ${src}`)
        event.preventDefault()
        return
      }
      // mountToken 校验钩子(Lume 增强):授权失败一律拒绝挂载(旧实现同语义)。
      let partition = deps.browserPartition ?? BROWSER_GUEST_PARTITION
      if (deps.mountAuthorizer) {
        const grant = deps.mountAuthorizer.authorizeGuestMount({
          ownerWebContentsId: win.webContents.id,
          src,
          partition: requestedPartition,
        })
        if (!grant) {
          deps.warn("[browser-pane] rejected unauthorized browser guest mount", src)
          event.preventDefault()
          return
        }
        partition = grant.partition
      }
      // 强制安全基线(ZCode eV:contextIsolation/nodeIntegration=false/sandbox/nodeIntegrationInSubFrames=true + 专属 guest preload)。
      webPreferences.preload = deps.guestPreloadPath
      webPreferences.contextIsolation = true
      webPreferences.nodeIntegration = false
      webPreferences.nodeIntegrationInSubFrames = true
      webPreferences.sandbox = true
      // 剥除 renderer 侧声明,再按白名单强制(ZCode eV 对 params 的改写)。
      delete params.preload
      delete params.nodeintegration
      params.nodeintegrationinsubframes = "true"
      delete params.disablewebsecurity
      delete params.allowpopups
      params.allowpopups = "true"
      params.partition = partition
    }

    win.webContents.on("will-attach-webview", onWillAttach)
    const detachGuests: Array<() => void> = []
    const onDidAttach = (_event: Electron.Event, guestContents: Electron.WebContents): void => {
      detachGuests.push(attachBrowserGuestWindowOpenControls({ guestContents, hostWebContents: win.webContents, deps }))
    }
    win.webContents.on("did-attach-webview", onDidAttach)
    return () => {
      win.webContents.removeListener("will-attach-webview", onWillAttach)
      win.webContents.removeListener("did-attach-webview", onDidAttach)
      for (const detach of detachGuests) detach()
    }
  }

  /** 漏斗适配:命令名 → 与裸通道相同的实现(见头部偏差 2)。 */
  async function handleRendererCommand(command: string, payload: unknown, senderWebContentsId: number): Promise<unknown> {
    const handler = invokeHandlers[command]
    if (handler) return handler(payload, senderWebContentsId)
    if (command === BROWSER_VIEW_IPC_CHANNELS.screenshotSurfaceReady) {
      handleScreenshotSurfaceReady(payload, senderWebContentsId)
      return null
    }
    throw new Error(`unsupported browser-view command: ${command}`)
  }

  return {
    handleRendererCommand,
    hardenWindowForBrowserGuests,
    dispose() {
      for (const channel of Object.keys(invokeHandlers)) ipcMain.removeHandler(channel)
      ipcMain.removeAllListeners(BROWSER_VIEW_IPC_CHANNELS.screenshotSurfaceReady)
      ipcMain.removeAllListeners(BROWSER_EMBEDDED_DIALOG_CHANNEL)
    },
  }
}

/**
 * guest 弹窗拦截(ZCode _ve = attachEmbeddedBrowserWindowOpenHandler,coding-plan 分支不移植):
 *  - before-input-event 跟踪 Ctrl/Cmd;
 *  - setWindowOpenHandler 一律 deny:URL 非白名单 → 仅告警;修饰键激活或 background-tab →
 *    openExternal;其余回 `lume:open-browser-url` 请 renderer 开新面板 tab。
 *
 * @returns 该 guest 的解绑函数。
 */
function attachBrowserGuestWindowOpenControls(input: {
  guestContents: Electron.WebContents
  hostWebContents: Electron.WebContents
  deps: BrowserIpcDeps
}): () => void {
  const { guestContents, hostWebContents, deps } = input
  let externalBrowserModifierActive = false
  const onBeforeInput = (_event: Electron.Event, input: { type: string; control?: boolean; meta?: boolean }): void => {
    if (isExternalModifierUp(input)) {
      externalBrowserModifierActive = false
      return
    }
    externalBrowserModifierActive = isExternalModifierDown(input)
  }
  guestContents.on("before-input-event", onBeforeInput)
  const onWindowOpen = (details: { url: string; disposition: string }): { action: "deny" } => {
    const { url, disposition } = details
    if (!isAllowedBrowserPopupUrl(url)) {
      deps.warn(`[browser-pane] blocked unsupported webview popup url: ${url}`)
      return { action: "deny" }
    }
    if (shouldOpenPopupExternally({ disposition, externalBrowserModifierActive })) {
      void Promise.resolve(deps.openExternal(url)).catch((error: unknown) => {
        deps.warn("[browser-pane] failed to open webview popup externally", error)
      })
      return { action: "deny" }
    }
    if (deps.emit) deps.emit(BROWSER_OPEN_BROWSER_URL_CHANNEL, { url, disposition })
    else hostWebContents.send(BROWSER_OPEN_BROWSER_URL_CHANNEL, { url, disposition })
    return { action: "deny" }
  }
  guestContents.setWindowOpenHandler(onWindowOpen)
  return () => {
    guestContents.removeListener("before-input-event", onBeforeInput)
    // setWindowOpenHandler 无解绑 API;guest 销毁后 handler 自然失效。
  }
}
