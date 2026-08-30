/**
 * 单视图命令执行器 —— executeBrowserCommandOnView 分发器与导航/状态/输入处理器。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js(前半:URL/导航、状态与超时原语、
 *       输入原语、命令处理器、executeBrowserCommandOnView 分发器、
 *       handlePlaywrightAction 与辅助 evaluate 通道)
 *
 * ZCode 原名对照:
 *   rM → isAllowedBrowserUrl            Bde → isElectronNavigationAborted
 *   dH → normalizedHost                 lH → normalizedPath
 *   Fde → isEquivalentNavigationUrl     Wde → confirmAbortedNavigationCommitted
 *   mH → handleNavigate                 Tj → PAGE_STATE_PROBE_EXPRESSION
 *   oM → now                            He → readState
 *   Bj → settleNavigation               Lg → safe
 *   Sr → refNotFound                    Wt → executionError
 *   gH → handleGetState                 gde → MODIFIER_BITS
 *   Dj → KEY_TABLE                      hde → MODIFIER_KEY_TABLE
 *   yde → normalizeCuaKey               $j → asModifier
 *   wde → keyDefinition                 Rn → modifiersBitmask
 *   ai → resolveRefCenter               ci → dispatchClickAt
 *   Nj → dispatchDrag                   Lj → dispatchDragPath
 *   nM → dispatchScrollGesture          Uj → dispatchKeyPress
 *   Ng → dispatchKey                    kde → OOPIF_ATTACH_BUDGET_MS
 *   bde → FOCUSED_FRAME_ELEMENT_EXPRESSION
 *   iM → cdpRuntimeError                _de → evaluateTargetKey
 *   En → sendToTarget                   Wj → detachAttachedSessions
 *   zj → tryAttachFrameTarget           Pde → waitForOopifTarget
 *   Sde → resolveFocusedInputTarget     Cde → escapeHtml
 *   Ide → clipboardItems                Rde → shouldIncludeRichText
 *   sM → createInputTargetToken         Zj → assertFocusedInputTarget
 *   Ug → pasteTextIntoFocusedTarget     Hj → handleClick
 *   Gj → handleType                     Kj → handlePress
 *   qj → handleCuaKeypress              Vj → handleScroll
 *   Jj → handleCuaScroll                Xj → handleDomCuaScroll
 *   Yj → handleHover                    Qj → handleSelect
 *   eH → handleCheck                    tH → handleDrag
 *   nH → handleCuaDrag                  oH → resolveCommandPoint
 *   jj → resolveDragPoint               jg → executeBrowserCommandOnView
 *   ui → normalizePlaywrightTimeout     ule → POLL_INTERVAL_MS
 *   EH → poll                           vM → timeoutResult
 *   fle → locatorTimeoutResult          mle → urlMatches
 *   RH → waitForDocumentState           gle → evaluateWithCdp
 *   TH → handlePlaywrightAction
 *   (Vd → BrowserNavigationTimeoutError 已并入 ../types)
 *
 * 语义偏差(应为空,除以下已声明项):
 *   - 平台:ref 注册表/频道命名保持 ZCode 内部标识(__zcodeRefs 等)。
 *   - s(X,"name") 为压缩器 displayName 元数据,非注入字符串内的出现一律去除。
 *   - Uj 内 n.toReversed() 以 n.slice().reverse() 等价改写(lib ES2022 无 toReversed)。
 *   - createInputTargetToken 原调 vde()(未在提取源中),以 crypto.randomUUID() 替代。
 *   - handlePlaywrightAction 的 domSnapshot/locator 需要第二段 playwright 引擎
 *     会话(PlaywrightDomSnapshotSession/IabPlaywrightLocatorSession),经
 *     PlaywrightActionExecutorPort 注入;未装配时按 capability_unsupported 返回。
 *   - executeBrowserCommandOnView 的调用方需先行完成命令参数协议校验(与 ZCode
 *     共享 zod 协议等价),各 *Params 接口即该协议的形状声明。
 *   - A7 去重(集成接线):输入原语/键表/鼠标滚动键盘与导航状态原语改由
 *     ../input 单源提供;聚焦帧解析与虚拟剪贴板粘贴管线改由 ../injected/text-input
 *     单源提供。原内联副本的 clipboardItems 缺 {entries, presentation_style} 包装层
 *     (Fj 按 item.entries 消费,缺失会使 textForMime/setData 失效),属副本缺陷,
 *     已随去重一并修正;text-input 的 dispatchTextInput(ZCode 名
 *     pasteTextIntoFocusedTarget/Ug)为规范实现,本文件保留同名选项适配层
 *     (includeRichText → richTextFallback)。
 *   - fill 路由为 Lume 扩展:ZCode 执行器 jg 无 fill 分支(fill 仅存在于
 *     locator 操作面,落默认分支 capability_unsupported);Lume 按协议 46 命令面
 *     补齐 case "fill",复用 type 机制(可选 ref 点击聚焦 + Fj 粘贴管线),
 *     replaceInputValue:true 承载替换语义(locator fill 的 replace !== false
 *     分支保留在 locator-session.ts)。
 *
 * 注意:screenshot/snapshot/evaluate/element-info 各模块 import 本文件的
 * readState(函数声明,提升绑定),运行期互相调用,ESM 活绑定安全。
 */
