/**
 * 截图表面子系统 —— prepare/ready/release 三段协议 + 活动期 capture 泵 + 透明窗口引导。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\03-screenshot-subsystem.source.js
 * (ZCode 桌面端 main bundle 字节区间 991832..1011693 的截图子系统切片)。
 *
 * ZCode 原名对照(s(X,"name") 注解还原):
 * | 本文件标识符                                        | ZCode 原名 |
 * |---------------------------------------------------|------------|
 * | startBrowserScreenshotTransparentWindowBootstrap   | KH         |
 * | DesktopBrowserScreenshotActivityController         | qg         |
 * | DesktopBrowserScreenshotSurfaceCoordinator         | Vg         |
 * | createDesktopBrowserScreenshotSurfaceCoordinator   | YH         |
 * | sameBrowserScreenshotViewport                      | qH         |
 * | releaseBrowserScreenshotResourceOnce               | VH         |
 * | toBrowserScreenshotSurfacePreparePayload           | JH         |
 * | toBrowserScreenshotSurfaceReleasePayload           | XH         |
 * | CAPTURE_PROBE_RECT                                 | Ule        |
 * | GUEST_CAPTURE_PUMP_MIN_INTERVAL_MS                 | Ble        |
 * | CAPTURE_PUMP_BOOTSTRAP_START_DELAY_MS              | Fle        |
 * | DEFAULT_ACTIVITY_TIMEOUT_MS                        | Wle        |
 * | SURFACE_SCALE_TOLERANCE                            | zle        |
 * | DEFAULT_PREPARE_TIMEOUT_MS                         | rN(切片外常量,按重写规格取 3000) |
 *
 * 语义偏差(平台/装配层,逻辑逐行等价):
 * 1. `BrowserWindow.fromId(windowId)` → 单窗口 `getWindow()` + `win.id === windowId`
 *    身份校验(等价 fromId 的"窗口不存在则跳过"语义)。
 * 2. `win.webContents.send(I.BrowserViewScreenshotSurfacePrepare/Release, payload)`
 *    → `emit({ method: "lume:browser-view-screenshot-surface-prepare|-release", params })`
 *    (types.ts 的 BrowserEventSink 事件面;通道落地由 ipc 层完成)。
 * 3. `handleReady({windowId, senderWebContentsId, payload})` 合并为
 *    `handleReady(payload, senderWebContentsId)`,windowId 移入 ready 载荷由 renderer 回显。
 * 4. 通道前缀:`I.BrowserViewScreenshotSurface*`/`zcode:` → `lume:browser-view-screenshot-surface-*`。
 * 5. 本切片仅含截图子系统;提取源中相邻的工具函数(waitForCondition/raceBackendExecution 等)
 *    与恢复引导/本地媒体预览协议不属于本模块,未移植。
 */
import type { BrowserWindow } from "electron"
import type {
  BrowserEventSink,
  ScreenshotSurfaceCoordinatorPort,
  ScreenshotSurfaceLease,
  ScreenshotSurfacePrepareRequest,
} from "./types"

/* ── 常量(ZCode 原名见文件头对照表) ─────────────────────────────────── */

/** 1×1 capturePage 探活区域(ZCode Ule):开销极小,仅为让合成器持续产帧。 */
const CAPTURE_PROBE_RECT = { x: 0, y: 0, width: 1, height: 1 }
/** guest 泵 "paced" 模式的最小采集间隔 ms(ZCode Ble=200)。 */
const GUEST_CAPTURE_PUMP_MIN_INTERVAL_MS = 200
/** 透明窗口引导后 capture 泵的启动延迟 ms(ZCode Fle=100)。 */
const CAPTURE_PUMP_BOOTSTRAP_START_DELAY_MS = 100
/** activity watchdog 默认超时 ms(ZCode Wle=35e3)。 */
const DEFAULT_ACTIVITY_TIMEOUT_MS = 35_000
/** surfaceScale 容差(ZCode zle=0.001):unscaled 模式要求 |scale-1|≤0.001。 */
const SURFACE_SCALE_TOLERANCE = 0.001
/** prepare 默认超时 ms(ZCode rN,切片外常量;renderer 侧兜底为 timeoutMs+1000)。 */
const DEFAULT_PREPARE_TIMEOUT_MS = 3_000

/** main→renderer 事件通道:截图表面摆位开始(types.ts 事件面 `lume:browser-view-*`)。 */
export const BROWSER_SCREENSHOT_SURFACE_PREPARE_CHANNEL = "lume:browser-view-screenshot-surface-prepare"
/** main→renderer 事件通道:截图表面摆位结束(renderer 恢复布局)。 */
export const BROWSER_SCREENSHOT_SURFACE_RELEASE_CHANNEL = "lume:browser-view-screenshot-surface-release"
/** renderer→main send 型通道:摆位完成回报,ipc 层接到 `handleReady`。 */
export const BROWSER_SCREENSHOT_SURFACE_READY_CHANNEL = "lume:browser-view-screenshot-surface-ready"

/* ── 协议载荷 ─────────────────────────────────────────────────────── */

/** main→renderer prepare 载荷(ZCode JH 输出)。 */
export type BrowserScreenshotSurfacePreparePayload = {
  requestId: string
  workspaceKey: string
  sessionId: string
  browserId: string
  browserGeneration: number
  tabId: string
  webContentsId: number
  viewport: { width: number; height: number }
  surfaceScaleMode?: "current" | "unscaled"
  timeoutMs: number
}

