/**
 * 浏览器 webview 池 —— 面板 tab 的 `<webview>` 承载层(命令式,React 之外)。
 *
 * 沿用旧实现(BrowserWebviewPool.tsx,053e4d306^)的定位思路:webview 装在
 * `position:fixed` 的宿主层里,经 rAF+ResizeObserver 贴合 React 布局里的目标矩形
 * (present),从而脱离 React 重渲染/重挂载。按 ZCode 面板语义简化并扩展:
 *  - guest 创建走 ZCode 形状:`<webview partition="persist:lume-browser" allowpopups
 *    nodeintegrationinsubframes src=about:blank>`;恢复期以
 *    `lume-browser-restore://pending` 作首 src,真实导航在 dom-ready 后 loadURL
 *    (useBrowserPanel 驱动);
 *  - 截图表面屏外定影(TEt 语义):stageOffscreen 把 wrapper 固定到视口左上角
 *    (width=viewport.width, height=viewport.height+48 工具栏行高,opacity .001,
 *    pointer-events:none),releaseStaging 恢复;
 *  - present/ensure/discard 语义对齐旧池;recover(换代重建)由 useBrowserPanel 以
 *    discard+ensureGuest 组合实现(webview 重建必先经 main 确认 detach)。
 *
 * 语义偏差(相对 ZCode XTt 的文档内 webview):
 *  - ZCode 的 webview 直接渲染在 responsive 画布 DOM 内(transform 缩放就地生效);
 *    本池沿用 Lume 的宿主层浮置方案,画布只出目标矩形,surfaceScale 由面板经
 *    `setSurfaceScale` 写入 wrapper 的 `data-browser-surface-scale`,供截图校验循环读取。
 *  - 桌面 zoom 补偿(ZCode XTt 的 VTt 分解)落在池内 webview 元素上:面板经
 *    `setZoomCompensation` 写入,池把 webview 撑到 100%*layoutScale 再 scale(transformScale)
 *    (origin 左上);截图定影期间清除补偿保持 1:1 采样,releaseStaging 时恢复。
 */
import { IDENTITY_ZOOM_COMPENSATION, type BrowserZoomCompensation } from './browser-panel-logic'

/** 旧池宿主层 id(pointer-events-none fixed inset-0,位于应用覆盖层之上)。 */
const BROWSER_GUEST_HOST_ID = 'lume-browser-webview-pool'

/** 截图定影容器高出的工具栏行高(ZCode/架构文档 §19:"+48px 截图容器高度"硬编码耦合)。 */
export const BROWSER_SURFACE_TOOLBAR_ALLOWANCE_PX = 48