import {
  dispatchClickAt,
  dispatchDrag,
  dispatchDragPath,
  dispatchKey,
  dispatchKeyPress,
  dispatchScrollGesture,
  isAllowedBrowserUrl,
  modifiersBitmask,
  readState,
  settleNavigation,
  type CommandPoint,
  type Point2D,
} from "../input"
import { dispatchTextInput, type TextInputEvaluateTarget } from "../injected/text-input"

/* ── A7 去重重导出(公共导出面保持不变;实现单源于 input/text-input 模块) ── */

export {
  asModifier,
  dispatchClickAt,
  dispatchDrag,
  dispatchDragPath,
  dispatchKey,
  dispatchKeyPress,
  dispatchScrollGesture,
  isAllowedBrowserUrl,
  keyDefinition,
  modifiersBitmask,
  normalizeCuaKey,
  readState,
  settleNavigation,
} from "../input"
export type { CommandPoint, Point2D }
export {
  assertFocusedInputTarget,
  cdpRuntimeError,
  clipboardItems,
  createInputTargetToken,
  detachAttachedSessions,
  escapeHtml,
  evaluateTargetKey,
  resolveFocusedInputTarget,
  sendToTarget,
  shouldIncludeRichText,
  tryAttachFrameTarget,
  waitForOopifTarget,
} from "../injected/text-input"
export type InputEvaluateTarget = TextInputEvaluateTarget
import {
  checkScript,
  resolveScript,
  selectScript,
  ELEMENT_INFO_RUNTIME_FN_SOURCE,
  OVERLAY_RUNTIME_FN_SOURCE,
} from "./injecteds/generators"
import {
  handleElementInfo, serializeRuntimeCall, evaluateInPlaywrightIsolatedWorld,
} from "./element-info"
import { handleEvaluate } from "./evaluate"
import { handleSnapshot } from "./snapshot"
import { handleScreenshot, captureScreenshotWithCssPixelCorrection, buildViewportScreenshotParams } from "./screenshot"
import {
  BrowserNavigationTimeoutError,
  type BrowserCommand,
  type BrowserCommandResult,
  type ControlledView,
} from "../types"

/* ── PortingGap:协议与依赖形状声明 ──────────────────────────────────── */

/**
 * PortingGap:ZCode 共享 zod 协议的命令参数形状(46 命令枚举中的执行器子集)。
 * 调用方(guest-manager 装配层)负责先行 zod 校验;执行器按已校验输入消费。
 */
export interface NavigateCommandParams { url: string }
export interface ScreenshotCommandParams { clip?: { x: number; y: number; width: number; height: number }; fullPage?: boolean }
export interface SnapshotCommandParams { maxElements?: number; includeHidden?: boolean }
export interface ClickCommandParams { ref?: string; x?: number; y?: number; button?: "left" | "right" | "middle"; doubleClick?: boolean; modifiers?: string[] }
export interface TypeCommandParams { ref?: string; text: string }
export interface FillCommandParams { ref?: string; text: string }
export interface PressCommandParams { ref?: string; key: string; modifiers?: string[] }
export interface CuaKeypressCommandParams { keys: string[] }
export interface ScrollCommandParams { ref?: string; x?: number; y?: number }
export interface CuaScrollCommandParams { x: number; y: number; scrollX: number; scrollY: number; modifiers?: string[] }
export interface DomCuaScrollCommandParams { nodeId?: string; scrollX: number; scrollY: number }
export interface HoverCommandParams { ref?: string; x?: number; y?: number; modifiers?: string[] }
export interface SelectCommandParams { ref: string; values: string[] }
export interface CheckCommandParams { ref: string; checked?: boolean }
export interface DragCommandParams { fromRef?: string; from?: Point2D; toRef?: string; to?: Point2D; modifiers?: string[] }
export interface CuaDragCommandParams { path: Point2D[]; modifiers?: string[] }
export interface ElementInfoCommandParams { x: number; y: number }
export interface EvaluateCommandParams { expression: string }

/** PortingGap:playwright 动作请求形状(name 判别 + 各动作字段)。 */
export interface PlaywrightActionRequest {
  name: string
  x?: number
  y?: number
  includeNonInteractable?: boolean
  expression?: string
  arg?: unknown
  expressionKind?: string
  timeoutMs?: number
  url?: string
  waitUntil?: string
  state?: string
  [key: string]: unknown
}

/** playwright 引擎执行结果(domSnapshot/locator 之外的动作由执行器内建)。 */
export interface PlaywrightActionExecution {
  kind: "cancelled" | "timeout" | "ok"
  reason?: string
  value?: unknown
}

/**
 * PortingGap:playwright-over-CDP 引擎端口(02 源码后半段的
 * PlaywrightDomSnapshotSession/IabPlaywrightLocatorSession),由集成者装配。
 */
export interface PlaywrightActionExecutorPort {
  domSnapshot(view: ControlledView, signal?: AbortSignal): Promise<string>
  locator(view: ControlledView, action: PlaywrightActionRequest, timeoutMs: number, signal?: AbortSignal): Promise<PlaywrightActionExecution>
}

export interface ExecuteBrowserCommandOptions {
  signal?: AbortSignal
  /** navigate 的 settle 预算(默认 10s,见 handleNavigate) */
  navigateSettleMs?: number
  /** playwright 引擎端口(domSnapshot/locator 必需) */
  playwright?: PlaywrightActionExecutorPort
}

