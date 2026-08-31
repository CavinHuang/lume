/**
 * 浏览器面板状态中枢 —— ZCode 语义的 tab 模型 + 事件面 + attach/驻留/截图摆位编排。
 *
 * 语义来源:.zcode/analysis/zcode-browser-implementation-guide.md §4、
 * .zcode/analysis/zcode-browser-panel-architecture.md §3/§4、
 * .zcode/analysis/extracted/04-renderer-panel.source.js
 * (XTt webview 元素、Se/Ce attach/detach、hEt 截图 surface 校验、_Et 滚轮续接、
 *  崩溃自愈白名单 cF、xA/CEt responsive 视口)。
 *
 * tab 模型(Lume 描述符,替代旧 BrowserTabDescriptor):
 *   { tabId, workspaceKey, sessionId, residency, guestState, … }
 *   residency: resident → suspend-pending → suspended → restoring → resident
 *   guestState: unmounted → mounting → attached;不可自愈崩溃 → crashed
 *
 * 语义偏差(ZCode 面板语义在 Lume 的落法,均为设计文档 §1 R4 允许的简化):
 *   1. webview 承载用 Lume 的浮置池(webview-pool.ts)而非文档内渲染;
 *      responsive 缩放折算出的 surfaceScale 经 pool.setSurfaceScale 供截图校验读取;
 *      桌面 zoom 补偿(VTt 分解)经 pool.setZoomCompensation 落在池内 webview 上。
 *   2. desktopZoomFactor 经 options 注入(缺省 1):Lume renderer 未暴露桌面 zoom
 *      档位(ZCode SEt 经宿主 API 读取),折算/分解公式在 browser-panel-logic.ts。
 *   3. agent 操作期间的用户 resize 弱提示(aEt)由 SidePane 的 useBrowserResizeWarning
 *      承载;此处保留 5s 操作横幅、per-tab operationUntil 与 resetsResizeBaseline 基线。
 *   4. currentTask 上报与 selected 同值(Lume 面板无 agent 任务关联)。
 *   5. main→renderer 事件经通用漏斗(listen),非裸 ipcRenderer(见 browser-view.ts 头部)。
 *   6. 最近关闭环 renderer 内存 8 条(browser-panel-logic.ts;不排除来源),重开换新
 *      tabId(ZCode §5);tab 重排为纯内存 Ade(不动 activeTabId)。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  BROWSER_WHEEL_BOUNDARY_CHANNEL,
  BrowserViewAttachGuestResult,
  browserViewAttachGuest,
  browserViewCloseTabFromRenderer,
  browserViewDetachGuest,
  browserViewEnsureResident,
  browserViewReportResidency,
  browserViewSuspendReady,
  browserViewUpdateViewport,
  onBrowserViewCloseTab,
  onBrowserViewOperation,
  onBrowserViewOpenBrowserUrl,
  onBrowserViewReady,
  onBrowserViewRestore,
  onBrowserViewScreenshotSurfacePrepare,
  onBrowserViewScreenshotSurfaceRelease,
  onBrowserViewSuspend,
  onBrowserViewVisibility,
  onBrowserViewViewportChanged,
  sendBrowserScreenshotSurfaceReady,
  type BrowserViewRestorePayload,
  type BrowserViewScreenshotSurfacePreparePayload,
  type BrowserWheelBoundaryPayload,
} from '@/lib/desktop-api/browser-view'
import { openExternal, writeClipboardText } from '@/lib/desktop-api/native'
import { buildElementPickerCancelScript, buildElementPickerStartScript, isElementPickerResult } from './element-picker'
import {
  decomposeDesktopZoom,
  IDENTITY_ZOOM_COMPENSATION,
  pushClosedTabRing,
  reorderedByIds,
  type ClosedTabEntry,
} from './browser-panel-logic'
import {
  addStoredBrowserTab,
  findStoredBrowserTab,
  patchStoredBrowserTab,
  readBrowserWorkspaceSnapshot,
  removeStoredBrowserTab,
  saveBrowserWorkspaceSnapshot,
} from './browser-workspace-state'
import { createBrowserWebviewPool, readGuestSurfaceSample, isViewportAligned, type BrowserWebviewElement, type BrowserWebviewPool } from './webview-pool'

/** agent 操作态横幅时长(ZCode 5s 操作窗)。 */
export const BROWSER_OPERATION_BANNER_MS = 5000

/** responsive 视口范围(ZCode ra:i8 = 320×320 ~ 3840×2160)。 */
export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const

/** 崩溃自愈白名单(ZCode cF:Set(['abnormal-exit','killed','crashed','oom','memory-eviction']))。 */
const RECOVERABLE_EXIT_REASONS = new Set(['abnormal-exit', 'killed', 'crashed', 'oom', 'memory-eviction'])

/** 截图 surface prepare 默认超时(ZCode Rae=3000)+ 校验截止宽限 1000(lEt)。 */
const SURFACE_PREPARE_DEFAULT_TIMEOUT_MS = 3000
const SURFACE_VERIFY_GRACE_MS = 1000
/** surfaceScale 收敛阈值(ZCode sEt=0.001)。 */
const SURFACE_SCALE_TOLERANCE = 0.001
/** surface 校验循环评估间隔(ZCode cEt=100ms 兜底)。 */
const SURFACE_VERIFY_INTERVAL_MS = 100

/** 面板 tab 驻留态(对齐 main 侧 BrowserResidency 的 renderer 视角)。 */
export type BrowserPanelResidency = 'resident' | 'suspend-pending' | 'suspended' | 'restoring'

/** 面板 tab guest 承载态。 */
export type BrowserPanelGuestState = 'unmounted' | 'mounting' | 'attached' | 'crashed'

/** Lume 面板 tab 描述符。 */
export interface BrowserPanelTab {
  tabId: string
  workspaceKey: string
  sessionId: string
  remoteSessionId?: string
  browserId: string
  browserGeneration: number
  /** agent 建(browser-view-ready)或用户开(open-browser-url/本地)。 */
  origin: 'agent' | 'user'
  residency: BrowserPanelResidency
  guestState: BrowserPanelGuestState
  title: string | null
  /** 最近页面 URL(驻留恢复的 restoreUrl 缓存)。 */
  url: string | null
  faviconUrl: string | null
  loading: boolean
  /** agent 操作横幅截止时间(Date.now 基准;0 表示无操作态)。 */
  operationUntil: number
  /** webview 重建代数(recoveryRequested/崩溃/显式导航重建 +1)。 */
  guestGeneration: number
  errorMessage: string | null
  /** 主帧加载失败错误码(证书判定 isCertificateErrorCode 用;成功加载清零)。 */
  loadErrorCode: number | null
  /** 不可自愈崩溃详情(LTt guest 失败卡;重建成功后清零)。 */
  guestFailure: { exitCode: number; reason: string } | null
  /** 导航历史状态(did-navigate/-in-page 时随 webview.canGoBack/Forward 刷新)。 */
  canGoBack?: boolean
  canGoForward?: boolean
}

