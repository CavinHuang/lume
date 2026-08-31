/**
 * 浏览器面板 IPC 封装 —— `lume:browser-view-*` 通道的 renderer 侧最小类型化包装。
 *
 * 全部走应用既有通用通道(desktop-runtime 的 invoke/listen 漏斗,经 sandbox preload
 * 的 `lume:invoke`/`lume:event:*` 白名单);不新增 preload 面。
 * 载荷形状按 ZCode(06-ipc-and-wiring.source.js E_e + 06 装配段 send 载荷)。
 *
 * 集成前提(见 apps/desktop/src/browser/ipc.ts 头部偏差 2):
 *  - invoke 型命令名需加入 `renderer-ipc-contract.ts` 的 ALLOWED_RENDERER_INVOKE_COMMANDS,
 *    并在 main dispatchCommand 把这些命令转发到 `BrowserIpc.handleRendererCommand`;
 *  - 事件型通道名需加入 ALLOWED_RENDERER_EVENT_CHANNELS(main 侧以
 *    `lume:event:<通道名>` send,preload listen 同名)。
 */
import { invoke } from '@/lib/desktop-runtime/core'
import { listen } from '@/lib/desktop-runtime/event'

/* ── 通道名(与 apps/desktop/src/browser/ipc.ts 单源对应) ─────────────── */

/** renderer→main invoke 通道名集合。 */
export const BrowserViewInvokeChannel = {
  attachGuest: 'lume:browser-view-attach-guest',
  detachGuest: 'lume:browser-view-detach-guest',
  updateViewport: 'lume:browser-view-update-viewport',
  clearData: 'lume:browser-view-clear-data',
  screenshotSurfaceReady: 'lume:browser-view-screenshot-surface-ready',
  closeTabFromRenderer: 'lume:browser-view-close-tab-from-renderer',
  reportResidency: 'lume:browser-view-report-residency',
  suspendReady: 'lume:browser-view-suspend-ready',
  ensureResident: 'lume:browser-view-ensure-resident',
  restoreTabs: 'lume:browser-view-restore-tabs',
} as const

/** main→renderer 事件通道名集合(listen 时经 preload 加 `lume:event:` 前缀)。 */
export const BrowserViewEventChannel = {
  ready: 'lume:browser-view-ready',
  operation: 'lume:browser-view-operation',
  visibility: 'lume:browser-view-visibility',
  viewportChanged: 'lume:browser-view-viewport-changed',
  screenshotSurfacePrepare: 'lume:browser-view-screenshot-surface-prepare',
  screenshotSurfaceRelease: 'lume:browser-view-screenshot-surface-release',
  closeTab: 'lume:browser-view-close-tab',
  suspend: 'lume:browser-view-suspend',
  restore: 'lume:browser-view-restore',
  openBrowserUrl: 'lume:open-browser-url',
} as const

/** guest → host 滚轮边界转发通道(guest preload sendToHost;webview ipc-message 匹配)。 */
export const BROWSER_WHEEL_BOUNDARY_CHANNEL = 'lume:browser-wheel-boundary'

/* ── renderer→main invoke 载荷(attach/detach/update/report/…) ─────────── */

/** attach-guest 入参(ZCode:`{key(tabId), webContentsId, active?, workspaceKey?, remoteSessionId?, sessionId?, residencyGeneration?}`)。 */
export interface BrowserViewAttachGuestInput {
  key: string
  webContentsId: number
  active?: boolean
  workspaceKey?: string
  remoteSessionId?: string
  sessionId?: string
  residencyGeneration?: number
}

/** attach-guest 结果(ZCode attachGuest 返回;undefined 视为 not-found)。 */
export interface BrowserViewAttachGuestResult {
  ok: boolean
  reason?: string
  recoveryRequested?: boolean
  guestGeneration?: number
}

/** close-tab-from-renderer 作用域(main 权威关闭,五元组)。 */
export interface BrowserViewTabScopeInput {
  tabId: string
  workspaceKey: string
  sessionId: string
  remoteSessionId?: string
}

/** report-residency 载荷(ZCode:`{selected, visible, currentTask, loading, restoreUrl, title, faviconUrl}` + 作用域)。 */
export interface BrowserViewResidencyReportInput extends BrowserViewTabScopeInput {
  selected: boolean
  visible: boolean
  currentTask: boolean
  loading: boolean
  restoreUrl: string | null
  title: string | null
  faviconUrl?: string | null
}

/** restore-tabs 查询(窗口重建拉 shell 列表)。 */
export interface BrowserViewRestoreTabsInput {
  workspaceKey: string
  remoteSessionId?: string
  sessionId?: string
}

/** suspend-ready ack(ZCode:`{tabId, generation}`)。 */
export interface BrowserViewSuspendReadyInput {
  tabId: string
  generation: number
}

/** update-viewport 载荷(ZCode:`{tabId, viewport|null}` responsive 同步)。 */
export interface BrowserViewUpdateViewportInput {
  tabId: string
  viewport: { width: number; height: number } | null
}