/** 命令结果包装器:统一注入 elapsedMs(ZCode 分发器内的 done)。 */
export type CommandDone = (result: BrowserCommandResult) => BrowserCommandResult

/* ── 页面状态 ──────────────────────────────────────────────────────── */

/** readState 返回的页面状态;handleGetState 追加滚动/视口字段。 */
export interface BrowserPageState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  scrollX?: number
  scrollY?: number
  viewportWidth?: number
  viewportHeight?: number
}

/* CommandPoint/Point2D 坐标形状(A7 去重)由 ../input 单源提供并重导出。 */

// Tj:只读页面滚动/视口探测表达式(handleGetState 使用)。
export const PAGE_STATE_PROBE_EXPRESSION = "(function(){return {scrollX:Math.round(window.scrollX||window.pageXOffset||0),scrollY:Math.round(window.scrollY||window.pageYOffset||0),innerWidth:window.innerWidth||document.documentElement.clientWidth||0,innerHeight:window.innerHeight||document.documentElement.clientHeight||0};})()"

/* ── URL/导航 ──────────────────────────────────────────────────────── */

/**
 * ZCode 原名 Bde/isElectronNavigationAborted:Electron ERR_ABORTED 判定。
 */
export function isElectronNavigationAborted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown }
  return candidate.code === "ERR_ABORTED" || candidate.errno === -3
    || (typeof candidate.message === "string" && /\bERR_ABORTED\b|\(-3\)/u.test(candidate.message))
}

/** ZCode 原名 dH/normalizedHost:主机归一化(去 m./www. 前缀,小写)。 */
export function normalizedHost(host: string): string {
  return host.toLowerCase().replace(/^(?:m|www)\./u, "")
}

/** ZCode 原名 lH/normalizedPath:路径去尾斜杠(根路径保留)。 */
export function normalizedPath(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/u, "") : path
}

/**
 * ZCode 原名 Fde/isEquivalentNavigationUrl:aborted 导航提交后的等价 URL
 * 判定(about: 严格相等;其余协议/归一化主机/端口/路径/search 相等)。
 */
export function isEquivalentNavigationUrl(left: string, right: string): boolean {
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.protocol === "about:" || b.protocol === "about:"
      ? a.href === b.href
      : a.protocol === b.protocol
        && normalizedHost(a.hostname) === normalizedHost(b.hostname)
        && a.port === b.port
        && normalizedPath(a.pathname) === normalizedPath(b.pathname)
        && a.search === b.search
  } catch {
    return false
  }
}

/** ZCode 原名 Lde:aborted 导航提交确认预算(ms)。 */
const ABORTED_NAVIGATION_CONFIRM_BUDGET_MS = 500
/** ZCode 原名 Ude:aborted 导航提交确认轮询步进(ms)。 */
const ABORTED_NAVIGATION_CONFIRM_POLL_MS = 25

/**
 * ZCode 原名 Wde/confirmAbortedNavigationCommitted:loadURL 以 ERR_ABORTED
 * 失败后,按 25ms 步进轮询(500ms 预算)确认导航是否实际提交。
 * 判据:URL 变化 + 页面 location 与主进程一致 + readyState 就绪 + 等价 URL。
 */
export async function confirmAbortedNavigationCommitted(
  view: ControlledView,
  targetUrl: string,
  previousUrl: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + ABORTED_NAVIGATION_CONFIRM_BUDGET_MS
  while (Date.now() <= deadline) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError")
    try {
      const probe = await view.webContents.executeJavaScript(`(() => ({
        href: globalThis.location?.href ?? "",
        readyState: document.readyState
      }))()`) as { href?: unknown; readyState?: unknown } | null
      const currentUrl = view.webContents.getURL()
      const href = typeof probe?.href === "string" ? probe.href : ""
      const readyState = probe?.readyState
      if (currentUrl !== previousUrl && href === currentUrl
        && (readyState === "interactive" || readyState === "complete")
        && isEquivalentNavigationUrl(targetUrl, currentUrl)) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, ABORTED_NAVIGATION_CONFIRM_POLL_MS))
  }
  return false
}

/** ZCode 原名 oM/now:单调计时起点(Date.now)。 */
export function now(): number {
  return Date.now()
}

/** ZCode 原名 Lg/safe:吞异常取默认值。 */
export function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/* He/readState 与 Bj/settleNavigation(A7 去重)已由 ../input 单源提供并重导出。 */

/** ZCode 原名 Sr/refNotFound:ref 未找到的标准错误负载。 */
export function refNotFound(ref: string): BrowserCommandResult {
  return {
    ok: false,
    error: {
      code: "ref_not_found",
      message: `ref ${ref} not found (take a fresh snapshot() first)`,
    },
  }
}

/** ZCode 原名 Wt/executionError:执行错误的标准错误负载。 */
export function executionError(message: string): BrowserCommandResult {
  return {
    ok: false,
    error: {
      code: "execution_error",
      message,
    },
  }
}

/** ZCode 原名 gH/handleGetState:readState + 滚动/视口探测(失败静默降级)。 */
export async function handleGetState(view: ControlledView, done: CommandDone): Promise<BrowserCommandResult> {
  const state: BrowserPageState = readState(view.webContents)
  try {
    const probe = await view.webContents.executeJavaScript(PAGE_STATE_PROBE_EXPRESSION) as Record<string, unknown> | null
    if (probe && typeof probe === "object") {
      if (typeof probe.scrollX === "number") state.scrollX = probe.scrollX
      if (typeof probe.scrollY === "number") state.scrollY = probe.scrollY
      if (typeof probe.innerWidth === "number") state.viewportWidth = probe.innerWidth
      if (typeof probe.innerHeight === "number") state.viewportHeight = probe.innerHeight
    }
  } catch {}
  return done({
    ok: true,
    state,
  })
}

