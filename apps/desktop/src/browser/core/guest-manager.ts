/**
 * BrowserGuestManager —— 内嵌浏览器来宾 webContents / tab 核心管理器(Lume 移植版)。
 *
 * 来源:
 *   - ZCode 反混淆重建源码 `D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\01-browser-guest-manager.source.js`
 *     (原 bundle: out/main/index.js 字节偏移 919612–994500 模块体 + 1452839–1456500 装配点)
 *   - 移植规范: apps/desktop/src/browser/PORTING.md
 *   - 契约: ./core/types.ts(不得修改)
 *
 * ZCode 原名对照(s(X,"name") keep-names 标注核实):
 *   Kg  → BrowserGuestManager(本类)
 *   Gg  → BrowserTabResidencyCoordinator(改为构造注入端口,实现在 core/residency.ts)
 *   kM  → STALE_BINDING_RECOVERY_HINT      Sle → DEFAULT_ATTACH_TIMEOUT_MS(10000)
 *   Cle → GUEST_CDP_IDLE_TIMEOUT_MS(1000)  Ile → RECORDING_ARTIFACT_CLEANUP_DELAY_MS(3600s)
 *   OH  → DEFAULT_NATURAL_VIEWPORT(800x600) DH → RECORDING_VIEWPORT(1280x720)
 *   BH  → normalizeDesktopZoomMetricsScale  bM → buildViewportMetricsOverride
 *   at  → scopeKey(types.ts 同名导出)       vt → sameScope(types.ts 同名导出)
 *   $H  → normalizeLegacyContext            Rle → suspendAckKey
 *   Ele → toRestoredShell                   _M → isSideEffecting
 *   vle/sr → abortError                     Hg → throwIfAborted
 *   AH  → recordBrowserVideo(前序模块辅助,runRecording 依赖,随本文件移植)
 *   Tle → linkAbortSignal                   PM → waitForPromiseWithSignal
 *   Cr  → waitForDelay                      Ale → waitForCondition
 *   SM  → readScreenshotSurfaceInvalidation NH → raceBackendExecution
 *   LH  → isBrowserViewportSize             UH → isBrowserPointValue
 *   xle → normalizeBackgroundViewport       Mle → isScreenshotCommand
 *   CM  → assertViewportOverride            Ole → normalizeDialogType
 *   Dle → sanitizeBrowserMetaUrl            Fe → safeStr
 *   ot  → safeBool                          ui → normalizePlaywrightTimeout(executor 同款)
 *   fr  → VIEWPORT_LIMITS(共享视口边界常量, PortingGap)
 *   jg  → executeBrowserCommandOnView(A4/A5 注入端口 CommandExecutor)
 *   ca  → executeIabPlaywrightLocator(A4 注入端口 IabPlaywrightLocatorExecutor)
 *   pi  → randomUUID   Ple → webContents   MH → rm   yle → stat   wle → join   _le → tmpdir
 *   Ij  → buildBrowserViewCloseTabNotification(载荷近似, 见偏差 1)
 *   zM/z1 → resolveBrowserOperationTabId / browserOperationResetsResizeBaseline(归 A7 ipc 层)
 *
 * 语义偏差(应仅剩命名/平台前缀, 以下为显式记录):
 *  1. 事件通道:ZCode 经 BrowserWindow.webContents.send(I.BrowserView*) 直发渲染进程;
 *     Lume 统一改为 deps.emit({method:"lume:browser-view-*", params}),频道名见
 *     BROWSER_VIEW_CHANNELS。close-tab 载荷以五元组 + tabId 近似(ZCode Ij 原实现
 *     在外部装配模块,提取域内不可见)。
 *  2. 常驻协调器 Gg 改为注入端口 BrowserTabResidencyCoordinatorPort;挂起/恢复/常驻
 *     变更/孤儿回收回调缺省实现为 deps.emit 对应频道(suspend/restore/close-tab),
 *     因此 ZCode "无 onRestoreTabRequested 时回退 onOpenTabRequested" 的分支由缺省
 *     emit(restore) 覆盖,不再回退 ready。
 *  3. residencyOptions.now/warn/recording.now 并入 deps.now/deps.warn/deps.now。
 *  4. 命令载荷按还原源码为平铺形状(BrowserGuestCommand);shared 协议 zod 集成时映射。
 *  5. setupDialogTracking 在维护 pendingDialogs 之外追加 onDialogOpening/onDialogClosed
 *     钩子(A6 EmbeddedBrowserJavaScriptDialogController 接线)。
 *  6. suspendFlights / suspendAckWaiters 的写入端在原 bundle 位于提取域外的挂起发起
 *     装配段;本文件以 suspendTabForIdle/runSuspendFlight 补齐(suspend-scheduler 驱动),
 *     读取/清理/等待语义与还原源码一致。
 *  7. render-process-gone 回调读 details.reason(ZCode 原码 i[1]?.reason 与
 *     Electron 42 的 WebContents 签名 (event, details) 一致)。
 */

import { randomUUID } from "crypto"
import { rm, stat } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import type {
  Event as ElectronEvent,
  NavigationEntry,
  WebContents,
} from "electron"
import {
  sameScope,
  scopeKey,
} from "./types"
import type {
  BrowserCommandResult,
  BrowserDialogInfo,
  BrowserDownloadRecord,
  BrowserLifecycle,
  BrowserManagerDeps,
  BrowserOwnerContext,
  BrowserRecordingRecord,
  BrowserResidency,
  BrowserResultMeta,
  BrowserTabRecord,
  BrowserViewportOverride,
  ControlledView,
  RecordingRecorder,
  RecordingRecorderOptions,
  ScreenshotSurfaceLease,
} from "./types"

/* 本模块错误均以 {code,message} 结果对象表达(错误码 ⊆ BROWSER_ERROR_CODES),
 * 不抛 coded Error —— 与还原源码一致, 故不使用 browserError/BrowserNavigationTimeoutError。 */

/* ════════════════════════════════════════════════════════════════════
 * PortingGap —— types.ts 契约之外、本文件内声明的结构性类型。
 * 集成者如需上移到共享契约, 请保持字段名不变。
 * ════════════════════════════════════════════════════════════════════ */

/**
 * PortingGap: 内部 tab 记录 = 契约 BrowserTabRecord 去除管理器级集合
 * (downloads/downloadWaiters/queuedDownloads 在还原源码中是管理器级 Map/Set,
 *  不在 record 上), 并补充运行时清理句柄与恢复存储标记。
 */
export type GuestTabRecord = Omit<
  BrowserTabRecord,
  "downloads" | "downloadWaiters" | "queuedDownloads"
> & GuestTabRecordCleanup

interface GuestTabRecordCleanup {
  /** CDP 崩溃守卫监听清理(setupCdpCrashGuard) */
  crashGuardCleanup?: () => void
  /** debugger "message" 监听清理(setupDialogTracking) */
  cdpMessageCleanup?: () => void
  /** session "will-download" 监听清理(setupDownloadTracking) */
  downloadCleanup?: () => void
  /** 活动(did-start/stop-loading 等)监听清理(setupActivityTracking) */
  activityCleanup?: () => void
  /** 记录是否由恢复存储(restoreTabs)重建, 首次成功恢复后清除 */
  restoredFromStore?: boolean
}

/** PortingGap: 常驻协调器记录中 guest-manager 依赖的字段投影(Gg 完整记录在 core/residency.ts) */
export interface BrowserTabResidencySnapshot {
  tabId: string
  windowId: number
  sessionId: string
  residency: BrowserResidency
  generation: number
  lastSelectedAt: number | null
  /** renderer 可见(挂起裁决读侧) */
  visible: boolean
  /** 最近活动时间(挂起空闲判定读侧) */
  lastActivityAt: number
}

/** PortingGap: 常驻协调器完整记录(Gg;generation 由协调器自持) */
export interface BrowserTabResidencyRecord extends BrowserTabResidencySnapshot {
  guestAttached: boolean
  openedAt: number
  lastActivityAt: number
  preferred: boolean
  currentTask: boolean
  selected: boolean
  visible: boolean
  operationActive: boolean
  captureActive: boolean
  audible: boolean
  mediaActive: boolean
  loading: boolean
  downloadActive: boolean
}

/** PortingGap: registerTabResidency → upsert 的入参形状(generation 由协调器自持, 不随输入) */
export type BrowserTabResidencyUpsertInput = Omit<BrowserTabResidencyRecord, "generation">

/** PortingGap: residencyCoordinator.report 的增量补丁 */
export interface BrowserTabResidencyReportPatch {
  selected?: boolean
  visible?: boolean
  currentTask?: boolean
  loading?: boolean
  operationActive?: boolean
  captureActive?: boolean
  audible?: boolean
  mediaActive?: boolean
  downloadActive?: boolean
}

/**
 * PortingGap: BrowserTabResidencyCoordinator(Gg)注入端口 —— 最小结构接口。
 * 实现见 core/residency.ts, 由集成者装配。
 */
export interface BrowserTabResidencyCoordinatorPort {
  upsert(record: BrowserTabResidencyUpsertInput): unknown
  get(tabId: string): BrowserTabResidencySnapshot | null
  report(tabId: string, patch: BrowserTabResidencyReportPatch): void
  /** live-background → suspend-pending(挂起发起;core/residency.ts beginSuspend) */
  beginSuspend(tabId: string): BrowserTabResidencySnapshot | null
  /** suspend-pending → suspended(挂起完成;generation 匹配才有效) */
  commitSuspend(tabId: string, generation: number): BrowserTabResidencySnapshot | null
  /** suspend-pending → live-*(ack 超时/失败回滚;generation 匹配才有效) */
  cancelSuspend(tabId: string, generation: number): BrowserTabResidencySnapshot | null
  markRestoring(tabId: string): BrowserTabResidencySnapshot | null
  completeRestore(tabId: string, generation: number): boolean
  failRestore(tabId: string, generation: number): BrowserTabResidencySnapshot | null
  markAttached(tabId: string, visible: boolean, residencyGeneration?: number): boolean
  markDetached(tabId: string): void
  remove(tabId: string): void
  whenIdle(): Promise<void>
  dispose(): void
}

/** PortingGap: 恢复存储端口(ZCode residencyOptions.recoveryStore) */
export interface BrowserRecoveryStorePort {
  whenIdle?(): Promise<void>
  listShells(query: {
    workspaceKey: string
    remoteSessionId?: string
    sessionId?: string
  }): Promise<BrowserRestoredTabShell[]>
  remove(tabId: string): Promise<void>
  getPageState(tabId: string): Promise<BrowserPageStateSnapshot | undefined>
  removePageState(tabId: string): Promise<void>
  upsertPageState(snapshot: BrowserPageStateSnapshot): Promise<void>
  upsert(shell: BrowserTabShellSnapshot): Promise<void>
}

/** PortingGap: 恢复存储中的 tab 壳记录(restoreTabs 读取 / persistShell 写入) */
export interface BrowserTabShellSnapshot {
  schemaVersion: 1
  tabId: string
  windowBindingId: string | null
  workspaceKey: string
  remoteSessionId?: string
  sessionId: string
  browserId: string
  browserGeneration: number
  origin: "agent" | "user"
  lifecycle: BrowserLifecycle
  restoreUrl: string | null
  title: string | null
  faviconUrl: string | null
  viewport: BrowserViewportOverride | null
  openedAt: number
  lastSelectedAt: number | null
  updatedAt: number
}

/** PortingGap: 页面导航历史快照(restoreGuestState / persistRecoverySnapshot) */
export interface BrowserPageStateSnapshot {
  schemaVersion: 1
  tabId: string
  entries: NavigationEntry[]
  activeIndex: number
  updatedAt: number
}

/** PortingGap: 恢复存储返回的壳视图(restoreTabs 输入) */
export interface BrowserRestoredTabShell {
  tabId: string
  workspaceKey: string
  remoteSessionId?: string
  sessionId: string
  browserId?: string
  browserGeneration?: number
  lifecycle: BrowserLifecycle
  origin: "agent" | "user"
  restoreUrl: string | null
  title: string | null
  faviconUrl: string | null
  viewport: BrowserViewportOverride | null
  openedAt: number
  lastSelectedAt: number | null
}

/** restoreTabs 对渲染进程的输出(toRestoredShell) */
export interface BrowserRestoredShellView {
  tabId: string
  workspaceKey: string
  remoteSessionId?: string
  sessionId: string
  browserId: string
  browserGeneration: number
  origin: "agent" | "user"
  restoreUrl?: string | null
  title?: string | null
  faviconUrl?: string | null
  openedAt: number
  lastSelectedAt?: number | null
}

/**
 * PortingGap: A4/A5 接线 —— executeBrowserCommandOnView(jg)注入端口。
 * 集成时接线: 来自 executor 模块(core/executor/dispatcher)。
 */
export type CommandExecutor = (
  view: ControlledView,
  command: BrowserGuestCommand,
  options?: { signal?: AbortSignal },
) => Promise<BrowserCommandResult>

/** PortingGap: executeIabPlaywrightLocator(ca)的结果判别 */
export type IabPlaywrightLocatorOutcome =
  | { kind: "done"; value: unknown }
  | { kind: "cancelled" }
  | { kind: "timeout"; reason: string }

/**
 * PortingGap: A4 接线 —— executeIabPlaywrightLocator(ca)注入端口
 * (录制场景中的选择器动作复用 locator 执行器)。
 */
export type IabPlaywrightLocatorExecutor = (
  view: ControlledView,
  action: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<IabPlaywrightLocatorOutcome>

/**
 * PortingGap: 命令载荷按还原源码为平铺形状(method + 顶层参数)。
 * shared 协议包(packages/shared/src/browser)集成时做 zod → 本形状映射。
 */
export interface BrowserGuestCommand {
  method: string
  requestId?: string
  turnId?: string
  /** nameSession */
  name?: string
  /** browserVisibilitySet */
  visible?: boolean
  /** browserViewportSet */
  width?: number
  height?: number
  /** tab 定位 / activateTab / claimTab / recordingStatus|Cancel */
  tabId?: string
  /** recordingStatus / recordingCancel */
  recordingId?: string
  /** finalizeTabs */
  keep?: Array<{ tabId: string; status: BrowserLifecycle }>
  /** finalize */
  deliverable?: boolean
  /** playwrightWaitForTimeout / waitForEvent */
  timeoutMs?: number
  /** handleDialog */
  accept?: boolean
  promptText?: string
  /** playwright 动作(locator/evaluate/waitForEvent/downloadPath/fileChooserSetFiles/elementScreenshot) */
  action?: BrowserGuestCommandAction
  /** recordingStart */
  options?: BrowserRecordingStartOptions
  /** 坐标型 click/scroll(录制场景内部派发走 executor) */
  x?: number
  y?: number
  button?: string
  doubleClick?: boolean
}

/** PortingGap: playwright action 平铺形状 */
export interface BrowserGuestCommandAction {
  name: string
  operation?: string
  event?: string
  downloadId?: string
  timeoutMs?: number
  [key: string]: unknown
}

/** PortingGap: recordingStart 载荷 */
export interface BrowserRecordingStartOptions {
  viewport?: BrowserViewportOverride
  fps?: number
  maxDurationMs?: number
  settleMs?: number
  showCursor?: boolean
  actions?: RecordingScenarioAction[]
}

/** PortingGap: 录制场景动作(平铺形状) */
export interface RecordingScenarioAction {
  type:
    | "wait"
    | "click"
    | "type"
    | "waitFor"
    | "hover"
    | "move"
    | "scroll"
    | "scrollTo"
    | "wheel"
    | "drag"
  selector?: string
  x?: number
  y?: number
  button?: string
  doubleClick?: boolean
  text?: string
  state?: string
  timeoutMs?: number
  durationMs?: number
  deltaX?: number
  deltaY?: number
  times?: number
  intervalMs?: number
  path?: Array<{ x: number; y: number }>
  delayAfterMs?: number
}

/** 渲染器 attach-guest 载荷(ZCode BrowserViewReady 应答后的 attach 形状) */
export interface GuestAttachScope {
  windowId?: number
  workspaceKey?: string
  sessionId?: string
  remoteSessionId?: string
  active?: boolean
  residencyGeneration?: number
}

/** attachGuest 返回(成功时仅 guestGeneration, 与还原源码一致) */
export interface GuestAttachOutcome {
  ok: boolean
  reason?: string
  recoveryRequested?: boolean
  guestGeneration?: number
}

/** 渲染器上报的最小 tab 作用域(五元组) */
export interface RendererTabScope {
  tabId: string
  windowId: number
  workspaceKey: string
  sessionId: string
  remoteSessionId?: string
}

/** 渲染器 report-residency 载荷 */
export interface RendererResidencyReport extends RendererTabScope {
  restoreUrl?: string
  /** null = 页面标题已清空(cachedTitle 随之清空;缺省 = 无标题更新) */
  title?: string | null
  faviconUrl?: string | null
  loading: boolean
  selected: boolean
  visible: boolean
  currentTask?: boolean
}

/** 渲染器 suspend-ready 载荷 */
export interface RendererSuspendAck {
  tabId: string
  windowId: number
  generation: number
}

/** PortingGap: tab 挂起裁决视图(suspend-scheduler 的输入;listSuspendViews 输出) */
export interface TabSuspendView {
  tabId: string
  residency: BrowserResidency
  /** renderer 展示中(可见即不可挂起) */
  visible: boolean
  /** 管理器运行态保护位(选中/加载/媒体/agent 命令/截图录像/下载) */
  busy: boolean
  /** 最近活动时间(空闲判定基准;residency 记录维护) */
  lastActivityAt: number
}

/** restore-tabs 渲染器请求载荷 */
export interface RendererRestoreTabsRequest {
  windowId: number
  workspaceKey: string
  remoteSessionId?: string
  sessionId?: string
}

/** 挂起/恢复/常驻变更通知(suspend / restore 频道载荷, 含代数) */
export interface BrowserResidencyTransitionNotification {
  tabId: string
  workspaceKey: string
  remoteSessionId?: string
  sessionId: string
  browserId: string
  browserGeneration: number
  generation: number
  residency: BrowserResidency
}

/** summary(list 命令行) */
export interface BrowserTabSummary {
  tabId: string
  url: string
  title: string
  viewport: BrowserViewportOverride
  active?: true
  lifecycle?: BrowserLifecycle
}

/** snapshotRecording 形状 */
export interface BrowserRecordingSnapshot {
  id: string
  status: BrowserRecordingRecord["status"]
  phase: BrowserRecordingRecord["phase"]
  progress: number
  startedAt: number
  updatedAt: number
  artifact?: NonNullable<BrowserRecordingRecord["artifact"]>
  error?: string
}

/** 录制产物(recordBrowserVideo 返回) */
type BrowserRecordingArtifact = NonNullable<BrowserRecordingRecord["artifact"]>

/** 请求登记条目(runningRequests) */
interface BrowserRequestEntry {
  context: BrowserOwnerContext
  controller: AbortController
  dispatched: boolean
  tabId?: string
}

/** 在途截图条目(inFlightScreenshots, 同 tab 去重) */
interface InFlightScreenshotEntry {
  execution: Promise<BrowserCommandResult>
  requestId: string
  startedAt: number
}

/** waitForGuest 等待者(waiters) */
interface GuestAttachWaiter {
  resolve: (guest: WebContents | null) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

/** waitForDownload 等待者(downloadWaiters) */
interface GuestDownloadWaiter {
  resolve: (downloadId: string | null) => void
  timer: ReturnType<typeof setTimeout>
  signal: AbortSignal
  onAbort: () => void
}

/** 事件频道名(design doc §2.2, ZCode I.BrowserView* 对应) */
export const BROWSER_VIEW_CHANNELS = {
  ready: "lume:browser-view-ready",
  operation: "lume:browser-view-operation",
  visibility: "lume:browser-view-visibility",
  viewportChanged: "lume:browser-view-viewport-changed",
  closeTab: "lume:browser-view-close-tab",
  suspend: "lume:browser-view-suspend",
  restore: "lume:browser-view-restore",
} as const

/* ════════════════════════════════════════════════════════════════════
 * 常量
 * ════════════════════════════════════════════════════════════════════ */

/** kM —— 预动作陈旧绑定恢复提示文案(activateTab/resolveTab 失败时附带给模型) */
const STALE_BINDING_RECOVERY_HINT =
  "This is pre-action stale-binding recovery, not post-action popup observation. Keep the existing browser binding; call browser.tabs.list(), then browser.tabs.get(info.id). If the controlled list is empty, inspect browser.user.openTabs() and use browser.user.claimTab(info) before creating a new tab."

/** Sle —— guest 附加等待超时 */
const DEFAULT_ATTACH_TIMEOUT_MS = 10000

/** Cle —— guest teardown 前 CDP 在途命令排空超时 */
const GUEST_CDP_IDLE_TIMEOUT_MS = 1000

/** 挂起发起:等 renderer suspend-ready ack 的超时(超时回滚 live-background, 下轮重试) */
const DEFAULT_SUSPEND_ACK_TIMEOUT_MS = 5000

/** Ile —— 录制产物保留时长(之后删除条目与临时 WebM) */
const RECORDING_ARTIFACT_CLEANUP_DELAY_MS = 3600 * 1000

/** OH —— 自然视口缺省值 */
const DEFAULT_NATURAL_VIEWPORT: BrowserViewportOverride = { width: 800, height: 600 }

/** DH —— 录制视口缺省值(新 tab 的 viewportOverride 同源) */
const RECORDING_VIEWPORT: BrowserViewportOverride = { width: 1280, height: 720 }

/**
 * fr —— PortingGap: 视口边界常量(还原源码自共享模块导入, 无原名标注)。
 * design doc §2.1 constants: viewport 320×320 ~ 3840×2160。
 */
const VIEWPORT_LIMITS = {
  minWidth: 320,
  minHeight: 320,
  maxWidth: 3840,
  maxHeight: 2160,
} as const

/* ════════════════════════════════════════════════════════════════════
 * 模块级工具(命名对齐见文件头对照表)
 * ════════════════════════════════════════════════════════════════════ */

/** BH —— 桌面缩放系数量规归一(>1 的有限值保留, 否则回 1) */
function normalizeDesktopZoomMetricsScale(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 1) > 1 ? value ?? 1 : 1
}

/** bM —— CDP Emulation.setDeviceMetricsOverride 参数(dontSetVisibleSize + 可选 scale) */
function buildViewportMetricsOverride(
  viewport: BrowserViewportOverride,
  desktopZoomScale?: number,
): Record<string, unknown> {
  const scale = normalizeDesktopZoomMetricsScale(desktopZoomScale)
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
    dontSetVisibleSize: true,
    ...(scale > 1 ? { scale } : {}),
  }
}