/** 截图表面摆位完成回报(ZCode 唯一 send 型:`{...request, surfaceScale, viewport}`)。 */
export interface BrowserScreenshotSurfaceReadyOutput {
  requestId: string
  workspaceKey: string
  sessionId: string
  browserId: string
  browserGeneration: number
  tabId: string
  webContentsId: number
  viewport: { width: number; height: number }
  surfaceScale: number
  /** Lume 偏差:main 侧协调器 handleReady 要求回显窗口 id;prepare 载荷未带时省略。 */
  windowId?: number
}

/* ── main→renderer 事件载荷(ZCode 06 装配段的 win.webContents.send 形状) ── */

/** browser-view-ready:请 renderer 创建 webview 壳。 */
export interface BrowserViewReadyPayload {
  workspaceKey: string
  remoteSessionId?: string
  sessionId: string
  tabId: string
  browserId: string
  browserGeneration: number
}

/** browser-view-operation:agent 操作前后通知(5s 操作态 + resize 基线重置标记)。 */
export interface BrowserViewOperationPayload {
  workspaceKey: string
  remoteSessionId?: string
  sessionId: string
  tabId: string | null
  browserId: string
  browserGeneration: number
  resetsResizeBaseline: boolean
}

/** browser-view-visibility:agent 侧显隐浏览器面板。 */
export interface BrowserViewVisibilityPayload {
  visible: boolean
  workspaceKey: string
  remoteSessionId?: string | null
  sessionId: string
  tabId?: string
  browserId: string
  browserGeneration: number
}

/** browser-view-viewport-changed:agent 设置/清除 tab 视口(responsive 画布跟随)。 */
export interface BrowserViewViewportChangedPayload {
  workspaceKey: string
  remoteSessionId?: string
  sessionId: string
  tabId: string | null
  browserId: string
  browserGeneration: number
  viewport: { width: number; height: number } | null
}

/** 截图表面摆位开始(与 core/screenshot-surface.ts 的 prepare 载荷一致)。 */
export interface BrowserViewScreenshotSurfacePreparePayload {
  requestId: string
  workspaceKey: string
  sessionId: string
  browserId: string
  browserGeneration: number
  tabId: string
  webContentsId: number
  viewport: { width: number; height: number }
  surfaceScaleMode?: 'current' | 'unscaled'
  timeoutMs: number
  /** Lume 偏差:renderer 需在 ready 里回显 windowId;main 未带时省略。 */
  windowId?: number
}

/** 截图表面摆位结束(renderer 恢复布局)。 */
export interface BrowserViewScreenshotSurfaceReleasePayload {
  requestId: string
  workspaceKey: string
  sessionId: string
  browserId: string
  browserGeneration: number
  tabId: string
  webContentsId: number
}

/** browser-view-close-tab:main 主导关闭。 */
export interface BrowserViewCloseTabPayload {
  tabId: string
  reason?: string
}

/** browser-view-suspend:请 renderer 卸载 webview(generation 竞态防护)。 */
export interface BrowserViewSuspendPayload {
  tabId: string
  generation: number
}

/** browser-view-restore:请 renderer 以 restore 停靠页重建 webview。 */
export interface BrowserViewRestorePayload {
  tabId: string
  /** 恢复代数:attach 时作为 residencyGeneration 回传,不匹配会被 main 拒绝。 */
  generation: number
  restoreUrl?: string | null
}

/** open-browser-url:弹窗拦截后请 renderer 开新面板 tab。 */
export interface BrowserOpenBrowserUrlPayload {
  url: string
  disposition: string
}

/** guest 滚轮边界载荷(guest preload 计算后的未消费 delta,px)。 */
export interface BrowserWheelBoundaryPayload {
  deltaX: number
  deltaY: number
}

/* ── invoke 封装 ──────────────────────────────────────────────────────── */

async function browserViewInvoke<T>(channel: string, payload?: unknown): Promise<T> {
  return invoke<T>(channel, payload)
}

/** webview 就绪,提交 guest(ZCode attach-guest;result.ok 为 false 且 recoveryRequested 时 renderer 需换代重建)。 */
export function browserViewAttachGuest(
  input: BrowserViewAttachGuestInput,
): Promise<BrowserViewAttachGuestResult | undefined> {
  return browserViewInvoke<BrowserViewAttachGuestResult | undefined>(BrowserViewInvokeChannel.attachGuest, input)
}

/** 销毁 webview 前请求脱管(main 确认 CDP 已断才返回 true 放行重建)。 */
export function browserViewDetachGuest(input: { key: string; webContentsId: number }): Promise<boolean> {
  return browserViewInvoke<boolean>(BrowserViewInvokeChannel.detachGuest, input)
}

/** renderer 侧关闭面板 tab(main 权威)。 */
export function browserViewCloseTabFromRenderer(scope: BrowserViewTabScopeInput): Promise<unknown> {
  return browserViewInvoke<unknown>(BrowserViewInvokeChannel.closeTabFromRenderer, scope)
}