/**
 * ZCode 原名 mH/handleNavigate:白名单校验 → loadURL + settleNavigation
 * (默认 10s)。超时/执行错误均上报 sideEffect:"uncertain";AbortError 直接
 * 向上抛(由分发器归一化为 cancelled);ERR_ABORTED 经 500ms 窗口确认提交。
 */
export async function handleNavigate(
  view: ControlledView,
  params: NavigateCommandParams,
  done: CommandDone,
  opts?: ExecuteBrowserCommandOptions,
): Promise<BrowserCommandResult> {
  if (!isAllowedBrowserUrl(params.url)) {
    return done({
      ok: false,
      error: {
        code: "navigation_blocked",
        message: `Blocked URL: ${params.url}`,
      },
    })
  }
  const previousUrl = view.webContents.getURL()
  try {
    await settleNavigation(view.webContents.loadURL(params.url), opts?.navigateSettleMs ?? 10_000, opts?.signal)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    if (isElectronNavigationAborted(error) && await confirmAbortedNavigationCommitted(view, params.url, previousUrl, opts?.signal)) {
      return done({
        ok: true,
        state: readState(view.webContents),
      })
    }
    return done({
      ok: false,
      error: {
        code: error instanceof BrowserNavigationTimeoutError ? "timeout" : "execution_error",
        message: error instanceof Error ? error.message : String(error),
        sideEffect: "uncertain",
      },
    })
  }
  return done({
    ok: true,
    state: readState(view.webContents),
  })
}

/* ── 输入原语(A7 去重:键表/鼠标/拖拽/滚动/键盘由 ../input 单源提供并重导出) ── */

/**
 * ZCode 原名 ai/resolveRefCenter:按 ref 解析元素中心视口坐标;
 * 结果缺失/形状不符返回 null。
 */
export async function resolveRefCenter(view: ControlledView, ref: string): Promise<CommandPoint | null> {
  const result = await view.webContents.executeJavaScript(resolveScript(ref)) as { cx?: unknown; cy?: unknown } | null
  return !result || typeof result.cx !== "number" || typeof result.cy !== "number"
    ? null
    : { cx: result.cx, cy: result.cy }
}

/* ci/dispatchClickAt、Nj/dispatchDrag、Lj/dispatchDragPath、nM/dispatchScrollGesture、
 * Uj/dispatchKeyPress、Ng/dispatchKey(A7 去重)已由 ../input 单源提供并重导出。 */

/* ── 帧链解析与虚拟剪贴板粘贴(handleType 依赖) ───────────────────── */

/** CDP Runtime.evaluate 响应形状(仅取用字段)。 */
interface CdpEvaluateResponse {
  result?: { objectId?: string; subtype?: string; value?: unknown }
  exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string }
}

/* iM/cdpRuntimeError、_de/evaluateTargetKey、En/sendToTarget、Wj/detachAttachedSessions、
 * zj/tryAttachFrameTarget、Pde/waitForOopifTarget、Sde/resolveFocusedInputTarget、
 * Cde/escapeHtml、Ide/clipboardItems、Rde/shouldIncludeRichText、sM/createInputTargetToken、
 * Zj/assertFocusedInputTarget(A7 去重)已由 ../injected/text-input 单源提供并重导出。
 * 注意:Ide 规范实现返回 [{ entries, presentation_style:"unspecified" }](Fj 按
 * item.entries 消费);原内联副本缺该包装层,已修正。 */

/** ZCode 原名 Ug/pasteTextIntoFocusedTarget 的粘贴选项。 */
export interface PasteTextOptions {
  includeRichText?: boolean
  inputTargetToken?: string
  replaceInputValue?: boolean
  initialTarget?: InputEvaluateTarget
}

/**
 * ZCode 原名 Ug/pasteTextIntoFocusedTarget:解析聚焦输入目标 → 构造剪贴板
 * 条目 → 页函数 Fj 派发 paste 事件(失败走 fallbackPaste);finally 释放
 * 全部附加会话。
 * (A7 去重:管线委托 text-input 的 dispatchTextInput(Ug 规范实现);本文件
 * 仅保留 includeRichText → richTextFallback 的选项适配,控制流等价。)
 */
export async function pasteTextIntoFocusedTarget(view: ControlledView, text: string, options: PasteTextOptions = {}): Promise<void> {
  await dispatchTextInput(view, text, {
    ...(options.includeRichText === undefined ? {} : { richTextFallback: options.includeRichText }),
    ...(options.inputTargetToken == null ? {} : { inputTargetToken: options.inputTargetToken }),
    ...(options.replaceInputValue === undefined ? {} : { replaceInputValue: options.replaceInputValue }),
    ...(options.initialTarget === undefined ? {} : { initialTarget: options.initialTarget }),
  })
}

/* ── CDP 直连命令处理器 ────────────────────────────────────────────── */