/** main→renderer release 载荷(ZCode XH 输出:裁掉 surfaceScaleMode/timeoutMs/viewport)。 */
export type BrowserScreenshotSurfaceReleasePayload = Omit<
  BrowserScreenshotSurfacePreparePayload,
  "surfaceScaleMode" | "timeoutMs" | "viewport"
>

/** renderer→main ready 回报载荷(架构文档:`{...request, surfaceScale, viewport}`,含 windowId 回显)。 */
export type BrowserScreenshotSurfaceReadyPayload = {
  windowId: number
  requestId: string
  workspaceKey: string
  sessionId: string
  browserId: string
  browserGeneration: number
  tabId: string
  webContentsId: number
  viewport: { width: number; height: number }
  surfaceScale: number
}

/* ── 辅助函数 ─────────────────────────────────────────────────────── */

/**
 * 视口 ±1px 视为稳定(ZCode qH sameBrowserScreenshotViewport):
 * renderer 摆位采样与请求视口的容差比较。
 */
function sameBrowserScreenshotViewport(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1
}

/**
 * 把 release 包成"仅执行一次"的函数(ZCode VH releaseBrowserScreenshotResourceOnce):
 * lease 引用计数与 abort 监听可能双重触发释放。
 */
function releaseBrowserScreenshotResourceOnce(release: () => void): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    release()
  }
}

/** 组装 main→renderer prepare 载荷(ZCode JH toBrowserScreenshotSurfacePreparePayload)。 */
function toBrowserScreenshotSurfacePreparePayload(
  request: ScreenshotSurfacePrepareRequest,
  timeoutMs: number,
): BrowserScreenshotSurfacePreparePayload {
  return {
    requestId: request.requestId,
    workspaceKey: request.workspaceKey,
    sessionId: request.sessionId,
    browserId: request.browserId,
    browserGeneration: request.browserGeneration,
    tabId: request.tabId,
    webContentsId: request.webContentsId,
    viewport: request.viewport,
    ...(request.surfaceScaleMode ? { surfaceScaleMode: request.surfaceScaleMode } : {}),
    timeoutMs,
  }
}

/** 裁剪 prepare 载荷为 release 载荷(ZCode XH toBrowserScreenshotSurfaceReleasePayload)。 */
function toBrowserScreenshotSurfaceReleasePayload(
  payload: BrowserScreenshotSurfacePreparePayload,
): BrowserScreenshotSurfaceReleasePayload {
  const { surfaceScaleMode: _surfaceScaleMode, timeoutMs: _timeoutMs, viewport: _viewport, ...rest } = payload
  return rest
}

/* ── 透明窗口引导(ZCode KH) ──────────────────────────────────────── */

interface TransparentWindowBootstrapOptions {
  win: BrowserWindow
  enabled: boolean
  windowId: number
  webContentsId: number
  requestId: string
  hideTaskbarDuringBootstrap: boolean
  log?: (message: string) => void
}

/**
 * 透明窗口引导(ZCode KH startBrowserScreenshotTransparentWindowBootstrap)。
 *
 * 窗口不可见且未最小化时,以 `setOpacity(0)` + `showInactive()` 置前,
 * 让 Chromium 合成器开始产帧(win32 可选 `setSkipTaskbar(true)` 隐藏任务栏);
 * focus 或 release 时恢复 opacity 与 skipTaskbar,并在非聚焦时重新隐藏窗口。
 *
 * 返回:
 * - `undefined`:无需引导(enabled=false / 窗口可见 / 已最小化);
 * - `false`:需要引导但窗口能力不足或引导失败(acquire 直接放弃);
 * - `{ release }`:引导成功,调用 release 恢复窗口状态。
 */
function startBrowserScreenshotTransparentWindowBootstrap(
  options: TransparentWindowBootstrapOptions,
): { release: () => void } | false | undefined {
  const { win } = options
  if (!options.enabled || win.isVisible?.() !== false || win.isMinimized?.() === true) return undefined
  if (
    !win.isFocused ||
    !win.getOpacity ||
    !win.setOpacity ||
    !win.showInactive ||
    !win.hide ||
    !win.on ||
    !win.removeListener ||
    (options.hideTaskbarDuringBootstrap && !win.setSkipTaskbar)
  ) {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap unavailable windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    )
    return false
  }
  let originalOpacity: number
  try {
    originalOpacity = win.getOpacity()
  } catch {
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap opacity read failed windowId=${options.windowId}`,
    )
    return false
  }
  let restored = false
  let skipTaskbarApplied = false
  const restore = (skipHide: boolean) => {
    if (restored) return
    restored = true
    try {
      win.removeListener?.("focus", handleFocus)
    } catch {
      options.log?.(
        `[browser-screenshot-activity] transparent bootstrap listener cleanup failed windowId=${options.windowId}`,
      )
    }
    if (!win.isDestroyed()) {
      try {
        if (!skipHide && !win.isFocused?.()) win.hide?.()
      } catch {
        options.log?.(
          `[browser-screenshot-activity] transparent bootstrap hide failed windowId=${options.windowId}`,
        )
      } finally {
        if (!win.isDestroyed()) {
          try {
            win.setOpacity?.(originalOpacity)
          } catch {
            options.log?.(
              `[browser-screenshot-activity] transparent bootstrap opacity restore failed windowId=${options.windowId}`,
            )
          }
          if (skipTaskbarApplied) {
            try {
              win.setSkipTaskbar?.(false)
            } catch {
              options.log?.(
                `[browser-screenshot-activity] transparent bootstrap taskbar restore failed windowId=${options.windowId}`,
              )
            }
          }
        }
      }
    }
  }
  const handleFocus = () => {
    restore(true)
  }
  try {
    if (options.hideTaskbarDuringBootstrap) {
      win.setSkipTaskbar?.(true)
      skipTaskbarApplied = true
    }
    win.setOpacity(0)
    win.on("focus", handleFocus)
    win.showInactive()
  } catch {
    restore(true)
    options.log?.(
      `[browser-screenshot-activity] transparent bootstrap failed windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
    )
    return false
  }
  return {
    release: () => {
      restore(false)
    },
  }
}