/** $H —— 旧版单参数上下文(attachGuest/execute 直传字符串时构造) */
function normalizeLegacyContext(workspaceKey: string): BrowserOwnerContext {
  return {
    requestId: `legacy:${randomUUID()}`,
    browserId: "legacy-iab",
    browserGeneration: 0,
    windowId: 0,
    workspaceKey,
    sessionId: workspaceKey,
    clientMode: "desktop-continuous",
    legacy: true,
  }
}

/** Rle —— 挂起确认等待者键 */
function suspendAckKey(tabId: string, generation: number): string {
  return `${tabId}\0${generation}`
}

/** Ele —— 恢复存储壳视图 → 渲染器 restore 载荷(browserId/generation 取当前 owner) */
function toRestoredShell(
  shell: BrowserRestoredTabShell,
  owner: BrowserOwnerContext,
): BrowserRestoredShellView {
  return {
    tabId: shell.tabId,
    workspaceKey: shell.workspaceKey,
    ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
    sessionId: shell.sessionId,
    browserId: owner.browserId,
    browserGeneration: owner.browserGeneration,
    origin: shell.origin,
    restoreUrl: shell.restoreUrl,
    title: shell.title,
    faviconUrl: shell.faviconUrl,
    openedAt: shell.openedAt,
    lastSelectedAt: shell.lastSelectedAt,
  }
}

/** _M —— 命令副作用判定(取消时决定 sideEffect:"uncertain") */
function isSideEffecting(command: BrowserGuestCommand): boolean {
  if (command.method === "playwright" && command.action?.name === "locator") {
    return ["click", "dblclick", "downloadMedia", "fill", "press", "selectOption", "setChecked"].includes(
      command.action.operation ?? "",
    )
  }
  if (command.method === "playwright" && command.action?.name === "evaluate") return true
  return [
    "navigate",
    "back",
    "forward",
    "reload",
    "click",
    "fill",
    "type",
    "press",
    "cuaKeypress",
    "scroll",
    "cuaScroll",
    "domCuaScroll",
    "hover",
    "select",
    "check",
    "drag",
    "cuaDrag",
    "recordingStart",
    "recordingCancel",
    "handleDialog",
    "close",
    "evaluate",
    "finalize",
    "finalizeTabs",
    "claimTab",
    "activateTab",
    "markDeliverable",
    "markHandoff",
    "newTab",
  ].includes(command.method)
}

/** vle/sr —— 标准中止异常 */
function abortError(message = "Browser recording cancelled"): DOMException {
  return new DOMException(message, "AbortError")
}

/** Hg —— 已中止则抛出 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
}

/** Tle —— 外部 signal 中止联动到请求 controller;返回解绑函数 */
function linkAbortSignal(external: AbortSignal | undefined, controller: AbortController): () => void {
  if (!external) return () => {}
  const abort = (): void => controller.abort(external.reason)
  if (external.aborted) abort()
  else external.addEventListener("abort", abort, { once: true })
  return () => external.removeEventListener("abort", abort)
}

/** PM —— signal 竞速等待 Promise:{completed:true,value} | {completed:false}(中止) */
function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<{ completed: false } | { completed: true; value: T }> {
  if (signal.aborted) return Promise.resolve({ completed: false })
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => signal.removeEventListener("abort", onAbort)
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ completed: false })
    }
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      value => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ completed: true, value })
      },
      error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/** Cr —— 可中止延时;true=自然到时,false=被中止 */
function waitForDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise(resolve => {
    let finished = false
    const finish = (elapsed: boolean): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
      resolve(elapsed)
    }
    const timer = setTimeout(() => finish(true), ms)
    const onAbort = (): void => finish(false)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

/** Ale —— 轮询条件等待 */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<"cancelled" | "matched" | "timeout"> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal.aborted) return "cancelled"
    if (predicate()) return "matched"
    const remaining = deadline - Date.now()
    if (remaining <= 0) return "timeout"
    if (!(await waitForDelay(Math.min(50, remaining), signal))) return "cancelled"
  }
}

/** SM —— 读取截图表面失效原因(invalidated signal) */
function readScreenshotSurfaceInvalidation(signal: AbortSignal | undefined): Error | undefined {
  if (signal?.aborted) {
    return signal.reason instanceof Error ? signal.reason : new Error("browser screenshot activity was invalidated")
  }
  return undefined
}

/** NH —— 后端执行与请求中止竞速(按 _M 决定 sideEffect 语义) */
async function raceBackendExecution(
  execution: Promise<BrowserCommandResult>,
  signal: AbortSignal,
  command: BrowserGuestCommand,
  startedAt: number,
): Promise<BrowserCommandResult> {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: "browser request cancelled after backend dispatch; side effects may have occurred",
        sideEffect: isSideEffecting(command) ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    }
  }
  return await new Promise<BrowserCommandResult>(resolve => {
    let settled = false
    const finish = (result: BrowserCommandResult): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const onAbort = (): void =>
      finish({
        ok: false,
        error: {
          code: "cancelled",
          message: isSideEffecting(command)
            ? "browser request cancelled after backend dispatch; side effects may have occurred"
            : "browser request cancelled",
          sideEffect: isSideEffecting(command) ? "uncertain" : "none",
        },
        elapsedMs: Date.now() - startedAt,
      })
    signal.addEventListener("abort", onAbort, { once: true })
    execution.then(
      finish,
      error =>
        finish({
          ok: false,
          error: { code: "execution_error", message: error instanceof Error ? error.message : String(error) },
          elapsedMs: Date.now() - startedAt,
        }),
    )
  })
}

/** LH —— executeJavaScript 量得的视口形状守卫(类型谓词) */
function isBrowserViewportSize(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== "object") return false
  const candidate = value as { width?: unknown; height?: unknown }
  return (
    Number.isInteger(candidate.width) &&
    Number(candidate.width) > 0 &&
    Number.isInteger(candidate.height) &&
    Number(candidate.height) > 0
  )
}

/** UH —— 页面坐标点形状守卫(类型谓词) */
function isBrowserPointValue(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false
  const candidate = value as { x?: unknown; y?: unknown }
  return typeof candidate.x === "number" && typeof candidate.y === "number"
}

/** xle —— 背景视口回退值夹取到共享边界 */
function normalizeBackgroundViewport(viewport: BrowserViewportOverride): BrowserViewportOverride {
  return {
    width: Math.min(VIEWPORT_LIMITS.maxWidth, Math.max(VIEWPORT_LIMITS.minWidth, viewport.width)),
    height: Math.min(VIEWPORT_LIMITS.maxHeight, Math.max(VIEWPORT_LIMITS.minHeight, viewport.height)),
  }
}

/** ui —— playwright 超时归一(executor 模块同款语义, PortingGap) */
function normalizePlaywrightTimeout(value: unknown, fallbackMs: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallbackMs
}

/** Mle —— 截图类命令判定(决定走 surface coordinator 路径) */
function isScreenshotCommand(command: BrowserGuestCommand): boolean {
  return (
    command.method === "screenshot" ||
    (command.method === "playwright" && command.action?.name === "elementScreenshot")
  )
}

/** CM —— 视口越界断言 */
function assertViewportOverride(viewport: BrowserViewportOverride): void {
  if (
    !Number.isInteger(viewport.width) ||
    viewport.width < VIEWPORT_LIMITS.minWidth ||
    viewport.width > VIEWPORT_LIMITS.maxWidth ||
    !Number.isInteger(viewport.height) ||
    viewport.height < VIEWPORT_LIMITS.minHeight ||
    viewport.height > VIEWPORT_LIMITS.maxHeight
  ) {
    throw new Error("browser viewport is outside the supported free-size range")
  }
}

/** Fe —— 安全取值(异常回退) */
function safeStr<T>(getter: () => T, fallback: T): T {
  try {
    return getter()
  } catch {
    return fallback
  }
}

/** ot —— 安全布尔(异常回退) */
function safeBool(getter: () => boolean, fallback: boolean): boolean {
  try {
    return getter()
  } catch {
    return fallback
  }
}

/** Ole —— CDP 对话框类型归一 */
function normalizeDialogType(type: unknown): BrowserDialogInfo["type"] {
  switch (type) {
    case "alert":
    case "confirm":
    case "prompt":
    case "beforeunload":
      return type
    default:
      return "alert"
  }
}

/** Dle —— meta currentUrl 去凭据/查询/锚 */
function sanitizeBrowserMetaUrl(url: string): string | undefined {
  if (!url) return undefined
  try {
    const parsed = new URL(url)
    parsed.username = ""
    parsed.password = ""
    parsed.search = ""
    parsed.hash = ""
    const normalized = parsed.toString()
    return parsed.pathname === "/" ? normalized.slice(0, -1) : normalized
  } catch {
    return undefined
  }
}

interface RecordBrowserVideoOptions {
  tempRoot: string
  recordingId: string
  targetFrame: Electron.WebFrameMain
  viewport: BrowserViewportOverride
  fps: number
  signal: AbortSignal
  now?: () => number
  onPhase?: (phase: "capturing" | "finalizing") => void
  onCaptureComplete?: () => void
  executeScenario: () => Promise<void>
  createRecorder: (options: RecordingRecorderOptions) => Promise<RecordingRecorder>
}

/** AH —— 录制编排:建录制器→执行场景→停录→校验产物;失败即取消并清理临时文件 */
async function recordBrowserVideo(options: RecordBrowserVideoOptions): Promise<BrowserRecordingArtifact> {
  const artifactPath = join(options.tempRoot, `${options.recordingId}.webm`)
  const now = options.now ?? Date.now
  let recorder: RecordingRecorder | undefined
  let completed = false
  try {
    throwIfAborted(options.signal)
    recorder = await options.createRecorder({
      outputPath: artifactPath,
      targetFrame: options.targetFrame,
      viewport: options.viewport,
      fps: options.fps,
      signal: options.signal,
    })
    throwIfAborted(options.signal)
    const captureStartedAt = now()
    options.onPhase?.("capturing")
    await options.executeScenario()
    throwIfAborted(options.signal)
    const durationMs = Math.max(0, Math.round(now() - captureStartedAt))
    options.onCaptureComplete?.()
    options.onPhase?.("finalizing")
    await recorder.stop()
    throwIfAborted(options.signal)
    const artifactStat = await stat(artifactPath)
    if (!artifactStat.isFile() || artifactStat.size === 0) {
      throw new Error("Browser recording produced an empty WebM artifact")
    }
    completed = true
    return {
      path: artifactPath,
      mimeType: "video/webm",
      width: options.viewport.width,
      height: options.viewport.height,
      fps: options.fps,
      durationMs,
      frameCount: Math.max(1, Math.round((durationMs / 1000) * options.fps)),
    }
  } finally {
    if (!completed) {
      await recorder?.cancel().catch(() => {})
      await rm(artifactPath, { force: true }).catch(() => {})
    }
  }
}

/* ════════════════════════════════════════════════════════════════════
 * BrowserGuestManager(Kg)
 * ════════════════════════════════════════════════════════════════════ */

/** guest-manager 装配选项(结构性端口 + 渲染器回调覆写) */
export interface BrowserGuestManagerOptions {
  /** A2 装配:常驻协调器端口(core/residency.ts 实现注入) */
  residency: { coordinator: BrowserTabResidencyCoordinatorPort }
  /** 恢复存储端口(ZCode residencyOptions.recoveryStore) */
  recoveryStore?: BrowserRecoveryStorePort
  /** A4/A5 接线:executeBrowserCommandOnView(jg)来自 executor 模块 */
  executeCommand?: CommandExecutor
  /** A4 接线:executeIabPlaywrightLocator(ca)来自 executor 模块(录制场景选择器动作) */
  executeLocator?: IabPlaywrightLocatorExecutor
  /** A6 接线:EmbeddedBrowserJavaScriptDialogController —— 对话框打开钩子 */
  onDialogOpening?: (tabId: string, info: BrowserDialogInfo) => void
  /** A6 接线:对话框关闭钩子 */
  onDialogClosed?: (tabId: string) => void
  /** 以下回调缺省经 deps.emit 发 lume:browser-view-* 频道, 可覆写(测试/装配) */
  onCloseTabRequested?: (tabId: string, owner: BrowserOwnerContext) => void
  onOpenTabRequested?: (tabId: string, owner: BrowserOwnerContext) => void
  onVisibilityChanged?: (visible: boolean, owner: BrowserOwnerContext, tabId?: string) => void
  onViewportChanged?: (
    viewport: BrowserViewportOverride | null,
    owner: BrowserOwnerContext,
    tabId: string,
  ) => void
  onSuspendTabRequested?: (notification: BrowserResidencyTransitionNotification) => void
  onRestoreTabRequested?: (notification: BrowserResidencyTransitionNotification) => void
  onResidencyChanged?: (notification: BrowserResidencyTransitionNotification) => void
  onRecoveryOrphanCloseRequested?: (notification: { tabId: string; reason: string }) => void
}

/**
 * BrowserGuestManager(Kg)—— tab 注册表 / 五元组 scope / attachGuest 校验链 /
 * execute 46 命令分发 / 截图门控 / 录制 / 下载 / 对话框跟踪 / 视口覆盖 /
 * 挂起恢复 / CDP 附加与拆除。
 */
export class BrowserGuestManager {
  private readonly deps: BrowserManagerDeps
  private readonly options: BrowserGuestManagerOptions
  private readonly recoveryStore: BrowserRecoveryStorePort | undefined
  private readonly residencyCoordinator: BrowserTabResidencyCoordinatorPort
  private readonly attachTimeoutMs: number

  private readonly onCloseTabRequested: (tabId: string, owner: BrowserOwnerContext) => void
  private readonly onOpenTabRequested: (tabId: string, owner: BrowserOwnerContext) => void
  private readonly onVisibilityChanged: (visible: boolean, owner: BrowserOwnerContext, tabId?: string) => void
  private readonly onViewportChanged: (
    viewport: BrowserViewportOverride | null,
    owner: BrowserOwnerContext,
    tabId: string,
  ) => void
  private readonly onSuspendTabRequested: (notification: BrowserResidencyTransitionNotification) => void
  private readonly onRestoreTabRequested: (notification: BrowserResidencyTransitionNotification) => void
  private readonly onResidencyChanged: (notification: BrowserResidencyTransitionNotification) => void
  private readonly onRecoveryOrphanCloseRequested: (notification: { tabId: string; reason: string }) => void

  /** tab 注册表(tabId → 记录) */
  readonly tabs = new Map<string, GuestTabRecord>()
  /** 已关闭 tabId 集合(防 renderer 迟到 attach 复活) */
  readonly closedTabIds = new Set<string>()
  /** scopeKey → 活动 tabId */
  readonly activeTabByScope = new Map<string, string>()
  /** scopeKey → 缺省 tabId(首个隐式创建的 tab) */
  readonly defaultTabByScope = new Map<string, string>()
  /** tabId → guest 附加等待者 */
  readonly waiters = new Map<string, GuestAttachWaiter[]>()
  /** tabId → 待处理 JS 对话框 */
  readonly pendingDialogs = new Map<string, BrowserDialogInfo>()
  /** requestId → 在途请求 */
  readonly runningRequests = new Map<string, BrowserRequestEntry>()
  /** tabId → 在途截图(同 tab 去重) */
  readonly inFlightScreenshots = new Map<string, InFlightScreenshotEntry>()
  /** recordingId → 录制条目 */
  readonly recordings = new Map<string, BrowserRecordingRecord>()
  /** downloadId → 下载记录 */
  readonly downloads = new Map<string, BrowserDownloadRecord>()
  /** tabId → 尚无等待者的下载 id 队列 */
  readonly queuedDownloads = new Map<string, string[]>()
  /** tabId → 下载路径等待者队列 */
  readonly downloadWaiters = new Map<string, GuestDownloadWaiter[]>()
  /** scopeKey → 会话命名 */
  readonly sessionNames = new Map<string, string>()
  /** scopeKey → 面板可见性 */
  readonly visibilityByScope = new Map<string, boolean>()
  /** windowId → 量得的自然视口 */
  readonly naturalViewportByWindow = new Map<number, BrowserViewportOverride>()
  /** tabId → 挂起确认等待者(写入端 = runSuspendFlight, 见头注偏差 6) */
  readonly suspendAckWaiters = new Map<string, () => void>()
  /** tabId → 挂起飞行(写入端 = suspendTabForIdle;读取端 ensureGuest) */
  readonly suspendFlights = new Map<string, Promise<unknown>>()
  /** tabId → 恢复飞行(去重) */
  readonly restoreFlights = new Map<string, Promise<WebContents | null>>()
  /** tabId → 附加飞行(去重) */
  readonly guestAttachFlights = new Map<string, Promise<WebContents | null>>()
  /** tabId → 恢复认领的 windowId(多窗口恢复互斥) */
  readonly restoredTabClaims = new Map<string, number>()