/** ZCode 原名 oH/resolveCommandPoint:坐标解析优先 ref,否则要求显式 (x,y)。 */
export async function resolveCommandPoint(view: ControlledView, params: { ref?: string; x?: number; y?: number }, label: string): Promise<{ kind: "ok"; point: CommandPoint } | { kind: "error"; error: BrowserCommandResult }> {
  if (params.ref) {
    const point = await resolveRefCenter(view, params.ref)
    return point
      ? { kind: "ok", point }
      : { kind: "error", error: refNotFound(params.ref) }
  }
  return typeof params.x === "number" && typeof params.y === "number"
    ? { kind: "ok", point: { cx: params.x, cy: params.y } }
    : { kind: "error", error: executionError(`${label} requires ref or (x,y)`) }
}

/** ZCode 原名 jj/resolveDragPoint:drag 端点解析(ref 或 {x,y})。 */
export async function resolveDragPoint(view: ControlledView, ref: string | undefined, point: Point2D | undefined, label: string): Promise<{ kind: "ok"; point: CommandPoint } | { kind: "error"; error: BrowserCommandResult }> {
  if (ref) {
    const resolved = await resolveRefCenter(view, ref)
    return resolved
      ? { kind: "ok", point: resolved }
      : { kind: "error", error: refNotFound(ref) }
  }
  return point
    ? { kind: "ok", point: { cx: point.x, cy: point.y } }
    : { kind: "error", error: executionError(`drag requires ${label}Ref or ${label}{x,y}`) }
}