/* ── 活动期控制器(ZCode qg) ──────────────────────────────────────── */

/** capture 泵状态:running=泵循环在跑;wakeDelay=用于提前唤醒的 setTimeout 句柄。 */
interface CapturePumpState {
  running: boolean
  wakeDelay?: () => void
}

type CapturePumpTarget = "owner" | "guest"
type CapturePumpMode = "stopped" | "continuous" | "paced"

/** 单个 `${windowId}:${webContentsId}` 键下的活动期状态。 */
interface BrowserScreenshotActivityState {
  key: string
  windowId: number
  webContentsId: number
  tokens: Map<symbol, { prepared: boolean }>
  restoreGeneration: number
  active: boolean
  invalidationController: AbortController
  transparentWindowBootstrap?: { release: () => void }
  capturePumpsAllowed: boolean
  capturePumpStartTimer?: ReturnType<typeof setTimeout>
  pumps: { owner: CapturePumpState; guest: CapturePumpState }
}

/** acquire 入参(YH 以 payload.requestId/webContentsId + "browser-screenshot" 调用)。 */
export interface BrowserScreenshotActivityAcquireOptions {
  windowId: number
  webContentsId: number
  requestId: string
  /** 语义标注,ZCode 原样透传 "browser-screenshot"(控制器本身不读取)。 */
  reason: string
}

/** acquire 返回的活动租约(与 ScreenshotSurfaceLease 不同:多 markPrepared,无身份字段)。 */
export interface BrowserScreenshotActivityLease {
  invalidated: AbortSignal
  markPrepared: () => void
  release: () => void
}

export interface DesktopBrowserScreenshotActivityControllerOptions {
  /** Lume 单窗口形态:替代 ZCode 的 fromId(windowId)(见文件头偏差 1)。 */
  getWindow: () => BrowserWindow | null
  /** webContents.fromId 的可注入形态(测试用)。 */
  webContentsFromId: (id: number) => Electron.WebContents | undefined
  allowTransparentWindowBootstrap?: boolean
  hideTaskbarDuringTransparentWindowBootstrap?: boolean
  log?: (message: string) => void
}

/**
 * 截图活动期控制器(ZCode qg DesktopBrowserScreenshotActivityController)。
 *
 * 以 `${windowId}:${webContentsId}` 为键管理截图活动期:acquire 返回
 * lease{invalidated, markPrepared, release};capture 泵有 stopped/continuous/paced
 * 三种模式(prepare 未完成期间 continuous 连转,之后 guest 泵转 paced,间隔
 * GUEST_CAPTURE_PUMP_MIN_INTERVAL_MS=200ms);captureOnce 用 1×1 区域 capturePage
 * 探活,失败即 invalidateActivity 并 abort 失效信号。
 *
 * 透明窗口引导存在时,泵延迟 CAPTURE_PUMP_BOOTSTRAP_START_DELAY_MS=100ms 启动,
 * 全部 token markPrepared(或引导到期)后才释放引导恢复窗口状态。
 */
export class DesktopBrowserScreenshotActivityController {
  readonly options: DesktopBrowserScreenshotActivityControllerOptions

  private states = new Map<string, BrowserScreenshotActivityState>()

  constructor(options: DesktopBrowserScreenshotActivityControllerOptions) {
    this.options = options
  }

  /**
   * 获取活动租约。已存在同键活动态时复用(restoreGeneration+1 抢占 teardown);
   * 目标窗口/guest 不可解析或透明引导不可用时返回 undefined(调用方按失败处理)。
   */
  acquire(options: BrowserScreenshotActivityAcquireOptions): BrowserScreenshotActivityLease | undefined {
    const key = this.getStateKey(options.windowId, options.webContentsId)
    let state = this.states.get(key)
    if (state && !state.active) {
      this.states.delete(key)
      state = undefined
    }
    if (state) {
      state.restoreGeneration += 1
    } else {
      const targets = this.resolveActivityTargets(options.windowId, options.webContentsId)
      if (!targets) {
        this.options.log?.(
          `[browser-screenshot-activity] acquire skipped windowId=${options.windowId} webContentsId=${options.webContentsId} requestId=${options.requestId}`,
        )
        return undefined
      }
      const bootstrap = startBrowserScreenshotTransparentWindowBootstrap({
        win: targets.window,
        enabled: this.options.allowTransparentWindowBootstrap === true,
        windowId: options.windowId,
        webContentsId: options.webContentsId,
        requestId: options.requestId,
        hideTaskbarDuringBootstrap: this.options.hideTaskbarDuringTransparentWindowBootstrap === true,
        log: this.options.log,
      })
      if (bootstrap === false) return undefined
      state = {
        key,
        windowId: options.windowId,
        webContentsId: options.webContentsId,
        tokens: new Map(),
        restoreGeneration: 0,
        active: true,
        invalidationController: new AbortController(),
        transparentWindowBootstrap: bootstrap,
        capturePumpsAllowed: !bootstrap,
        pumps: { owner: { running: false }, guest: { running: false } },
      }
      this.states.set(key, state)
      this.scheduleCapturePumpsAfterTransparentBootstrap(state)
    }
    const token = Symbol(options.requestId)
    state.tokens.set(token, { prepared: false })
    this.wakeCapturePumps(state)
    this.ensureCapturePumps(state)
    let released = false
    return {
      invalidated: state.invalidationController.signal,
      markPrepared: () => {
        if (released) return
        const entry = state.tokens.get(token)
        if (!entry || entry.prepared) return
        entry.prepared = true
        this.maybeReleaseTransparentWindowBootstrap(state)
        this.wakeCapturePumps(state)
        this.ensureCapturePumps(state)
      },
      release: () => {
        if (!released) {
          released = true
          this.releaseToken(key, state, token)
        }
      },
    }
  }