/** 上报 tab 驻留运行态(状态变化即报,驱动 main 挂起/恢复决策)。 */
export function browserViewReportResidency(report: BrowserViewResidencyReportInput): Promise<void> {
  return browserViewInvoke<void>(BrowserViewInvokeChannel.reportResidency, report)
}

/** renderer 已卸载 webview 的 ack(按 tabId+generation 匹配 waiter)。 */
export function browserViewSuspendReady(input: BrowserViewSuspendReadyInput): Promise<void> {
  return browserViewInvoke<void>(BrowserViewInvokeChannel.suspendReady, input)
}

/** 用户请求复活挂起 tab。 */
export function browserViewEnsureResident(scope: BrowserViewTabScopeInput): Promise<void> {
  return browserViewInvoke<void>(BrowserViewInvokeChannel.ensureResident, scope)
}

/** 清除内嵌浏览器数据(mode 'cache' 仅缓存面;'all' 含 cookies/localStorage 登录态)。 */
export function browserViewClearEmbeddedBrowserData(mode: 'cache' | 'all'): Promise<{ success: boolean; error?: string }> {
  return browserViewInvoke<{ success: boolean; error?: string }>(BrowserViewInvokeChannel.clearData, mode)
}

/** 窗口重建时拉 shell 列表。 */
export function browserViewRestoreTabs(query: BrowserViewRestoreTabsInput): Promise<readonly unknown[]> {
  return browserViewInvoke<readonly unknown[]>(BrowserViewInvokeChannel.restoreTabs, query)
}

/** responsive 视口同步(viewport=null 退出 responsive)。 */
export function browserViewUpdateViewport(input: BrowserViewUpdateViewportInput): Promise<void> {
  return browserViewInvoke<void>(BrowserViewInvokeChannel.updateViewport, input)
}

/** 截图表面摆位完成回报(ZCode 唯一 send 型;经 invoke 漏斗适配,main 转 handleReady)。 */
export function sendBrowserScreenshotSurfaceReady(payload: BrowserScreenshotSurfaceReadyOutput): Promise<void> {
  return browserViewInvoke<void>(BrowserViewInvokeChannel.screenshotSurfaceReady, payload)
}

/* ── 事件订阅 ─────────────────────────────────────────────────────────── */

type Unsubscribe = () => void

function onBrowserViewEvent<T>(channel: string, listener: (payload: T) => void): Promise<Unsubscribe> {
  return listen<T>(channel, ({ payload }) => listener(payload))
}

/** 订阅 browser-view-ready(请建 webview 壳)。 */
export function onBrowserViewReady(listener: (payload: BrowserViewReadyPayload) => void): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.ready, listener)
}

/** 订阅 browser-view-operation(5s 操作态;resetsResizeBaseline 标记 resize 基线重置)。 */
export function onBrowserViewOperation(listener: (payload: BrowserViewOperationPayload) => void): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.operation, listener)
}

/** 订阅 browser-view-visibility(面板显隐)。 */
export function onBrowserViewVisibility(listener: (payload: BrowserViewVisibilityPayload) => void): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.visibility, listener)
}

/** 订阅 browser-view-viewport-changed(responsive 画布跟随模型视口)。 */
export function onBrowserViewViewportChanged(listener: (payload: BrowserViewViewportChangedPayload) => void): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.viewportChanged, listener)
}

/** 订阅截图表面摆位开始。 */
export function onBrowserViewScreenshotSurfacePrepare(
  listener: (payload: BrowserViewScreenshotSurfacePreparePayload) => void,
): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.screenshotSurfacePrepare, listener)
}

/** 订阅截图表面摆位结束。 */
export function onBrowserViewScreenshotSurfaceRelease(
  listener: (payload: BrowserViewScreenshotSurfaceReleasePayload) => void,
): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.screenshotSurfaceRelease, listener)
}

/** 订阅 main 主导的关 tab。 */
export function onBrowserViewCloseTab(listener: (payload: BrowserViewCloseTabPayload) => void): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.closeTab, listener)
}

/** 订阅挂起指令(renderer 卸载 webview 后须 ack suspend-ready)。 */
export function onBrowserViewSuspend(listener: (payload: BrowserViewSuspendPayload) => void): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.suspend, listener)
}

/** 订阅恢复指令(以 lume-browser-restore://pending 重建 webview)。 */
export function onBrowserViewRestore(listener: (payload: BrowserViewRestorePayload) => void): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.restore, listener)
}

/** 订阅弹窗转新 tab(setWindowOpenHandler 拦截回传)。 */
export function onBrowserViewOpenBrowserUrl(listener: (payload: BrowserOpenBrowserUrlPayload) => void): Promise<Unsubscribe> {
  return onBrowserViewEvent(BrowserViewEventChannel.openBrowserUrl, listener)
}