/** ZCode 原名 Hj/handleClick:坐标解析 → dispatchClickAt(button/双击/修饰键)。 */
export async function handleClick(view: ControlledView, params: ClickCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  const point = await resolveCommandPoint(view, params, "click")
  if (point.kind === "error") return done(point.error)
  await dispatchClickAt(view, point.point, params.button ?? "left", params.doubleClick === true, modifiersBitmask(params.modifiers))
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 Gj/handleType:可选 ref 点击聚焦 → 虚拟剪贴板粘贴文本。 */
export async function handleType(view: ControlledView, params: TypeCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  if (params.ref) {
    const point = await resolveRefCenter(view, params.ref)
    if (!point) return done(refNotFound(params.ref))
    await dispatchClickAt(view, point, "left", false)
  }
  await pasteTextIntoFocusedTarget(view, params.text)
  return done({ ok: true, state: readState(view.webContents) })
}

/**
 * handleFill(ZCode 执行器 jg 无 fill 分支;Lume 补齐,语义取自 02 源码
 * IabPlaywrightLocatorSession.perform 的 fill 操作:聚焦目标 → 经 Fj 粘贴管线
 * 以 replaceInputValue 投递文本)。与 handleType 同构(可选 ref 点击聚焦),
 * 差异仅在 replaceInputValue:true —— fill 的协议形状 {ref?, text} 无 replace
 * 字段,恒为替换(replace !== false);追加语义由 type 承载,locator fill 的
 * replace:false 分支保留在 locator-session.ts。
 */
export async function handleFill(view: ControlledView, params: FillCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  if (params.ref) {
    const point = await resolveRefCenter(view, params.ref)
    if (!point) return done(refNotFound(params.ref))
    await dispatchClickAt(view, point, "left", false)
  }
  await pasteTextIntoFocusedTarget(view, params.text, { replaceInputValue: true })
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 Kj/handlePress:可选 ref 点击聚焦 → 单键 down+up。 */
export async function handlePress(view: ControlledView, params: PressCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  if (params.ref) {
    const point = await resolveRefCenter(view, params.ref)
    if (!point) return done(refNotFound(params.ref))
    await dispatchClickAt(view, point, "left", false)
  }
  await dispatchKey(view, params.key, modifiersBitmask(params.modifiers))
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 qj/handleCuaKeypress:"+"组合键序列。 */
export async function handleCuaKeypress(view: ControlledView, params: CuaKeypressCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  await dispatchKeyPress(view, params.keys)
  return done({ ok: true, state: readState(view.webContents) })
}

/**
 * ZCode 原名 Vj/handleScroll:带 ref 时仅滚动 ref 进入视野(resolveRefCenter
 * 的 scrollIntoView 副作用)后返回 ok;无 ref 时在 (0,0) 派发 mouseWheel。
 */
export async function handleScroll(view: ControlledView, params: ScrollCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  if (params.ref) {
    return await resolveRefCenter(view, params.ref)
      ? done({ ok: true, state: readState(view.webContents) })
      : done(refNotFound(params.ref))
  }
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 0,
    y: 0,
    deltaX: params.x ?? 0,
    deltaY: params.y ?? 0,
  })
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 Jj/handleCuaScroll:显式坐标 + scrollX/scrollY 滚动手势。 */
export async function handleCuaScroll(view: ControlledView, params: CuaScrollCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  await dispatchScrollGesture(view, { cx: params.x, cy: params.y }, params.scrollX, params.scrollY, modifiersBitmask(params.modifiers))
  return done({ ok: true, state: readState(view.webContents) })
}

/**
 * ZCode 原名 Xj/handleDomCuaScroll:nodeId 解析中心点,否则取 cssVisualViewport
 * 中心;缺失时 execution_error。
 */
export async function handleDomCuaScroll(view: ControlledView, params: DomCuaScrollCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  let point: CommandPoint
  if (params.nodeId) {
    point = await resolveRefCenter(view, params.nodeId)
    if (!point) return done(refNotFound(params.nodeId))
  } else {
    const metrics = await view.cdp.send("Page.getLayoutMetrics") as { cssVisualViewport?: { clientWidth?: unknown; clientHeight?: unknown } }
    const clientWidth = metrics.cssVisualViewport?.clientWidth
    const clientHeight = metrics.cssVisualViewport?.clientHeight
    if (typeof clientWidth !== "number" || typeof clientHeight !== "number") {
      return done(executionError("Page.getLayoutMetrics returned no cssVisualViewport"))
    }
    point = { cx: clientWidth / 2, cy: clientHeight / 2 }
  }
  await dispatchScrollGesture(view, point, params.scrollX, params.scrollY)
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 Yj/handleHover:坐标解析 → mouseMoved(可选修饰键)。 */
export async function handleHover(view: ControlledView, params: HoverCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  const point = await resolveCommandPoint(view, params, "hover")
  if (point.kind === "error") return done(point.error)
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.point.cx,
    y: point.point.cy,
    ...(modifiersBitmask(params.modifiers) > 0 ? { modifiers: modifiersBitmask(params.modifiers) } : {}),
  })
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 Qj/handleSelect:select 脚本错误映射。 */
export async function handleSelect(view: ControlledView, params: SelectCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  const result = await view.webContents.executeJavaScript(selectScript(params.ref, params.values)) as Record<string, unknown> | null
  if (!result || typeof result !== "object") return done(executionError("select returned invalid result"))
  if (result.error === "ref_not_found") return done(refNotFound(params.ref))
  if (result.error === "not_select") return done(executionError(`element ${params.ref} is not a <select>`))
  if (result.error === "no_match") return done(executionError(`no <option> matched values ${JSON.stringify(params.values)}`))
  if (result.error) return done(executionError(`select failed: ${result.error}`))
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 eH/handleCheck:check 脚本错误映射(checked 默认 true)。 */
export async function handleCheck(view: ControlledView, params: CheckCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  const result = await view.webContents.executeJavaScript(checkScript(params.ref, params.checked ?? true)) as Record<string, unknown> | null
  if (!result || typeof result !== "object") return done(executionError("check returned invalid result"))
  if (result.error === "ref_not_found") return done(refNotFound(params.ref))
  if (result.error === "not_checkable") return done(executionError(`element ${params.ref} is not a checkbox/radio`))
  if (result.error) return done(executionError(`check failed: ${result.error}`))
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 tH/handleDrag:from/to 端点解析 → 两点插值拖拽。 */
export async function handleDrag(view: ControlledView, params: DragCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  const from = await resolveDragPoint(view, params.fromRef, params.from, "from")
  if (from.kind === "error") return done(from.error)
  const to = await resolveDragPoint(view, params.toRef, params.to, "to")
  if (to.kind === "error") return done(to.error)
  await dispatchDrag(view, from.point, to.point, modifiersBitmask(params.modifiers))
  return done({ ok: true, state: readState(view.webContents) })
}

/** ZCode 原名 nH/handleCuaDrag:显式路径拖拽。 */
export async function handleCuaDrag(view: ControlledView, params: CuaDragCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  await dispatchDragPath(view, params.path, modifiersBitmask(params.modifiers))
  return done({ ok: true, state: readState(view.webContents) })
}

/* ── playwright 辅助通道 ───────────────────────────────────────────── */

/** ZCode 原名 ui/normalizePlaywrightTimeout:超时归一(默认/上限 3000ms)。 */
export function normalizePlaywrightTimeout(timeoutMs?: number, capMs = 3_000): number {
  return Math.min(Math.max(0, typeof timeoutMs === "number" ? timeoutMs : 3_000), capMs || 3_000)
}

/** ZCode 原名 ule:playwright 轮询步进(ms)。 */
const POLL_INTERVAL_MS = 50

/** ZCode 原名 EH/poll:通用条件轮询(cancelled/matched/timeout)。 */
export async function poll(check: () => Promise<boolean> | boolean, timeoutMs: number, signal?: AbortSignal): Promise<"cancelled" | "matched" | "timeout"> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return "cancelled"
    if (await check()) return "matched"
    const remaining = deadline - Date.now()
    if (remaining <= 0) return "timeout"
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)))
  }
}

/** ZCode 原名 vM/timeoutResult:标准超时错误负载。 */
export function timeoutResult(done: CommandDone, waitingFor: string): BrowserCommandResult {
  return done({
    ok: false,
    error: {
      code: "timeout",
      message: `Timeout waiting for ${waitingFor}`,
    },
  })
}

/** ZCode 原名 fle/locatorTimeoutResult:locator 专用超时文案。 */
export function locatorTimeoutResult(done: CommandDone, reason: string): BrowserCommandResult {
  return done({
    ok: false,
    error: {
      code: "timeout",
      message: `Timeout waiting for ${reason}. Do not retry the same locator. Take a fresh domSnapshot(), rebuild from snapshot-proven facts, and check count()/isVisible() before the next action.`,
    },
  })
}