  constructor(deps: BrowserManagerDeps, options: BrowserGuestManagerOptions) {
    this.deps = deps
    this.options = options
    this.recoveryStore = options.recoveryStore
    this.residencyCoordinator = options.residency.coordinator
    this.attachTimeoutMs = deps.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS
    this.onCloseTabRequested =
      options.onCloseTabRequested ?? ((tabId, owner) => this.emitBrowserViewCloseTab(tabId, owner))
    this.onOpenTabRequested =
      options.onOpenTabRequested ?? ((tabId, owner) => this.emitBrowserViewReady(tabId, owner))
    this.onVisibilityChanged =
      options.onVisibilityChanged ?? ((visible, owner, tabId) => this.emitBrowserViewVisibility(visible, owner, tabId))
    this.onViewportChanged =
      options.onViewportChanged ?? ((viewport, owner, tabId) => this.emitBrowserViewViewportChanged(viewport, owner, tabId))
    this.onSuspendTabRequested =
      options.onSuspendTabRequested ?? (notification => this.emitBrowserViewSuspend(notification))
    this.onRestoreTabRequested =
      options.onRestoreTabRequested ?? (notification => this.emitBrowserViewRestore(notification))
    this.onResidencyChanged =
      options.onResidencyChanged ?? (notification => this.emitBrowserViewRestore(notification))
    this.onRecoveryOrphanCloseRequested =
      options.onRecoveryOrphanCloseRequested ??
      (notification => this.emitBrowserViewRecoveryOrphanClose(notification.tabId, notification.reason))
  }

  /* ────────────────────────────────────────────────────────────────
   * 事件出口(缺省实现经 deps.emit,ZCode 装配点直发 IPC 的等价物)
   * ──────────────────────────────────────────────────────────────── */

  /** onOpenTabRequested 缺省实现 → lume:browser-view-ready(ZCode I.BrowserViewReady) */
  private emitBrowserViewReady(tabId: string, owner: BrowserOwnerContext): void {
    this.deps.emit({
      method: BROWSER_VIEW_CHANNELS.ready,
      params: {
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        tabId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      },
    })
  }

  /** onVisibilityChanged 缺省实现 → lume:browser-view-visibility */
  private emitBrowserViewVisibility(
    visible: boolean,
    owner: BrowserOwnerContext,
    tabId?: string,
  ): void {
    this.deps.emit({
      method: BROWSER_VIEW_CHANNELS.visibility,
      params: {
        visible,
        workspaceKey: owner.workspaceKey,
        remoteSessionId: owner.remoteSessionId,
        sessionId: owner.sessionId,
        ...(tabId ? { tabId } : {}),
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      },
    })
  }

  /** onViewportChanged 缺省实现 → lume:browser-view-viewport-changed */
  private emitBrowserViewViewportChanged(
    viewport: BrowserViewportOverride | null,
    owner: BrowserOwnerContext,
    tabId: string,
  ): void {
    this.deps.emit({
      method: BROWSER_VIEW_CHANNELS.viewportChanged,
      params: {
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        tabId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
        viewport,
      },
    })
  }

  /** onCloseTabRequested 缺省实现 → lume:browser-view-close-tab(Ij 载荷近似, 见头注偏差 1) */
  private emitBrowserViewCloseTab(tabId: string, owner: BrowserOwnerContext): void {
    this.deps.emit({
      method: BROWSER_VIEW_CHANNELS.closeTab,
      params: {
        tabId,
        workspaceKey: owner.workspaceKey,
        ...(owner.remoteSessionId ? { remoteSessionId: owner.remoteSessionId } : {}),
        sessionId: owner.sessionId,
        browserId: owner.browserId,
        browserGeneration: owner.browserGeneration,
      },
    })
  }

  private emitBrowserViewSuspend(notification: BrowserResidencyTransitionNotification): void {
    this.deps.emit({ method: BROWSER_VIEW_CHANNELS.suspend, params: { ...notification } })
  }

  private emitBrowserViewRestore(notification: BrowserResidencyTransitionNotification): void {
    this.deps.emit({ method: BROWSER_VIEW_CHANNELS.restore, params: { ...notification } })
  }

  /** recovery-orphan 关闭 → lume:browser-view-close-tab(ZCode 原载荷 {tabId, reason}) */
  private emitBrowserViewRecoveryOrphanClose(tabId: string, reason: string): void {
    this.deps.emit({ method: BROWSER_VIEW_CHANNELS.closeTab, params: { tabId, reason } })
  }

  /**
   * A7 接线:ipc 层在命令执行前后调用, 发 lume:browser-view-operation。
   * ZCode 的 resolveBrowserOperationTabId(zM)/browserOperationResetsResizeBaseline(z1)
   * 归 ipc 层实现, 此处只负责按五元组装载荷发送。
   */
  sendOperationEvent(context: BrowserOwnerContext, tabId: string | undefined, resetsResizeBaseline: boolean): void {
    this.deps.emit({
      method: BROWSER_VIEW_CHANNELS.operation,
      params: {
        workspaceKey: context.workspaceKey,
        ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
        sessionId: context.sessionId,
        ...(tabId ? { tabId } : {}),
        browserId: context.browserId,
        browserGeneration: context.browserGeneration,
        resetsResizeBaseline,
      },
    })
  }

  /* ────────────────────────────────────────────────────────────────
   * 注入端口访问器(A4/A5 接线缺失时显式报错)
   * ──────────────────────────────────────────────────────────────── */

  private getCommandExecutor(): CommandExecutor {
    const executor = this.options.executeCommand
    if (!executor) throw new Error("browser command executor is not wired (A4/A5 integration)")
    return executor
  }

  private getLocatorExecutor(): IabPlaywrightLocatorExecutor {
    const executor = this.options.executeLocator
    if (!executor) throw new Error("browser playwright locator executor is not wired (A4 integration)")
    return executor
  }

  /* ────────────────────────────────────────────────────────────────
   * attachGuest —— 渲染器 webContents 逐项校验 + CDP 附加 + 跟踪器安装
   * ──────────────────────────────────────────────────────────────── */

  /**
   * 渲染器 attach-guest 入口:webContents.fromId 存在 → webview 类型 → 未关闭 →
   * window/workspace/session/remoteSession 作用域一致 → 常驻 suspended/restoring
   * 代数校验 → CDP debugger.attach("1.3") → 安装四类跟踪器 → 视口覆盖 →
   * 唤醒等待者 → 持久化壳。
   */
  /** ZCode Pve:guest 文本右键菜单(选中态复制);幂等安装,弹层经 deps 注入。 */
  private readonly contextMenuWebContents = new WeakSet<Electron.WebContents>()
  private installTextContextMenu(guest: Electron.WebContents): void {
    if (!this.deps.popupContextMenu || this.contextMenuWebContents.has(guest)) return
    this.contextMenuWebContents.add(guest)
    guest.on("context-menu", (_event, params) => {
      this.deps.popupContextMenu?.(guest, params)
    })
    guest.once("destroyed", () => this.contextMenuWebContents.delete(guest))
  }