  /** 移除 token;最后一个 token 移除后以 microtask 延迟 teardown(等窗口复用/竞态守卫)。 */
  private releaseToken(key: string, state: BrowserScreenshotActivityState, token: symbol): void {
    if (this.states.get(key) !== state || !state.tokens.delete(token)) return
    this.wakeCapturePumps(state)
    if (state.tokens.size > 0) return
    const generation = ++state.restoreGeneration
    queueMicrotask(() => {
      if (
        this.states.get(key) !== state ||
        state.tokens.size > 0 ||
        state.restoreGeneration !== generation
      ) {
        return
      }
      state.active = false
      this.releaseTransparentWindowBootstrap(state)
      this.wakeCapturePumps(state)
      if (this.states.get(key) === state) this.states.delete(key)
    })
  }

  /** capture 泵主循环:按泵模式连续/间隔采集,采集失败即 invalidate 并终止。 */
  private async runCapturePump(state: BrowserScreenshotActivityState, target: CapturePumpTarget): Promise<void> {
    const pump = state.pumps[target]
    pump.running = true
    let startedAt = Date.now()
    let pending: Promise<boolean> | undefined = this.captureOnce(state, target)
    try {
      while (pending) {
        const mode = this.getPumpMode(state, target)
        if (mode === "stopped") {
          const captured = await pending
          if (!captured) this.invalidateActivity(state, target)
          pending = undefined
          continue
        }
        if (mode === "continuous") {
          const nextStartedAt = Date.now()
          const next = this.captureOnce(state, target)
          const captured = await pending
          if (!captured) {
            this.invalidateActivity(state, target)
            await next
            pending = undefined
            continue
          }
          pending = next
          startedAt = nextStartedAt
          await this.waitForContinuousCaptureTurn(state, pump, target)
          continue
        }
        const captured = await pending
        if (!captured) {
          this.invalidateActivity(state, target)
          pending = undefined
          continue
        }
        pending = undefined
        await this.waitForGuestCaptureSlot(state, pump, startedAt)
        if (this.getPumpMode(state, target) !== "stopped") {
          startedAt = Date.now()
          pending = this.captureOnce(state, target)
        }
      }
    } finally {
      pump.wakeDelay = undefined
      pump.running = false
      if (this.getPumpMode(state, target) !== "stopped") this.ensureCapturePump(state, target)
    }
  }