/** ZCode 原名 mle/urlMatches:glob(* 通配)URL 匹配。 */
export function urlMatches(pattern: string, url: string): boolean {
  if (!pattern.includes("*")) return url === pattern
  const regex = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${regex}$`).test(url)
}

/** ZCode 原名 RH/waitForDocumentState:readyState 条件等待(networkidle 不支持)。 */
export async function waitForDocumentState(view: ControlledView, state: string, timeoutMs: number, signal?: AbortSignal): Promise<"cancelled" | "matched" | "timeout"> {
  if (state === "networkidle") throw new Error("playwright_wait_for_load_state does not support networkidle")
  return poll(async () => {
    const probe = await view.webContents.executeJavaScript(`(() => ({
        readyState: document.readyState,
        resourceCount: 0
      }))()`) as { readyState?: string }
    return state === "domcontentloaded" ? probe.readyState !== "loading" : probe.readyState === "complete"
  }, timeoutMs, signal)
}

/** ZCode 原名 gle/evaluateWithCdp:带 abort 终止执行与异常归一化的求值通道。 */
export async function evaluateWithCdp(view: ControlledView, expression: string, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const terminate = () => {
    view.cdp.send("Runtime.terminateExecution").catch(() => {})
  }
  if (signal?.aborted) throw new DOMException("aborted", "AbortError")
  signal?.addEventListener("abort", terminate, { once: true })
  try {
    const response = await view.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    }) as CdpEvaluateResponse
    if (response.exceptionDetails) {
      throw new Error(`playwright.evaluate failed: ${response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Playwright evaluate failed"}`)
    }
    return response.result?.value
  } finally {
    signal?.removeEventListener("abort", terminate)
  }
}

/**
 * ZCode 原名 TH/handlePlaywrightAction:method="playwright" 处理器。
 * domSnapshot/locator 需注入 PlaywrightActionExecutorPort(02 源码后半段引擎,
 * PortingGap);elementInfo/elementScreenshot/evaluate/waitForURL/waitForLoadState
 * 由本模块内建;异常沿用分发器错误归一化。
 */
export async function handlePlaywrightAction(
  view: ControlledView,
  action: PlaywrightActionRequest,
  done: CommandDone,
  signal?: AbortSignal,
  playwright?: PlaywrightActionExecutorPort,
): Promise<BrowserCommandResult> {
  if (action.name === "domSnapshot") {
    if (!playwright) {
      return done({
        ok: false,
        error: {
          code: "capability_unsupported",
          message: `playwright.${action.name} is handled by the IAB manager`,
        },
      })
    }
    const snapshot = await playwright.domSnapshot(view, signal)
    return done({
      ok: true,
      value: snapshot,
    })
  }
  if (action.name === "elementInfo") {
    const info = await evaluateInPlaywrightIsolatedWorld(view, serializeRuntimeCall(ELEMENT_INFO_RUNTIME_FN_SOURCE, action))
    return done({
      ok: true,
      value: info,
    })
  }
  if (action.name === "elementScreenshot") {
    await evaluateInPlaywrightIsolatedWorld(view, serializeRuntimeCall(OVERLAY_RUNTIME_FN_SOURCE, action))
    try {
      const captured = await captureScreenshotWithCssPixelCorrection(view, await buildViewportScreenshotParams(view))
      if (!captured.data) throw new Error("CDP Page.captureScreenshot returned no data")
      return done({
        ok: true,
        image: {
          base64: captured.data,
          mimeType: "image/png",
        },
      })
    } finally {
      await evaluateInPlaywrightIsolatedWorld(view, serializeRuntimeCall(OVERLAY_RUNTIME_FN_SOURCE, {
        x: action.x,
        y: action.y,
        remove: true,
      }))
    }
  }
  if (action.name === "evaluate") {
    const argJson = JSON.stringify(action.arg)
    const expression = action.expressionKind === "function"
      ? `(${action.expression})(${argJson})`
      : `(() => { const arg = ${argJson}; return (${action.expression}); })()`
    const value = await evaluateWithCdp(view, expression, normalizePlaywrightTimeout(action.timeoutMs), signal)
    return done({
      ok: true,
      value,
    })
  }
  if (action.name === "waitForURL") {
    const pattern = action.url ?? ""
    const timeoutMs = normalizePlaywrightTimeout(action.timeoutMs)
    const startedAt = Date.now()
    const urlOutcome = await poll(() => urlMatches(pattern, view.webContents.getURL()), timeoutMs, signal)
    if (urlOutcome === "cancelled") {
      return done({
        ok: false,
        error: {
          code: "cancelled",
          message: "browser request cancelled",
          sideEffect: "none",
        },
      })
    }
    if (urlOutcome !== "matched") return timeoutResult(done, `URL ${pattern}`)
    const waitUntil = action.waitUntil ?? "load"
    if (waitUntil !== "commit") {
      const stateOutcome = await waitForDocumentState(view, waitUntil, Math.max(1, timeoutMs - (Date.now() - startedAt)), signal)
      if (stateOutcome === "cancelled") {
        return done({
          ok: false,
          error: {
            code: "cancelled",
            message: "browser request cancelled",
            sideEffect: "none",
          },
        })
      }
      if (stateOutcome === "timeout") return timeoutResult(done, `URL ${pattern} to reach ${waitUntil}`)
    }
    return done({
      ok: true,
      value: view.webContents.getURL(),
    })
  }
  if (action.name === "waitForLoadState") {
    const state = action.state ?? "load"
    const outcome = await waitForDocumentState(view, state, normalizePlaywrightTimeout(action.timeoutMs), signal)
    return outcome === "cancelled"
      ? done({
          ok: false,
          error: {
            code: "cancelled",
            message: "browser request cancelled",
            sideEffect: "none",
          },
        })
      : outcome === "matched"
        ? done({ ok: true })
        : timeoutResult(done, `load state ${state}`)
  }
  if (action.name === "locator") {
    if (!playwright) {
      return done({
        ok: false,
        error: {
          code: "capability_unsupported",
          message: `playwright.${action.name} is handled by the IAB manager`,
        },
      })
    }
    const outcome = await playwright.locator(view, action, normalizePlaywrightTimeout(action.timeoutMs), signal)
    return outcome.kind === "cancelled"
      ? done({
          ok: false,
          error: {
            code: "cancelled",
            message: "browser request cancelled",
            sideEffect: "none",
          },
        })
      : outcome.kind === "timeout"
        ? locatorTimeoutResult(done, outcome.reason ?? "locator")
        : done({
            ok: true,
            value: outcome.value,
          })
  }
  return done({
    ok: false,
    error: {
      code: "capability_unsupported",
      message: `playwright.${action.name} is handled by the IAB manager`,
    },
  })
}