  attachGuest(tabId: string, webContentsId: number, scope?: GuestAttachScope): GuestAttachOutcome {
    let record = this.tabs.get(tabId)
    const guest = this.deps.webContentsFromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      const recoveryRequested =
        record && record.lifecycle !== "closed" ? this.requestGuestRebind(record, guest ? "destroyed" : "not-found") : false
      this.deps.log(`[browser-use] attachGuest skip tabId=${tabId} id=${webContentsId} reason=${guest ? "destroyed" : "not-found"}`)
      return { ok: false, reason: guest ? "destroyed" : "not-found", recoveryRequested }
    }
    if (!this.deps.isWebviewType(guest)) {
      this.deps.log(
        `[browser-use] attachGuest rejected tabId=${tabId} id=${webContentsId} reason=not-webview type=${safeStr(() => guest.getType(), "?")}`,
      )
      return { ok: false, reason: "not-webview", recoveryRequested: false }
    }
    this.installTextContextMenu(guest)
    if (this.closedTabIds.has(tabId)) {
      this.deps.log(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`)
      return { ok: false, reason: "closed", recoveryRequested: false }
    }
    if (!record) {
      // 未知 tabId:按 workspaceKey 构造 unclaimed-iab owner,或 legacy 上下文
      const owner: BrowserOwnerContext = scope?.workspaceKey
        ? {
            requestId: `unclaimed:${randomUUID()}`,
            browserId: "unclaimed-iab",
            browserGeneration: 0,
            windowId: scope.windowId ?? 0,
            workspaceKey: scope.workspaceKey,
            sessionId: scope.sessionId?.trim() || "unscoped",
            ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
            clientMode: "desktop-continuous",
          }
        : normalizeLegacyContext(tabId)
      if (scope?.windowId !== undefined) owner.windowId = scope.windowId
      record = {
        tabId,
        owner,
        cdpAttached: false,
        guestLifecycle: "detached",
        pendingCdpCommands: 0,
        guestGeneration: 0,
        hasAttachedGuest: false,
        rebindRequested: false,
        lifecycle: "active",
        origin: scope?.workspaceKey ? "user" : "agent",
        claimable: !!(scope?.workspaceKey && scope.sessionId?.trim()),
        ...(scope?.workspaceKey ? { userOwner: { ...owner } } : {}),
        active: false,
        loading: false,
        mediaActive: false,
        cachedUrl: "",
        cachedTitle: "",
        cachedFaviconUrl: null,
        openedAt: this.now(),
      }
      this.tabs.set(tabId, record)
      this.registerTabResidency(record, scope?.active === true)
    }
    if (record.lifecycle === "closed") {
      this.deps.log(`[browser-use] attachGuest rejected tabId=${tabId} reason=closed`)
      return { ok: false, reason: "closed", recoveryRequested: false }
    }
    if (scope?.windowId !== undefined && record.owner.windowId !== scope.windowId) {
      this.deps.log(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=window-mismatch expected=${record.owner.windowId} actual=${scope.windowId}`,
      )
      return { ok: false, reason: "window-mismatch", recoveryRequested: false }
    }
    if (scope?.workspaceKey && record.owner.workspaceKey !== scope.workspaceKey) {
      this.deps.log(`[browser-use] attachGuest rejected tabId=${tabId} reason=workspace-mismatch`)
      return this.rejectGuestAttach(record, guest, "workspace-mismatch")
    }
    if (scope?.sessionId && record.owner.sessionId !== scope.sessionId) {
      this.deps.log(`[browser-use] attachGuest rejected tabId=${tabId} reason=session-mismatch`)
      return this.rejectGuestAttach(record, guest, "session-mismatch")
    }
    if ((record.owner.remoteSessionId ?? "") !== (scope?.remoteSessionId ?? "")) {
      this.deps.log(`[browser-use] attachGuest rejected tabId=${tabId} reason=remote-session-mismatch`)
      return this.rejectGuestAttach(record, guest, "remote-session-mismatch")
    }
    const residency = this.residencyCoordinator.get(tabId)
    if (record.guest !== guest && (residency?.residency === "suspended" || residency?.residency === "suspend-pending")) {
      // 常驻为 suspended/suspend-pending 且 guest 不匹配 → 直接关闭来宾 webContents
      this.deps.log(`[browser-use] attachGuest rejected tabId=${tabId} reason=residency-${residency?.residency}`)
      this.closeGuestWebContents(record, guest)
      return { ok: false, reason: "residency-suspended", recoveryRequested: false }
    }
    if (
      residency?.residency === "restoring" &&
      !this.residencyCoordinator.markAttached(tabId, scope?.active === true, scope?.residencyGeneration)
    ) {
      // restoring 期代数不匹配 → 拒绝附加(防止旧 guest 复活)
      this.deps.log(
        `[browser-use] attachGuest rejected tabId=${tabId} reason=residency-generation-mismatch expected=${residency.generation} actual=${scope?.residencyGeneration ?? "missing"}`,
      )
      this.closeGuestWebContents(record, guest)
      return { ok: false, reason: "residency-generation-mismatch", recoveryRequested: false }
    }
    if (residency?.residency === "restoring") {
      try {
        guest.stop()
      } catch (error) {
        this.warn(`browser tab provisional navigation stop failed tabId=${tabId}`, error)
      }
    }
    const sameGuest = record.guest === guest
    if (record.guest && !sameGuest) this.detachGuest(record)
    let cdpAttached = false
    try {
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3")
      cdpAttached = guest.debugger.isAttached()
    } catch {
      cdpAttached = safeBool(() => guest.debugger.isAttached(), false)
    }
    record.guest = guest
    record.cdpAttached = cdpAttached
    record.guestLifecycle = "attached"
    record.guestTeardownFlight = undefined
    if (!sameGuest) record.guestGeneration += 1
    record.hasAttachedGuest = true
    record.attachFailure = undefined
    record.rebindRequested = false
    if (residency?.residency !== "restoring") {
      record.cachedUrl = safeStr(() => guest.getURL(), record.cachedUrl)
      record.cachedTitle = safeStr(() => guest.getTitle(), record.cachedTitle)
    }
    if (scope?.active === true) {
      record.active = true
      if (!record.claimable) this.selectTab(record, false)
      this.restoreNaturalViewportAfterBackground(record)
    } else if (scope?.active === false) {
      record.active = false
      this.residencyCoordinator.report(record.tabId, { selected: false, visible: false })
      const ownerScope = scopeKey(record.owner)
      if (this.activeTabByScope.get(ownerScope) === tabId) this.activeTabByScope.delete(ownerScope)
    }
    this.deps.log(`[browser-use] attachGuest tabId=${tabId} windowId=${record.owner.windowId} cdp=${cdpAttached}`)
    guest.once("destroyed", () => {
      const current = this.tabs.get(tabId)
      if (current?.guest === guest) {
        this.detachGuest(current)
        this.requestGuestRebind(current, "guest-destroyed")
      }
    })
    if (!sameGuest) this.setupCdpCrashGuard(record, guest)
    if (!sameGuest) this.setupDialogTracking(record, guest)
    if (!sameGuest) this.setupDownloadTracking(record, guest)
    if (!sameGuest) this.setupActivityTracking(record, guest)
    if (!sameGuest) this.applyViewportOverride(record)
    if (record.viewportOverride) {
      this.onViewportChanged({ ...record.viewportOverride }, record.owner, record.tabId)
    }
    if (scope?.active !== false && this.visibilityByScope.get(scopeKey(record.owner)) === true) {
      this.onVisibilityChanged(true, record.owner, record.tabId)
    }
    this.resolveWaiters(tabId, guest)
    if (residency?.residency !== "restoring") {
      this.residencyCoordinator.markAttached(tabId, scope?.active === true)
    }
    this.persistShell(record)
    return { ok: true, guestGeneration: record.guestGeneration }
  }

  /* ────────────────────────────────────────────────────────────────
   * 渲染器入口:updateViewportFromRenderer / getTabOwner / reportResidency /
   * acknowledgeSuspend / closeTabFromRenderer / whenRecoveryIdle /
   * ensureResidentFromRenderer / restoreTabs
   * ──────────────────────────────────────────────────────────────── */

  /** 渲染器 update-viewport:invoke 载荷入口(viewport 为 null 表示重置) */
  async updateViewportFromRenderer(
    tabId: string,
    viewport: BrowserViewportOverride | null,
    windowId: number,
    desktopZoomFactor = 1,
  ): Promise<void> {
    const record = this.tabs.get(tabId)
    if (!record || record.lifecycle === "closed" || record.owner.windowId !== windowId) {
      throw new Error(`browser tab '${tabId}' is unavailable for viewport update`)
    }
    if (viewport) {
      assertViewportOverride(viewport)
      record.desktopZoomFactor = normalizeDesktopZoomMetricsScale(desktopZoomFactor)
      await this.setTabViewport(record, viewport)
      return
    }
    await this.resetTabViewport(record)
  }

  /** 读取 tab 归属上下文拷贝(ipc 装配层用) */
  getTabOwner(tabId: string): BrowserOwnerContext | null {
    const owner = this.tabs.get(tabId)?.owner
    return owner ? { ...owner } : null
  }

  /** 渲染器 report-residency:状态/活动上报 + 常驻协调器推进 */
  async reportResidency(report: RendererResidencyReport): Promise<void> {
    const record = this.requireRendererOwnedTab(report)
    record.cachedUrl = report.restoreUrl?.trim() || record.cachedUrl
    if (report.title !== undefined) record.cachedTitle = report.title ?? ""
    if (report.faviconUrl !== undefined) record.cachedFaviconUrl = report.faviconUrl
    record.loading = report.loading
    this.residencyCoordinator.report(record.tabId, {
      selected: report.selected,
      visible: report.visible,
      currentTask: report.currentTask,
      loading: report.loading,
      audible: safeBool(() => record.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: record.mediaActive,
      operationActive: this.hasRunningRequestForTab(record.tabId),
      captureActive: this.isTabCaptureActive(record),
      downloadActive: this.hasPendingDownloadForTab(record.tabId),
    })
    if (report.selected) {
      record.active = true
      if (!record.claimable) this.selectTab(record, false)
    } else {
      record.active = false
      const ownerScope = scopeKey(record.owner)
      if (this.activeTabByScope.get(ownerScope) === record.tabId) this.activeTabByScope.delete(ownerScope)
    }
    await this.persistShell(record)
    await this.residencyCoordinator.whenIdle()
  }

  /** 渲染器 suspend-ready:按 tabId+generation 唤醒挂起确认等待者 */
  acknowledgeSuspend(ack: RendererSuspendAck): void {
    const record = this.tabs.get(ack.tabId)
    if (!record || record.owner.windowId !== ack.windowId) return
    const key = suspendAckKey(ack.tabId, ack.generation)
    this.suspendAckWaiters.get(key)?.()
  }

  /** 渲染器 close-tab-from-renderer */
  async closeTabFromRenderer(request: RendererTabScope): Promise<void> {
    const record = this.tabs.get(request.tabId)
    if (!record || record.lifecycle === "closed") {
      this.closedTabIds.add(request.tabId)
      return
    }
    const owned = this.requireRendererOwnedTab(request)
    await this.closeTabDurably(owned, false)
  }

  /** 恢复存储排空(测试/关窗前同步) */
  async whenRecoveryIdle(): Promise<void> {
    await this.recoveryStore?.whenIdle?.()
  }

  /** 渲染器 ensure-resident:确保 guest 存活(挂起则恢复) */
  async ensureResidentFromRenderer(request: RendererTabScope): Promise<void> {
    const record = this.requireRendererOwnedTab(request)
    if (!(await this.ensureGuest(record, new AbortController().signal))) {
      throw new Error(`browser tab '${record.tabId}' restore failed`)
    }
  }

  /** 渲染器 restore-tabs:按工作区恢复壳记录(多窗口经 restoredTabClaims 互斥) */
  async restoreTabs(request: RendererRestoreTabsRequest): Promise<BrowserRestoredShellView[]> {
    const shells =
      (await this.recoveryStore?.listShells({
        workspaceKey: request.workspaceKey,
        ...(request.remoteSessionId ? { remoteSessionId: request.remoteSessionId } : {}),
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      })) ?? []
    this.deps.log(
      `[browser-use] restoreTabs windowId=${request.windowId} workspaceKey=${request.workspaceKey} remoteSessionId=${request.remoteSessionId ?? "<local>"} sessionId=${request.sessionId ?? "<all>"} records=${shells.length}`,
    )
    const restored: BrowserRestoredShellView[] = []
    for (const shell of shells) {
      if (this.closedTabIds.has(shell.tabId)) continue
      const claimedWindowId = this.restoredTabClaims.get(shell.tabId)
      if (claimedWindowId !== undefined && claimedWindowId !== request.windowId) continue
      this.restoredTabClaims.set(shell.tabId, request.windowId)
      let record = this.tabs.get(shell.tabId)
      if (record) {
        if (record.owner.windowId !== request.windowId) continue
      } else {
        const owner: BrowserOwnerContext = {
          requestId: `restore:${randomUUID()}`,
          browserId: shell.browserId ?? (shell.origin === "user" ? "unclaimed-iab" : "restored-iab"),
          browserGeneration: shell.browserGeneration ?? 0,
          windowId: request.windowId,
          workspaceKey: shell.workspaceKey,
          ...(shell.remoteSessionId ? { remoteSessionId: shell.remoteSessionId } : {}),
          sessionId: shell.sessionId,
          clientMode: "desktop-continuous",
        }
        record = {
          tabId: shell.tabId,
          owner,
          cdpAttached: false,
          guestLifecycle: "detached",
          pendingCdpCommands: 0,
          guestGeneration: 0,
          hasAttachedGuest: false,
          rebindRequested: false,
          lifecycle: shell.lifecycle,
          origin: shell.origin,
          claimable: shell.origin === "user",
          ...(shell.origin === "user" ? { userOwner: { ...owner } } : {}),
          active: false,
          ...(shell.viewport ? { viewportOverride: { ...shell.viewport } } : {}),
          loading: false,
          mediaActive: false,
          cachedUrl: shell.restoreUrl ?? "",
          cachedTitle: shell.title ?? "",
          cachedFaviconUrl: shell.faviconUrl,
          openedAt: shell.openedAt,
          restoredFromStore: true,
        }
        this.tabs.set(shell.tabId, record)
        this.registerTabResidency(record, false, "suspended", shell.lastSelectedAt)
      }
      restored.push(toRestoredShell(shell, record.owner))
    }
    return restored
  }

  /* ────────────────────────────────────────────────────────────────
   * execute / executeInScope —— 请求登记、AbortController、46 命令分发
   * ──────────────────────────────────────────────────────────────── */

  /**
   * 命令执行入口。context 兼容旧版字符串(workspaceKey → legacy 上下文)。
   * cancelRequest/turnEnded/closeSession 三类管理命令不占请求槽;
   * 其余命令登记 runningRequests 并联动外部 signal。
   */
  async execute(
    context: BrowserOwnerContext | string,
    command: BrowserGuestCommand,
    externalSignal?: AbortSignal,
  ): Promise<BrowserCommandResult> {
    const ownerContext = typeof context === "string" ? normalizeLegacyContext(context) : context
    this.deps.log(
      `[browser-use] execute requestId=${ownerContext.requestId} browserId=${ownerContext.browserId} generation=${ownerContext.browserGeneration} windowId=${ownerContext.windowId} sessionId=${ownerContext.sessionId} method=${command.method}`,
    )
    if (this.runningRequests.has(ownerContext.requestId)) {
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "duplicate_request_id",
            message: `browser requestId '${ownerContext.requestId}' is already running`,
            sideEffect: "none",
          },
          elapsedMs: 0,
        },
        ownerContext,
      )
    }
    if (command.method === "cancelRequest") {
      const cancelled = this.abortRequest(command.requestId, ownerContext)
      return this.withMeta({ ok: true, value: { cancelled }, elapsedMs: 0 }, ownerContext)
    }
    if (command.method === "turnEnded") {
      this.endTurn(ownerContext, command.turnId ?? ownerContext.turnId)
      return this.withMeta({ ok: true, elapsedMs: 0 }, ownerContext)
    }
    if (command.method === "closeSession") {
      this.closeSession(ownerContext)
      return this.withMeta({ ok: true, elapsedMs: 0 }, ownerContext)
    }
    const controller = new AbortController()
    const unlinkExternalSignal = linkAbortSignal(externalSignal, controller)
    const request: BrowserRequestEntry = { context: ownerContext, controller, dispatched: false }
    this.runningRequests.set(ownerContext.requestId, request)
    try {
      return await this.executeInScope(ownerContext, command, request)
    } finally {
      unlinkExternalSignal()
      if (this.runningRequests.get(ownerContext.requestId) === request) {
        this.runningRequests.delete(ownerContext.requestId)
      }
      if (request.tabId) this.refreshRuntimeProtection(request.tabId)
    }
  }

  /** scope 内命令分发(46 方法;完整清单见文件头 design doc §2.1) */
  async executeInScope(
    context: BrowserOwnerContext,
    command: BrowserGuestCommand,
    request: BrowserRequestEntry,
  ): Promise<BrowserCommandResult> {
    const startedAt = Date.now()
    if (request.controller.signal.aborted) return this.cancelledResult(context, false, startedAt)
    if (command.method === "list") {
      const tabs = await Promise.all(this.ownedTabs(context).map(record => this.summary(record)))
      return this.withMeta({ ok: true, tabs, elapsedMs: Date.now() - startedAt }, context)
    }
    if (command.method === "listUserTabs") {
      const userTabs = this.openUserTabs(context).map(record => this.userTabInfo(record))
      return this.withMeta({ ok: true, userTabs, elapsedMs: Date.now() - startedAt }, context)
    }
    if (command.method === "nameSession") {
      this.sessionNames.set(scopeKey(context), command.name ?? "")
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context)
    }
    if (command.method === "browserVisibilityGet") {
      return this.withMeta(
        { ok: true, value: this.visibilityByScope.get(scopeKey(context)) === true, elapsedMs: Date.now() - startedAt },
        context,
      )
    }
    if (command.method === "browserVisibilitySet") {
      const ownerScope = scopeKey(context)
      this.visibilityByScope.set(ownerScope, command.visible === true)
      const activeTabId = this.activeTabByScope.get(ownerScope)
      const activeTab = activeTabId ? this.tabs.get(activeTabId) : this.ownedTabs(context).at(-1)
      this.onVisibilityChanged(command.visible === true, context, activeTab?.tabId)
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, activeTab)
    }
    if (command.method === "browserViewportSet") {
      const tab = this.resolveTab(context, command.tabId)
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt)
      const viewport = { width: command.width ?? 0, height: command.height ?? 0 }
      await this.setTabViewport(tab, viewport)
      this.selectTab(tab, true)
      this.onViewportChanged(viewport, tab.owner, tab.tabId)
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab)
    }
    if (command.method === "browserViewportReset") {
      const tab = this.resolveTab(context, command.tabId)
      if (!tab) return this.unavailableTabResult(context, command.tabId, startedAt)
      await this.resetTabViewport(tab)
      this.onViewportChanged(null, tab.owner, tab.tabId)
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab)
    }
    if (command.method === "recordingStatus" || command.method === "recordingCancel") {
      const recording = this.recordings.get(command.recordingId ?? "")
      if (!recording || !sameScope(recording.context, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' is unavailable in this context`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        )
      }
      if (command.tabId && command.tabId !== recording.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser recording '${command.recordingId}' does not belong to tab '${command.tabId}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        )
      }
      if (command.method === "recordingCancel" && recording.status === "running") {
        recording.controller.abort(new DOMException("recording cancelled", "AbortError"))
        this.setRecordingTerminal(recording, "cancelled")
      }
      return this.withMeta(
        { ok: true, recording: this.snapshotRecording(recording), elapsedMs: Date.now() - startedAt },
        context,
        this.tabs.get(recording.tabId),
      )
    }
    if (command.method === "activateTab") {
      const tab = this.tabs.get(command.tabId ?? "")
      if (!tab || tab.lifecycle === "closed" || !sameScope(tab.owner, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' is unavailable for activation. ${STALE_BINDING_RECOVERY_HINT}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        )
      }
      request.tabId = tab.tabId
      this.refreshRuntimeProtection(tab.tabId)
      const guest = await this.ensureGuest(tab, request.controller.signal)
      if (!guest || safeBool(() => guest.isDestroyed(), true)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `browser tab '${command.tabId}' could not be restored for activation`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        )
      }
      this.selectTab(tab, true)
      return this.withMeta(
        { ok: true, tab: await this.summary(tab), elapsedMs: Date.now() - startedAt },
        context,
        tab,
      )
    }
    if (command.method === "claimTab") {
      const tab = this.tabs.get(command.tabId ?? "")
      if (!tab || !this.canClaimUserTab(tab, context)) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `user browser tab '${command.tabId}' is unavailable or already claimed`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        )
      }
      const claimed = this.claimTab(tab, context)
      return this.withMeta(
        { ok: true, tab: await this.summary(claimed), elapsedMs: Date.now() - startedAt },
        context,
        claimed,
      )
    }
    if (command.method === "finalizeTabs") {
      const decisions = new Map<string, BrowserLifecycle>(
        (command.keep ?? []).map(entry => [entry.tabId, entry.status]),
      )
      const unknownTabIds = [...decisions.keys()].filter(
        tabId => !this.ownedTabs(context).some(record => record.tabId === tabId),
      )
      if (unknownTabIds.length > 0) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: `cannot finalize unknown tab(s): ${unknownTabIds.join(", ")}`,
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
        )
      }
      this.finalizeTabs(context, decisions)
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context)
    }
    if (command.method === "newTab") {
      const tab = this.createTab(context)
      request.tabId = tab.tabId
      this.refreshRuntimeProtection(tab.tabId)
      if (!(await this.ensureGuest(tab, request.controller.signal))) {
        const failure = this.cancelledOrUnavailable(context, request, startedAt, tab)
        await this.closeTabDurably(tab)
        return this.withMeta(failure, context, tab, "closed")
      }
      return this.withMeta(
        { ok: true, tab: await this.summary(tab), elapsedMs: Date.now() - startedAt },
        context,
        tab,
      )
    }
    const tab = this.resolveTab(context, command.tabId)
    if (!tab) {
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "backend_unavailable",
            message: command.tabId
              ? `browser tab '${command.tabId}' is not visible in the current context. ${STALE_BINDING_RECOVERY_HINT}`
              : "browser tab is unavailable",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
      )
    }
    request.tabId = tab.tabId
    this.refreshRuntimeProtection(tab.tabId)
    if (command.method === "recordingStart") {
      const running = [...this.recordings.values()].find(
        entry => entry.tabId === tab.tabId && entry.status === "running",
      )
      if (running) {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "execution_error",
              message: `browser tab '${tab.tabId}' already has active recording '${running.id}'`,
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        )
      }
      const recording = this.createRecordingEntry(context, tab)
      this.recordings.set(recording.id, recording)
      this.refreshRuntimeProtection(tab.tabId)
      this.runRecording(recording, tab, command.options).catch(error => {
        if (recording.status !== "running") return
        if (
          recording.controller.signal.aborted &&
          recording.controller.signal.reason instanceof DOMException &&
          recording.controller.signal.reason.name === "TimeoutError"
        ) {
          this.setRecordingTerminal(recording, "failed", recording.controller.signal.reason.message)
        } else if (recording.controller.signal.aborted) {
          this.setRecordingTerminal(recording, "cancelled")
        } else {
          this.setRecordingTerminal(recording, "failed", error instanceof Error ? error.message : String(error))
        }
      })
      return this.withMeta(
        { ok: true, recording: this.snapshotRecording(recording), elapsedMs: Date.now() - startedAt },
        context,
        tab,
      )
    }
    if (command.method === "getDialog") {
      return this.withMeta(
        { ok: true, dialog: this.pendingDialogs.get(tab.tabId) ?? null, elapsedMs: Date.now() - startedAt },
        context,
        tab,
      )
    }
    if (command.method === "close") {
      await this.closeTabDurably(tab)
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab, "closed")
    }
    if (command.method === "finalize") {
      tab.lifecycle = command.deliverable === false ? "active" : "deliverable"
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab)
    }
    if (command.method === "markDeliverable") {
      tab.lifecycle = "deliverable"
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab)
    }
    if (command.method === "markHandoff") {
      tab.lifecycle = "handoff"
      return this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab)
    }
    if (command.method === "playwrightWaitForTimeout") {
      const elapsed = await waitForDelay(command.timeoutMs ?? 0, request.controller.signal)
      return elapsed
        ? this.withMeta({ ok: true, elapsedMs: Date.now() - startedAt }, context, tab)
        : this.withMeta(this.cancelledResult(context, false, startedAt), context, tab)
    }
    if (
      command.method === "playwright" &&
      (command.action?.name === "fileChooserSetFiles" ||
        (command.action?.name === "waitForEvent" && command.action.event === "filechooser"))
    ) {
      return this.withMeta(
        {
          ok: false,
          error: { code: "capability_unsupported", message: "File uploads are not supported by iab" },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      )
    }
    if (command.method === "playwright" && command.action?.name === "downloadPath") {
      const download = this.downloads.get(command.action.downloadId ?? "")
      if (!download || download.tabId !== tab.tabId) {
        return this.withMeta(
          {
            ok: false,
            error: { code: "backend_unavailable", message: "download is unavailable for this tab" },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        )
      }
      const outcome = await waitForCondition(
        () => download.state !== "pending",
        command.action.timeoutMs ?? 30000,
        request.controller.signal,
      )
      if (outcome === "cancelled") {
        return this.withMeta(this.cancelledResult(context, false, startedAt), context, tab)
      }
      if (outcome === "timeout") {
        return this.withMeta(
          { ok: false, error: { code: "timeout", message: "Timeout waiting for download path" }, elapsedMs: Date.now() - startedAt },
          context,
          tab,
        )
      }
      if (download.state !== "completed") {
        return this.withMeta(
          {
            ok: false,
            error: { code: "execution_error", message: `download ${download.state}`, sideEffect: "uncertain" },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        )
      }
      return this.withMeta(
        { ok: true, value: download.path, elapsedMs: Date.now() - startedAt },
        context,
        tab,
      )
    }
    const guest = await this.ensureGuest(tab, request.controller.signal)
    if (!guest) return this.cancelledOrUnavailable(context, request, startedAt, tab)
    if (safeBool(() => guest.isDestroyed(), false)) {
      this.detachGuest(tab)
      return this.withMeta(
        {
          ok: false,
          error: { code: "backend_unavailable", message: "browser guest destroyed" },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      )
    }
    const guestGeneration = tab.guestGeneration
    // assertCurrentGuest:每次 CDP 派发前校验 guest 未被替换/销毁
    const assertCurrentGuest = (): void => {
      if (tab.guestLifecycle === "detaching") throw new Error("browser guest is detaching")
      if (tab.guest !== guest || tab.guestGeneration !== guestGeneration || safeBool(() => guest.isDestroyed(), true)) {
        throw new Error("browser guest changed before command dispatch")
      }
    }
    const sendCdpCommand = (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ): Promise<unknown> => this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest)
    if (command.method === "playwright" && command.action?.name === "waitForEvent" && command.action.event === "download") {
      const downloadId = await this.waitForDownload(
        tab.tabId,
        normalizePlaywrightTimeout(command.action.timeoutMs, 120000),
        request.controller.signal,
      )
      if (!downloadId) {
        const result: BrowserCommandResult = request.controller.signal.aborted
          ? this.cancelledResult(context, false, startedAt)
          : { ok: false, error: { code: "timeout", message: "Timeout waiting for download" }, elapsedMs: Date.now() - startedAt }
        return this.withMeta(result, context, tab)
      }
      return this.withMeta(
        { ok: true, value: { id: downloadId }, elapsedMs: Date.now() - startedAt },
        context,
        tab,
      )
    }
    if (command.method === "handleDialog") {
      try {
        assertCurrentGuest()
      } catch {
        return this.withMeta(
          {
            ok: false,
            error: {
              code: "backend_unavailable",
              message: "browser guest changed before command dispatch",
              sideEffect: "none",
            },
            elapsedMs: Date.now() - startedAt,
          },
          context,
          tab,
        )
      }
      request.dispatched = true
      const dialogOutcome: Promise<BrowserCommandResult> = sendCdpCommand("Page.handleJavaScriptDialog", {
        accept: command.accept === true,
        ...(command.promptText !== undefined ? { promptText: command.promptText } : {}),
      })
        .then(() => ({ ok: true, elapsedMs: Date.now() - startedAt }))
        .catch((error: unknown) => ({
          ok: false,
          error: { code: "execution_error", message: error instanceof Error ? error.message : String(error) },
          elapsedMs: Date.now() - startedAt,
        }))
      const raced = await raceBackendExecution(dialogOutcome, request.controller.signal, command, startedAt)
      if (raced.ok) this.pendingDialogs.delete(tab.tabId)
      return this.withMeta(raced, context, tab)
    }
    const screenshotCommand = isScreenshotCommand(command)
    const inFlight = screenshotCommand ? this.inFlightScreenshots.get(tab.tabId) : undefined
    if (inFlight) {
      // 同 tab 已有在途截图 → 直接返回 timeout,防止叠加截图
      const pendingMs = Date.now() - inFlight.startedAt
      this.deps.log(
        `[browser-use] screenshot rejected tabId=${tab.tabId} requestId=${context.requestId} pendingRequestId=${inFlight.requestId} pendingMs=${pendingMs}`,
      )
      return this.withMeta(
        {
          ok: false,
          error: {
            code: "timeout",
            message:
              "A previous screenshot for this browser tab is still completing after timeout. Wait before retrying, or reopen the tab if it does not recover.",
            sideEffect: "none",
          },
          elapsedMs: Date.now() - startedAt,
        },
        context,
        tab,
      )
    }
    const execution: Promise<BrowserCommandResult> = screenshotCommand
      ? this.executeScreenshotWithPreparedSurface(
          context,
          tab,
          guest,
          command,
          request,
          startedAt,
          assertCurrentGuest,
          sendCdpCommand,
        )
      : this.getCommandExecutor()(
          this.toControlledView(
            guest,
            !!(tab.viewportOverride || tab.backgroundViewportFallback),
            undefined,
            assertCurrentGuest,
            sendCdpCommand,
          ),
          command,
          { signal: request.controller.signal },
        )
    if (!screenshotCommand) request.dispatched = true
    if (screenshotCommand) {
      const tracked: InFlightScreenshotEntry = {
        execution,
        requestId: context.requestId,
        startedAt: Date.now(),
      }
      this.inFlightScreenshots.set(tab.tabId, tracked)
      this.refreshRuntimeProtection(tab.tabId)
      const clearTrackedScreenshot = (): void => {
        if (this.inFlightScreenshots.get(tab.tabId) !== tracked) return
        this.inFlightScreenshots.delete(tab.tabId)
        this.refreshRuntimeProtection(tab.tabId)
        this.deps.log(
          `[browser-use] screenshot backend settled tabId=${tab.tabId} requestId=${context.requestId} elapsedMs=${Date.now() - tracked.startedAt}`,
        )
      }
      execution.then(clearTrackedScreenshot, clearTrackedScreenshot)
    }
    const raced = await raceBackendExecution(execution, request.controller.signal, command, startedAt)
    return this.withMeta(raced, context, tab)
  }

  /* ────────────────────────────────────────────────────────────────
   * 截图 —— surface coordinator prepare + 视口串行化 + CSS 像素归一
   * ──────────────────────────────────────────────────────────────── */

  /** 截图路径:surface prepare 串行进视口队列, 捕获后按需重采样回 CSS 像素 */
  private async executeScreenshotWithPreparedSurface(
    context: BrowserOwnerContext,
    tab: GuestTabRecord,
    guest: WebContents,
    command: BrowserGuestCommand,
    request: BrowserRequestEntry,
    startedAt: number,
    assertCurrentGuest: () => void,
    sendCdpCommand: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>,
  ): Promise<BrowserCommandResult> {
    let lease: ScreenshotSurfaceLease | undefined
    try {
      const coordinator = this.deps.screenshotSurfaceCoordinator
      if (!coordinator) throw new Error("browser screenshot surface coordinator is unavailable")
      const viewport = await this.readTabViewport(tab)
      let result: BrowserCommandResult | undefined
      await this.enqueueViewportMutation(tab, async () => {
        lease = await coordinator.prepare({
          requestId: context.requestId,
          windowId: context.windowId,
          workspaceKey: context.workspaceKey,
          sessionId: context.sessionId,
          browserId: context.browserId,
          browserGeneration: context.browserGeneration,
          tabId: tab.tabId,
          webContentsId: guest.id,
          viewport,
          signal: request.controller.signal,
        })
        if (
          request.controller.signal.aborted ||
          tab.guest !== guest ||
          guest.isDestroyed() ||
          lease.webContentsId !== guest.id
        ) {
          throw new Error("browser guest changed while preparing screenshot surface")
        }
        const invalidation = readScreenshotSurfaceInvalidation(lease.invalidated)
        if (invalidation) throw invalidation
        const needsNormalization = !!(tab.viewportOverride || tab.backgroundViewportFallback)
        // surfaceScale<1 时捕获后重采样回 CSS 像素
        const captureNormalizedScreenshot =
          needsNormalization && lease.surfaceScale < 0.999
            ? async (): Promise<string | undefined> => {
                if (!this.deps.resizeScreenshotToCssPixels) {
                  throw new Error("browser screenshot CSS pixel normalizer is unavailable")
                }
                const png = (await guest.capturePage()).toPNG()
                if (png.byteLength !== 0) {
                  return this.deps.resizeScreenshotToCssPixels(png.toString("base64"), viewport)
                }
                return undefined
              }
            : undefined
        request.dispatched = true
        result = await this.getCommandExecutor()(
          this.toControlledView(guest, needsNormalization, captureNormalizedScreenshot, assertCurrentGuest, sendCdpCommand),
          command,
          { signal: request.controller.signal },
        )
        const postInvalidation = readScreenshotSurfaceInvalidation(lease.invalidated)
        if (postInvalidation) throw postInvalidation
      })
      if (!result) throw new Error("browser screenshot did not produce a result")
      return result
    } catch (error) {
      const aborted = request.controller.signal.aborted
      return {
        ok: false,
        error: {
          code: aborted ? "cancelled" : "backend_unavailable",
          message: aborted
            ? "browser screenshot surface preparation cancelled"
            : error instanceof Error
              ? error.message
              : String(error),
          sideEffect: "none",
        },
        elapsedMs: Date.now() - startedAt,
      }
    } finally {
      lease?.release()
    }
  }

  /* ────────────────────────────────────────────────────────────────
   * 录制 —— 条目管理 + runRecording + 场景动作 + 光标 overlay + 滚动动画
   * ──────────────────────────────────────────────────────────────── */

  private recordingNow(): number {
    // ZCode 原为 residencyOptions.recording.now, 并入 deps.now(见头注偏差 3)
    return this.deps.now?.() ?? Date.now()
  }

  private createRecordingEntry(context: BrowserOwnerContext, tab: GuestTabRecord): BrowserRecordingRecord {
    const now = this.recordingNow()
    return {
      id: `iab-recording:${randomUUID()}`,
      context: { ...context },
      tabId: tab.tabId,
      controller: new AbortController(),
      status: "running",
      phase: "preparing",
      progress: 0,
      startedAt: now,
      updatedAt: now,
    }
  }

  private snapshotRecording(recording: BrowserRecordingRecord): BrowserRecordingSnapshot {
    return {
      id: recording.id,
      status: recording.status,
      phase: recording.phase,
      progress: recording.progress,
      startedAt: recording.startedAt,
      updatedAt: recording.updatedAt,
      ...(recording.artifact ? { artifact: { ...recording.artifact } } : {}),
      ...(recording.error ? { error: recording.error } : {}),
    }
  }

  private setRecordingPhase(recording: BrowserRecordingRecord, phase: BrowserRecordingRecord["phase"]): void {
    if (recording.status !== "running") return
    recording.phase = phase
    recording.progress = phase === "capturing" ? 0.1 : 0.9
    recording.updatedAt = this.recordingNow()
    this.refreshRuntimeProtection(recording.tabId)
  }

  private setRecordingTerminal(
    recording: BrowserRecordingRecord,
    status: BrowserRecordingRecord["status"],
    error?: string,
  ): void {
    recording.status = status
    recording.phase = status === "running" ? recording.phase : status
    recording.progress = status === "completed" ? 1 : recording.progress
    recording.updatedAt = this.recordingNow()
    if (error) recording.error = error
    else recording.error = undefined
    if (!recording.cleanupTimer) {
      recording.cleanupTimer = setTimeout(() => {
        this.recordings.delete(recording.id)
        if (recording.artifact?.path) void rm(recording.artifact.path, { force: true }).catch(() => {})
      }, RECORDING_ARTIFACT_CLEANUP_DELAY_MS)
      recording.cleanupTimer.unref?.()
    }
    this.refreshRuntimeProtection(recording.tabId)
  }

  private abortRecordings(predicate: (recording: BrowserRecordingRecord) => boolean, reason: string): void {
    for (const recording of this.recordings.values()) {
      if (recording.status !== "running" || !predicate(recording)) continue
      recording.controller.abort(new DOMException(reason, "AbortError"))
      this.setRecordingTerminal(recording, "cancelled")
    }
  }

  /** 录制主飞行:视口设定→surface prepare(unscaled)→超时/失效联动→场景执行→产物落盘 */
  private async runRecording(
    recording: BrowserRecordingRecord,
    tab: GuestTabRecord,
    options?: BrowserRecordingStartOptions,
  ): Promise<void> {
    const signal = recording.controller.signal
    const scenario = options ?? {}
    const viewport = scenario.viewport ?? { ...RECORDING_VIEWPORT }
    const fps = scenario.fps ?? 25
    const maxDurationMs = scenario.maxDurationMs ?? 60000
    const settleMs = scenario.settleMs ?? 300
    assertViewportOverride(viewport)
    const guest = await this.ensureGuest(tab, signal)
    if (!guest || guest.isDestroyed()) throw new Error("browser guest unavailable for recording")
    const previousViewportOverride = tab.viewportOverride ? { ...tab.viewportOverride } : undefined
    let lease: ScreenshotSurfaceLease | undefined
    let maxDurationTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await this.setTabViewport(tab, viewport)
      this.onViewportChanged(viewport, tab.owner, tab.tabId)
      const coordinator = this.deps.screenshotSurfaceCoordinator
      if (!coordinator) throw new Error("browser recording surface coordinator is unavailable")
      lease = await coordinator.prepare({
        requestId: `recording:${recording.id}`,
        windowId: recording.context.windowId,
        workspaceKey: recording.context.workspaceKey,
        sessionId: recording.context.sessionId,
        browserId: recording.context.browserId,
        browserGeneration: recording.context.browserGeneration,
        tabId: tab.tabId,
        webContentsId: guest.id,
        viewport,
        surfaceScaleMode: "unscaled",
        signal,
        activityTimeoutMs: maxDurationMs + 30000,
      })
      if (!lease || lease.webContentsId !== guest.id) {
        throw new Error("browser guest changed while preparing recording surface")
      }
      const preparedInvalidation = readScreenshotSurfaceInvalidation(lease.invalidated)
      if (preparedInvalidation) throw preparedInvalidation
      const invalidated = lease.invalidated
      const invalidateRecording = (): void => {
        recording.controller.abort(
          invalidated.reason instanceof Error ? invalidated.reason : new Error("browser recording surface invalidated"),
        )
      }
      invalidated.addEventListener("abort", invalidateRecording, { once: true })
      // 超时经 controller.abort(TimeoutError) 传播, finally 里恢复视口/释放 surface
      maxDurationTimer = setTimeout(
        () => recording.controller.abort(new DOMException("browser recording timed out", "TimeoutError")),
        maxDurationMs,
      )
      const recordingGeneration = tab.guestGeneration
      const assertCurrentGuest = (): void => {
        if (tab.guestLifecycle === "detaching") throw new Error("browser guest is detaching")
        if (
          tab.guest !== guest ||
          tab.guestGeneration !== recordingGeneration ||
          safeBool(() => guest.isDestroyed(), true)
        ) {
          throw new Error("browser guest changed before recording dispatch")
        }
      }
      const view = this.toControlledView(
        guest,
        true,
        undefined,
        assertCurrentGuest,
        (method, params, sessionId) => this.sendGuestCdpCommand(tab, guest, method, params, sessionId, assertCurrentGuest),
      )
      if (scenario.showCursor !== false) await this.installRecordingCursorOverlay(guest)
      const createRecorder = this.deps.recording?.createRecorder
      if (!createRecorder) throw new Error("browser WebM recorder is unavailable")
      recording.artifact = await recordBrowserVideo({
        targetFrame: guest.mainFrame,
        tempRoot: this.deps.recording?.tempRoot ?? tmpdir(),
        recordingId: recording.id.replace(/[^A-Za-z0-9._-]/gu, "-"),
        viewport,
        fps,
        signal,
        onPhase: phase => this.setRecordingPhase(recording, phase),
        onCaptureComplete: () => {
          if (maxDurationTimer) {
            clearTimeout(maxDurationTimer)
            maxDurationTimer = undefined
          }
          lease?.release()
        },
        executeScenario: async () => {
          if (settleMs > 0 && !(await waitForDelay(settleMs, signal))) throw abortError()
          await this.executeRecordingActions(view, scenario.actions ?? [], signal, viewport)
        },
        createRecorder,
      })
      this.setRecordingTerminal(recording, "completed")
    } finally {
      if (maxDurationTimer) clearTimeout(maxDurationTimer)
      if (scenario.showCursor !== false) await this.removeRecordingCursorOverlay(guest)
      await this.restoreRecordingViewport(tab, previousViewportOverride).catch(() => {})
      lease?.release()
    }
  }

  private async restoreRecordingViewport(
    tab: GuestTabRecord,
    override: BrowserViewportOverride | undefined,
  ): Promise<void> {
    if (tab.lifecycle === "closed") return
    if (override) {
      await this.setTabViewport(tab, override)
      this.onViewportChanged(override, tab.owner, tab.tabId)
      return
    }
    await this.resetTabViewport(tab)
    this.onViewportChanged(null, tab.owner, tab.tabId)
  }

  private async executeRecordingActions(
    view: ControlledView,
    actions: RecordingScenarioAction[],
    signal: AbortSignal,
    viewport: BrowserViewportOverride,
  ): Promise<void> {
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 }
    for (const action of actions) {
      if (signal.aborted) throw abortError()
      await this.executeRecordingAction(view, action, signal, pointer)
      const delayAfterMs = action.delayAfterMs
      if (delayAfterMs && !(await waitForDelay(delayAfterMs, signal))) throw abortError()
    }
  }

  private async executeRecordingAction(
    view: ControlledView,
    action: RecordingScenarioAction,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    if (action.type === "wait") {
      if (!(await waitForDelay(action.durationMs ?? 0, signal))) throw abortError()
      return
    }
    if (action.type === "click" || action.type === "type" || action.type === "waitFor") {
      const locatorAction =
        action.type === "click"
          ? action.selector
            ? {
                name: "locator",
                selector: action.selector,
                operation: action.doubleClick ? "dblclick" : "click",
                ...(action.button ? { button: action.button } : {}),
              }
            : undefined
          : action.type === "type"
            ? { name: "locator", selector: action.selector, operation: "fill", value: action.text }
            : {
                name: "locator",
                selector: action.selector,
                operation: "waitFor",
                state: action.state ?? "visible",
              }
      if (locatorAction) {
        // 选择器动作复用 playwright locator 执行器(A4 端口 ca)
        const outcome = await this.getLocatorExecutor()(
          view,
          locatorAction,
          action.type === "waitFor" ? action.timeoutMs ?? 3000 : 3000,
          signal,
        )
        if (outcome.kind === "cancelled") throw abortError()
        if (outcome.kind === "timeout") throw new Error(`recording action timed out: ${outcome.reason}`)
        return
      }
      if (typeof action.x !== "number" || typeof action.y !== "number") {
        throw new Error("recording click requires selector or (x,y)")
      }
      await this.executeRecordingBrowserCommand(view, {
        method: "click",
        x: action.x,
        y: action.y,
        ...(action.button ? { button: action.button } : {}),
        ...(action.doubleClick !== undefined ? { doubleClick: action.doubleClick } : {}),
      })
      pointer.x = action.x
      pointer.y = action.y
      return
    }
    if (action.type === "hover") {
      if (action.selector) {
        const point = await this.resolveRecordingSelectorPoint(view, action.selector, signal)
        await this.moveRecordingPointer(view, point.x, point.y, action.durationMs ?? 0, signal, pointer)
      } else if (typeof action.x === "number" && typeof action.y === "number") {
        await this.moveRecordingPointer(view, action.x, action.y, action.durationMs ?? 0, signal, pointer)
      } else {
        throw new Error("recording hover requires selector or (x,y)")
      }
      return
    }
    if (action.type === "move") {
      await this.moveRecordingPointer(view, action.x ?? 0, action.y ?? 0, action.durationMs ?? 0, signal, pointer)
      return
    }
    if (action.type === "scroll") {
      await this.animateRecordingScroll(view, action.deltaX ?? 0, action.deltaY ?? 0, action.durationMs ?? 0, signal)
      return
    }
    if (action.type === "scrollTo") {
      const current = (await view.webContents.executeJavaScript("({ x: window.scrollX, y: window.scrollY })")) as {
        x?: unknown
        y?: unknown
      }
      const currentX = Number(current?.x ?? 0)
      const currentY = Number(current?.y ?? 0)
      const target = action.selector
        ? await this.resolveRecordingSelectorScrollTarget(view, action.selector, signal)
        : { x: action.x ?? currentX, y: action.y ?? currentY }
      await this.animateRecordingScroll(view, target.x - currentX, target.y - currentY, action.durationMs ?? 0, signal)
      return
    }
    if (action.type === "wheel") {
      const times = action.times ?? 1
      for (let index = 0; index < times; index += 1) {
        await this.executeRecordingBrowserCommand(view, {
          method: "scroll",
          x: action.deltaX ?? 0,
          y: action.deltaY ?? 0,
        })
        if (action.intervalMs && !(await waitForDelay(action.intervalMs, signal))) throw abortError()
      }
      return
    }
    if (action.type === "drag") {
      const path = action.path ?? []
      const segmentCount = Math.max(1, path.length - 1)
      const segmentDelayMs = Math.floor((action.durationMs ?? 0) / segmentCount)
      const start = path[0]
      await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y })
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: start.x,
        y: start.y,
        button: "left",
        clickCount: 1,
      })
      for (const point of path.slice(1)) {
        await view.cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
        })
        if (segmentDelayMs > 0 && !(await waitForDelay(segmentDelayMs, signal))) throw abortError()
      }
      const last = path.at(-1)
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: last.x,
        y: last.y,
        button: "left",
        clickCount: 1,
      })
      pointer.x = last.x
      pointer.y = last.y
    }
  }

  private async executeRecordingBrowserCommand(
    view: ControlledView,
    command: BrowserGuestCommand,
  ): Promise<void> {
    const result = await this.getCommandExecutor()(view, command)
    if (!result.ok) throw new Error(result.error?.message ?? `recording action ${command.method} failed`)
  }

  private async resolveRecordingSelectorPoint(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const outcome = await this.getLocatorExecutor()(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
      },
      3000,
      signal,
    )
    if (outcome.kind !== "done" || !isBrowserPointValue(outcome.value)) {
      throw new Error(`recording selector '${selector}' has no visible point`)
    }
    return outcome.value
  }

  private async resolveRecordingSelectorScrollTarget(
    view: ControlledView,
    selector: string,
    signal: AbortSignal,
  ): Promise<{ x: number; y: number }> {
    const outcome = await this.getLocatorExecutor()(
      view,
      {
        name: "locator",
        selector,
        operation: "evaluate",
        expressionKind: "function",
        expression:
          "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
      },
      3000,
      signal,
    )
    if (outcome.kind !== "done" || !isBrowserPointValue(outcome.value)) {
      throw new Error(`recording selector '${selector}' has no scroll target`)
    }
    return outcome.value
  }

  private async moveRecordingPointer(
    view: ControlledView,
    x: number,
    y: number,
    durationMs: number,
    signal: AbortSignal,
    pointer: { x: number; y: number },
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)))
    const startX = pointer.x
    const startY = pointer.y
    for (let step = 1; step <= steps; step += 1) {
      if (signal.aborted) throw abortError()
      const progress = step / steps
      await view.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX + (x - startX) * progress,
        y: startY + (y - startY) * progress,
      })
      if (durationMs > 0 && step < steps && !(await waitForDelay(durationMs / steps, signal))) throw abortError()
    }
    pointer.x = x
    pointer.y = y
  }

  private async installRecordingCursorOverlay(guest: WebContents): Promise<void> {
    await guest.executeJavaScript(`(() => {
      const id = "__zcode_browser_recording_cursor";
      document.getElementById(id)?.remove();
      const cursor = document.createElement("div");
      cursor.id = id;
      cursor.style.cssText = "position:fixed;left:0;top:0;width:18px;height:18px;border-radius:50%;background:#ff4d4f;border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;z-index:2147483647;transform:translate(-50%,-50%);opacity:0;transition:opacity 80ms linear";
      document.documentElement.appendChild(cursor);
      const move = (event) => {
        cursor.style.left = event.clientX + "px";
        cursor.style.top = event.clientY + "px";
        cursor.style.opacity = "1";
      };
      const down = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(.72)";
      };
      const up = () => {
        cursor.style.transform = "translate(-50%,-50%) scale(1)";
      };
      window["__zcodeBrowserRecordingCursorCleanup"]?.();
      window.addEventListener("mousemove", move, true);
      window.addEventListener("mousedown", down, true);
      window.addEventListener("mouseup", up, true);
      window["__zcodeBrowserRecordingCursorCleanup"] = () => {
        window.removeEventListener("mousemove", move, true);
        window.removeEventListener("mousedown", down, true);
        window.removeEventListener("mouseup", up, true);
        cursor.remove();
        delete window["__zcodeBrowserRecordingCursorCleanup"];
      };
    })()`)
  }

  private async removeRecordingCursorOverlay(guest: WebContents): Promise<void> {
    if (guest.isDestroyed()) return
    await guest.executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()').catch(() => {})
  }

  private async animateRecordingScroll(
    view: ControlledView,
    deltaX: number,
    deltaY: number,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)))
    for (let step = 0; step < steps; step += 1) {
      await this.executeRecordingBrowserCommand(view, { method: "scroll", x: deltaX / steps, y: deltaY / steps })
      if (durationMs > 0 && step + 1 < steps && !(await waitForDelay(durationMs / steps, signal))) throw abortError()
    }
  }

  /* ────────────────────────────────────────────────────────────────
   * tab 管理 —— resolveTab / createTab / ownedTabs / claim / select /
   * release / finalize / summary / viewport 读取
   * ──────────────────────────────────────────────────────────────── */

  /** tab 定位:显式 tabId → 活动 tab → 缺省 tab → 最后一个归属 tab → 兜底创建 */
  private resolveTab(context: BrowserOwnerContext, tabId?: string): GuestTabRecord | undefined {
    if (tabId) {
      const record = this.tabs.get(tabId)
      if (!record || record.lifecycle === "closed" || !sameScope(record.owner, context)) return undefined
      return record
    }
    const ownerScope = scopeKey(context)
    const activeTabId = this.activeTabByScope.get(ownerScope)
    const activeTab = activeTabId ? this.tabs.get(activeTabId) : undefined
    if (activeTab && activeTab.lifecycle !== "closed" && sameScope(activeTab.owner, context)) return activeTab
    const defaultTabId = this.defaultTabByScope.get(ownerScope)
    const defaultTab = defaultTabId ? this.tabs.get(defaultTabId) : undefined
    if (defaultTab && defaultTab.lifecycle !== "closed" && sameScope(defaultTab.owner, context)) return defaultTab
    const lastOwned = this.ownedTabs(context).at(-1)
    // 无任何候选时兜底 createTab(legacy 用 sessionId 作 tabId)
    return lastOwned || this.createTab(context, context.legacy ? context.sessionId : undefined, true)
  }

  /** 创建 tab(默认带 DH 1280x720 viewportOverride) */
  private createTab(context: BrowserOwnerContext, tabId?: string, setDefault = false): GuestTabRecord {
    const resolvedTabId = tabId ?? `iab-tab:${randomUUID()}`
    const existing = this.tabs.get(resolvedTabId)
    if (existing && existing.lifecycle !== "closed" && sameScope(existing.owner, context)) return existing
    const record: GuestTabRecord = {
      tabId: resolvedTabId,
      owner: { ...context },
      cdpAttached: false,
      guestLifecycle: "detached",
      pendingCdpCommands: 0,
      guestGeneration: 0,
      hasAttachedGuest: false,
      rebindRequested: false,
      lifecycle: "active",
      origin: "agent",
      claimable: false,
      active: false,
      loading: false,
      mediaActive: false,
      cachedUrl: "",
      cachedTitle: "",
      cachedFaviconUrl: null,
      openedAt: this.now(),
      viewportOverride: { ...RECORDING_VIEWPORT },
    }
    this.tabs.set(resolvedTabId, record)
    this.registerTabResidency(record, false)
    this.persistShell(record)
    if (setDefault) this.defaultTabByScope.set(scopeKey(context), resolvedTabId)
    return record
  }

  private ownedTabs(context: BrowserOwnerContext): GuestTabRecord[] {
    return [...this.tabs.values()].filter(record => record.lifecycle !== "closed" && sameScope(record.owner, context))
  }

  private canClaimUserTab(tab: GuestTabRecord, context: BrowserOwnerContext): boolean {
    return (
      tab.origin === "user" &&
      tab.claimable &&
      tab.lifecycle !== "closed" &&
      tab.owner.windowId === context.windowId &&
      tab.owner.workspaceKey === context.workspaceKey &&
      (tab.owner.remoteSessionId ?? "") === (context.remoteSessionId ?? "") &&
      tab.owner.sessionId === context.sessionId
    )
  }

  private openUserTabs(context: BrowserOwnerContext): GuestTabRecord[] {
    return [...this.tabs.values()]
      .filter(record => this.canClaimUserTab(record, context) && this.hasDiscoverableUserPage(record))
      .sort((a, b) => Number(b.active) - Number(a.active))
  }

  private hasDiscoverableUserPage(tab: GuestTabRecord): boolean {
    const guest = tab.guest
    const url = guest ? safeStr(() => guest.getURL(), tab.cachedUrl).trim() : tab.cachedUrl.trim()
    return url.length > 0 && url !== "about:blank"
  }

  private claimTab(tab: GuestTabRecord, context: BrowserOwnerContext): GuestTabRecord {
    if (this.canClaimUserTab(tab, context)) {
      tab.owner = { ...context }
      tab.claimable = false
      if (tab.active) this.selectTab(tab, false)
      this.deps.log(`[browser-use] claim human tab tabId=${tab.tabId} windowId=${context.windowId} sessionId=${context.sessionId}`)
    }
    return tab
  }

  /** 选中 tab:同 scope 全部 tab 重算 active 并上报常驻协调器 */
  private selectTab(tab: GuestTabRecord, notifyVisibility: boolean): void {
    const ownerScope = scopeKey(tab.owner)
    for (const candidate of this.tabs.values()) {
      if (!sameScope(candidate.owner, tab.owner)) continue
      candidate.active = candidate.tabId === tab.tabId
      this.residencyCoordinator.report(candidate.tabId, { selected: candidate.tabId === tab.tabId })
    }
    this.activeTabByScope.set(ownerScope, tab.tabId)
    if (notifyVisibility) {
      this.visibilityByScope.set(ownerScope, true)
      this.onVisibilityChanged(true, tab.owner, tab.tabId)
    }
  }

  /** 释放 tab 给用户(unclaimed 形态, 可被 claimTab 认领) */
  private releaseToUser(tab: GuestTabRecord): void {
    if (tab.claimable) return
    if (!tab.userOwner) {
      tab.userOwner = {
        ...tab.owner,
        requestId: `unclaimed:${randomUUID()}`,
        browserId: "unclaimed-iab",
        browserGeneration: 0,
        turnId: undefined,
      }
    }
    const ownerScope = scopeKey(tab.owner)
    if (this.activeTabByScope.get(ownerScope) === tab.tabId) this.activeTabByScope.delete(ownerScope)
    if (this.defaultTabByScope.get(ownerScope) === tab.tabId) this.defaultTabByScope.delete(ownerScope)
    tab.owner = { ...tab.userOwner }
    tab.origin = "user"
    tab.claimable = true
    tab.lifecycle = "active"
  }

  private finalizeTabs(context: BrowserOwnerContext, decisions: Map<string, BrowserLifecycle>): void {
    for (const record of this.tabs.values()) {
      if (!sameScope(record.owner, context)) continue
      const status = decisions.get(record.tabId)
      if (status === "handoff") record.lifecycle = status
      else if (status === "deliverable") {
        record.lifecycle = status
        this.releaseToUser(record)
      }
    }
  }

  private effectiveActiveTabId(context: BrowserOwnerContext): string | undefined {
    const ownerScope = scopeKey(context)
    const activeTabId = this.activeTabByScope.get(ownerScope)
    const activeTab = activeTabId ? this.tabs.get(activeTabId) : undefined
    if (activeTab && activeTab.lifecycle !== "closed") return activeTabId
    for (const record of this.tabs.values()) {
      if (record.active && record.lifecycle !== "closed" && sameScope(record.owner, context)) return record.tabId
    }
    return this.ownedTabs(context).at(-1)?.tabId
  }

  private async summary(tab: GuestTabRecord): Promise<BrowserTabSummary> {
    const guest = tab.guest
    if (guest) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl)
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle)
    }
    return {
      tabId: tab.tabId,
      url: tab.cachedUrl,
      title: tab.cachedTitle,
      viewport: await this.readTabViewport(tab),
      ...(this.effectiveActiveTabId(tab.owner) === tab.tabId ? { active: true as const } : {}),
      ...(tab.lifecycle !== "active" ? { lifecycle: tab.lifecycle } : {}),
    }
  }

  /** 视口读取:override → 背景回退 → executeJavaScript 实测 → 自然视口夹取回退 */
  private async readTabViewport(tab: GuestTabRecord): Promise<BrowserViewportOverride> {
    if (tab.viewportOverride) return { ...tab.viewportOverride }
    if (tab.backgroundViewportFallback) return { ...tab.backgroundViewportFallback }
    const guest = tab.guest
    if (!guest || safeBool(() => guest.isDestroyed(), true)) return { ...DEFAULT_NATURAL_VIEWPORT }
    const measured = await guest.executeJavaScript("({ width: window.innerWidth, height: window.innerHeight })")
    if (isBrowserViewportSize(measured)) {
      this.naturalViewportByWindow.set(tab.owner.windowId, { ...measured })
      return measured
    }
    const fallback = normalizeBackgroundViewport(
      this.naturalViewportByWindow.get(tab.owner.windowId) ?? DEFAULT_NATURAL_VIEWPORT,
    )
    await this.applyBackgroundViewportFallback(tab, fallback)
    this.deps.log(`[browser-use] applied background viewport fallback tabId=${tab.tabId} width=${fallback.width} height=${fallback.height}`)
    return { ...fallback }
  }

  private userTabInfo(tab: GuestTabRecord): { id: string; url?: string; title?: string } {
    const guest = tab.guest
    if (guest) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl)
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle)
    }
    return {
      id: tab.tabId,
      ...(tab.cachedUrl ? { url: tab.cachedUrl } : {}),
      ...(tab.cachedTitle ? { title: tab.cachedTitle } : {}),
    }
  }

  /** 结果统一附 meta(五元组 + openTabIds + tabId + currentUrl + lifecycle) */
  private withMeta(
    result: BrowserCommandResult,
    context: BrowserOwnerContext,
    tab?: GuestTabRecord,
    lifecycle?: BrowserLifecycle,
  ): BrowserCommandResult {
    const owned = this.ownedTabs(context)
    const guest = tab?.guest
    const currentUrl = tab
      ? sanitizeBrowserMetaUrl(guest ? safeStr(() => guest.getURL(), tab.cachedUrl) : tab.cachedUrl)
      : undefined
    const meta: BrowserResultMeta = {
      browserUse: true,
      backendType: "iab",
      browserId: context.browserId,
      browserGeneration: context.browserGeneration,
      openTabIds: owned.map(record => record.tabId),
      ...(tab ? { tabId: tab.tabId } : {}),
      ...(currentUrl ? { currentUrl } : {}),
      ...(lifecycle ? { lifecycle } : tab ? { lifecycle: tab.lifecycle } : {}),
    }
    return { ...result, meta }
  }

  /** ensureGuest 失败:中止 → cancelled(按 dispatched 判定副作用),否则不可用 */
  private cancelledOrUnavailable(
    context: BrowserOwnerContext,
    request: BrowserRequestEntry,
    startedAt: number,
    tab: GuestTabRecord,
  ): BrowserCommandResult {
    if (request.controller.signal.aborted) {
      return this.withMeta(this.cancelledResult(context, request.dispatched, startedAt), context, tab)
    }
    return this.withMeta(
      {
        ok: false,
        error: { code: "backend_unavailable", message: "browser guest not attached (webview not ready)" },
        elapsedMs: Date.now() - startedAt,
      },
      context,
      tab,
    )
  }

  private unavailableTabResult(
    context: BrowserOwnerContext,
    tabId: string | undefined,
    startedAt: number,
  ): BrowserCommandResult {
    return this.withMeta(
      {
        ok: false,
        error: {
          code: "backend_unavailable",
          message: tabId
            ? `browser tab '${tabId}' is not visible in the current context. ${STALE_BINDING_RECOVERY_HINT}`
            : "browser tab is unavailable",
        },
        elapsedMs: Date.now() - startedAt,
      },
      context,
    )
  }

  private cancelledResult(context: BrowserOwnerContext, dispatched: boolean, startedAt: number): BrowserCommandResult {
    void context
    return {
      ok: false,
      error: {
        code: "cancelled",
        message: dispatched
          ? "browser request cancelled after backend dispatch; side effects may have occurred"
          : "browser request cancelled before backend dispatch",
        sideEffect: dispatched ? "uncertain" : "none",
      },
      elapsedMs: Date.now() - startedAt,
    }
  }

  /** cancelRequest:同 scope 的在途请求中止 */
  private abortRequest(requestId: string | undefined, context: BrowserOwnerContext): boolean {
    const request = this.runningRequests.get(requestId ?? "")
    if (!request || !sameScope(request.context, context)) return false
    request.controller.abort(new DOMException("aborted", "AbortError"))
    return true
  }

  /** turnEnded:中止同 scope/turn 的请求与录制;deliverable/user tab 释放给用户 */
  private endTurn(context: BrowserOwnerContext, turnId?: string): void {
    this.abortRecordings(
      recording => sameScope(recording.context, context) && (turnId === undefined || recording.context.turnId === turnId),
      "turn ended",
    )
    for (const request of this.runningRequests.values()) {
      if (sameScope(request.context, context) && (turnId === undefined || request.context.turnId === turnId)) {
        request.controller.abort(new DOMException("turn ended", "AbortError"))
      }
    }
    for (const record of this.tabs.values()) {
      if (
        sameScope(record.owner, context) &&
        record.lifecycle !== "handoff" &&
        (record.lifecycle === "deliverable" || record.origin === "user")
      ) {
        this.releaseToUser(record)
      }
    }
  }

  /** closeSession:中止同 scope 请求与录制, 全部 tab 释放, 清 scope 级状态 */
  private closeSession(context: BrowserOwnerContext): void {
    this.abortRecordings(recording => sameScope(recording.context, context), "session closed")
    for (const request of this.runningRequests.values()) {
      if (sameScope(request.context, context)) request.controller.abort(new DOMException("session closed", "AbortError"))
    }
    for (const record of this.tabs.values()) {
      if (sameScope(record.owner, context)) this.releaseToUser(record)
    }
    const ownerScope = scopeKey(context)
    this.activeTabByScope.delete(ownerScope)
    this.defaultTabByScope.delete(ownerScope)
    this.sessionNames.delete(ownerScope)
    this.visibilityByScope.delete(ownerScope)
  }

  /** 关窗:中止窗口内请求/录制, 拆除 guest, 清窗口级状态 */
  closeWindow(windowId: number): void {
    this.abortRecordings(recording => recording.context.windowId === windowId, "window closed")
    for (const request of this.runningRequests.values()) {
      if (request.context.windowId === windowId) request.controller.abort(new DOMException("window closed", "AbortError"))
    }
    for (const record of this.tabs.values()) {
      if (record.owner.windowId !== windowId) continue
      this.detachAndCloseGuest(record)
      this.residencyCoordinator.remove(record.tabId)
      this.restoredTabClaims.delete(record.tabId)
      this.tabs.delete(record.tabId)
    }
    this.naturalViewportByWindow.delete(windowId)
  }

  private async removeTabRecovery(tab: GuestTabRecord): Promise<void> {
    await this.recoveryStore?.remove(tab.tabId)
  }

  /** 先删恢复记录再关 tab(关闭不可逆) */
  private async closeTabDurably(tab: GuestTabRecord, notifyRenderer = true): Promise<void> {
    if (tab.lifecycle !== "closed") {
      await this.removeTabRecovery(tab)
      this.closeTab(tab, notifyRenderer)
    }
  }

  private closeTab(tab: GuestTabRecord, notifyRenderer = true): void {
    if (tab.lifecycle === "closed") return
    this.abortRecordings(recording => recording.tabId === tab.tabId, "tab closed")
    tab.lifecycle = "closed"
    this.closedTabIds.add(tab.tabId)
    this.inFlightScreenshots.delete(tab.tabId)
    this.resolveWaiters(tab.tabId, null)
    this.detachAndCloseGuest(tab)
    for (const [downloadId, download] of this.downloads) {
      if (download.tabId === tab.tabId) this.downloads.delete(downloadId)
    }
    this.queuedDownloads.delete(tab.tabId)
    let waiter = this.downloadWaiters.get(tab.tabId)?.[0]
    while (waiter) {
      this.finishDownloadWaiter(tab.tabId, waiter, null)
      waiter = this.downloadWaiters.get(tab.tabId)?.[0]
    }
    const ownerScope = scopeKey(tab.owner)
    if (this.activeTabByScope.get(ownerScope) === tab.tabId) this.activeTabByScope.delete(ownerScope)
    if (this.defaultTabByScope.get(ownerScope) === tab.tabId) this.defaultTabByScope.delete(ownerScope)
    if (notifyRenderer) this.onCloseTabRequested(tab.tabId, tab.owner)
    this.residencyCoordinator.remove(tab.tabId)
    this.restoredTabClaims.delete(tab.tabId)
    this.tabs.delete(tab.tabId)
  }

  /* ────────────────────────────────────────────────────────────────
   * 跟踪器 —— CDP 崩溃守卫 / 对话框跟踪
   * ──────────────────────────────────────────────────────────────── */

  /** render-process-gone → guest 置 detaching + 强制 detach CDP */
  private setupCdpCrashGuard(tab: GuestTabRecord, guest: WebContents): void {
    tab.crashGuardCleanup?.()
    if (!guest.on || !guest.removeListener) return
    const tabId = tab.tabId
    const onRenderProcessGone = (_event: ElectronEvent, details: Electron.RenderProcessGoneDetails): void => {
      const reason = safeStr(() => String(details?.reason ?? "unknown"), "unknown")
      const guestId = safeStr(() => String(guest.id), "?")
      try {
        const current = this.tabs.get(tabId)
        if (current?.guest === guest) tab.guestLifecycle = "detaching"
        if (!guest.debugger.isAttached()) return
        guest.debugger.detach()
        this.deps.log(`[browser-use] cdp detached on render-process-gone tabId=${tabId} guestId=${guestId} reason=${reason}`)
      } catch (error) {
        this.warn(`browser guest cdp detach on render-process-gone failed tabId=${tabId} guestId=${guestId} reason=${reason}`, error)
      } finally {
        const current = this.tabs.get(tabId)
        if (current?.guest === guest) tab.cdpAttached = false
      }
    }
    guest.on("render-process-gone", onRenderProcessGone)
    tab.crashGuardCleanup = () => {
      guest.removeListener?.("render-process-gone", onRenderProcessGone)
    }
  }

  /** Page.enable + javascriptDialogOpening/Closed → pendingDialogs(A6 钩子见头注偏差 5) */
  private setupDialogTracking(tab: GuestTabRecord, guest: WebContents): void {
    const tabId = tab.tabId
    this.sendGuestCdpCommand(tab, guest, "Page.enable").catch(error => {
      this.deps.log(`[browser-use] Page.enable failed tabId=${tabId}: ${String(error)}`)
    })
    const onMessage = (_event: ElectronEvent, method: string, params: Record<string, unknown> | undefined): void => {
      const current = this.tabs.get(tabId)
      if (!current || current.guest !== guest || current.lifecycle === "closed") return
      if (method === "Page.javascriptDialogOpening") {
        const dialogParams = params ?? {}
        const info: BrowserDialogInfo = {
          type: normalizeDialogType(dialogParams.type),
          message: typeof dialogParams.message === "string" ? dialogParams.message : "",
          ...(typeof dialogParams.defaultPrompt === "string" ? { defaultPrompt: dialogParams.defaultPrompt } : {}),
        }
        this.pendingDialogs.set(tabId, info)
        this.options.onDialogOpening?.(tabId, info)
      } else if (method === "Page.javascriptDialogClosed") {
        this.pendingDialogs.delete(tabId)
        this.options.onDialogClosed?.(tabId)
      }
    }
    guest.debugger.on("message", onMessage)
    tab.cdpMessageCleanup = () => {
      guest.debugger.removeListener("message", onMessage)
    }
  }

  /* ────────────────────────────────────────────────────────────────
   * viewport 系列 —— override 设置/重置/背景回退/自然视口恢复/串行队列
   * ──────────────────────────────────────────────────────────────── */

  private applyViewportOverride(tab: GuestTabRecord): void {
    const override = tab.viewportOverride
    if (!override) return
    this.setTabViewport(tab, override).catch(error => {
      this.deps.log(`[browser-use] viewport apply failed tabId=${tab.tabId}: ${String(error)}`)
    })
  }

  private async setTabViewport(tab: GuestTabRecord, viewport: BrowserViewportOverride): Promise<void> {
    assertViewportOverride(viewport)
    if (tab.lifecycle === "closed") return
    tab.backgroundViewportFallback = undefined
    tab.viewportOverride = { ...viewport }
    const guest = tab.guest
    if (!guest) return
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(viewport, tab.desktopZoomFactor),
      )
    })
  }

  private async resetTabViewport(tab: GuestTabRecord): Promise<void> {
    if (tab.lifecycle === "closed") return
    tab.viewportOverride = undefined
    tab.desktopZoomFactor = undefined
    tab.backgroundViewportFallback = undefined
    const guest = tab.guest
    if (!guest) return
    await this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride")
    })
  }

  private async applyBackgroundViewportFallback(tab: GuestTabRecord, viewport: BrowserViewportOverride): Promise<void> {
    const guest = tab.guest
    if (!guest || tab.lifecycle === "closed") {
      throw new Error(`browser tab '${tab.tabId}' has no readable viewport`)
    }
    const fallback = { ...viewport }
    tab.backgroundViewportFallback = fallback
    try {
      await this.enqueueViewportMutation(tab, async () => {
        if (tab.guest !== guest || tab.lifecycle === "closed") return
        if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return
        await this.sendGuestCdpCommand(
          tab,
          guest,
          "Emulation.setDeviceMetricsOverride",
          buildViewportMetricsOverride(fallback),
        )
      })
    } catch (error) {
      if (tab.backgroundViewportFallback === fallback) tab.backgroundViewportFallback = undefined
      throw error
    }
  }

  /** 附加(active)后清除背景回退:先清 override,再实测自然视口;失败则回设 fallback */
  private restoreNaturalViewportAfterBackground(tab: GuestTabRecord): void {
    const fallback = tab.backgroundViewportFallback
    const guest = tab.guest
    if (!fallback || tab.viewportOverride || !guest) return
    this.enqueueViewportMutation(tab, async () => {
      if (tab.guest !== guest || tab.lifecycle === "closed") return
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return
      await this.sendGuestCdpCommand(tab, guest, "Emulation.clearDeviceMetricsOverride")
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return
      const measured = await guest.executeJavaScript("({ width: window.innerWidth, height: window.innerHeight })")
      if (tab.backgroundViewportFallback !== fallback || tab.viewportOverride) return
      if (isBrowserViewportSize(measured)) {
        this.naturalViewportByWindow.set(tab.owner.windowId, { ...measured })
        tab.backgroundViewportFallback = undefined
        return
      }
      await this.sendGuestCdpCommand(
        tab,
        guest,
        "Emulation.setDeviceMetricsOverride",
        buildViewportMetricsOverride(fallback),
      )
    }).catch(error => {
      this.deps.log(`[browser-use] background viewport restore failed tabId=${tab.tabId}: ${String(error)}`)
    })
  }

  /** 每 tab 串行视口变更队列, 完成后自清理 */
  private enqueueViewportMutation(tab: GuestTabRecord, mutation: () => Promise<void>): Promise<void> {
    const queued = (tab.viewportMutation ?? Promise.resolve())
      .catch(() => {})
      .then(mutation)
    tab.viewportMutation = queued
    const clearIfCurrent = (): void => {
      if (tab.viewportMutation === queued) tab.viewportMutation = undefined
    }
    queued.then(clearIfCurrent, clearIfCurrent)
    return queued
  }

  /* ────────────────────────────────────────────────────────────────
   * 下载 —— will-download 跟踪 / 等待者与队列
   * ──────────────────────────────────────────────────────────────── */

  /** session "will-download":先派发给等待者, 否则入 queuedDownloads */
  private setupDownloadTracking(tab: GuestTabRecord, guest: WebContents): void {
    tab.downloadCleanup?.()
    const session = guest.session
    if (!session) return
    const onWillDownload = (_event: ElectronEvent, item: Electron.DownloadItem, webContents: WebContents): void => {
      if (webContents !== guest || tab.guest !== guest || tab.lifecycle === "closed") return
      const downloadId = `iab-download:${randomUUID()}`
      const record: BrowserDownloadRecord = {
        tabId: tab.tabId,
        path: safeStr(() => item.getSavePath(), "") || null,
        state: "pending",
      }
      this.downloads.set(downloadId, record)
      this.refreshRuntimeProtection(tab.tabId)
      item.once("done", (_doneEvent, state) => {
        record.path = safeStr(() => item.getSavePath(), "") || record.path
        record.state = state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "interrupted"
        this.refreshRuntimeProtection(tab.tabId)
      })
      const waiter = this.downloadWaiters.get(tab.tabId)?.shift()
      if (waiter) this.finishDownloadWaiter(tab.tabId, waiter, downloadId)
      else {
        const queued = this.queuedDownloads.get(tab.tabId) ?? []
        queued.push(downloadId)
        this.queuedDownloads.set(tab.tabId, queued)
      }
    }
    session.on("will-download", onWillDownload)
    tab.downloadCleanup = () => guest.session?.removeListener("will-download", onWillDownload)
  }

  /** 等待下一个下载:先吃队列, 再挂等待者(超时/中止 → null) */
  private waitForDownload(tabId: string, timeoutMs: number, signal: AbortSignal): Promise<string | null> {
    const queued = this.queuedDownloads.get(tabId)?.shift()
    if (queued) return Promise.resolve(queued)
    if (signal.aborted) return Promise.resolve(null)
    return new Promise(resolve => {
      const waiter: GuestDownloadWaiter = {
        resolve: downloadId => resolve(downloadId),
        timer: setTimeout(() => this.finishDownloadWaiter(tabId, waiter, null), timeoutMs),
        signal,
        onAbort: () => this.finishDownloadWaiter(tabId, waiter, null),
      }
      signal.addEventListener("abort", waiter.onAbort, { once: true })
      const existing = this.downloadWaiters.get(tabId) ?? []
      existing.push(waiter)
      this.downloadWaiters.set(tabId, existing)
    })
  }

  private finishDownloadWaiter(tabId: string, waiter: GuestDownloadWaiter, downloadId: string | null): void {
    clearTimeout(waiter.timer)
    waiter.signal.removeEventListener("abort", waiter.onAbort)
    const existing = this.downloadWaiters.get(tabId)
    if (existing) {
      const index = existing.indexOf(waiter)
      if (index >= 0) existing.splice(index, 1)
      if (existing.length === 0) this.downloadWaiters.delete(tabId)
    }
    waiter.resolve(downloadId)
  }

  /* ────────────────────────────────────────────────────────────────
   * CDP —— sendGuestCdpCommand(pendingCdpCommands 计数) + toControlledView
   * ──────────────────────────────────────────────────────────────── */

  /** guest CDP 派发(assertCurrentGuest 守卫 + 在途命令计数供 teardown 排空) */
  private async sendGuestCdpCommand(
    tab: GuestTabRecord,
    guest: WebContents,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    assertCurrent?: () => void,
  ): Promise<unknown> {
    if (assertCurrent) assertCurrent()
    if (tab.guest !== guest || tab.guestLifecycle !== "attached") throw new Error("browser guest is detaching")
    tab.pendingCdpCommands += 1
    try {
      return await guest.debugger.sendCommand(method, params, sessionId)
    } finally {
      tab.pendingCdpCommands = Math.max(0, tab.pendingCdpCommands - 1)
    }
  }

  /** 受控视图包装:每个方法都先 assertCurrent 再代理到真实 webContents */
  private toControlledView(
    guest: WebContents,
    normalizeScreenshotToCssPixels = false,
    captureViewportScreenshot?: () => Promise<string | undefined>,
    assertCurrent?: () => void,
    sendCdpCommand?: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>,
  ): ControlledView {
    const assertCurrentGuest = (): void => {
      if (assertCurrent) assertCurrent()
    }
    return {
      webContents: {
        loadURL: (url: string) => {
          assertCurrentGuest()
          return guest.loadURL(url)
        },
        getURL: () => {
          assertCurrentGuest()
          return guest.getURL()
        },
        getTitle: () => {
          assertCurrentGuest()
          return guest.getTitle()
        },
        canGoBack: () => {
          assertCurrentGuest()
          return guest.navigationHistory.canGoBack()
        },
        canGoForward: () => {
          assertCurrentGuest()
          return guest.navigationHistory.canGoForward()
        },
        goBack: () => {
          assertCurrentGuest()
          guest.navigationHistory.goBack()
        },
        goForward: () => {
          assertCurrentGuest()
          guest.navigationHistory.goForward()
        },
        reload: () => {
          assertCurrentGuest()
          guest.reload()
        },
        executeJavaScript: (code: string) => {
          assertCurrentGuest()
          return guest.executeJavaScript(code, true)
        },
      },
      cdp: {
        send: (method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> => {
          try {
            assertCurrentGuest()
            if (!sendCdpCommand) throw new Error("browser guest cdp channel is unavailable")
            return sendCdpCommand(method, params, sessionId)
          } catch (error) {
            return Promise.reject(error)
          }
        },
      },
      captureViewportScreenshot,
      normalizeScreenshotToCssPixels,
      resizeScreenshotToCssPixels: this.deps.resizeScreenshotToCssPixels,
    }
  }

  /* ────────────────────────────────────────────────────────────────
   * 保护/淘汰 —— registerTabResidency / closeTabForLimit
   * ──────────────────────────────────────────────────────────────── */

  /** 向常驻协调器登记 tab(默认按 preferred 推导 residency) */
  private registerTabResidency(
    tab: GuestTabRecord,
    preferred: boolean,
    residency: BrowserResidency = preferred ? "live-visible" : "live-background",
    lastSelectedAt: number | null = null,
  ): void {
    const guest = tab.guest
    this.residencyCoordinator.upsert({
      tabId: tab.tabId,
      windowId: tab.owner.windowId,
      sessionId: tab.owner.sessionId,
      residency,
      guestAttached: !!(guest && !safeBool(() => guest.isDestroyed(), true)),
      openedAt: tab.openedAt,
      lastActivityAt: tab.openedAt,
      lastSelectedAt,
      preferred,
      currentTask: false,
      selected: preferred,
      visible: preferred,
      operationActive: false,
      captureActive: false,
      audible: false,
      mediaActive: false,
      loading: false,
      downloadActive: false,
    })
  }

  /**
   * tab-limit 淘汰回调(常驻协调器 onEvict):可拒绝(返回 false 停止淘汰)。
   * 装配方式:coordinator 构造时 onEvict → guestManager.closeTabForLimit(record)。
   */
  async closeTabForLimit(record: BrowserTabResidencySnapshot): Promise<boolean> {
    const tab = this.tabs.get(record.tabId)
    if (!tab || tab.lifecycle === "closed") return true
    try {
      await this.closeTabDurably(tab)
      this.deps.log(`[browser-use] closed tabId=${tab.tabId} reason=tab-limit windowId=${tab.owner.windowId}`)
      return true
    } catch (error) {
      this.warn(`browser tab limit close failed tabId=${tab.tabId}`, error)
      return false
    }
  }

  /* ────────────────────────────────────────────────────────────────
   * 挂起发起(ZCode 提取域外装配段的移植;suspend-scheduler / 装配层驱动)
   * ──────────────────────────────────────────────────────────────── */

  /**
   * tab 挂起裁决视图(挂起调度器读侧):常驻状态/可见性/空闲时间来自 residency
   * 记录,busy 为管理器运行态保护位。无常驻记录的 tab(理论上不存在 —— 登记
   * attach/创建时必然 upsert)不返回。
   */
  listSuspendViews(): TabSuspendView[] {
    const views: TabSuspendView[] = []
    for (const tab of this.tabs.values()) {
      if (tab.lifecycle === "closed") continue
      const residency = this.residencyCoordinator.get(tab.tabId)
      if (!residency) continue
      views.push({
        tabId: tab.tabId,
        residency: residency.residency,
        visible: residency.visible,
        busy: this.isTabRuntimeBusy(tab),
        lastActivityAt: residency.lastActivityAt,
      })
    }
    return views
  }

  /**
   * tab 是否可发起挂起(发起方预检):live-background 且无管理器运行态保护。
   * 保护集与 refreshRuntimeProtection 同源(active/loading/media/operation/capture/
   * download);residency 侧保护位(visible/selected/… )由 beginSuspend 兜底。
   */
  canSuspendTab(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (!tab || tab.lifecycle === "closed") return false
    if (this.residencyCoordinator.get(tabId)?.residency !== "live-background") return false
    return !this.isTabRuntimeBusy(tab)
  }

  /** 管理器运行态保护位(选中/加载/媒体/agent 命令在途/截图录像/下载) */
  private isTabRuntimeBusy(tab: GuestTabRecord): boolean {
    return (
      tab.active ||
      tab.loading ||
      tab.mediaActive ||
      this.hasRunningRequestForTab(tab.tabId) ||
      this.isTabCaptureActive(tab) ||
      this.hasPendingDownloadForTab(tab.tabId)
    )
  }

  /**
   * 挂起发起(挂起协议写入端, 头注偏差 6):beginSuspend(live-background →
   * suspend-pending, generation+1)→ persistRecoverySnapshot(拆 webview 前抢壳与
   * 导航历史)→ onSuspendTabRequested(lume:browser-view-suspend, renderer 卸载空壳)
   * → 等 suspend-ready ack → 复核代数 → detach+close guest → commitSuspend 落
   * suspended。已挂起/受保护/ack 超时(回滚 live-background)均返回 false。
   */
  async suspendTabForIdle(tabId: string): Promise<boolean> {
    if (!this.canSuspendTab(tabId)) return false
    const pending = this.residencyCoordinator.beginSuspend(tabId)
    const tab = this.tabs.get(tabId)
    if (!pending || !tab) return false
    const generation = pending.generation
    const flight = this.runSuspendFlight(tab, generation).finally(() => {
      if (this.suspendFlights.get(tabId) === flight) this.suspendFlights.delete(tabId)
    })
    this.suspendFlights.set(tabId, flight)
    return (await flight) === true
  }

  /**
   * 挂起主飞行:快照 → suspend 通知 → ack 等待 → 代数复核 → 关 guest → 落 suspended。
   * ack 前被救活(report 活动位/visible → generation+1 回 live-*)则提交必然失配,
   * 不关 guest。
   */
  private async runSuspendFlight(tab: GuestTabRecord, generation: number): Promise<boolean> {
    const guest = tab.guest
    if (guest && !safeBool(() => guest.isDestroyed(), true)) {
      await this.persistRecoverySnapshot(tab, guest)
    }
    this.onSuspendTabRequested(this.buildResidencyNotification(tab, generation, "suspend-pending"))
    if (!(await this.waitForSuspendAck(tab.tabId, generation, DEFAULT_SUSPEND_ACK_TIMEOUT_MS))) {
      this.residencyCoordinator.cancelSuspend(tab.tabId, generation)
      return false
    }
    const current = this.tabs.get(tab.tabId)
    if (!current || current !== tab || tab.lifecycle === "closed") return false
    const residency = this.residencyCoordinator.get(tab.tabId)
    if (!residency || residency.generation !== generation || residency.residency !== "suspend-pending") return false
    this.detachAndCloseGuest(tab)
    if (!this.residencyCoordinator.commitSuspend(tab.tabId, generation)) return false
    this.deps.log(`[browser-use] suspended tabId=${tab.tabId} generation=${generation}`)
    return true
  }

  /** 登记 suspend-ready 等待者并限时等待(acknowledgeSuspend 按 tabId+generation 唤醒) */
  private waitForSuspendAck(tabId: string, generation: number, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const key = suspendAckKey(tabId, generation)
      const timer = setTimeout(() => {
        this.suspendAckWaiters.delete(key)
        resolve(false)
      }, timeoutMs)
      this.suspendAckWaiters.set(key, () => {
        clearTimeout(timer)
        this.suspendAckWaiters.delete(key)
        resolve(true)
      })
    })
  }

  /* ────────────────────────────────────────────────────────────────
   * ensureGuest / 附加飞行 / 挂起恢复
   * ──────────────────────────────────────────────────────────────── */

  /** 确保 guest 存活:挂起/恢复中走恢复飞行;否则去重共享附加飞行 */
  private async ensureGuest(tab: GuestTabRecord, signal: AbortSignal): Promise<WebContents | null> {
    if (signal.aborted) return null
    const suspendFlight = this.suspendFlights.get(tab.tabId)
    if (suspendFlight && !(await waitForPromiseWithSignal(suspendFlight, signal)).completed) return null
    const residency = this.residencyCoordinator.get(tab.tabId)
    if (residency?.residency === "suspended" || residency?.residency === "restoring") {
      return await this.restoreSuspendedGuest(tab, signal)
    }
    const currentGuest = tab.guest
    if (currentGuest && !safeBool(() => currentGuest.isDestroyed(), true)) return currentGuest
    if (tab.guest) this.detachGuest(tab)
    let attachFlight = this.guestAttachFlights.get(tab.tabId)
    if (!attachFlight) {
      attachFlight = this.runGuestAttachFlight(tab)
      this.guestAttachFlights.set(tab.tabId, attachFlight)
      const clearFlight = (): void => {
        if (this.guestAttachFlights.get(tab.tabId) === attachFlight) this.guestAttachFlights.delete(tab.tabId)
      }
      attachFlight.then(clearFlight, clearFlight)
    }
    const outcome = await waitForPromiseWithSignal(attachFlight, signal)
    return outcome.completed ? outcome.value : null
  }

  /** 附加飞行最多两轮:每轮 onOpenTabRequested → waitForGuest → 必要时 requestGuestRebind */
  private async runGuestAttachFlight(tab: GuestTabRecord): Promise<WebContents | null> {
    for (let round = 0; round < 2; round += 1) {
      if (tab.lifecycle === "closed") return null
      if (!tab.rebindRequested) this.onOpenTabRequested(tab.tabId, tab.owner)
      const liveGuest = tab.guest
      if (liveGuest && !safeBool(() => liveGuest.isDestroyed(), true)) return liveGuest
      const guest = await this.waitForGuest(tab.tabId)
      if (guest && !safeBool(() => guest.isDestroyed(), true)) return guest
      if ((round === 0 && !tab.hasAttachedGuest && !tab.attachFailure) || round === 1) return null
      this.requestGuestRebind(tab, tab.attachFailure ?? "attach-timeout")
    }
    return null
  }

  /** 恢复飞行去重:suspended → restoring 状态机由常驻协调器 markRestoring 推进 */
  private async restoreSuspendedGuest(tab: GuestTabRecord, signal: AbortSignal): Promise<WebContents | null> {
    if (signal.aborted) return null
    let restoreFlight = this.restoreFlights.get(tab.tabId)
    if (!restoreFlight) {
      restoreFlight = this.runRestoreSuspendedGuest(tab, new AbortController().signal).finally(() => {
        if (this.restoreFlights.get(tab.tabId) === restoreFlight) this.restoreFlights.delete(tab.tabId)
      })
      this.restoreFlights.set(tab.tabId, restoreFlight)
    }
    const outcome = await waitForPromiseWithSignal(restoreFlight, signal)
    return outcome.completed ? outcome.value : null
  }

  /**
   * 恢复主飞行:markRestoring → 请求渲染器重建 webview(restore 或 ready)→
   * waitForGuest → restoreGuestState(历史恢复/URL 兜底)→ completeRestore /
   * failRestore(回挂起)/ recovery-orphan 关闭。
   */
  private async runRestoreSuspendedGuest(tab: GuestTabRecord, signal: AbortSignal): Promise<WebContents | null> {
    const previous = this.residencyCoordinator.get(tab.tabId)
    const restoring = this.residencyCoordinator.markRestoring(tab.tabId)
    if (!restoring) return null
    if (previous?.residency === "suspended") {
      this.onRestoreTabRequested(
        this.buildResidencyNotification(tab, restoring.generation, "restoring"),
      )
    }
    const guest = await this.waitForGuest(tab.tabId, signal)
    if (!guest) {
      const failed = this.residencyCoordinator.failRestore(tab.tabId, restoring.generation)
      if (failed) {
        this.onSuspendTabRequested(this.buildResidencyNotification(tab, failed.generation, "suspended"))
      }
      return null
    }
    const restored = await this.restoreGuestState(tab, guest)
    if (!restored && tab.restoredFromStore && !tab.cachedUrl) {
      // 恢复后无 URL 且来自恢复存储 → 视为 recovery-orphan 直接关 tab
      await this.removeTabRecovery(tab)
      this.onRecoveryOrphanCloseRequested({ tabId: tab.tabId, reason: "recovery-orphan" })
      this.closeTab(tab, false)
      return null
    }
    if (!restored) {
      const failed = this.residencyCoordinator.failRestore(tab.tabId, restoring.generation)
      this.detachAndCloseGuest(tab)
      if (failed) {
        this.onSuspendTabRequested(this.buildResidencyNotification(tab, failed.generation, "suspended"))
      }
      return null
    }
    if (!this.residencyCoordinator.completeRestore(tab.tabId, restoring.generation)) return null
    const completed = this.residencyCoordinator.get(tab.tabId)
    if (completed) {
      this.onResidencyChanged(
        this.buildResidencyNotification(
          tab,
          completed.generation,
          completed.residency === "live-visible" ? "live-visible" : "live-background",
        ),
      )
    }
    tab.restoredFromStore = false
    await this.persistShell(tab)
    return guest
  }

  private buildResidencyNotification(
    tab: GuestTabRecord,
    generation: number,
    residency: BrowserResidency,
  ): BrowserResidencyTransitionNotification {
    return {
      tabId: tab.tabId,
      workspaceKey: tab.owner.workspaceKey,
      remoteSessionId: tab.owner.remoteSessionId,
      sessionId: tab.owner.sessionId,
      browserId: tab.owner.browserId,
      browserGeneration: tab.owner.browserGeneration,
      generation,
      residency,
    }
  }

  /** 恢复页面状态:navigationHistory.restore 优先(含 ERR_ABORTED 容差), loadURL 兜底 */
  private async restoreGuestState(tab: GuestTabRecord, guest: WebContents): Promise<boolean> {
    const pageState = await this.recoveryStore?.getPageState(tab.tabId)
    if (pageState && pageState.entries.length > 0) {
      const activeEntry = pageState.entries[pageState.activeIndex]
      if (tab.cachedUrl && activeEntry?.url !== tab.cachedUrl) {
        this.warn(
          `browser tab stale page-state ignored tabId=${tab.tabId} shellUrl=${tab.cachedUrl} pageStateUrl=${activeEntry?.url ?? "missing"}`,
        )
        await this.recoveryStore?.removePageState(tab.tabId)
      } else {
        const acceptRestoredPageState = (): boolean => {
          const entry = pageState.entries[pageState.activeIndex]
          tab.cachedUrl = entry?.url ?? tab.cachedUrl
          tab.cachedTitle = entry?.title ?? tab.cachedTitle
          return true
        }
        try {
          this.deps.log(
            `[browser-use] restore page-state start tabId=${tab.tabId} index=${pageState.activeIndex} entries=${JSON.stringify(pageState.entries.map(entry => entry.url))}`,
          )
          await guest.navigationHistory.restore({
            entries: pageState.entries.map(entry => ({ ...entry })),
            index: pageState.activeIndex,
          })
          this.deps.log(
            `[browser-use] restore page-state complete tabId=${tab.tabId} url=${safeStr(() => guest.getURL(), "")} index=${safeStr(() => String(guest.navigationHistory.getActiveIndex()), "unknown")} entries=${safeStr(() => JSON.stringify(guest.navigationHistory.getAllEntries().map(entry => entry.url)), "unknown")}`,
          )
          return acceptRestoredPageState()
        } catch (error) {
          // ERR_ABORTED 但导航历史已就位 → 视为恢复成功
          const historyMatches = safeBool(() => {
            const entries = guest.navigationHistory.getAllEntries()
            return (
              guest.navigationHistory.getActiveIndex() === pageState.activeIndex &&
              entries.length === pageState.entries.length &&
              entries.every((entry, index) => entry.url === pageState.entries[index]?.url)
            )
          }, false)
          if (String(error).includes("ERR_ABORTED") && historyMatches) {
            return acceptRestoredPageState()
          }
          this.warn(`browser tab page-state restore failed tabId=${tab.tabId}`, error)
          await this.recoveryStore?.removePageState(tab.tabId)
        }
      }
    }
    if (!tab.cachedUrl) return false
    try {
      await guest.loadURL(tab.cachedUrl)
      return true
    } catch (error) {
      this.warn(`browser tab URL restore failed tabId=${tab.tabId}`, error)
      return false
    }
  }

  /** 刷新缓存并快照导航历史到恢复存储 */
  async persistRecoverySnapshot(tab: GuestTabRecord, guest: WebContents): Promise<void> {
    tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl)
    tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle)
    await this.persistShell(tab)
    try {
      const entries = guest.navigationHistory.getAllEntries().map(entry => ({ ...entry }))
      if (entries.length === 0) return
      const snapshot: BrowserPageStateSnapshot = {
        schemaVersion: 1,
        tabId: tab.tabId,
        entries,
        activeIndex: guest.navigationHistory.getActiveIndex(),
        updatedAt: this.now(),
      }
      await this.recoveryStore?.upsertPageState(snapshot)
    } catch (error) {
      this.warn(`browser tab page-state snapshot failed tabId=${tab.tabId}`, error)
    }
  }

  /** 壳记录持久化(失败仅告警, 不阻断) */
  private async persistShell(tab: GuestTabRecord): Promise<void> {
    const store = this.recoveryStore
    if (!store || tab.lifecycle === "closed") return
    const residency = this.residencyCoordinator.get(tab.tabId)
    const shell: BrowserTabShellSnapshot = {
      schemaVersion: 1,
      tabId: tab.tabId,
      windowBindingId: null,
      workspaceKey: tab.owner.workspaceKey,
      ...(tab.owner.remoteSessionId ? { remoteSessionId: tab.owner.remoteSessionId } : {}),
      sessionId: tab.owner.sessionId,
      browserId: tab.owner.browserId,
      browserGeneration: tab.owner.browserGeneration,
      origin: tab.origin,
      lifecycle: tab.lifecycle,
      restoreUrl: tab.cachedUrl || null,
      title: tab.cachedTitle || null,
      faviconUrl: tab.cachedFaviconUrl,
      viewport: tab.viewportOverride ? { ...tab.viewportOverride } : null,
      openedAt: tab.openedAt,
      lastSelectedAt: residency?.lastSelectedAt ?? null,
      updatedAt: this.now(),
    }
    try {
      await store.upsert(shell)
    } catch (error) {
      this.warn(`browser tab shell persist failed tabId=${tab.tabId}`, error)
    }
  }

  /** 渲染器作用域校验:五元组(windowId/workspaceKey/sessionId/remoteSessionId)+ 生命周期 */
  private requireRendererOwnedTab(report: RendererTabScope): GuestTabRecord {
    const record = this.tabs.get(report.tabId)
    if (
      !record ||
      record.lifecycle === "closed" ||
      record.owner.windowId !== report.windowId ||
      record.owner.workspaceKey !== report.workspaceKey ||
      record.owner.sessionId !== report.sessionId ||
      (record.owner.remoteSessionId ?? "") !== (report.remoteSessionId ?? "")
    ) {
      throw new Error(`browser tab '${report.tabId}' is unavailable for renderer scope`)
    }
    return record
  }

  /* ────────────────────────────────────────────────────────────────
   * 活动跟踪 + 运行时保护刷新
   * ──────────────────────────────────────────────────────────────── */

  private setupActivityTracking(tab: GuestTabRecord, guest: WebContents): void {
    tab.activityCleanup?.()
    if (!guest.on || !guest.removeListener) return
    const onLoadingStarted = (): void => {
      if (tab.guest !== guest) return
      tab.loading = true
      this.refreshRuntimeProtection(tab.tabId)
    }
    const onLoadingStopped = (): void => {
      if (tab.guest !== guest) return
      tab.loading = false
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl)
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle)
      this.refreshRuntimeProtection(tab.tabId)
      this.persistShell(tab)
    }
    const onAudioChanged = (): void => {
      this.refreshRuntimeProtection(tab.tabId)
    }
    const onMediaStarted = (): void => {
      if (tab.guest !== guest) return
      tab.mediaActive = true
      this.refreshRuntimeProtection(tab.tabId)
    }
    const onMediaPaused = (): void => {
      if (tab.guest !== guest) return
      tab.mediaActive = false
      this.refreshRuntimeProtection(tab.tabId)
    }
    guest.on("did-start-loading", onLoadingStarted)
    guest.on("did-stop-loading", onLoadingStopped)
    guest.on("audio-state-changed", onAudioChanged)
    guest.on("media-started-playing", onMediaStarted)
    guest.on("media-paused", onMediaPaused)
    tab.activityCleanup = () => {
      guest.removeListener?.("did-start-loading", onLoadingStarted)
      guest.removeListener?.("did-stop-loading", onLoadingStopped)
      guest.removeListener?.("audio-state-changed", onAudioChanged)
      guest.removeListener?.("media-started-playing", onMediaStarted)
      guest.removeListener?.("media-paused", onMediaPaused)
    }
  }

  /** 按 tab 当前活动刷新常驻保护(loading/operation/capture/audible/media/download) */
  private refreshRuntimeProtection(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (!tab) return
    this.residencyCoordinator.report(tabId, {
      loading: tab.loading,
      operationActive: this.hasRunningRequestForTab(tabId),
      captureActive: this.isTabCaptureActive(tab),
      audible: safeBool(() => tab.guest?.isCurrentlyAudible?.() ?? false, false),
      mediaActive: tab.mediaActive,
      downloadActive: this.hasPendingDownloadForTab(tabId),
    })
  }

  private hasRunningRequestForTab(tabId: string): boolean {
    return [...this.runningRequests.values()].some(request => request.tabId === tabId)
  }

  private isTabCaptureActive(tab: GuestTabRecord): boolean {
    return (
      this.inFlightScreenshots.has(tab.tabId) ||
      [...this.recordings.values()].some(recording => recording.tabId === tab.tabId && recording.status === "running") ||
      safeBool(() => tab.guest?.isBeingCaptured?.() ?? false, false)
    )
  }

  private hasPendingDownloadForTab(tabId: string): boolean {
    return [...this.downloads.values()].some(download => download.tabId === tabId && download.state === "pending")
  }

  /* ────────────────────────────────────────────────────────────────
   * detach / teardown / dispose
   * ──────────────────────────────────────────────────────────────── */

  private detachAndCloseGuest(tab: GuestTabRecord): void {
    const guest = tab.guest
    this.detachGuest(tab)
    this.closeGuestWebContents(tab, guest)
  }

  /** 作用域不匹配拒绝:请求重绑,并关闭不属于该 tab 的来宾 */
  private rejectGuestAttach(tab: GuestTabRecord, guest: WebContents, reason: string): GuestAttachOutcome {
    const recoveryRequested = this.requestGuestRebind(tab, reason)
    if (tab.guest !== guest) this.closeGuestWebContents(tab, guest)
    return { ok: false, reason, recoveryRequested }
  }

  /** 请求渲染器重开 webview(仅一次, rebindRequested 防重) */
  private requestGuestRebind(tab: GuestTabRecord, reason: string): boolean {
    tab.attachFailure = reason
    if (tab.lifecycle === "closed" || tab.rebindRequested || !this.onOpenTabRequested) return false
    tab.rebindRequested = true
    this.deps.log(`[browser-use] request guest rebind tabId=${tab.tabId} reason=${reason}`)
    this.onOpenTabRequested(tab.tabId, tab.owner)
    return true
  }

  private closeGuestWebContents(tab: GuestTabRecord, guest: WebContents | undefined = tab.guest): void {
    if (!guest || safeBool(() => guest.isDestroyed(), true)) return
    try {
      guest.close({ waitForBeforeUnload: false })
    } catch (error) {
      this.warn(`browser guest close failed tabId=${tab.tabId}`, error)
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** 告警:经注入 warn + log 双通道(附 error 摘要后缀) */
  private warn(message: string, error?: unknown): void {
    const suffix = error === undefined ? "" : ` error=${error instanceof Error ? error.message : String(error)}`
    this.deps.warn(`${message}${suffix}`)
    this.deps.log(`[browser-use] ${message}${suffix}`)
  }

  /** 按 tabId 拆除 guest(不关闭) */
  detach(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab) this.detachGuest(tab)
  }

  /** 渲染器替换 webview 前的拆除请求:校验 window/guest 匹配与 CDP 排空 */
  async detachGuestBeforeReplacement(tabId: string, guestId: number, windowId: number): Promise<boolean> {
    const tab = this.tabs.get(tabId)
    if (!tab) return true
    if (tab.owner.windowId !== windowId) {
      this.deps.log(`[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} guestId=${guestId} reason=window-mismatch`)
      return false
    }
    const guest = tab.guest
    if (!guest) return true
    if (!safeBool(() => guest.id === guestId, false)) {
      this.deps.log(`[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} guestId=${guestId} reason=guest-mismatch`)
      return false
    }
    if (safeBool(() => guest.isDestroyed(), true)) {
      if (tab.cdpAttached) {
        this.deps.log(`[browser-use] detachGuestBeforeReplacement rejected tabId=${tabId} guestId=${guestId} reason=destroyed-with-cdp`)
        return false
      }
      this.detachGuest(tab)
      return true
    }
    return this.beginGuestTeardown(tab, guest, "renderer replacement")
  }

  /** teardown 飞行去重(挂到 guestTeardownFlight, 完成自清) */
  private beginGuestTeardown(tab: GuestTabRecord, guest: WebContents, reason: string): Promise<boolean> {
    const existing = tab.guestTeardownFlight
    if (existing) return existing
    const flight = this.runGuestTeardown(tab, guest, reason)
    tab.guestTeardownFlight = flight
    const clearFlight = (): void => {
      if (tab.guestTeardownFlight === flight) tab.guestTeardownFlight = undefined
    }
    flight.then(clearFlight, clearFlight)
    return flight
  }

  /** teardown:abort 在途请求/录制 → 排空 CDP → detach 确认 → 置 detached */
  private async runGuestTeardown(tab: GuestTabRecord, guest: WebContents, reason: string): Promise<boolean> {
    if (tab.guest !== guest) return !tab.cdpAttached
    tab.guestLifecycle = "detaching"
    for (const request of this.runningRequests.values()) {
      if (request.tabId === tab.tabId) request.controller.abort(new DOMException(`browser guest ${reason}`, "AbortError"))
    }
    this.abortRecordings(recording => recording.tabId === tab.tabId, `browser guest ${reason}`)
    const pendingAtStart = tab.pendingCdpCommands
    const cdpIdle = await this.waitForGuestCdpIdle(tab, GUEST_CDP_IDLE_TIMEOUT_MS)
    if (!cdpIdle) {
      this.warn(
        `browser guest teardown cdp pending timeout tabId=${tab.tabId} pending=${tab.pendingCdpCommands} started=${pendingAtStart} reason=${reason}`,
      )
    }
    if (tab.guest !== guest) return !tab.cdpAttached
    if (safeBool(() => guest.isDestroyed(), true)) {
      if (tab.cdpAttached) {
        this.deps.log(
          `[browser-use] guest teardown rejected on destroyed guest tabId=${tab.tabId} guestId=${safeStr(() => String(guest.id), "?")}`,
        )
        return false
      }
      this.detachGuest(tab)
      return true
    }
    try {
      if (guest.debugger.isAttached()) guest.debugger.detach()
      if (guest.debugger.isAttached()) {
        this.warn(
          `browser guest replacement cdp detach not confirmed tabId=${tab.tabId} guestId=${safeStr(() => String(guest.id), "?")}`,
        )
        return false
      }
    } catch (error) {
      this.warn(`browser guest replacement cdp detach failed tabId=${tab.tabId} guestId=${safeStr(() => String(guest.id), "?")}`, error)
      if (tab.guest === guest && !safeBool(() => guest.isDestroyed(), true)) tab.guestLifecycle = "attached"
      return false
    }
    this.deps.log(`[browser-use] cdp detached before guest replacement tabId=${tab.tabId} guestId=${safeStr(() => String(guest.id), "?")}`)
    tab.cdpAttached = false
    tab.guestLifecycle = "detached"
    this.detachGuest(tab)
    return true
  }

  /** 等待在途 CDP 命令排空(10ms 步进轮询) */
  private async waitForGuestCdpIdle(tab: GuestTabRecord, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (tab.pendingCdpCommands > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, Math.min(10, deadline - Date.now())))
    }
    return tab.pendingCdpCommands === 0
  }

  /** 逐类清理监听(download/activity/crashGuard/cdpMessage)→ detach CDP → markDetached */
  private detachGuest(tab: GuestTabRecord): void {
    const guest = tab.guest
    const destroyed = guest ? safeBool(() => guest.isDestroyed(), true) : true
    if (guest) {
      tab.cachedUrl = safeStr(() => guest.getURL(), tab.cachedUrl)
      tab.cachedTitle = safeStr(() => guest.getTitle(), tab.cachedTitle)
    }
    this.pendingDialogs.delete(tab.tabId)
    try {
      if (!destroyed) tab.downloadCleanup?.()
    } catch (error) {
      this.deps.log(
        `[browser-use] detachGuest download cleanup failed tabId=${tab.tabId} error=${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      tab.downloadCleanup = undefined
    }
    try {
      if (!destroyed) tab.activityCleanup?.()
    } catch {
      // 忽略清理异常
    } finally {
      tab.activityCleanup = undefined
      tab.loading = false
      tab.mediaActive = false
    }
    try {
      tab.crashGuardCleanup?.()
    } catch {
      // 忽略清理异常
    } finally {
      tab.crashGuardCleanup = undefined
    }
    const wasCdpAttached = tab.cdpAttached
    try {
      tab.cdpMessageCleanup?.()
    } catch (error) {
      this.deps.log(
        `[browser-use] detachGuest cdp message cleanup failed tabId=${tab.tabId} error=${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      tab.cdpMessageCleanup = undefined
    }
    if (guest) {
      const guestId = safeStr(() => String(guest.id), "?")
      if (destroyed) {
        if (wasCdpAttached) {
          this.deps.log(`[browser-use] detachGuest cdp still attached on destroyed guest tabId=${tab.tabId} guestId=${guestId}`)
        }
      } else {
        try {
          if (guest.debugger.isAttached()) guest.debugger.detach()
        } catch (error) {
          this.warn(`browser guest cdp detach failed tabId=${tab.tabId} guestId=${guestId}`, error)
        }
      }
    }
    tab.guest = undefined
    tab.cdpAttached = false
    tab.guestLifecycle = destroyed ? "destroyed" : "detached"
    tab.backgroundViewportFallback = undefined
    tab.viewportMutation = undefined
    this.residencyCoordinator.markDetached(tab.tabId)
    this.refreshRuntimeProtection(tab.tabId)
  }

  hasGuest(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    return !!(tab?.guest && tab.lifecycle !== "closed")
  }

  /** 全量销毁:中止请求/录制, 关闭全部 tab, 清空全部状态与飞行 */
  disposeAll(): void {
    for (const request of this.runningRequests.values()) {
      request.controller.abort(new DOMException("browser manager disposed", "AbortError"))
    }
    for (const tab of this.tabs.values()) this.closeTab(tab, false)
    for (const tabId of this.waiters.keys()) this.resolveWaiters(tabId, null)
    this.tabs.clear()
    this.closedTabIds.clear()
    this.activeTabByScope.clear()
    this.defaultTabByScope.clear()
    this.sessionNames.clear()
    this.naturalViewportByWindow.clear()
    for (const [tabId, waiters] of this.downloadWaiters) {
      let waiter = waiters[0]
      while (waiter) {
        this.finishDownloadWaiter(tabId, waiter, null)
        waiter = waiters[0]
      }
    }
    this.downloads.clear()
    this.queuedDownloads.clear()
    this.inFlightScreenshots.clear()
    for (const recording of this.recordings.values()) {
      recording.controller.abort(new DOMException("browser manager disposed", "AbortError"))
      if (recording.cleanupTimer) clearTimeout(recording.cleanupTimer)
      if (recording.artifact?.path) void rm(recording.artifact.path, { force: true }).catch(() => {})
    }
    this.recordings.clear()
    this.residencyCoordinator.dispose()
    this.restoredTabClaims.clear()
    for (const resolve of this.suspendAckWaiters.values()) resolve()
    this.suspendAckWaiters.clear()
    this.suspendFlights.clear()
    this.restoreFlights.clear()
    this.guestAttachFlights.clear()
  }

  /* ────────────────────────────────────────────────────────────────
   * waiters —— waitForGuest / removeWaiter / resolveWaiters
   * ──────────────────────────────────────────────────────────────── */

  /** 等待 guest 附加(超时 = attachTimeoutMs, 中止 → null) */
  private waitForGuest(tabId: string, signal?: AbortSignal): Promise<WebContents | null> {
    if (signal?.aborted) return Promise.resolve(null)
    return new Promise(resolve => {
      const waiter: GuestAttachWaiter = {
        resolve: attached => resolve(attached),
        timer: setTimeout(() => {
          this.removeWaiter(tabId, waiter)
          this.deps.log(`[browser-use] waitForGuest timeout tabId=${tabId}`)
          resolve(null)
        }, this.attachTimeoutMs),
      }
      waiter.onAbort = () => {
        this.removeWaiter(tabId, waiter)
        resolve(null)
      }
      if (signal) {
        waiter.signal = signal
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }
      const existing = this.waiters.get(tabId) ?? []
      existing.push(waiter)
      this.waiters.set(tabId, existing)
    })
  }

  private removeWaiter(tabId: string, waiter: GuestAttachWaiter): void {
    clearTimeout(waiter.timer)
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort)
    const existing = this.waiters.get(tabId)
    if (!existing) return
    const index = existing.indexOf(waiter)
    if (index >= 0) existing.splice(index, 1)
    if (existing.length === 0) this.waiters.delete(tabId)
  }

  private resolveWaiters(tabId: string, guest: WebContents | null): void {
    const existing = this.waiters.get(tabId)
    if (!existing) return
    this.waiters.delete(tabId)
    for (const waiter of existing) {
      clearTimeout(waiter.timer)
      if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort)
      waiter.resolve(guest)
    }
  }
}