  /** 1×1 capturePage 探活;目标不可解析或采集抛错均视为失败。 */
  private async captureOnce(state: BrowserScreenshotActivityState, target: CapturePumpTarget): Promise<boolean> {
    const targets = this.resolveActivityTargets(state.windowId, state.webContentsId)
    if (!targets) return false
    try {
      await targets[target].capturePage(CAPTURE_PROBE_RECT)
      return true
    } catch (error) {
      this.options.log?.(
        `[browser-screenshot-activity] capture failed target=${target} windowId=${state.windowId} webContentsId=${state.webContentsId} error=${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  private ensureCapturePumps(state: BrowserScreenshotActivityState): void {
    if (!state.capturePumpsAllowed) return
    this.ensureCapturePump(state, "owner")
    this.ensureCapturePump(state, "guest")
  }

  private ensureCapturePump(state: BrowserScreenshotActivityState, target: CapturePumpTarget): void {
    if (!state.pumps[target].running && this.getPumpMode(state, target) !== "stopped") {
      void this.runCapturePump(state, target)
    }
  }

  /** 泵模式:无活动/无 token 停止;有未 prepared 的 token 连转;否则仅 guest 泵 paced。 */
  private getPumpMode(state: BrowserScreenshotActivityState, target: CapturePumpTarget): CapturePumpMode {
    if (!state.active || state.tokens.size === 0) return "stopped"
    const anyUnprepared = Array.from(state.tokens.values()).some((token) => !token.prepared)
    return anyUnprepared ? "continuous" : target === "guest" ? "paced" : "stopped"
  }

  /** guest 泵 paced 模式的剩余等待;wakeDelay 句柄可被 wakeCapturePumps 提前唤醒。 */
  private async waitForGuestCaptureSlot(
    state: BrowserScreenshotActivityState,
    pump: CapturePumpState,
    startedAt: number,
  ): Promise<void> {
    const delay = Math.max(0, GUEST_CAPTURE_PUMP_MIN_INTERVAL_MS - (Date.now() - startedAt))
    if (delay === 0 || this.getPumpMode(state, "guest") !== "paced") return
    await new Promise<void>((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (pump.wakeDelay === finish) pump.wakeDelay = undefined
        resolve()
      }
      const timer = setTimeout(finish, delay)
      pump.wakeDelay = finish
    })
  }

  /** continuous 模式的让步等待(setTimeout 0),让事件循环与并发 token 插入。 */
  private async waitForContinuousCaptureTurn(
    state: BrowserScreenshotActivityState,
    pump: CapturePumpState,
    target: CapturePumpTarget,
  ): Promise<void> {
    if (this.getPumpMode(state, target) !== "continuous") return
    await new Promise<void>((resolve) => {
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        if (pump.wakeDelay === finish) pump.wakeDelay = undefined
        resolve()
      }
      const timer = setTimeout(finish, 0)
      pump.wakeDelay = finish
    })
  }

  private wakeCapturePumps(state: BrowserScreenshotActivityState): void {
    state.pumps.owner.wakeDelay?.()
    state.pumps.guest.wakeDelay?.()
  }

  /** 采集失败:停活动、释放引导、摘除状态并广播 invalidated。 */
  private invalidateActivity(state: BrowserScreenshotActivityState, target: CapturePumpTarget): void {
    if (!state.active || state.tokens.size === 0) return
    state.active = false
    this.releaseTransparentWindowBootstrap(state)
    this.wakeCapturePumps(state)
    if (this.states.get(state.key) === state) this.states.delete(state.key)
    if (!state.invalidationController.signal.aborted) {
      state.invalidationController.abort(
        new Error(`browser screenshot activity capture failed for ${target}`),
      )
    }
  }

  /**
   * 解析活动目标:主窗口(须与 windowId 匹配且未销毁)+ guest webContents
   * (须存在且 hostWebContents 归属于主窗口 webContents)。
   */
  private resolveActivityTargets(
    windowId: number,
    webContentsId: number,
  ): { window: BrowserWindow; owner: Electron.WebContents; guest: Electron.WebContents } | undefined {
    const win = this.options.getWindow()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return undefined
    if (win.id !== windowId) return undefined
    const guest = this.options.webContentsFromId(webContentsId)
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.id !== webContentsId ||
      guest.hostWebContents?.id !== win.webContents.id
    ) {
      return undefined
    }
    return { window: win, owner: win.webContents, guest }
  }

  private releaseTransparentWindowBootstrap(state: BrowserScreenshotActivityState): void {
    if (state.capturePumpStartTimer) {
      clearTimeout(state.capturePumpStartTimer)
      state.capturePumpStartTimer = undefined
    }
    state.transparentWindowBootstrap?.release()
    state.transparentWindowBootstrap = undefined
  }

  private scheduleCapturePumpsAfterTransparentBootstrap(state: BrowserScreenshotActivityState): void {
    if (!state.transparentWindowBootstrap) return
    state.capturePumpStartTimer = setTimeout(() => {
      state.capturePumpStartTimer = undefined
      if (!state.active || this.states.get(state.key) !== state) return
      state.capturePumpsAllowed = true
      this.ensureCapturePumps(state)
      this.maybeReleaseTransparentWindowBootstrap(state)
    }, CAPTURE_PUMP_BOOTSTRAP_START_DELAY_MS)
  }

  private maybeReleaseTransparentWindowBootstrap(state: BrowserScreenshotActivityState): void {
    if (!state.capturePumpsAllowed) return
    if (Array.from(state.tokens.values()).some((token) => !token.prepared)) return
    this.releaseTransparentWindowBootstrap(state)
  }

  private getStateKey(windowId: number, webContentsId: number): string {
    return `${windowId}:${webContentsId}`
  }
}

/* ── 表面协调器(ZCode Vg) ────────────────────────────────────────── */

/** 活动租约形态(acquireActivity 的返回;qg.acquire 的结果)。 */
type SurfaceActivityLease = {
  invalidated: AbortSignal
  markPrepared?: () => void
  release: () => void
}

/** prepare 分组:同 guestKey(标识+viewport JSON)的请求共享一次摆位。 */
interface SurfaceGroup {
  key: string
  payload: BrowserScreenshotSurfacePreparePayload
  windowId: number
  requests: Set<SurfaceRequest>
  prepareSent: boolean
  ready: boolean
  released: boolean
  leaseReleases: Set<() => void>
  activityTimeoutMs?: number
  invalidationController: AbortController
  /** 首个就绪回报的 sender,其后来自其它 renderer 的回报被忽略。 */
  senderWebContentsId?: number
  activityLease?: SurfaceActivityLease
  activityAbortListener?: () => void
  activityTimer?: ReturnType<typeof setTimeout>
  readySurfaceScale?: number
  readyViewport?: { width: number; height: number }
}

/** prepare 的单个等待者(超时/abort 竞速的句柄集合)。 */
interface SurfaceRequest {
  input: ScreenshotSurfacePrepareRequest
  group: SurfaceGroup
  resolve: (lease: ScreenshotSurfaceLease) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  abortListener: () => void
}

export interface DesktopBrowserScreenshotSurfaceCoordinatorOptions {
  timeoutMs?: number
  activityTimeoutMs?: number
  /** 可选:活动期控制器工厂注入(ZCode 经 YH 接 qg.acquire)。 */
  acquireActivity?: (
    windowId: number,
    payload: BrowserScreenshotSurfacePreparePayload,
  ) => SurfaceActivityLease | undefined
  sendPrepare: (windowId: number, payload: BrowserScreenshotSurfacePreparePayload) => boolean
  sendRelease: (windowId: number, payload: BrowserScreenshotSurfaceReleasePayload) => void
  log?: (message: string) => void
  warn?: (message: string) => void
}

/**
 * 截图表面协调器(ZCode Vg DesktopBrowserScreenshotSurfaceCoordinator)。
 *
 * prepare() 按 guestKey(标识+viewport JSON)分组排队,串行 activateNextGroup():
 * 先 acquireActivity(活动控制器)再 sendPrepare;handleReady() 校验身份/视口稳定
 * (±1px)/surfaceScale 合法性(unscaled 要求 |scale-1|≤SURFACE_SCALE_TOLERANCE)
 * 后放行全部等待者;createLease 引用计数,最后一个 lease 释放时 settleGroup →
 * sendRelease + 活动租约清理 + 激活下一组。
 *
 * 看门狗:prepare 请求超时 timeoutMs(默认 3000,per-request abort 亦 fail-fast);
 * activity watchdog activityTimeoutMs(默认 35000,可 per-request 覆盖)兜底整组失败。
 */
export class DesktopBrowserScreenshotSurfaceCoordinator implements ScreenshotSurfaceCoordinatorPort {
  readonly options: DesktopBrowserScreenshotSurfaceCoordinatorOptions
  readonly timeoutMs: number
  readonly activityTimeoutMs: number

  private groupsByGuestKey = new Map<string, SurfaceGroup>()
  private groupsByReadyRequestId = new Map<string, SurfaceGroup>()
  private queuedGroups: SurfaceGroup[] = []
  private activeGroup?: SurfaceGroup
  private schedulingSuspended = false
  private disposed = false

  constructor(options: DesktopBrowserScreenshotSurfaceCoordinatorOptions) {
    this.options = options
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS
    this.activityTimeoutMs = options.activityTimeoutMs ?? DEFAULT_ACTIVITY_TIMEOUT_MS
  }

  /** 发起表面准备:同组复用已就绪分组直接发租约;否则入队等待 ready/超时/abort。 */
  prepare(request: ScreenshotSurfacePrepareRequest): Promise<ScreenshotSurfaceLease> {
    if (this.disposed) {
      return Promise.reject(new Error("browser screenshot surface coordinator disposed"))
    }
    if (request.signal.aborted) {
      return Promise.reject(new Error("browser screenshot surface preparation cancelled"))
    }
    if (request.viewport.width <= 0 || request.viewport.height <= 0) {
      return Promise.reject(
        new Error("browser screenshot surface preparation requires a non-zero viewport"),
      )
    }
    const guestKey = this.getGuestKey(request)
    let group = this.groupsByGuestKey.get(guestKey)
    if (group?.ready) {
      return Promise.resolve(this.createLease(group, request.signal))
    }
    if (!group) {
      group = {
        key: guestKey,
        payload: toBrowserScreenshotSurfacePreparePayload(request, this.timeoutMs),
        windowId: request.windowId,
        requests: new Set(),
        prepareSent: false,
        ready: false,
        released: false,
        leaseReleases: new Set(),
        activityTimeoutMs: request.activityTimeoutMs,
        invalidationController: new AbortController(),
      }
      this.groupsByGuestKey.set(guestKey, group)
      this.queuedGroups.push(group)
    }
    return new Promise<ScreenshotSurfaceLease>((resolve, reject) => {
      const entry = {} as SurfaceRequest
      const failForAbort = () => {
        this.finishRequestError(entry, new Error("browser screenshot surface preparation cancelled"))
      }
      entry.input = request
      entry.group = group
      entry.resolve = resolve
      entry.reject = reject
      entry.timer = setTimeout(() => {
        this.finishRequestError(
          entry,
          new Error(`browser screenshot surface preparation timed out after ${this.timeoutMs}ms`),
        )
      }, this.timeoutMs)
      entry.abortListener = failForAbort
      group.requests.add(entry)
      request.signal.addEventListener("abort", failForAbort, { once: true })
      if (request.signal.aborted) {
        failForAbort()
        return
      }
      this.activateNextGroup()
    })
  }

  /**
   * renderer 就绪回报入口(ipc 层把 `lume:browser-view-screenshot-surface-ready`
   * 接到这里)。校验身份五元组+windowId、sender 一致性、视口 ±1px 稳定、
   * surfaceScale>0、unscaled 模式 |scale-1|≤0.001,全部通过才放行整组。
   */
  handleReady(payload: BrowserScreenshotSurfaceReadyPayload, senderWebContentsId: number): void {
    const group = this.groupsByReadyRequestId.get(payload.requestId)
    if (!group || group !== this.activeGroup || group.released || group.ready) return
    const expected = group.payload
    if (
      group.windowId !== payload.windowId ||
      expected.requestId !== payload.requestId ||
      expected.workspaceKey !== payload.workspaceKey ||
      expected.sessionId !== payload.sessionId ||
      expected.browserId !== payload.browserId ||
      expected.browserGeneration !== payload.browserGeneration ||
      expected.tabId !== payload.tabId ||
      expected.webContentsId !== payload.webContentsId
    ) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with mismatched identity")
      return
    }
    if (group.senderWebContentsId !== undefined && group.senderWebContentsId !== senderWebContentsId) {
      this.options.log?.("[browser-screenshot-surface] ignored ready from a different renderer")
      return
    }
    group.senderWebContentsId ??= senderWebContentsId
    if (!sameBrowserScreenshotViewport(expected.viewport, payload.viewport)) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with unstable viewport")
      return
    }
    if (!Number.isFinite(payload.surfaceScale) || payload.surfaceScale <= 0) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with invalid surface scale")
      return
    }
    if (
      expected.surfaceScaleMode === "unscaled" &&
      Math.abs(payload.surfaceScale - 1) > SURFACE_SCALE_TOLERANCE
    ) {
      this.options.log?.("[browser-screenshot-surface] ignored ready with scaled recording surface")
      return
    }
    this.finishGroupReady(group, payload.viewport, payload.surfaceScale)
  }

  /** 窗口销毁:挂起调度,失败所有该窗口的分组后恢复调度。 */
  handleWindowDestroyed(windowId: number): void {
    const groups = Array.from(this.groupsByGuestKey.values())
    const previousSuspended = this.schedulingSuspended
    this.schedulingSuspended = true
    try {
      for (const group of groups) {
        if (group.windowId === windowId) {
          this.finishGroupError(group, new Error("browser screenshot surface preparation window destroyed"))
        }
      }
    } finally {
      this.schedulingSuspended = previousSuspended
      if (!previousSuspended) this.activateNextGroup()
    }
  }

  /** 释放全部分组(等待者以 disposed 错误拒绝);之后 prepare 直接拒绝。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const groups = Array.from(this.groupsByGuestKey.values())
    for (const group of groups) {
      this.finishGroupError(group, new Error("browser screenshot surface coordinator disposed"))
    }
  }

  /** guestKey:窗口+归属五元组+viewport+缩放模式的 JSON(ZCode 同构)。 */
  private getGuestKey(request: ScreenshotSurfacePrepareRequest): string {
    return JSON.stringify([
      request.windowId,
      request.workspaceKey,
      request.sessionId,
      request.browserId,
      request.browserGeneration,
      request.tabId,
      request.webContentsId,
      request.viewport.width,
      request.viewport.height,
      request.surfaceScaleMode ?? "current",
    ])
  }

  /** 串行激活:队首有效分组 acquireActivity + watchdog + sendPrepare。 */
  private activateNextGroup(): void {
    if (this.activeGroup || this.disposed) return
    const group = this.queuedGroups.shift()
    if (!group) return
    if (group.released || group.requests.size === 0) {
      this.activateNextGroup()
      return
    }
    this.activeGroup = group
    this.groupsByReadyRequestId.set(group.payload.requestId, group)
    if (this.options.acquireActivity) {
      group.activityLease = this.options.acquireActivity(group.windowId, group.payload)
      if (!group.activityLease) {
        this.finishGroupError(group, new Error("browser screenshot activity could not be acquired"))
        return
      }
      const invalidated = group.activityLease.invalidated
      if (invalidated) {
        const failForInvalidActivity = () => {
          const reason =
            invalidated.reason instanceof Error
              ? invalidated.reason
              : new Error("browser screenshot activity was invalidated")
          this.finishGroupError(group, reason)
        }
        group.activityAbortListener = failForInvalidActivity
        invalidated.addEventListener("abort", failForInvalidActivity, { once: true })
        if (invalidated.aborted) {
          failForInvalidActivity()
          return
        }
      }
      const activityTimeoutMs = group.activityTimeoutMs ?? this.activityTimeoutMs
      group.activityTimer = setTimeout(() => {
        this.options.warn?.(
          `[browser-screenshot-surface] activity watchdog released requestId=${group.payload.requestId} windowId=${group.windowId}`,
        )
        this.finishGroupError(
          group,
          new Error(`browser screenshot activity timed out after ${activityTimeoutMs}ms`),
        )
      }, activityTimeoutMs)
    }
    group.prepareSent = true
    let sent = false
    try {
      sent = this.options.sendPrepare(group.windowId, group.payload)
    } catch {
      if (!group.ready && !group.released) {
        this.finishGroupError(group, new Error("browser screenshot surface preparation could not be sent"))
      }
      return
    }
    if (!sent && !group.ready && !group.released) {
      this.finishGroupError(group, new Error("browser screenshot surface preparation could not be sent"))
    }
  }

  /** 就绪:标记活动租约 prepared,放行(逐个建租约)全部等待者。 */
  private finishGroupReady(
    group: SurfaceGroup,
    viewport: { width: number; height: number },
    surfaceScale: number,
  ): void {
    if (group.ready || group.released) return
    group.activityLease?.markPrepared?.()
    if (group.released) return
    group.ready = true
    group.readySurfaceScale = surfaceScale
    group.readyViewport = viewport
    this.groupsByReadyRequestId.delete(group.payload.requestId)
    const requests = [...group.requests]
    group.requests.clear()
    for (const request of requests) {
      this.clearRequest(request)
      request.resolve(this.createLease(group, request.input.signal))
    }
  }

  /** 单请求失败(超时/abort):摘除等待者;组未就绪且为空时整组结算。 */
  private finishRequestError(request: SurfaceRequest, error: Error): void {
    const { group } = request
    if (!group.requests.delete(request)) return
    this.clearRequest(request)
    request.reject(error)
    if (!group.ready && group.requests.size === 0) this.settleGroup(group)
  }

  /** 整组失败:abort 失效信号、拒绝全部等待者并结算。 */
  private finishGroupError(group: SurfaceGroup, error: Error): void {
    if (group.released) return
    if (!group.invalidationController.signal.aborted) group.invalidationController.abort(error)
    const requests = [...group.requests]
    group.requests.clear()
    for (const request of requests) {
      this.clearRequest(request)
      request.reject(error)
    }
    this.settleGroup(group)
  }

  private clearRequest(request: SurfaceRequest): void {
    clearTimeout(request.timer)
    request.input.signal.removeEventListener("abort", request.abortListener)
  }

  /** 创建引用计数租约:signal 已 abort 或 release 都会触发一次性结算检查。 */
  private createLease(group: SurfaceGroup, signal: AbortSignal): ScreenshotSurfaceLease {
    let release: () => void
    const onAbort = () => {
      release()
    }
    release = releaseBrowserScreenshotResourceOnce(() => {
      signal.removeEventListener("abort", onAbort)
      group.leaseReleases.delete(release)
      if (!group.released && group.leaseReleases.size === 0) this.settleGroup(group)
    })
    group.leaseReleases.add(release)
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) release()
    return {
      invalidated: group.invalidationController.signal,
      surfaceScale: group.readySurfaceScale ?? 1,
      webContentsId: group.payload.webContentsId,
      viewport: group.readyViewport ?? group.payload.viewport,
      release,
    }
  }

  /** 结算分组:发 release、清理活动租约/看门狗、激活下一组。 */
  private settleGroup(group: SurfaceGroup): void {
    if (group.released) return
    group.released = true
    if (group.activityTimer) {
      clearTimeout(group.activityTimer)
      group.activityTimer = undefined
    }
    this.groupsByGuestKey.delete(group.key)
    this.groupsByReadyRequestId.delete(group.payload.requestId)
    const queuedIndex = this.queuedGroups.indexOf(group)
    if (queuedIndex >= 0) this.queuedGroups.splice(queuedIndex, 1)
    try {
      if (group.prepareSent) {
        this.options.sendRelease(group.windowId, toBrowserScreenshotSurfaceReleasePayload(group.payload))
      }
    } catch {
      this.options.log?.("[browser-screenshot-surface] release send failed")
    } finally {
      for (const release of group.leaseReleases) release()
      group.leaseReleases.clear()
      const invalidated = group.activityLease?.invalidated
      if (invalidated && group.activityAbortListener) {
        invalidated.removeEventListener("abort", group.activityAbortListener)
      }
      group.activityAbortListener = undefined
      group.activityLease?.release()
      group.activityLease = undefined
    }
    if (this.activeGroup === group) {
      this.activeGroup = undefined
      if (!this.schedulingSuspended) this.activateNextGroup()
    }
  }
}

/* ── 装配工厂(ZCode YH) ──────────────────────────────────────────── */

export interface DesktopBrowserScreenshotSurfaceCoordinatorDeps {
  /** Lume 单窗口形态:替代 ZCode 的 BrowserWindow.fromId(见文件头偏差 1)。 */
  getWindow: () => BrowserWindow | null
  /** webContents.fromId 的可注入形态(测试用)。 */
  webContentsFromId: (id: number) => Electron.WebContents | undefined
  /** 事件面出口:prepare/release 以 `lume:browser-view-screenshot-surface-*` 通道发往窗口。 */
  emit: BrowserEventSink
  timeoutMs?: number
  activityTimeoutMs?: number
  /** 默认 darwin||win32 开启透明窗口引导。 */
  allowTransparentWindowBootstrap?: boolean
  /** 默认仅 win32 开启引导期隐藏任务栏。 */
  hideTaskbarDuringTransparentWindowBootstrap?: boolean
  log?: (message: string) => void
  warn?: (message: string) => void
}

/**
 * 装配工厂(ZCode YH createDesktopBrowserScreenshotSurfaceCoordinator):
 * 创建活动控制器与协调器并接线 —— acquireActivity→acquire;sendPrepare/sendRelease
 * 经 emit 以 `lume:browser-view-screenshot-surface-prepare|-release` 通道发往窗口;
 * 就绪回报由 ipc 层把 `lume:browser-view-screenshot-surface-ready` 接到返回实例的
 * `handleReady(payload, senderWebContentsId)`;窗口销毁接到 `handleWindowDestroyed`。
 * 返回实例即 types.ts 的 ScreenshotSurfaceCoordinatorPort 实现。
 */
export function createDesktopBrowserScreenshotSurfaceCoordinator(
  deps: DesktopBrowserScreenshotSurfaceCoordinatorDeps,
): DesktopBrowserScreenshotSurfaceCoordinator {
  const activityController = new DesktopBrowserScreenshotActivityController({
    getWindow: deps.getWindow,
    webContentsFromId: deps.webContentsFromId,
    allowTransparentWindowBootstrap:
      deps.allowTransparentWindowBootstrap ??
      (process.platform === "darwin" || process.platform === "win32"),
    hideTaskbarDuringTransparentWindowBootstrap:
      deps.hideTaskbarDuringTransparentWindowBootstrap ?? process.platform === "win32",
    log: deps.log,
  })
  return new DesktopBrowserScreenshotSurfaceCoordinator({
    timeoutMs: deps.timeoutMs,
    activityTimeoutMs: deps.activityTimeoutMs,
    acquireActivity: (windowId, payload) =>
      activityController.acquire({
        windowId,
        webContentsId: payload.webContentsId,
        requestId: payload.requestId,
        reason: "browser-screenshot",
      }),
    sendPrepare: (windowId, payload) => {
      const win = deps.getWindow()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.id !== windowId) {
        deps.log?.("[browser-screenshot-surface] prepare skipped for destroyed owner window")
        return false
      }
      try {
        deps.emit({
          method: BROWSER_SCREENSHOT_SURFACE_PREPARE_CHANNEL,
          params: payload as Record<string, unknown>,
        })
        return true
      } catch {
        deps.log?.("[browser-screenshot-surface] prepare send failed")
        return false
      }
    },
    sendRelease: (windowId, payload) => {
      const win = deps.getWindow()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed() || win.id !== windowId) {
        deps.log?.("[browser-screenshot-surface] release skipped for destroyed owner window")
        return
      }
      try {
        deps.emit({
          method: BROWSER_SCREENSHOT_SURFACE_RELEASE_CHANNEL,
          params: payload as Record<string, unknown>,
        })
      } catch {
        deps.log?.("[browser-screenshot-surface] release send failed")
      }
    },
    log: deps.log,
    warn: deps.warn,
  })
}