/** responsive 视口(ZCode CEt:viewport 非空即 responsive 开启)。 */
export type BrowserResponsiveViewport = { width: number; height: number }

function makeTabId(): string {
  const cryptoRef = globalThis.crypto
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID()
  return `browser-tab-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

/** 地址栏 URL 归一化(旧实现 browser-url.ts 同语义:https 补全 + localhost 走 http)。 */
export function normalizeBrowserUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  if (/^(https?:\/\/|about:|data:|lume-browser-restore:)/i.test(trimmed)) return trimmed
  if (/^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1)(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`
  return `https://${trimmed}`
}

/** webview DOM 事件的载荷通道形态(ipc-message)。 */
type IpcMessageEvent = Event & { channel?: string; args?: unknown[] }
type FaviconEvent = Event & { favicons?: string[] }
type RenderProcessGoneEvent = Event & { details?: { exitCode?: number; reason?: string } }
type LoadErrorEvent = Event & { isMainFrame?: boolean; errorCode?: number; errorDescription?: string; validatedURL?: string }

export interface UseBrowserPanelResult {
  tabs: BrowserPanelTab[]
  selectedTabId: string | null
  selectedTab: BrowserPanelTab | null
  /** 最近关闭环(新→旧,最多 8 条;重开换新 id)。 */
  closedTabs: ClosedTabEntry[]
  panelVisible: boolean
  /** agent 操作横幅可见(面板级 5s 窗口,任一 tab 操作即亮)。 */
  operationActive: boolean
  /** agent 视口(responsive)状态;null 即非 responsive。 */
  responsiveViewport: BrowserResponsiveViewport | null
  /** responsive 视觉缩放('fit' 随画布自适应)。 */
  responsiveZoom: 'fit' | number
  /** 当前生效的视觉缩放(fit 折算后),SidePane 用于画布尺寸与 transform。 */
  visualZoom: number
  resizeBaselineVersion: number
  /** 截图定影进行中(隐藏错误卡/空态,横幅让位)。 */
  surfaceStaging: boolean
  /** present 目标(RefObject<T>.current 即 T|null,可直接挂 JSX ref)。 */
  canvasRef: RefObject<HTMLDivElement>
  /** responsive 滚动容器(wheel 边界续接目标)。 */
  scrollContainerRef: RefObject<HTMLDivElement>
  /** responsive 画布尺寸(fit 缩放依据)。 */
  canvasSize: { width: number; height: number }
  selectTab: (tabId: string) => void
  openUrlTab: (url: string) => void
  closeTab: (tabId: string) => void
  /** 按新顺序重排 tab(ZCode Ade:不改动选中)。 */
  reorderTabs: (orderedIds: readonly string[]) => void
  /** 重开最近关闭条目(换新 tabId;成功后移出环)。 */
  reopenClosedTab: (entryId: string) => void
  /** 重建 guest(不可自愈崩溃卡的恢复动作;guestGeneration+1)。 */
  rebuildTab: (tabId: string) => void
  navigate: (tabId: string, url: string) => void
  goBack: (tabId: string) => void
  goForward: (tabId: string) => void
  reload: (tabId: string) => void
  openDevTools: (tabId: string) => void
  openExternalUrl: (url: string) => void
  toggleResponsiveMode: () => void
  setResponsiveZoom: (zoom: 'fit' | number) => void
  applyResponsiveViewportSize: (viewport: BrowserResponsiveViewport) => void
  wakeSuspendedTab: (tabId: string) => void
  /** 元素选取器(ZCode elementPicker.start/cancel):选取结果写剪贴板。 */
  elementPickerActive: boolean
  toggleElementPicker: (tabId: string) => Promise<void>
}

export interface UseBrowserPanelOptions {
  /** 用户 tab(open-browser-url/地址栏)缺省作用域;集成者传工作区身份。 */
  workspaceKey?: string
  sessionId?: string
  /**
   * 桌面 zoom 因子(ZCode SEt,1.1^clamp(level,-3,5) 折算后的值)。
   * Lume renderer 未暴露宿主 zoom 档位,集成者可注入,缺省 1(恒等)。
   */
  desktopZoomFactor?: number
}

/**
 * 面板主 hook:创建 webview 池、订阅全部 `lume:browser-view-*` 事件、
 * 驱动 attach/驻留上报/截图摆位/滚轮续接/崩溃自愈。一个面板实例调用一次。
 *
 * 工作区维度:tabs 按传入 workspaceKey 分桶(ZCode Ed/Dd 语义,见
 * browser-workspace-state.ts)——面板 React 态只装当前工作区的 tab,切换工作区时
 * 旧 key 落库、新 key 恢复;后台工作区的 tab 由 main 事件按 tabId 路由进仓库。
 */