/* ── 分发器 ────────────────────────────────────────────────────────── */

function commandParams<T>(command: BrowserCommand): T {
  // 调用方已完成协议校验(PortingGap:ZCode 共享 zod 协议),此处仅形状声明。
  return (command.params ?? {}) as unknown as T
}

function playwrightActionOf(command: BrowserCommand): PlaywrightActionRequest {
  return (command as { action?: PlaywrightActionRequest }).action ?? { name: "" }
}

/**
 * ZCode 原名 jg/executeBrowserCommandOnView:全部浏览器命令的唯一入口。
 * switch(method) 分发到 CDP 直连处理器或 handlePlaywrightAction;
 * 统一计时包装 done() 注入 elapsedMs;异常归一化为 cancelled(AbortError/
 * 信号)/timeout(TimeoutError 或消息含 timed out)/execution_error。
 */
export async function executeBrowserCommandOnView(
  view: ControlledView,
  command: BrowserCommand,
  opts?: ExecuteBrowserCommandOptions,
): Promise<BrowserCommandResult> {
  const startedAt = now()
  const done: CommandDone = (result) => ({
    ...result,
    elapsedMs: now() - startedAt,
  })
  try {
    switch (command.method) {
      case "navigate":
        return await handleNavigate(view, commandParams<NavigateCommandParams>(command), done, opts)
      case "getState":
        return await handleGetState(view, done)
      case "back":
        return view.webContents.goBack(), done({ ok: true, state: readState(view.webContents) })
      case "forward":
        return view.webContents.goForward(), done({ ok: true, state: readState(view.webContents) })
      case "reload":
        return view.webContents.reload(), done({ ok: true, state: readState(view.webContents) })
      case "screenshot":
        return await handleScreenshot(view, commandParams<ScreenshotCommandParams>(command), done)
      case "snapshot":
        return await handleSnapshot(view, commandParams<SnapshotCommandParams>(command), done)
      case "click":
        return await handleClick(view, commandParams<ClickCommandParams>(command), done)
      case "type":
        return await handleType(view, commandParams<TypeCommandParams>(command), done)
      case "fill":
        return await handleFill(view, commandParams<FillCommandParams>(command), done)
      case "press":
        return await handlePress(view, commandParams<PressCommandParams>(command), done)
      case "cuaKeypress":
        return await handleCuaKeypress(view, commandParams<CuaKeypressCommandParams>(command), done)
      case "scroll":
        return await handleScroll(view, commandParams<ScrollCommandParams>(command), done)
      case "cuaScroll":
        return await handleCuaScroll(view, commandParams<CuaScrollCommandParams>(command), done)
      case "domCuaScroll":
        return await handleDomCuaScroll(view, commandParams<DomCuaScrollCommandParams>(command), done)
      case "hover":
        return await handleHover(view, commandParams<HoverCommandParams>(command), done)
      case "select":
        return await handleSelect(view, commandParams<SelectCommandParams>(command), done)
      case "check":
        return await handleCheck(view, commandParams<CheckCommandParams>(command), done)
      case "drag":
        return await handleDrag(view, commandParams<DragCommandParams>(command), done)
      case "cuaDrag":
        return await handleCuaDrag(view, commandParams<CuaDragCommandParams>(command), done)
      case "elementInfo":
        return await handleElementInfo(view, commandParams<ElementInfoCommandParams>(command), done)
      case "evaluate":
        return await handleEvaluate(view, commandParams<EvaluateCommandParams>(command), done)
      case "playwright":
        return await handlePlaywrightAction(view, playwrightActionOf(command), done, opts?.signal, opts?.playwright)
      default:
        return done({
          ok: false,
          error: {
            code: "capability_unsupported",
            message: `command ${command.method} is not supported by executor (available: navigate/getState/back/forward/reload/screenshot/snapshot/click/type/fill/press/scroll/hover/select/check/drag/elementInfo/evaluate)`,
          },
        })
    }
  } catch (error) {
    const cancelled = opts?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError")
    const timedOut = !cancelled && error instanceof Error
      && (error.name === "TimeoutError" || /\b(?:timed out|timeout exceeded)\b/iu.test(error.message))
    return done({
      ok: false,
      error: {
        code: cancelled ? "cancelled" : timedOut ? "timeout" : "execution_error",
        message: cancelled ? "Browser command cancelled" : error instanceof Error ? error.message : String(error),
      },
    })
  }
}