/** webview 元素类型(Electron webview 标签的面板侧可用面)。 */
export type BrowserWebviewElement = HTMLElement & {
  src: string
  getWebviewPartition?(): string
  getWebContentsId(): number
  loadURL(url: string): Promise<void>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  openDevTools(): void
  isCrashed(): boolean
  setZoomFactor(factor: number): void
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

/** guest 挂载记录。 */
interface GuestEntry {
  tabId: string
  wrapper: HTMLDivElement
  webview: BrowserWebviewElement
  generation: number
  stopPositioning?: () => void
  target?: HTMLElement
  staged: boolean
  zoomCompensation: BrowserZoomCompensation
}

/** 池宿主层(带 pending 挂载表,复用旧池"跨 React 挂载点共享"思路)。 */
type BrowserGuestHost = HTMLDivElement & { lumeBrowserPendingMounts?: Map<string, Promise<BrowserWebviewElement>> }

export interface BrowserGuestCreateOptions {
  /** 恢复期首 src(lume-browser-restore://pending);缺省 about:blank。 */
  restorePending?: boolean
  /** webview 分区,缺省 persist:lume-browser。 */
  partition?: string
}

export type BrowserGuestEventListener = (event: Event) => void

export interface BrowserWebviewPool {
  /** 把 tab 的 webview 贴合到目标矩形(present)。 */
  present(tabId: string, target: HTMLElement): void
  /** 目标卸载时释放贴合(仅当当前 target 匹配)。 */
  release(tabId: string, target: HTMLElement): void
  /** 隐藏(选中切换/错误卡覆盖时不销毁 guest)。 */
  hide(tabId: string): void
  /** 取 guest webview(未挂载返回 undefined)。 */
  getGuest(tabId: string): BrowserWebviewElement | undefined
  /** 是否存在(含挂载中)。 */
  hasGuest(tabId: string): boolean
  /** 幂等创建 guest;并发调用共享同一挂载 Promise(旧池 mounts 语义)。 */
  ensureGuest(tabId: string, options?: BrowserGuestCreateOptions): Promise<BrowserWebviewElement>
  /** 销毁 guest(调用方必须先经 browserViewDetachGuest 确认 main 放行)。 */
  discardGuest(tabId: string): void
  /** 截图屏外定影(TEt:fixed 0/0,viewport 宽,高 +48 工具栏,opacity .001)。 */
  stageOffscreen(tabId: string, viewport: { width: number; height: number }): void
  /** 结束定影,回到 present/hidden。 */
  releaseStaging(tabId: string): void
  /** 面板把当前 surfaceScale 写给校验循环(responsive zoom 补偿折算)。 */
  setSurfaceScale(tabId: string, scale: number): void
  /** 写入桌面 zoom 补偿(VTt 分解;恒等时清除)。 */
  setZoomCompensation(tabId: string, compensation: BrowserZoomCompensation): void
  /** 订阅 webview 生命周期事件;guest 销毁时自动解绑。 */
  onGuestEvent(tabId: string, type: string, listener: BrowserGuestEventListener): () => void
}

function getBrowserGuestHost(): BrowserGuestHost {
  const existing = document.getElementById(BROWSER_GUEST_HOST_ID)
  if (existing instanceof HTMLDivElement) return existing as BrowserGuestHost
  const host = document.createElement('div') as BrowserGuestHost
  host.id = BROWSER_GUEST_HOST_ID
  host.className = 'pointer-events-none fixed inset-0 z-[61] overflow-hidden'
  document.body.append(host)
  return host
}

function getPendingMounts(host: BrowserGuestHost) {
  return (host.lumeBrowserPendingMounts ??= new Map<string, Promise<BrowserWebviewElement>>())
}

/**
 * 创建 webview 池实例。一个面板一个池;宿主层按 id 全局共享(重复挂载两个面板时
 * 后者复用同一层,与旧池一致)。
 */
export function createBrowserWebviewPool(partition = 'persist:lume-browser'): BrowserWebviewPool {
  const host = getBrowserGuestHost()
  const entries = new Map<string, GuestEntry>()
  const guestListeners = new Map<string, Map<string, Set<BrowserGuestEventListener>>>()

  function stopPositioning(entry: GuestEntry) {
    entry.stopPositioning?.()
    entry.stopPositioning = undefined
    entry.target = undefined
  }

  function setEntryHidden(entry: GuestEntry) {
    entry.wrapper.style.visibility = 'hidden'
    entry.wrapper.style.pointerEvents = 'none'
  }

  /**
   * 桌面 zoom 补偿(ZCode XTt):transformScale !== 1 时 webview 以
   * `100% * layoutScale` 布局 + scale(transformScale)(origin 左上)渲染,
   * wrapper(overflow hidden,贴合画布矩形)负责裁剪;恒等时全部复位。
   */
  function applyZoomCompensation(entry: GuestEntry) {
    const { layoutScale, transformScale } = entry.zoomCompensation
    const webviewStyle = entry.webview.style
    delete entry.wrapper.dataset.browserLayoutScale
    delete entry.wrapper.dataset.browserTransformScale
    webviewStyle.position = ''
    webviewStyle.top = ''
    webviewStyle.left = ''
    webviewStyle.transform = ''
    webviewStyle.transformOrigin = ''
    webviewStyle.width = '100%'
    webviewStyle.height = '100%'
    if (transformScale === 1) return
    webviewStyle.position = 'absolute'
    webviewStyle.top = '0'
    webviewStyle.left = '0'
    webviewStyle.transform = `scale(${transformScale})`
    webviewStyle.transformOrigin = 'top left'
    webviewStyle.width = `${100 * layoutScale}%`
    webviewStyle.height = `${100 * layoutScale}%`
    entry.wrapper.dataset.browserLayoutScale = String(layoutScale)
    entry.wrapper.dataset.browserTransformScale = String(transformScale)
  }

  function emitGuestEvent(entry: GuestEntry, event: Event) {
    const byType = guestListeners.get(entry.tabId)
    if (!byType) return
    const listeners = byType.get(event.type)
    if (!listeners) return
    for (const listener of [...listeners]) listener(event)
  }

  function bindGuestEventRelay(entry: GuestEntry) {
    // 统一在 webview 上转发已订阅的事件类型;guest 销毁时随条目一并清理。
    const byType = guestListeners.get(entry.tabId)
    if (!byType) return
    for (const type of byType.keys()) bindSingle(entry, type)
  }

  const boundTypes = new Map<string, Set<string>>()

  function bindSingle(entry: GuestEntry, type: string) {
    const bound = boundTypes.get(entry.tabId) ?? new Set<string>()
    if (bound.has(type)) return
    bound.add(type)
    boundTypes.set(entry.tabId, bound)
    const relay = (event: Event) => {
      const current = entries.get(entry.tabId)
      if (current && current.webview === entry.webview) emitGuestEvent(entry, event)
    }
    entry.webview.addEventListener(type, relay)
  }

  /** 定位循环(旧池 positionAt:rAF 节流 + 目标与各级裁剪祖先的交矩形 + clipPath)。 */
  function positionAt(entry: GuestEntry, target: HTMLElement) {
    stopPositioning(entry)
    entry.target = target
    let frame = 0
    const update = () => {
      frame = 0
      if (entry.target !== target || !target.isConnected || entry.staged) {
        setEntryHidden(entry)
        return
      }
      const rect = target.getBoundingClientRect()
      let visibleTop = Math.max(0, rect.top)
      let visibleRight = Math.min(window.innerWidth, rect.right)
      let visibleBottom = Math.min(window.innerHeight, rect.bottom)
      let visibleLeft = Math.max(0, rect.left)
      for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor)
        const clipsX = style.overflowX !== 'visible'
        const clipsY = style.overflowY !== 'visible'
        if (!clipsX && !clipsY) continue
        const ancestorRect = ancestor.getBoundingClientRect()
        if (clipsX) {
          visibleLeft = Math.max(visibleLeft, ancestorRect.left)
          visibleRight = Math.min(visibleRight, ancestorRect.right)
        }
        if (clipsY) {
          visibleTop = Math.max(visibleTop, ancestorRect.top)
          visibleBottom = Math.min(visibleBottom, ancestorRect.bottom)
        }
      }
      if (rect.width <= 0 || rect.height <= 0 || visibleRight <= visibleLeft || visibleBottom <= visibleTop) {
        setEntryHidden(entry)
        return
      }
      entry.wrapper.style.visibility = 'visible'
      entry.wrapper.style.pointerEvents = 'auto'
      entry.wrapper.style.left = `${rect.left}px`
      entry.wrapper.style.top = `${rect.top}px`
      entry.wrapper.style.width = `${rect.width}px`
      entry.wrapper.style.height = `${rect.height}px`
      entry.wrapper.style.clipPath = `inset(${Math.max(0, visibleTop - rect.top)}px ${Math.max(0, rect.right - visibleRight)}px ${Math.max(0, rect.bottom - visibleBottom)}px ${Math.max(0, visibleLeft - rect.left)}px)`
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(target)
    for (let ancestor = target.parentElement; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    entry.stopPositioning = () => {
      if (frame) window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
    update()
  }

  const discardGuest = (tabId: string) => {
    const entry = entries.get(tabId)
    if (!entry) return
    stopPositioning(entry)
    boundTypes.delete(tabId)
    guestListeners.delete(tabId)
    entry.wrapper.remove()
    entries.delete(tabId)
  }

  const ensureGuest = (tabId: string, options: BrowserGuestCreateOptions = {}): Promise<BrowserWebviewElement> => {
    const existing = entries.get(tabId)
    if (existing) return Promise.resolve(existing.webview)
    const mounts = getPendingMounts(host)
    const pending = mounts.get(tabId)
    if (pending) return pending
    const mount = new Promise<BrowserWebviewElement>((resolve) => {
      const wrapper = document.createElement('div')
      wrapper.dataset.browserGuestTabId = tabId
      wrapper.dataset.browserGuestGeneration = '0'
      wrapper.dataset.browserGuestStaged = 'false'
      wrapper.dataset.browserSurfaceScale = '1'
      wrapper.dataset.browserLayoutScale = '1'
      wrapper.style.position = 'fixed'
      wrapper.style.visibility = 'hidden'
      wrapper.style.overflow = 'hidden'
      wrapper.style.pointerEvents = 'none'
      const webview = document.createElement('webview') as BrowserWebviewElement
      webview.setAttribute('partition', options.partition ?? partition)
      webview.setAttribute('allowpopups', '')
      webview.setAttribute('nodeintegrationinsubframes', 'true')
      webview.style.display = 'flex'
      webview.style.width = '100%'
      webview.style.height = '100%'
      webview.style.border = '0'
      webview.style.backgroundColor = '#fff'
      wrapper.append(webview)
      host.append(wrapper)
      // ZCode XTt:恢复期首 src = lume-browser-restore://pending,否则 about:blank;
      // 真实导航由面板在 dom-ready 后 loadURL 驱动。
      webview.setAttribute('src', options.restorePending ? 'lume-browser-restore://pending' : 'about:blank')
      const entry: GuestEntry = { tabId, wrapper, webview, generation: 0, staged: false, zoomCompensation: IDENTITY_ZOOM_COMPENSATION }
      entries.set(tabId, entry)
      bindGuestEventRelay(entry)
      resolve(webview)
    }).finally(() => mounts.delete(tabId))
    mounts.set(tabId, mount)
    return mount
  }

  return {
    present(tabId, target) {
      const entry = entries.get(tabId)
      if (!entry) return
      entry.staged = false
      entry.wrapper.dataset.browserGuestStaged = 'false'
      positionAt(entry, target)
    },
    release(tabId, target) {
      const entry = entries.get(tabId)
      if (!entry || entry.target !== target) return
      stopPositioning(entry)
      setEntryHidden(entry)
    },
    hide(tabId) {
      const entry = entries.get(tabId)
      if (!entry) return
      stopPositioning(entry)
      setEntryHidden(entry)
    },
    getGuest(tabId) {
      return entries.get(tabId)?.webview
    },
    hasGuest(tabId) {
      return entries.has(tabId) || getPendingMounts(host).has(tabId)
    },
    ensureGuest,
    discardGuest,
    stageOffscreen(tabId, viewport) {
      const entry = entries.get(tabId)
      if (!entry) return
      stopPositioning(entry)
      entry.staged = true
      entry.wrapper.dataset.browserGuestStaged = 'true'
      entry.wrapper.style.visibility = 'visible'
      entry.wrapper.style.left = '0px'
      entry.wrapper.style.top = '0px'
      entry.wrapper.style.width = `${viewport.width}px`
      entry.wrapper.style.height = `${viewport.height + BROWSER_SURFACE_TOOLBAR_ALLOWANCE_PX}px`
      entry.wrapper.style.clipPath = ''
      entry.wrapper.style.pointerEvents = 'none'
      entry.wrapper.style.opacity = '0.001'
      // 定影期清除 zoom 补偿变换,保证 guest 表面 1:1 对齐请求视口。
      entry.webview.style.transform = ''
      entry.webview.style.width = `${viewport.width}px`
      entry.webview.style.height = `${viewport.height}px`
    },
    releaseStaging(tabId) {
      const entry = entries.get(tabId)
      if (!entry || !entry.staged) return
      entry.staged = false
      entry.wrapper.dataset.browserGuestStaged = 'false'
      entry.wrapper.style.opacity = ''
      applyZoomCompensation(entry)
      if (entry.target && entry.target.isConnected) positionAt(entry, entry.target)
      else setEntryHidden(entry)
    },
    setSurfaceScale(tabId, scale) {
      const entry = entries.get(tabId)
      if (!entry) return
      entry.wrapper.dataset.browserSurfaceScale = String(scale)
    },
    setZoomCompensation(tabId, compensation) {
      const entry = entries.get(tabId)
      if (!entry) return
      entry.zoomCompensation = compensation
      // 截图定影期间不套补偿(保持 1:1 采样),releaseStaging 时恢复。
      if (!entry.staged) applyZoomCompensation(entry)
    },
    onGuestEvent(tabId, type, listener) {
      let byType = guestListeners.get(tabId)
      if (!byType) {
        byType = new Map()
        guestListeners.set(tabId, byType)
      }
      let listeners = byType.get(type)
      if (!listeners) {
        listeners = new Set()
        byType.set(type, listeners)
      }
      listeners.add(listener)
      const entry = entries.get(tabId)
      if (entry) bindSingle(entry, type)
      return () => {
        listeners?.delete(listener)
      }
    },
  }
}

/**
 * 截图表面稳定采样(ZCode hEt 校验循环的采样读数):
 *  - viewport 以 wrapper/webview 几何为准(与请求 ±1px 视为对齐,a8);
 *  - surfaceScale 读 wrapper 的 `data-browser-surface-scale`(见头部偏差)。
 */
export function readGuestSurfaceSample(
  webview: BrowserWebviewElement,
): { viewport: { width: number; height: number }; surfaceScale: number } {
  const wrapper = webview.parentElement
  const rect = webview.getBoundingClientRect()
  const surfaceScale = Number(wrapper?.dataset.browserSurfaceScale)
  return {
    viewport: { width: Math.round(rect.width), height: Math.round(rect.height) },
    surfaceScale: Number.isFinite(surfaceScale) && surfaceScale > 0 ? surfaceScale : 1,
  }
}

/** 视口 ±1px 对齐判定(ZCode a8 sameBrowserScreenshotViewport 容差)。 */
export function isViewportAligned(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1
}