export function useBrowserPanel(options: UseBrowserPanelOptions = {}): UseBrowserPanelResult {
  const workspaceKey = options.workspaceKey ?? 'default'
  const defaultScopeRef = useRef({
    sessionId: options.sessionId ?? 'user',
  })
  /** 桌面 zoom 因子(非法值归一为 1;原始值直接进 deps,保证档位变化即重算)。 */
  const desktopZoomFactor = Number.isFinite(options.desktopZoomFactor) && (options.desktopZoomFactor ?? 1) > 0
    ? options.desktopZoomFactor ?? 1
    : 1
  /** 当前装在面板 React 态里的工作区 key(save-on-switch 的落库键)。 */
  const workspaceKeyRef = useRef(workspaceKey)
  const pool = useMemo<BrowserWebviewPool>(() => createBrowserWebviewPool(), [])
  const [tabs, setTabs] = useState<BrowserPanelTab[]>([])
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null)
  const [closedTabs, setClosedTabs] = useState<ClosedTabEntry[]>([])
  const [panelVisible, setPanelVisible] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  /** 面板级操作横幅截止(ZCode kde:操作事件即写 Date.now()+5s,与选中无关)。 */
  const [lastOperationUntil, setLastOperationUntil] = useState(0)
  const [viewportByTab, setViewportByTab] = useState<Record<string, BrowserResponsiveViewport | undefined>>({})
  const [responsiveZoom, setResponsiveZoom] = useState<'fit' | number>('fit')
  const [resizeBaselineVersion, setResizeBaselineVersion] = useState(0)
  const [surfaceRequest, setSurfaceRequest] = useState<BrowserViewScreenshotSurfacePreparePayload | null>(null)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const tabsRef = useRef<BrowserPanelTab[]>([])
  tabsRef.current = tabs
  const selectedTabIdRef = useRef<string | null>(null)
  selectedTabIdRef.current = selectedTabId
  const panelVisibleRef = useRef(panelVisible)
  panelVisibleRef.current = panelVisible
  const closedTabsRef = useRef<ClosedTabEntry[]>([])
  closedTabsRef.current = closedTabs

  /** attach scope 指纹去重(ZCode Se:同指纹不重复提交)。 */
  const attachFingerprintRef = useRef(new Map<string, string>())
  /** 恢复代数(restore 事件下发,attach 时回传 residencyGeneration)。 */
  const residencyGenerationRef = useRef(new Map<string, number>())
  /** dom-ready 后待真实导航的 URL(ZCode W.current:webview 未就绪时的挂起导航)。 */
  const pendingNavigationRef = useRef(new Map<string, string>())
  /** 崩溃自愈在途标记(防重入,ZCode he.current)。 */
  const crashRecoveringRef = useRef(new Set<string>())
  /** surface 校验循环句柄。 */
  const surfaceVerifyRef = useRef<{ tabId: string; requestId: string; timer: number } | null>(null)
  /** 当前摆位请求(release 比对用;与 state 同步维护)。 */
  const surfaceRequestRef = useRef<BrowserViewScreenshotSurfacePreparePayload | null>(null)

  const patchTab = useCallback((tabId: string, patch: Partial<BrowserPanelTab>) => {
    setTabs((current) => current.map((tab) => (tab.tabId === tabId ? { ...tab, ...patch } : tab)))
    // 后台工作区 bucket 路由:挂起/恢复/标题/favicons/url 等事件只带 tabId。
    patchStoredBrowserTab(tabId, patch)
  }, [])

  /* ── attach(ZCode Se)+ detach(ZCode Ce)──────────────────────────── */

  const detachGuest = useCallback(async (tabId: string): Promise<boolean> => {
    const fingerprint = attachFingerprintRef.current.get(tabId)
    if (!fingerprint) return true
    const webview = pool.getGuest(tabId)
    let webContentsId = 0
    try {
      webContentsId = webview?.getWebContentsId() ?? 0
    } catch {
      webContentsId = 0
    }
    if (!webContentsId) return true
    try {
      const confirmed = await browserViewDetachGuest({ key: tabId, webContentsId })
      if (!confirmed) return false
    } catch {
      return false
    }
    return true
  }, [pool])

  /** webview 重建(换代):detach 确认 → 池销毁 → 以新代数重挂 + 重绑事件。 */
  const remountTab = useCallback((tabId: string, options: { url?: string | null } = {}) => {
    const tab = tabsRef.current.find((item) => item.tabId === tabId) ?? findStoredBrowserTab(tabId)
    if (!tab) return
    void (async () => {
      if (!(await detachGuest(tabId))) {
        // main 未确认 CDP 断开(ZCode Ce):取消重建,防 guest 串位。
        return
      }
      crashRecoveringRef.current.delete(tabId)
      attachFingerprintRef.current.delete(tabId)
      pendingNavigationRef.current.delete(tabId)
      pool.discardGuest(tabId)
      const restoreUrl = options.url ?? tab.url
      patchTab(tabId, { guestState: 'mounting', guestGeneration: tab.guestGeneration + 1, errorMessage: null, loadErrorCode: null, guestFailure: null, loading: Boolean(restoreUrl) })
      residencyGenerationRef.current.delete(tabId)
      const webview = await pool.ensureGuest(tabId, { restorePending: tab.residency === 'restoring' })
      bindTabEvents(tabId, webview)
      if (restoreUrl) pendingNavigationRef.current.set(tabId, restoreUrl)
    })()
  }, [detachGuest, patchTab, pool])

  const handleGuestReady = useCallback((tabId: string) => {
    // 当前列表优先,后台工作区 bucket 兜底(后台挂载的 webview 也要提交 attach)。
    const tab = tabsRef.current.find((item) => item.tabId === tabId) ?? findStoredBrowserTab(tabId)
    const webview = pool.getGuest(tabId)
    if (!tab || !webview) return
    let webContentsId = 0
    try {
      webContentsId = webview.getWebContentsId()
    } catch {
      webContentsId = 0
    }
    if (!Number.isSafeInteger(webContentsId) || webContentsId <= 0) return
    const active = selectedTabIdRef.current === tabId
    const residencyGeneration = residencyGenerationRef.current.get(tabId)
    // scope 指纹去重(ZCode Se):did-attach 与 dom-ready 双触发,同指纹不重复提交。
    const fingerprint = JSON.stringify({
      active,
      webContentsId,
      workspaceKey: tab.workspaceKey,
      remoteSessionId: tab.remoteSessionId ?? '',
      sessionId: tab.sessionId,
      residencyGeneration: residencyGeneration ?? null,
    })
    if (attachFingerprintRef.current.get(tabId) === fingerprint) return
    attachFingerprintRef.current.set(tabId, fingerprint)
    void browserViewAttachGuest({
      key: tabId,
      webContentsId,
      active,
      workspaceKey: tab.workspaceKey,
      remoteSessionId: tab.remoteSessionId,
      sessionId: tab.sessionId,
      ...(residencyGeneration === undefined ? {} : { residencyGeneration }),
    })
      .then((result: BrowserViewAttachGuestResult | undefined) => {
        if (result && !result.ok) {
          // main 拒绝:等待按 owner scope 重绑;recoveryRequested → 换代重建(ZCode Se)。
          if (result.recoveryRequested) {
            attachFingerprintRef.current.delete(tabId)
            remountTab(tabId)
          } else {
            attachFingerprintRef.current.delete(tabId)
          }
          return
        }
        patchTab(tabId, { guestState: 'attached' })
      })
      .catch(() => {
        attachFingerprintRef.current.delete(tabId)
      })
  }, [patchTab, pool, remountTab])

  /* ── webview 事件绑定(每次挂载/重挂后调用;池在销毁时自动清理) ─────── */

  const bindTabEvents = useCallback((tabId: string, webview: BrowserWebviewElement) => {
    pool.onGuestEvent(tabId, 'did-attach', () => handleGuestReady(tabId))
    pool.onGuestEvent(tabId, 'dom-ready', () => {
      handleGuestReady(tabId)
      // ZCode:真实导航在 dom-ready 后 loadURL(首挂 src 只是 about:blank/停靠页)。
      const pendingUrl = pendingNavigationRef.current.get(tabId)
      if (!pendingUrl) return
      pendingNavigationRef.current.delete(tabId)
      void webview.loadURL(pendingUrl).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('ERR_ABORTED')) return
        patchTab(tabId, { errorMessage: message, loadErrorCode: null, loading: false })
      })
    })
    pool.onGuestEvent(tabId, 'did-start-loading', () => patchTab(tabId, { loading: true, errorMessage: null, loadErrorCode: null }))
    pool.onGuestEvent(tabId, 'did-stop-loading', () => patchTab(tabId, { loading: false }))
    pool.onGuestEvent(tabId, 'did-navigate', () => patchTab(tabId, { url: safeUrl(webview), ...navigationState(webview) }))
    pool.onGuestEvent(tabId, 'did-navigate-in-page', () => patchTab(tabId, { url: safeUrl(webview), ...navigationState(webview) }))
    pool.onGuestEvent(tabId, 'page-title-updated', (event) => {
      patchTab(tabId, { title: (event as Event & { title?: string }).title || null })
    })
    pool.onGuestEvent(tabId, 'page-favicon-updated', (event) => {
      const favicons = (event as FaviconEvent).favicons
      patchTab(tabId, { faviconUrl: favicons?.[0] ?? null })
    })
    pool.onGuestEvent(tabId, 'did-fail-load', (event) => {
      const details = event as LoadErrorEvent
      // 子 frame 失败与请求中断(-3)不展示(ZCode 同)。
      if (details.isMainFrame === false || details.errorCode === -3) return
      patchTab(tabId, {
        // 卡片标题按 isCertificateErrorCode(loadErrorCode) 分型,errorMessage 只存详情。
        errorMessage: details.errorDescription || String(details.errorCode ?? ''),
        loadErrorCode: typeof details.errorCode === 'number' ? details.errorCode : null,
        url: details.validatedURL || safeUrl(webview),
      })
    })
    pool.onGuestEvent(tabId, 'render-process-gone', (event) => {
      const details = (event as RenderProcessGoneEvent).details
      const reason = details?.reason ?? ''
      if (!RECOVERABLE_EXIT_REASONS.has(reason)) {
        // 不可自愈:guest 失败卡(LTt)承载,重试走 rebuildTab 换代重建。
        patchTab(tabId, {
          guestState: 'crashed',
          errorMessage: null,
          loadErrorCode: null,
          guestFailure: { exitCode: details?.exitCode ?? 0, reason },
          loading: false,
        })
        return
      }
      if (crashRecoveringRef.current.has(tabId)) return
      crashRecoveringRef.current.add(tabId)
      remountTab(tabId)
    })
    pool.onGuestEvent(tabId, 'ipc-message', (event) => {
      const message = event as IpcMessageEvent
      if (message.channel !== BROWSER_WHEEL_BOUNDARY_CHANNEL) return
      // guest 滚到底继续滚面板(ZCode _Et:responsive 画布 scrollBy 续接)。
      const payload = message.args?.[0] as BrowserWheelBoundaryPayload | undefined
      const deltaX = Number.isFinite(payload?.deltaX) ? Number(payload?.deltaX) : 0
      const deltaY = Number.isFinite(payload?.deltaY) ? Number(payload?.deltaY) : 0
      if (deltaX === 0 && deltaY === 0) return
      scrollContainerRef.current?.scrollBy({ behavior: 'auto', left: deltaX, top: deltaY })
    })
  }, [handleGuestReady, patchTab, pool, remountTab])

  /* ── 挂载 / 关闭 / 恢复编排 ─────────────────────────────────────────── */

  const mountTab = useCallback((tabId: string, options: { pendingUrl?: string | null } = {}) => {
    const tab = tabsRef.current.find((item) => item.tabId === tabId) ?? findStoredBrowserTab(tabId)
    if (!tab) return
    if (pool.hasGuest(tabId)) return
    void pool.ensureGuest(tabId, { restorePending: tab.residency === 'restoring' }).then((webview) => {
      bindTabEvents(tabId, webview)
      if (options.pendingUrl) pendingNavigationRef.current.set(tabId, options.pendingUrl)
      if (selectedTabIdRef.current === tabId && canvasRef.current) pool.present(tabId, canvasRef.current)
    })
  }, [bindTabEvents, pool])

  const createTab = useCallback((input: {
    tabId?: string
    workspaceKey: string
    sessionId: string
    remoteSessionId?: string
    browserId: string
    browserGeneration: number
    origin: 'agent' | 'user'
    url?: string | null
  }): string => {
    const tabId = input.tabId ?? makeTabId()
    const tab: BrowserPanelTab = {
      tabId,
      workspaceKey: input.workspaceKey,
      sessionId: input.sessionId,
      remoteSessionId: input.remoteSessionId,
      browserId: input.browserId,
      browserGeneration: input.browserGeneration,
      origin: input.origin,
      residency: 'resident',
      guestState: 'unmounted',
      title: null,
      url: input.url ?? null,
      faviconUrl: null,
      loading: false,
      operationUntil: 0,
      guestGeneration: 0,
      errorMessage: null,
      loadErrorCode: null,
      guestFailure: null,
      canGoBack: false,
      canGoForward: false,
    }
    if (input.workspaceKey !== workspaceKeyRef.current) {
      // 非当前工作区:落后台 bucket(ZCode ready→后台挂载),不进面板列表、不抢选中。
      addStoredBrowserTab(input.workspaceKey, tab)
      return tabId
    }
    setTabs((current) => (current.some((item) => item.tabId === tabId) ? current : [...current, tab]))
    // 同步维护 ref:同 tick 的 mountTab/编排需要立即读到该 tab。
    if (!tabsRef.current.some((item) => item.tabId === tabId)) {
      tabsRef.current = [...tabsRef.current, tab]
    }
    selectedTabIdRef.current = tabId
    setSelectedTabId(tabId)
    return tabId
  }, [])

  const removeTabLocally = useCallback((tabId: string) => {
    const closedSource = tabsRef.current.find((item) => item.tabId === tabId) ?? findStoredBrowserTab(tabId)
    if (closedSource && closedSource.origin !== 'agent') {
      // 最近关闭环(ZCode Xde=8):agent 持有的 browser-use tab 由主进程权威持有,
      // 不入用户重开环(ZCode:"browser-use 不入环")。
      setClosedTabs((current) => pushClosedTabRing(current, {
        id: makeTabId(),
        title: closedSource.title,
        url: closedSource.url,
        faviconUrl: closedSource.faviconUrl,
        closedAt: Date.now(),
      }))
    }
    const inCurrentList = tabsRef.current.some((item) => item.tabId === tabId)
    attachFingerprintRef.current.delete(tabId)
    residencyGenerationRef.current.delete(tabId)
    pendingNavigationRef.current.delete(tabId)
    pool.discardGuest(tabId)
    if (!inCurrentList) {
      // 后台工作区 bucket 的 tab:从仓库移除(main 权威关闭的幂等回声)。
      removeStoredBrowserTab(tabId)
      return
    }
    // 同步维护 ref,保证同 tick 内的后续编排读到最新表。
    tabsRef.current = tabsRef.current.filter((item) => item.tabId !== tabId)
    setTabs(tabsRef.current)
    if (selectedTabIdRef.current === tabId) {
      const fallback = tabsRef.current[tabsRef.current.length - 1]?.tabId ?? null
      selectedTabIdRef.current = fallback
      setSelectedTabId(fallback)
    }
  }, [pool])

  const closeTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((item) => item.tabId === tabId)
    if (!tab) return
    // main 权威关闭;成功后本地移除(main 亦会发 close-tab 事件,幂等)。
    void browserViewCloseTabFromRenderer({
      tabId,
      workspaceKey: tab.workspaceKey,
      sessionId: tab.sessionId,
      remoteSessionId: tab.remoteSessionId,
    })
      .then(() => removeTabLocally(tabId))
      .catch(() => undefined)
  }, [removeTabLocally])

  /** 按新顺序重排 tab(ZCode Ade:非全量排列忽略;不改动 activeTabId)。 */
  const reorderTabs = useCallback((orderedIds: readonly string[]) => {
    setTabs((current) => {
      const nextIds = reorderedByIds(current.map((tab) => tab.tabId), orderedIds)
      if (!nextIds) return current
      const byId = new Map(current.map((tab) => [tab.tabId, tab]))
      const next = nextIds
        .map((id) => byId.get(id))
        .filter((tab): tab is BrowserPanelTab => Boolean(tab))
      return next.length === current.length && next.every((tab, index) => tab === current[index]) ? current : next
    })
  }, [])

  /** 重开最近关闭条目:换新 tabId 建用户 tab 并导航到原 URL(ZCode §5)。 */
  const reopenClosedTab = useCallback((entryId: string) => {
    const entry = closedTabsRef.current.find((item) => item.id === entryId)
    if (!entry) return
    setClosedTabs((current) => current.filter((item) => item.id !== entryId))
    const normalized = entry.url ? normalizeBrowserUrl(entry.url) : ''
    const tabId = createTab({
      workspaceKey: workspaceKeyRef.current,
      sessionId: defaultScopeRef.current.sessionId,
      browserId: 'unclaimed-iab',
      browserGeneration: 0,
      origin: 'user',
      url: normalized || null,
    })
    mountTab(tabId, normalized ? { pendingUrl: normalized } : {})
  }, [createTab, mountTab])

  /** 不可自愈崩溃卡的恢复:换代重建 guest(成功后 guestFailure 随 remount 清零)。 */
  const rebuildTab = useCallback((tabId: string) => {
    remountTab(tabId)
  }, [remountTab])

  /** 挂起 tab 复活请求:main 权威翻转 residency 后走 restore 重建(失败仅 warn,ZCode 同款)。 */
  const ensureResidentFor = useCallback((tab: BrowserPanelTab) => {
    void browserViewEnsureResident({
      tabId: tab.tabId,
      workspaceKey: tab.workspaceKey,
      sessionId: tab.sessionId,
      remoteSessionId: tab.remoteSessionId,
    }).catch((error: unknown) => {
      console.warn('[browser] ensureResident failed for tab', tab.tabId, error)
    })
  }, [])

  const wakeSuspendedTab = useCallback((tabId: string) => {
    const tab = tabsRef.current.find((item) => item.tabId === tabId)
    if (tab) ensureResidentFor(tab)
  }, [ensureResidentFor])

  // 元素选取器(ZCode MTt 控制器:代数守卫 + start/cancel 脚本;结果写剪贴板)。
  const [elementPickerActive, setElementPickerActive] = useState(false)
  const elementPickerGenerationRef = useRef(0)
  const toggleElementPicker = useCallback(async (tabId: string) => {
    const webview = pool.getGuest(tabId)
    if (!webview) return
    const generation = ++elementPickerGenerationRef.current
    if (elementPickerActive) {
      setElementPickerActive(false)
      try { await webview.executeJavaScript(buildElementPickerCancelScript(), true) } catch { /* webview 已销毁 */ }
      return
    }
    setElementPickerActive(true)
    try {
      const result = await webview.executeJavaScript(buildElementPickerStartScript(), true)
      if (elementPickerGenerationRef.current !== generation) return
      setElementPickerActive(false)
      if (!isElementPickerResult(result) || result.status !== 'selected' || !result.element) return
      const element = result.element
      const block = [
        `选择器: \`${element.selector}\``,
        element.text ? `文本: ${element.text}` : '',
        `位置: ${Math.round(element.rect.x)},${Math.round(element.rect.y)} ${Math.round(element.rect.width)}×${Math.round(element.rect.height)}`,
        '',
        '```html',
        element.outerHTML,
        '```',
      ].filter(Boolean).join('\n')
      await writeClipboardText(block).catch(() => undefined)
    } catch {
      if (elementPickerGenerationRef.current === generation) setElementPickerActive(false)
    }
  }, [elementPickerActive, pool])

  /* ── 工作区切换:旧 key 落库 + 新 key 恢复(ZCode save-on-switch/restore-on-switch)── */

  /** 把某工作区的快照装进面板 React 态(首挂恢复与切换恢复共用)。 */
  const applyWorkspaceSnapshot = useCallback((key: string) => {
    const restored = readBrowserWorkspaceSnapshot(key)
    // guest 活性对账:描述符称已挂载但池中无 guest(后台被摘/面板重挂)→ 回落 unmounted 壳;
    // residency 以仓库为准(挂起的恢复为挂起壳,等用户唤醒走 ensureResident)。
    const reconciled = restored.tabs.map((tab) => (
      (tab.guestState === 'attached' || tab.guestState === 'mounting') && !pool.hasGuest(tab.tabId)
        ? { ...tab, guestState: 'unmounted' as const, loading: false }
        : tab
    ))
    // 离场 tab 不在新列表:显式隐藏 guest(否则浮置 webview 残留在宿主层)。
    for (const tab of tabsRef.current) {
      if (!reconciled.some((item) => item.tabId === tab.tabId)) pool.hide(tab.tabId)
    }
    tabsRef.current = reconciled
    setTabs(reconciled)
    const activeTabId = restored.activeTabId && reconciled.some((tab) => tab.tabId === restored.activeTabId)
      ? restored.activeTabId
      : reconciled.at(-1)?.tabId ?? null
    selectedTabIdRef.current = activeTabId
    setSelectedTabId(activeTabId)
    setPanelVisible(!restored.collapsed)
    // 选中的 resident tab 若池中无 guest(面板重挂场景)→ 以缓存 URL 重挂;挂起壳等唤醒。
    const selected = reconciled.find((tab) => tab.tabId === activeTabId)
    if (selected && selected.residency !== 'suspended' && !pool.hasGuest(selected.tabId)) {
      mountTab(selected.tabId, { pendingUrl: selected.url && selected.url !== 'about:blank' ? selected.url : null })
    }
  }, [mountTab, pool])

  /** 首挂恢复(面板重挂不丢当前工作区态;ZCode Ad(key) 初始化同语义)。 */
  useEffect(() => {
    applyWorkspaceSnapshot(workspaceKeyRef.current)
  }, [applyWorkspaceSnapshot])

  /** 切换工作区:旧 key 落库(save)→ 新 key 装载(restore);纯内存,reload 即失。 */
  useEffect(() => {
    const previousKey = workspaceKeyRef.current
    if (previousKey === workspaceKey) return
    workspaceKeyRef.current = workspaceKey
    saveBrowserWorkspaceSnapshot(previousKey, {
      tabs: tabsRef.current,
      activeTabId: selectedTabIdRef.current,
      collapsed: !panelVisibleRef.current,
    })
    applyWorkspaceSnapshot(workspaceKey)
  }, [applyWorkspaceSnapshot, workspaceKey])

  /** 面板卸载再落一次(ZCode:切换 cleanup 落盘 + 卸载再落)。 */
  useEffect(() => () => {
    saveBrowserWorkspaceSnapshot(workspaceKeyRef.current, {
      tabs: tabsRef.current,
      activeTabId: selectedTabIdRef.current,
      collapsed: !panelVisibleRef.current,
    })
  }, [])

  /* ── main→renderer 事件面(订阅一次,handler 全部经 ref/useState updater)── */

  useEffect(() => {
    let disposed = false
    const unsubs: Array<() => void> = []

    void onBrowserViewReady((payload) => {
      if (disposed) return
      if (tabsRef.current.some((tab) => tab.tabId === payload.tabId)) return
      createTab({
        tabId: payload.tabId,
        workspaceKey: payload.workspaceKey,
        sessionId: payload.sessionId,
        remoteSessionId: payload.remoteSessionId,
        browserId: payload.browserId,
        browserGeneration: payload.browserGeneration,
        origin: 'agent',
      })
      // 请建 webview 壳(ZCode onOpenTabRequested → Ready);真实 URL 由后续 agent 命令驱动。
      mountTab(payload.tabId)
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewOperation((payload) => {
      // 面板级 5s 操作横幅(ZCode kde:操作事件即写,与选中 tab 无关)。
      setLastOperationUntil(Date.now() + BROWSER_OPERATION_BANNER_MS)
      if (!payload.tabId) return
      setTabs((current) => current.map((tab) => (tab.tabId === payload.tabId
        ? { ...tab, operationUntil: Date.now() + BROWSER_OPERATION_BANNER_MS }
        : tab)))
      // activateTab/newTab/viewport*/visibilitySet:重置 responsive resize 基线(ZCode z1)。
      if (payload.resetsResizeBaseline) setResizeBaselineVersion((version) => version + 1)
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewVisibility((payload) => {
      setPanelVisible(payload.visible)
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewViewportChanged((payload) => {
      if (!payload.tabId) return
      setViewportByTab((current) => ({ ...current, [payload.tabId as string]: payload.viewport ?? undefined }))
      if (payload.viewport) {
        // agent 设视口 → suppress resize 弱提示的基线重置(ZCode prepareForAgentViewportChange 简化)。
        setResizeBaselineVersion((version) => version + 1)
      }
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewScreenshotSurfacePrepare((payload) => {
      if (disposed) return
      // 身份匹配(ZCode OEt:workspaceKey+sessionId+browserId+browserGeneration+tabId);
      // 后台工作区 bucket 的 tab 也要能屏外定影(截图不依赖面板可见)。
      const tab = tabsRef.current.find((item) => item.tabId === payload.tabId) ?? findStoredBrowserTab(payload.tabId)
      if (!tab
        || tab.workspaceKey !== payload.workspaceKey
        || tab.sessionId !== payload.sessionId
        || tab.browserId !== payload.browserId
        || tab.browserGeneration !== payload.browserGeneration) return
      mountTab(payload.tabId)
      void pool.ensureGuest(payload.tabId).then((webview) => {
        if (disposed) return
        pool.stageOffscreen(payload.tabId, payload.viewport)
        surfaceRequestRef.current = payload
        setSurfaceRequest(payload)
        startSurfaceVerifyLoop(payload, webview)
      })
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewScreenshotSurfaceRelease((payload) => {
      if (disposed) return
      if (surfaceVerifyRef.current
        && surfaceVerifyRef.current.tabId === payload.tabId
        && surfaceVerifyRef.current.requestId === payload.requestId) {
        window.clearInterval(surfaceVerifyRef.current.timer)
        surfaceVerifyRef.current = null
      }
      if (surfaceRequestRef.current?.requestId === payload.requestId) {
        surfaceRequestRef.current = null
        setSurfaceRequest(null)
      }
      pool.releaseStaging(payload.tabId)
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewCloseTab((payload) => {
      removeTabLocally(payload.tabId)
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewSuspend((payload) => {
      // generation 校验(落后则忽略,ZCode 挂起协议)。
      const expected = residencyGenerationRef.current.get(payload.tabId)
      if (expected !== undefined && expected > payload.generation) return
      void (async () => {
        await detachGuest(payload.tabId).catch(() => false)
        pool.discardGuest(payload.tabId)
        attachFingerprintRef.current.delete(payload.tabId)
        pendingNavigationRef.current.delete(payload.tabId)
        patchTab(payload.tabId, { residency: 'suspended', guestState: 'unmounted', loading: false })
        // 空壳已就位 → ack(按 tabId+generation 匹配 waiter)。
        void browserViewSuspendReady({ tabId: payload.tabId, generation: payload.generation }).catch(() => undefined)
      })()
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewRestore((payload: BrowserViewRestorePayload) => {
      // 当前列表优先,后台工作区 bucket 兜底(未知 tab 丢弃,与旧 `if (!tab) return` 同)。
      const known = tabsRef.current.find((item) => item.tabId === payload.tabId) ?? findStoredBrowserTab(payload.tabId)
      if (!known) return
      residencyGenerationRef.current.set(payload.tabId, payload.generation)
      attachFingerprintRef.current.delete(payload.tabId)
      patchTab(payload.tabId, {
        residency: 'restoring',
        guestState: 'mounting',
        url: payload.restoreUrl ?? known.url,
      })
      void pool.ensureGuest(payload.tabId, { restorePending: true }).then((webview) => {
        bindTabEvents(payload.tabId, webview)
        if (selectedTabIdRef.current === payload.tabId && canvasRef.current) pool.present(payload.tabId, canvasRef.current)
      })
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    void onBrowserViewOpenBrowserUrl((payload) => {
      if (!payload.url) return
      // 弹窗转新面板 tab:本地创建用户 tab(作用域 = 当前工作区),真实导航在 dom-ready 后 loadURL。
      const tabId = createTab({
        workspaceKey: workspaceKeyRef.current,
        sessionId: defaultScopeRef.current.sessionId,
        browserId: 'unclaimed-iab',
        browserGeneration: 0,
        origin: 'user',
        url: payload.url,
      })
      mountTab(tabId, { pendingUrl: payload.url })
    }).then((unsub) => { if (disposed) unsub(); else unsubs.push(unsub) })

    return () => {
      disposed = true
      for (const unsub of unsubs) unsub()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createTab, detachGuest, mountTab, patchTab, pool, removeTabLocally, bindTabEvents])

  /* ── 截图 surface 校验循环(ZCode hEt:rAF 循环 + 2 次稳定采样 + 截止宽限) ── */

  const startSurfaceVerifyLoop = useCallback((request: BrowserViewScreenshotSurfacePreparePayload, webview: BrowserWebviewElement) => {
    if (surfaceVerifyRef.current) window.clearInterval(surfaceVerifyRef.current.timer)
    const timeoutMs = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : SURFACE_PREPARE_DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs + SURFACE_VERIFY_GRACE_MS
    let lastSample: { viewport: { width: number; height: number }; surfaceScale: number } | null = null
    let reported = false
    const timer = window.setInterval(() => {
      if (reported) return
      if (Date.now() >= deadline || pool.getGuest(request.tabId) !== webview) {
        window.clearInterval(timer)
        if (surfaceVerifyRef.current?.requestId === request.requestId) surfaceVerifyRef.current = null
        return
      }
      let webContentsId = 0
      try {
        webContentsId = webview.getWebContentsId()
      } catch {
        webContentsId = 0
      }
      if (webContentsId !== request.webContentsId) return
      const sample = readGuestSurfaceSample(webview)
      if (!isViewportAligned(sample.viewport, request.viewport)) {
        lastSample = null
        return
      }
      const stable = lastSample !== null
        && isViewportAligned(lastSample.viewport, sample.viewport)
        && Math.abs(lastSample.surfaceScale - sample.surfaceScale) <= SURFACE_SCALE_TOLERANCE
      lastSample = sample
      if (!stable) return
      reported = true
      window.clearInterval(timer)
      if (surfaceVerifyRef.current?.requestId === request.requestId) surfaceVerifyRef.current = null
      void sendBrowserScreenshotSurfaceReady({
        requestId: request.requestId,
        workspaceKey: request.workspaceKey,
        sessionId: request.sessionId,
        browserId: request.browserId,
        browserGeneration: request.browserGeneration,
        tabId: request.tabId,
        webContentsId: request.webContentsId,
        viewport: sample.viewport,
        surfaceScale: sample.surfaceScale,
        ...(request.windowId === undefined ? {} : { windowId: request.windowId }),
      }).catch(() => undefined)
    }, SURFACE_VERIFY_INTERVAL_MS)
    surfaceVerifyRef.current = { tabId: request.tabId, requestId: request.requestId, timer }
  }, [pool])

  /* ── 派生状态 ───────────────────────────────────────────────────────── */

  const selectedTab = useMemo(
    () => tabs.find((tab) => tab.tabId === selectedTabId) ?? null,
    [tabs, selectedTabId],
  )
  const responsiveViewport = selectedTabId ? viewportByTab[selectedTabId] ?? null : null
  const operationActive = lastOperationUntil > now
  const surfaceStaging = surfaceRequest?.tabId === selectedTabId

  /** 操作横幅倒计时(1s 步进即可)。 */
  useEffect(() => {
    if (lastOperationUntil <= Date.now() && !tabs.some((tab) => tab.operationUntil > Date.now())) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [lastOperationUntil, tabs])

  /** fit 缩放:画布尺寸观察(ZCode YTt 的 ResizeObserver;留 32px 边距)。 */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      setCanvasSize((current) => (current.width === Math.round(rect.width) && current.height === Math.round(rect.height)
        ? current
        : { width: Math.round(rect.width), height: Math.round(rect.height) }))
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  /** responsive 视觉缩放(ZCode zTt fit 公式:可用尺寸乘 desktopZoom)。 */
  const visualZoom = useMemo(() => {
    if (responsiveZoom !== 'fit') return responsiveZoom / 100
    if (!responsiveViewport || canvasSize.width <= 0 || canvasSize.height <= 0) return 1
    const availableWidth = Math.max(0, canvasSize.width - 32) * desktopZoomFactor
    const availableHeight = Math.max(0, canvasSize.height - 32) * desktopZoomFactor
    if (availableWidth === 0 || availableHeight === 0) return 1
    return Math.min(1, availableWidth / responsiveViewport.width, availableHeight / responsiveViewport.height)
  }, [canvasSize, desktopZoomFactor, responsiveViewport, responsiveZoom])

  /** surfaceScale 下发(池浮置方案的 ZCode [data-responsive-scale] 等价物;ZCode BTt:visualZoom/desktopZoom)。 */
  useEffect(() => {
    if (!selectedTabId || !responsiveViewport) return
    pool.setSurfaceScale(selectedTabId, visualZoom / desktopZoomFactor)
  }, [desktopZoomFactor, pool, responsiveViewport, selectedTabId, visualZoom])

  /** 桌面 zoom 补偿(ZCode XTt 的 VTt 分解;仅 responsive 画布需要,切选中/退出即复位)。 */
  useEffect(() => {
    if (!selectedTabId) return
    pool.setZoomCompensation(selectedTabId, responsiveViewport
      ? decomposeDesktopZoom(desktopZoomFactor)
      : IDENTITY_ZOOM_COMPENSATION)
  }, [desktopZoomFactor, pool, responsiveViewport, selectedTabId])

  /** present/hide 跟随选中与面板状态。 */
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.tabId === selectedTabId && panelVisible && canvasRef.current) {
        if (!surfaceStaging) pool.present(tab.tabId, canvasRef.current)
      } else if (!surfaceStaging || tab.tabId !== surfaceRequest?.tabId) {
        pool.hide(tab.tabId)
      }
    }
  }, [panelVisible, pool, selectedTabId, surfaceRequest?.tabId, surfaceStaging, tabs])

  /** 驻留上报(ZCode:每次状态变化 report;selected/visible/currentTask/loading/restoreUrl/title/favicon)。 */
  useEffect(() => {
    for (const tab of tabs) {
      const selected = tab.tabId === selectedTabId
      const visible = panelVisible && selected
      const restoreUrl = tab.url && tab.url !== 'about:blank' ? tab.url : null
      void browserViewReportResidency({
        tabId: tab.tabId,
        workspaceKey: tab.workspaceKey,
        sessionId: tab.sessionId,
        remoteSessionId: tab.remoteSessionId,
        selected,
        visible,
        currentTask: selected,
        loading: tab.loading,
        restoreUrl,
        title: tab.title,
        faviconUrl: tab.faviconUrl,
      }).catch(() => undefined)
    }
  }, [panelVisible, selectedTabId, tabs])

  /* ── 动作 ──────────────────────────────────────────────────────────── */

  const selectTab = useCallback((tabId: string) => {
    setSelectedTabId(tabId)
    // 激活挂起 tab 先请求复活(ZCode handleActivateSidePaneTab:ensureResident 失败仅
    // warn 仍激活;成功后 main restore 通道翻转 residency,占位卡随 residency 消失)。
    const tab = tabsRef.current.find((item) => item.tabId === tabId)
    if (tab && tab.residency === 'suspended') ensureResidentFor(tab)
  }, [ensureResidentFor])

  const openUrlTab = useCallback((url: string) => {
    const normalized = normalizeBrowserUrl(url)
    if (!normalized) return
    const tabId = createTab({
      workspaceKey: workspaceKeyRef.current,
      sessionId: defaultScopeRef.current.sessionId,
      browserId: 'unclaimed-iab',
      browserGeneration: 0,
      origin: 'user',
      url: normalized,
    })
    mountTab(tabId, { pendingUrl: normalized })
  }, [createTab, mountTab])

  const navigate = useCallback((tabId: string, url: string) => {
    const normalized = normalizeBrowserUrl(url)
    if (!normalized) return
    const webview = pool.getGuest(tabId)
    const tab = tabsRef.current.find((item) => item.tabId === tabId)
    if (!webview || !tab || tab.guestState !== 'attached') {
      pendingNavigationRef.current.set(tabId, normalized)
      if (tab && tab.guestState !== 'mounting') remountTab(tabId, { url: normalized })
      return
    }
    patchTab(tabId, { url: normalized, errorMessage: null, loadErrorCode: null })
    void webview.loadURL(normalized).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('ERR_ABORTED')) return
      patchTab(tabId, { errorMessage: message, loadErrorCode: null, loading: false })
    })
  }, [patchTab, pool, remountTab])

  const goBack = useCallback((tabId: string) => {
    const webview = pool.getGuest(tabId)
    if (!webview) return
    try { if (webview.canGoBack()) webview.goBack() } catch { /* webview 未就绪 */ }
  }, [pool])

  const goForward = useCallback((tabId: string) => {
    const webview = pool.getGuest(tabId)
    if (!webview) return
    try { if (webview.canGoForward()) webview.goForward() } catch { /* webview 未就绪 */ }
  }, [pool])

  const reload = useCallback((tabId: string) => {
    const webview = pool.getGuest(tabId)
    if (!webview) return
    try { webview.reload() } catch { /* webview 未就绪 */ }
  }, [pool])

  const openDevTools = useCallback((tabId: string) => {
    const webview = pool.getGuest(tabId)
    if (!webview) return
    try { webview.openDevTools() } catch { /* webview 未就绪 */ }
  }, [pool])

  const openExternalUrl = useCallback((url: string) => {
    if (/^https?:\/\//i.test(url)) void openExternal(url).catch(() => undefined)
  }, [])

  const toggleResponsiveMode = useCallback(() => {
    const tabId = selectedTabIdRef.current
    if (!tabId) return
    const next: BrowserResponsiveViewport | null = responsiveViewport ? null : { width: 393, height: 852 }
    setViewportByTab((current) => ({ ...current, [tabId]: next ?? undefined }))
    void browserViewUpdateViewport({ tabId, viewport: next }).catch(() => undefined)
  }, [responsiveViewport])

  const applyResponsiveViewportSize = useCallback((viewport: BrowserResponsiveViewport) => {
    const tabId = selectedTabIdRef.current
    if (!tabId) return
    const clamped: BrowserResponsiveViewport = {
      width: Math.min(BROWSER_VIEWPORT_LIMITS.maxWidth, Math.max(BROWSER_VIEWPORT_LIMITS.minWidth, Math.round(viewport.width))),
      height: Math.min(BROWSER_VIEWPORT_LIMITS.maxHeight, Math.max(BROWSER_VIEWPORT_LIMITS.minHeight, Math.round(viewport.height))),
    }
    setViewportByTab((current) => ({ ...current, [tabId]: clamped }))
    void browserViewUpdateViewport({ tabId, viewport: clamped }).catch(() => undefined)
  }, [])

  return {
    tabs,
    selectedTabId,
    selectedTab,
    closedTabs,
    panelVisible,
    operationActive,
    responsiveViewport,
    responsiveZoom,
    visualZoom,
    resizeBaselineVersion,
    surfaceStaging,
    canvasRef,
    scrollContainerRef,
    canvasSize,
    selectTab,
    openUrlTab,
    closeTab,
    reorderTabs,
    reopenClosedTab,
    rebuildTab,
    navigate,
    goBack,
    goForward,
    reload,
    openDevTools,
    openExternalUrl,
    toggleResponsiveMode,
    setResponsiveZoom,
    applyResponsiveViewportSize,
    wakeSuspendedTab,
    elementPickerActive,
    toggleElementPicker,
  }
}

/** 读取 webview 当前 URL(webview 未就绪回 about:blank)。 */
function safeUrl(webview: BrowserWebviewElement): string {
  try {
    return webview.getURL() || 'about:blank'
  } catch {
    return 'about:blank'
  }
}

/** 读取 webview 导航历史状态(webview 未就绪回空 patch,按钮保持禁用)。 */
function navigationState(webview: BrowserWebviewElement): Pick<BrowserPanelTab, 'canGoBack' | 'canGoForward'> {
  try {
    return { canGoBack: webview.canGoBack(), canGoForward: webview.canGoForward() }
  } catch {
    return {}
  }
}
