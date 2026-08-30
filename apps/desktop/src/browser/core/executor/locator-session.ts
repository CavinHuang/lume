/**
 * IAB playwright locator 会话 —— playwright locator 语义的 CDP 复刻。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js [SECTION] IabPlaywrightLocatorSession
 *
 * ZCode 原名对照:
 *   sle → LOCATOR_WORLD_NAME("zcode-playwright-locator")
 *   li  → PLAYWRIGHT_INJECTED_GLOBAL_FIELD(见 injected-loader.ts)
 *   pM  → RETRY_DELAY_MS(50ms 重试步进)
 *   SH  → QUERY_SELECTOR_STRICT_VISIBLE_FALLBACK_SOURCE
 *   fM  → strictVisibleSelectorSetup(先 strict 再可见性回退)
 *   mM  → SCROLL_ALIGNMENTS(center/end/start/nearest 轮换)
 *   gM  → locatorAbortError
 *   PH  → locatorRuntimeError
 *   ale → isRecoverableLocatorRace
 *   cle → splitSelectorTokens(" >> " 段拆分,含引号/转义感知)
 *   dle → frameSegments(internal:control=enter-frame 帧链)
 *   CH  → modifierNames(ControlOrMeta 按 darwin 映射 Meta/Control)
 *   lle → pressParts("+" 组合键解析)
 *   gde → MODIFIER_BITS  Rn → modifiersBitmask
 *   di  → INPUT_TARGET_TOKEN_FIELD(本地副本,与 injecteds/generators.ts 一致)
 *   sM  → createInputTargetToken(PortingGap:见函数注)
 *   hM  → IabPlaywrightLocatorSession
 *   ca  → executeIabPlaywrightLocator(一次性入口:建会话 → execute → dispose)
 *
 * 端口接缝(装配层接线,见 LocatorInputPorts):
 *   ci/dispatchClickAt、Ng/dispatchKey        → core/input.ts(A7 接线)
 *   Ug/pasteTextIntoFocusedTarget、
 *   Zj/assertFocusedInputTarget               → executor/dispatcher.ts(A4 已落地
 *                                               同名函数,签名结构兼容)
 *
 * 语义偏差(已声明项):
 *   - boundaries.toReversed() 以 slice().reverse() 等价改写(lib ES2022 无
 *     toReversed,与 dispatcher.ts 同一偏差)。
 *   - createInputTargetToken 原调 vde()(未在提取源中),以 crypto.randomUUID()
 *     替代(与 dispatcher.ts 同一偏差)。
 *   - ZCode 的模块级日志 k.debug 以构造注入的 debug 端口替代(禁 console)。
 *   - actions.ts 的 evaluateLocator/waitForState/waitForUnique 经
 *     IabPlaywrightLocatorSessionHost 结构化接口回调本类;两模块间为函数声明
 *     提升绑定的 ESM 活绑定循环引用(与 dispatcher.ts 注释同款,运行期安全)。
 *   - 装配桥:executeIabPlaywrightLocator 结果(kind:done/cancelled/timeout)由
 *     集成者适配 dispatcher.ts 的 PlaywrightActionExecutorPort.locator
 *     (kind:ok/cancelled/timeout,done→ok)。
 */
import type { ControlledView } from "../types"
import {
  PLAYWRIGHT_INJECTED_GLOBAL_FIELD,
  getPlaywrightInjectedScriptSource,
} from "./injected-loader"
import { evaluateLocator, waitForState, waitForUnique } from "./actions"

/* ── PortingGap:协议与依赖形状声明 ──────────────────────────────────── */

/**
 * PortingGap:locator 动作请求形状(ZCode 共享 zod 协议的 locator 分支,
 * 由调用方先行 zod 校验)。
 */
export interface LocatorAction {
  selector: string
  operation: string
  force?: boolean
  button?: string
  modifiers?: string[]
  value?: string
  replace?: boolean
  attribute?: string
  checked?: boolean
  selections?: unknown[]
  state?: string
  expression?: string
  expressionKind?: string
  arg?: unknown
}

/** 执行结果三分支(done/cancelled/timeout),由装配层适配为命令结果。 */
export type LocatorOutcome =
  | { kind: "done"; value?: unknown }
  | { kind: "cancelled" }
  | { kind: "timeout"; reason: string }

/** 帧求值目标请求(sessionId 缺省为主会话)。 */
export interface FrameContextRequest {
  frameId: string
  sessionId?: string
}

/** 已建隔离世界上下文的帧求值目标。 */
export interface LocatorEvaluateTarget extends FrameContextRequest {
  contextId: number
}

/** resolveTarget 产物:帧边界链 + 最终帧 + 末段 selector。 */
export interface LocatorResolvedTarget {
  boundaries: LocatorFrameBoundary[]
  frame: FrameContextRequest
  selector: string
}

/** querySingleValue 选项(allowMissing 时不注入"未命中"守卫)。 */
export interface QuerySingleValueOptions {
  allowMissing?: boolean
}

/** CDP RemoteObject 形状(仅取用字段)。 */
export interface CdpRemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  objectId?: string
  description?: string
}

/** CDP Runtime.evaluate / Runtime.callFunctionOn 响应形状。 */
export interface CdpEvaluateResponse {
  result?: CdpRemoteObject
  exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string }
}

interface CdpDescribeNodeResponse {
  node?: { frameId?: string; backendNodeId?: number; localName?: string; nodeName?: string }
}

interface CdpContentQuadsResponse {
  quads?: number[][]
}

interface CdpGetNodeForLocationResponse {
  backendNodeId?: number
}

interface CdpCreateIsolatedWorldResponse {
  executionContextId?: number
}

interface CdpGetFrameTreeResponse {
  frameTree?: { frame?: { id?: string } }
}

interface CdpAttachResponse {
  sessionId?: string
}

/** 单个帧边界(双线性映射与遮挡检查的输入)。 */
export interface LocatorFrameBoundary {
  /** 帧内容四边形(DOM.getContentQuads quads[0],8 个坐标分量)。 */
  contentQuad: number[]
  /** 子帧视口尺寸(子上下文 globalThis.innerWidth/innerHeight)。 */
  childSize: { width: number; height: number }
  /** 帧宿主元素(iframe)的 backendNodeId。 */
  ownerBackendNodeId: number
  /** 父帧求值目标(会话附件用)。 */
  parent: FrameContextRequest
}

/** actionability 探测参数(scroll 对齐轮换/状态检查开关)。 */
export interface ActionProbeOptions {
  force: boolean
  needsEditable: boolean
  needsEnabled: boolean
  needsHitTarget: boolean
  needsStable: boolean
  scrollAlignment: { block: string; inline: string }
}

/** actionability 探测结果(页内 injected 管道返回的载荷)。 */
export interface LocatorActionProbe {
  count: number
  actionable: boolean
  reason?: string
  obstruction?: string
  x?: number
  y?: number
  checked?: boolean
}

/** raceActionProbe 结果(probe 完成前被超时/abort 抢先的形态)。 */
export type LocatorActionProbeOutcome =
  | { kind: "done"; value: LocatorActionProbe }
  | { kind: "cancelled" }
  | { kind: "timeout" }

/** 帧链双线性映射后的指针点(顶层点 + 各帧边界点)。 */
export interface LocatorPointerPoints {
  boundaryPoints: Map<LocatorFrameBoundary, { x: number; y: number }>
  top: { x: number; y: number }
}

/**
 * 鼠标/键盘/粘贴原语端口。
 * A7 接线:dispatchClickAt/dispatchKey 由 core/input.ts(A7)同名原语装配;
 * pasteTextIntoFocusedTarget/assertFocusedInputTarget 由 executor/dispatcher.ts
 * (A4 已落地)同名函数装配。
 */
export interface LocatorInputPorts {
  /** ZCode 原名 ci:move → press → release(clickCount 双击=2)。 */
  dispatchClickAt(view: ControlledView, point: { cx: number; cy: number }, button: string, doubleClick: boolean, modifiers?: number): Promise<void>
  /** ZCode 原名 Ng:单键 down+up(可选目标 sessionId)。 */
  dispatchKey(view: ControlledView, key: string, modifiers?: number, sessionId?: string): Promise<void>
  /** ZCode 原名 Ug:虚拟剪贴板粘贴(fill 文本投递)。 */
  pasteTextIntoFocusedTarget(view: ControlledView, text: string, options?: {
    includeRichText?: boolean
    inputTargetToken?: string
    replaceInputValue?: boolean
    initialTarget?: { sessionId?: string; contextId?: number }
  }): Promise<void>
  /** ZCode 原名 Zj:粘贴前校验聚焦元素 inputTargetToken 未漂移。 */
  assertFocusedInputTarget(view: ControlledView, target: { sessionId?: string; contextId?: number }, token: string): Promise<void>
}

/** CDP Runtime.evaluate 响应形状(仅取用字段)。 */
export interface CdpEvaluateResponse {
  result?: CdpRemoteObject
  exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string }
}

/** ZCode 原名 sle:locator 隔离世界命名。 */
const LOCATOR_WORLD_NAME = "zcode-playwright-locator"

/** ZCode 原名 di:输入目标 token 字段(与 injecteds/generators.ts 字节一致)。 */
const INPUT_TARGET_TOKEN_FIELD = "__zcodeIabInputTargetToken"

/** ZCode 原名 pM:主循环重试步进(ms)。 */
export const RETRY_DELAY_MS = 50

/**
 * ZCode 原名 SH:strict 匹配 + 唯一可见回退的页内查询函数源。
 * 多匹配时取唯一可见者,仍多义则抛 strictModeViolationError。
 */
const QUERY_SELECTOR_STRICT_VISIBLE_FALLBACK_SOURCE = `
function querySelectorStrictWithVisibleFallback(injected, parsedSelector, root) {
  const matches = injected.querySelectorAll(parsedSelector, root);
  if (!matches.length) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return null;
  }

  if (matches.length === 1) {
    injected.checkDeprecatedSelectorUsage(parsedSelector, matches);
    return matches[0];
  }

  const visibleMatches = matches.filter((element) => {
    const state = injected.elementState(element, "visible");
    return !!state.matches;
  });
  if (visibleMatches.length === 1) return visibleMatches[0];

  throw injected.strictModeViolationError(parsedSelector, matches);
}
`

/**
 * ZCode 原名 fM/strictVisibleSelectorSetup:在页内注入 SH 并把 selector 解析
 * 为 resolvedElement/elements 两个绑定(供后续表达式消费)。
 */
export function strictVisibleSelectorSetup(selector: string): string {
  return `${QUERY_SELECTOR_STRICT_VISIBLE_FALLBACK_SOURCE}
      const parsedSelector = injected.parseSelector(${JSON.stringify(selector)});
      const resolvedElement = querySelectorStrictWithVisibleFallback(injected, parsedSelector, root);
      const elements = resolvedElement ? [resolvedElement] : [];`
}

/** ZCode 原名 mM:scrollIntoView 对齐轮换表(重试轮换,force 固定 center)。 */
const SCROLL_ALIGNMENTS: Array<{ block: string; inline: string }> = [{
  block: "center",
  inline: "center",
}, {
  block: "end",
  inline: "end",
}, {
  block: "start",
  inline: "start",
}, {
  block: "nearest",
  inline: "nearest",
}]

/**
 * ZCode 原名 gM/abortError:locator 专用 AbortError
 * (与快照会话的 abortError 文案不同,保留各自语境)。
 */
export function locatorAbortError(): Error {
  return new DOMException("Browser locator action aborted", "AbortError")
}

/**
 * ZCode 原名 PH/runtimeError:提取 CDP 响应异常文本;无异常返回 undefined。
 */
export function locatorRuntimeError(response: CdpEvaluateResponse): string | undefined {
  const details = response.exceptionDetails
  if (details) {
    return details.exception?.description
      ?? (details.exception?.value == null ? undefined : String(details.exception.value))
      ?? details.text
      ?? "Playwright locator evaluation failed"
  }
  return undefined
}

/**
 * ZCode 原名 ale/isRecoverableLocatorRace:文档竞态(执行上下文销毁/帧分离/
 * inspected target navigated)判定 —— 命中则 resetDocumentContexts 后重试。
 */
export function isRecoverableLocatorRace(error: unknown): boolean {
  return error instanceof Error
    ? /execution context (?:was )?destroyed|cannot find context|frame (?:was )?detached|inspected target navigated/iu.test(error.message)
    : false
}

/**
 * ZCode 原名 cle/splitSelectorTokens:按 " >> " 拆分选择器段
 * (引号/模板串/反斜杠转义感知,段内空白裁剪)。
 */
export function splitSelectorTokens(selector: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote = ""
  let escaped = false
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index] ?? ""
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\") {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = ""
      continue
    }
    if (character === '"' || character === "'" || character === "`") {
      current += character
      quote = character
      continue
    }
    if (selector.slice(index, index + 4) === " >> ") {
      tokens.push(current.trim())
      current = ""
      index += 3
      continue
    }
    current += character
  }
  if (current.trim()) tokens.push(current.trim())
  return tokens
}

/**
 * ZCode 原名 dle/frameSegments:把 " >> " 段按 internal:control=enter-frame
 * 切成帧链(每段 = 进入下一帧的 frame selector;末段为最终目标 selector)。
 */
export function frameSegments(selector: string): string[] {
  const frames: string[] = []
  const pending: string[] = []
  for (const token of splitSelectorTokens(selector)) {
    if (token === "internal:control=enter-frame") {
      if (pending.length === 0) throw new Error("frame locator is missing a frame selector")
      frames.push(pending.join(" >> "))
      pending.length = 0
      continue
    }
    pending.push(token)
  }
  if (pending.length === 0) throw new Error("frame locator is missing a child selector")
  frames.push(pending.join(" >> "))
  return frames
}

/** ZCode 原名 gde:修饰键 → CDP 位掩码(ControlOrMeta 在 darwin 映射 Meta)。 */
const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
}

/** ZCode 原名 Rn/modifiersBitmask:修饰键数组 → 位掩码。 */
function modifiersBitmask(modifiers?: string[]): number {
  if (!modifiers || modifiers.length === 0) return 0
  let mask = 0
  for (const modifier of modifiers) mask |= MODIFIER_BITS[modifier]
  return mask
}

/**
 * ZCode 原名 CH/modifierNames:修饰键名平台映射 —— ControlOrMeta 在 darwin
 * 映射 Meta,其余平台映射 Control;其余原样保留。
 */
export function modifierNames(modifiers?: string[]): string[] {
  return (modifiers ?? []).map((modifier) => modifier !== "ControlOrMeta"
    ? modifier
    : process.platform === "darwin"
      ? "Meta"
      : "Control")
}

/**
 * ZCode 原名 lle/pressParts:locator.press 的 "Mod+a" 解析 —— 末段为按键,
 * 其余段过滤出修饰键并与动作级 modifiers 合并后做平台映射。
 */
export function pressParts(key: string | undefined, modifiers?: string[]): { key: string; modifiers: string[] } {
  const parts = String(key ?? "").split("+").filter(Boolean)
  if (parts.length === 0) throw new Error("locator.press requires a key")
  const finalKey = parts.pop()
  const modifierKeys = parts.filter((part) => ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(part))
  return {
    key: finalKey as string,
    modifiers: modifierNames([...modifiers ?? [], ...modifierKeys]),
  }
}

/**
 * PortingGap(重建 sM/createInputTargetToken):vde 未在提取源中,
 * 以 crypto.randomUUID() 生成等价唯一 token(与 dispatcher.ts 同一偏差)。
 */
function createInputTargetToken(): string {
  return crypto.randomUUID()
}

/**
 * ZCode 原名 hM/IabPlaywrightLocatorSession:单视图 playwright locator 会话。
 * contexts 按帧缓存隔离世界执行上下文;attachedSessionIds 跟踪 OOPIF 附加会话;
 * rootFrame 缓存主帧。execute 分支:count/allTextContents/isVisible/isEnabled
 * 直接 queryValue;waitFor → waitForState;textContent/innerText/getAttribute/
 * evaluate 先 waitForUnique(count===1) 再 perform;其余操作进入 deadline
 * 重试循环(actionProbe → perform → 可恢复竞态重试)。
 */
export class IabPlaywrightLocatorSession {
  readonly view: ControlledView
  readonly timeoutMs: number
  readonly signal: AbortSignal | undefined
  private readonly input: LocatorInputPorts
  private readonly debug?: (message: string, details?: Record<string, unknown>) => void

  constructor(deps: {
    view: ControlledView
    timeoutMs: number
    signal?: AbortSignal
    input: LocatorInputPorts
    debug?: (message: string, details?: Record<string, unknown>) => void
  }) {
    this.view = deps.view
    this.timeoutMs = deps.timeoutMs
    this.signal = deps.signal
    this.input = deps.input
    this.debug = deps.debug
  }

  private contexts = new Map<string, LocatorEvaluateTarget>()
  private attachedSessionIds = new Set<string>()
  private rootFrame: FrameContextRequest | undefined

  /** 释放全部附加会话(OOPIF);隔离世界随文档生命周期,无需显式销毁。 */
  async dispose(): Promise<void> {
    await Promise.allSettled([...this.attachedSessionIds].map((sessionId) => this.view.cdp.send("Target.detachFromTarget", { sessionId })))
    this.attachedSessionIds.clear()
  }

  /**
   * 主入口:按 operation 分派。actionable 操作进入 deadline 预算重试循环
   * (50ms 步进),actionProbe 抛出可恢复文档竞态时 resetDocumentContexts
   * 并重新解析帧链;点击类操作先做帧链双线性映射与遮挡检查。
   */
  async execute(action: LocatorAction): Promise<LocatorOutcome> {
    let target = await this.resolveTarget(action.selector)
    if (action.operation === "count") {
      return { kind: "done", value: await this.queryValue(target, "elements.length") }
    }
    if (action.operation === "allTextContents") {
      return { kind: "done", value: await this.queryValue(target, "elements.map(element => element.textContent ?? '')") }
    }
    if (action.operation === "isVisible") {
      return { kind: "done", value: await this.queryValue(target, "Boolean(elements[0] && injected.elementState(elements[0], 'visible').matches)") }
    }
    if (action.operation === "isEnabled") {
      return { kind: "done", value: await this.queryValue(target, "Boolean(elements[0] && injected.elementState(elements[0], 'enabled').matches)") }
    }
    if (action.operation === "waitFor") return waitForState(this, target, action)
    if (["textContent", "innerText", "getAttribute", "evaluate"].includes(action.operation)) {
      const unique = await waitForUnique(this, target, action.selector)
      return unique.kind !== "done"
        ? unique
        : { kind: "done", value: await this.perform(target, action, { count: 1, actionable: true }) }
    }
    const deadline = Date.now() + this.timeoutMs
    let reason = `locator ${action.selector}`
    let attempt = 0
    for (;;) {
      if (this.signal?.aborted) return { kind: "cancelled" }
      const budget = deadline - Date.now()
      if (budget <= 0) return { kind: "timeout", reason }
      const isFill = action.operation === "fill"
      const isClickLike = ["click", "dblclick", "setChecked"].includes(action.operation)
      const needsEnabled = ["click", "dblclick", "fill", "press", "selectOption", "setChecked"].includes(action.operation)
      let outcome: LocatorActionProbeOutcome
      try {
        outcome = await this.actionProbe(target, {
          force: action.operation === "fill" ? false : action.force === true,
          needsEditable: isFill,
          needsEnabled,
          needsHitTarget: isClickLike && action.force !== true,
          needsStable: isClickLike,
          scrollAlignment: action.force === true ? SCROLL_ALIGNMENTS[0] as { block: string; inline: string } : SCROLL_ALIGNMENTS[attempt % SCROLL_ALIGNMENTS.length] as { block: string; inline: string },
        }, budget)
      } catch (error) {
        if (!isRecoverableLocatorRace(error)) throw error
        this.debug?.("[browser-use] recovering locator after document race", {
          error: error instanceof Error ? error.message : String(error),
          operation: action.operation,
          selector: action.selector,
        })
        await this.resetDocumentContexts()
        target = await this.resolveTarget(action.selector)
        attempt += 1
        continue
      }
      if (outcome.kind === "cancelled") return { kind: "cancelled" }
      if (outcome.kind === "timeout") return { kind: "timeout", reason }
      const probe = outcome.value
      if (probe.count === 1 && probe.actionable) {
        const points = isClickLike ? this.pointerFramePoints(target, probe) : undefined
        if (isClickLike && action.force !== true) {
          const obstruction = await this.frameObstruction(target, points as LocatorPointerPoints)
          if (obstruction) {
            reason = `${action.operation} actionability (covered by ${obstruction}) for selector ${action.selector}`
            attempt += 1
            continue
          }
        }
        return {
          kind: "done",
          value: await this.perform(target, action, points
            ? { ...probe, x: points.top.x, y: points.top.y }
            : probe),
        }
      }
      reason = probe.count === 0
        ? `locator ${action.selector}`
        : `${action.operation} actionability (${probe.reason ?? "not-actionable"}${probe.obstruction ? ` by ${probe.obstruction}` : ""}) for selector ${action.selector}`
      attempt += 1
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { kind: "timeout", reason }
      if (!await this.delay(Math.min(RETRY_DELAY_MS, remaining))) return { kind: "cancelled" }
    }
  }

  /** 按 operation 执行最终动作(probe 已确认 actionable 后调用)。 */
  private async perform(target: LocatorResolvedTarget, action: LocatorAction, probe: LocatorActionProbe): Promise<unknown> {
    switch (action.operation) {
      case "textContent":
        return this.querySingleValue(target, "elements[0].textContent")
      case "innerText":
        return this.querySingleValue(target, "elements[0].innerText")
      case "getAttribute":
        return this.querySingleValue(target, `elements[0].getAttribute(${JSON.stringify(action.attribute)})`)
      case "click":
      case "dblclick":
        await this.input.dispatchClickAt(this.view, { cx: probe.x, cy: probe.y }, action.button ?? "left", action.operation === "dblclick", modifiersBitmask(modifierNames(action.modifiers)))
        return null
      case "fill": {
        const text = String(action.value ?? "")
        const token = createInputTargetToken()
        if (action.replace !== false) {
          const result = await this.querySingleValue(target, `(() => {
              const result = injected.fill(elements[0], ${JSON.stringify(text)});
              if (result === "needsinput") {
                const input = injected.retarget(elements[0], "follow-label") ?? elements[0];
                Object.defineProperty(input, ${JSON.stringify(INPUT_TARGET_TOKEN_FIELD)}, {
                  configurable: true,
                  value: ${JSON.stringify(token)},
                  writable: true,
                });
              }
              return result;
            })()`)
          if (result === "done") return null
          if (result !== "needsinput") throw new Error(`locator.fill failed: ${String(result)}`)
        } else await this.focusForInput(target, token)
        const context = await this.context(target.frame)
        await this.input.pasteTextIntoFocusedTarget(this.view, text, {
          includeRichText: false,
          initialTarget: {
            contextId: context.contextId,
            sessionId: context.sessionId,
          },
          inputTargetToken: token,
          replaceInputValue: action.replace !== false,
        })
        return null
      }
      case "press": {
        const token = createInputTargetToken()
        await this.focusForInput(target, token, false)
        const context = await this.context(target.frame)
        await this.input.assertFocusedInputTarget(this.view, context, token)
        const parts = pressParts(action.value, action.modifiers)
        await this.input.dispatchKey(this.view, parts.key, modifiersBitmask(parts.modifiers), context.sessionId)
        return null
      }
      case "setChecked": {
        if (probe.checked !== action.checked) {
          await this.input.dispatchClickAt(this.view, { cx: probe.x, cy: probe.y }, "left", false)
        }
        if (await this.querySingleValue(target, "Boolean(elements[0].checked)") !== action.checked) {
          throw new Error(`locator.setChecked(${String(action.checked)}) did not change the element state`)
        }
        return null
      }
      case "selectOption":
        return this.selectOption(target, action)
      case "downloadMedia":
        return await this.querySingleValue(target, `(() => {
            const element = elements[0];
            element.scrollIntoView({ block: "center", inline: "nearest" });
            const media = element.closest?.("img, video, source, a[href]") ??
              element.querySelector?.("img, video, source, a[href]") ?? element;
            const read = (value, name) => typeof value?.[name] === "string" ? value[name] : null;
            const url = read(media, "currentSrc") ?? read(media, "src") ?? read(media, "href") ?? "";
            if (!url) throw new Error("Matched element does not expose a downloadable URL");
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = url.split("/").pop()?.split("?")[0] || "download";
            anchor.rel = "noopener";
            anchor.style.display = "none";
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            return true;
          })()`), null
      case "evaluate":
        return evaluateLocator(this, target, action)
      default:
        throw new Error(`unsupported locator operation: ${action.operation}`)
    }
  }

  /**
   * actionability 探测:单次 Runtime.evaluate 内完成 strict 解析 → 状态检查
   * (visible/enabled/editable/detached) → scrollIntoView(轮换对齐) → rAF
   * 稳定性(10 帧内需 2 帧几何不变;node 换代时按 locator 重解析再比较) →
   * hit target(expectHitTarget);经 raceActionProbe 与超时/abort 竞速。
   */
  private async actionProbe(target: LocatorResolvedTarget, options: ActionProbeOptions, budgetMs: number): Promise<LocatorActionProbeOutcome> {
    const probe = (async () => {
      const context = await this.context(target.frame)
      const expression = `(async () => {
      const injected = globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD};
      const root = document;
      ${QUERY_SELECTOR_STRICT_VISIBLE_FALLBACK_SOURCE}
      const parsedSelector = injected.parseSelector(${JSON.stringify(target.selector)});
      const resolveCurrentElement = () =>
        querySelectorStrictWithVisibleFallback(injected, parsedSelector, root);
      let element = resolveCurrentElement();
      if (!element) return { count: 0, actionable: false };
      const stateNames = [];
      if (!${String(options.force)}) stateNames.push("visible");
      if (${String(options.needsEnabled && !options.force)}) stateNames.push("enabled");
      if (${String(options.needsEditable)}) stateNames.push("editable");
      const checkStates = (candidate) => {
        if (!candidate.isConnected) return "detached";
        for (const stateName of stateNames) {
          const result = injected.elementState(candidate, stateName);
          if (result.received === "error:notconnected") return "detached";
          if (!result.matches) return stateName;
        }
        return null;
      };
      const initialState = checkStates(element);
      if (initialState) {
        const reason = initialState === "visible" ? "hidden" :
          initialState === "enabled" ? "disabled" :
          initialState === "editable" ? "not-editable" : "not-stable";
        return { count: initialState === "detached" ? 0 : 1, actionable: false, reason };
      }
      element.scrollIntoView({
        block: ${JSON.stringify(options.scrollAlignment.block)},
        inline: ${JSON.stringify(options.scrollAlignment.inline)},
        behavior: "instant"
      });
      const waitForAnimationFrame = () => new Promise(resolve => {
        const view = element.ownerDocument?.defaultView;
        if (typeof view?.requestAnimationFrame === "function") view.requestAnimationFrame(() => resolve(undefined));
        else globalThis.setTimeout(() => resolve(undefined), 0);
      });
      let rect = element.getBoundingClientRect();
      if (${String(options.needsStable)}) {
        let stableFrames = 0;
        for (let index = 0; index < 10 && stableFrames < 2; index += 1) {
          await waitForAnimationFrame();
          // Bug 根因：el-table 等页面会在 rAF 间用同 locator、同几何的新 DOM node 替换旧 node。
          // locator 描述当前匹配目标，不绑定首次 node identity；detach 后应重解析再比较几何。
          const currentElement = element.isConnected ? element : resolveCurrentElement();
          if (!currentElement) return { count: 0, actionable: false };
          const next = currentElement.getBoundingClientRect();
          const unchanged = rect.left === next.left && rect.top === next.top &&
            rect.width === next.width && rect.height === next.height;
          stableFrames = unchanged ? stableFrames + 1 : 0;
          rect = next;
          element = currentElement;
        }
        if (stableFrames < 2) return { count: 1, actionable: false, reason: "not-stable" };
      }
      const finalState = checkStates(element);
      if (finalState) {
        const reason = finalState === "visible" ? "hidden" :
          finalState === "enabled" ? "disabled" :
          finalState === "editable" ? "not-editable" : "not-stable";
        return { count: finalState === "detached" ? 0 : 1, actionable: false, reason };
      }
      const checked = "checked" in element ? Boolean(element.checked) : undefined;
      if (!${String(options.needsHitTarget)}) return { count: 1, actionable: true, checked };
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const inViewport = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 &&
        x <= globalThis.innerWidth && y <= globalThis.innerHeight;
      const hitResult = inViewport ? injected.expectHitTarget({ x, y }, element) : "outside-viewport";
      const receivesEvents = hitResult === "done";
      if (!inViewport) return { count: 1, actionable: false, reason: "outside-viewport", checked };
      if (!receivesEvents) {
        const obstruction = typeof hitResult === "string" ? hitResult :
          hitResult?.hitTargetDescription ?? "another element";
        return { count: 1, actionable: false, reason: "covered", obstruction, checked };
      }
      return { count: 1, actionable: true, x, y, checked };
      })()`
      const value = (await this.evaluate(context, expression, true, budgetMs)).value
      return this.requireActionProbe(value, target.selector)
    })()
    return this.raceActionProbe(probe, target.frame, budgetMs)
  }

  /** 校验 probe 载荷形状(count∈{0,1}/actionable 布尔/坐标有限)。 */
  private requireActionProbe(value: unknown, selector: string): LocatorActionProbe {
    const candidate = value as LocatorActionProbe
    if (!value || typeof value !== "object"
      || !Number.isInteger(candidate.count) || Number(candidate.count) < 0 || Number(candidate.count) > 1
      || typeof candidate.actionable !== "boolean") {
      this.debug?.("[browser-use] invalid pointer probe payload", {
        selector,
        valueKeys: value && typeof value === "object" ? Object.keys(value) : [],
        valueType: value === null ? "null" : typeof value,
      })
      throw new Error(`Playwright pointer probe returned an invalid payload for selector ${selector}`)
    }
    if (candidate.x !== undefined && !Number.isFinite(candidate.x)
      || candidate.y !== undefined && !Number.isFinite(candidate.y)) {
      throw new Error(`Playwright pointer probe returned invalid coordinates for selector ${selector}`)
    }
    return candidate
  }

  /**
   * 帧链双线性映射:把子帧内的命中点沿帧边界四边形逆序映射到顶层视口
   * (每层按 childSize 归一后在 contentQuad 上双线性插值)。
   */
  private pointerFramePoints(target: LocatorResolvedTarget, probe: LocatorActionProbe): LocatorPointerPoints {
    if (probe.x === undefined || probe.y === undefined) {
      throw new Error(`Playwright pointer probe returned no click point for selector ${target.selector}`)
    }
    let point = { x: probe.x, y: probe.y }
    const boundaryPoints = new Map<LocatorFrameBoundary, { x: number; y: number }>()
    for (const boundary of target.boundaries.slice().reverse()) {
      const [x1, y1, x2, y2, x3, y3, x4, y4] = boundary.contentQuad
      const ratioX = point.x / boundary.childSize.width
      const ratioY = point.y / boundary.childSize.height
      point = {
        x: x1 * (1 - ratioX) * (1 - ratioY) + x2 * ratioX * (1 - ratioY) + x3 * ratioX * ratioY + x4 * (1 - ratioX) * ratioY,
        y: y1 * (1 - ratioX) * (1 - ratioY) + y2 * ratioX * (1 - ratioY) + y3 * ratioX * ratioY + y4 * (1 - ratioX) * ratioY,
      }
      boundaryPoints.set(boundary, point)
    }
    return { boundaryPoints, top: point }
  }

  /**
   * 帧遮挡检查:沿帧链逆序在父帧上下文 DOM.getNodeForLocation(含 UA shadow)
   * 命中点处取实际节点;非帧宿主本身即视为被遮挡,返回其标签描述。
   */
  private async frameObstruction(target: LocatorResolvedTarget, points: LocatorPointerPoints): Promise<string | undefined> {
    for (const boundary of target.boundaries.slice().reverse()) {
      const point = points.boundaryPoints.get(boundary)
      if (!point) throw new Error("Playwright pointer frame chain is incomplete")
      const x = Math.round(point.x)
      const y = Math.round(point.y)
      try {
        const located = await this.send<CdpGetNodeForLocationResponse>(boundary.parent, "DOM.getNodeForLocation", {
          includeUserAgentShadowDOM: true,
          x,
          y,
        })
        if (!located.backendNodeId || located.backendNodeId === boundary.ownerBackendNodeId) continue
        const described = (await this.send<CdpDescribeNodeResponse>(boundary.parent, "DOM.describeNode", {
          backendNodeId: located.backendNodeId,
        })).node
        return `<${described?.localName || described?.nodeName?.toLowerCase() || "another element"}>`
      } catch {}
    }
    return undefined
  }

  /**
   * probe 与超时/abort 竞速:超时或 abort 先行时对目标会话
   * Runtime.terminateExecution 终止页内执行,再返回 timeout/cancelled。
   */
  private raceActionProbe(probe: Promise<LocatorActionProbe>, frame: FrameContextRequest, budgetMs: number): Promise<LocatorActionProbeOutcome> {
    if (this.signal?.aborted) return Promise.resolve({ kind: "cancelled" })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (outcome: LocatorActionProbeOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.signal?.removeEventListener("abort", onAbort)
        resolve(outcome)
      }
      const terminate = () => {
        this.view.cdp.send("Runtime.terminateExecution", undefined, frame.sessionId).catch(() => {})
      }
      const timer = setTimeout(() => {
        terminate()
        finish({ kind: "timeout" })
      }, Math.max(0, budgetMs))
      const onAbort = () => {
        terminate()
        finish({ kind: "cancelled" })
      }
      this.signal?.addEventListener("abort", onAbort, { once: true })
      if (this.signal?.aborted) onAbort()
      probe.then((value) => finish({ kind: "done", value }), (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.signal?.removeEventListener("abort", onAbort)
        reject(error)
      })
    })
  }

  /**
   * 文档竞态恢复:释放全部附加会话、清空帧上下文缓存与主帧缓存,
   * 下次 context()/mainFrame() 惰性重建。
   */
  private async resetDocumentContexts(): Promise<void> {
    await Promise.allSettled([...this.attachedSessionIds].map((sessionId) => this.view.cdp.send("Target.detachFromTarget", { sessionId })))
    this.attachedSessionIds.clear()
    this.contexts.clear()
    this.rootFrame = undefined
  }

  /**
   * 聚焦输入目标:followLabel 时先 retarget(follow-label);
   * 聚焦成功后在元素上登记 inputTargetToken(fill/press 防漂移)。
   */
  private async focusForInput(target: LocatorResolvedTarget, token: string, followLabel = true): Promise<void> {
    const result = await this.querySingleValue(target, `(() => {
        const element = ${String(followLabel)}
          ? injected.retarget(elements[0], "follow-label") ?? elements[0]
          : elements[0];
        const result = element.matches(":focus") ? "done" : injected.focusNode(element, false);
        if (result !== "done") return result;
        Object.defineProperty(element, ${JSON.stringify(INPUT_TARGET_TOKEN_FIELD)}, {
          configurable: true,
          value: ${JSON.stringify(token)},
          writable: true,
        });
        return "done";
      })()`)
    if (result !== "done") throw new Error(`locator could not focus element: ${String(result)}`)
  }

  /** selectOption:injected.selectOptions;"error:" 前缀结果转为异常。 */
  private async selectOption(target: LocatorResolvedTarget, action: LocatorAction): Promise<unknown> {
    const selectionsJson = JSON.stringify(action.selections ?? [])
    const result = await this.querySingleValue(target, `injected.selectOptions(elements[0], ${selectionsJson})`)
    if (typeof result === "string" && result.startsWith("error:")) {
      throw new Error(`locator.selectOption failed: ${result}`)
    }
    return result
  }

  /**
   * 零改动页内查询:strict 解析 selector 为 elements 后直接对 expression
   * 求值(count/isVisible/isEnabled/allTextContents/waitForState 使用)。
   * (public:actions.ts 的 host 接口回调所需。)
   */
  async queryValue(target: LocatorResolvedTarget, expression: string): Promise<unknown> {
    const context = await this.context(target.frame)
    const script = `(() => {
      const injected = globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD};
      const root = document;
      const elements = injected.querySelectorAll(injected.parseSelector(${JSON.stringify(target.selector)}), root);
      return ${expression};
    })()`
    return (await this.evaluate(context, script, true)).value
  }

  /**
   * 单元素页内查询:strict + 可见性回退解析 resolvedElement(allowMissing 时
   * 不注入"未命中"抛错守卫),再对 expression 求值。
   * (public:actions.ts 的 host 接口回调所需。)
   */
  async querySingleValue(target: LocatorResolvedTarget, expression: string, options: QuerySingleValueOptions = {}): Promise<unknown> {
    const context = await this.context(target.frame)
    const guard = options.allowMissing ? "" : 'if (!resolvedElement) throw new Error("No element matched selector");'
    const script = `(() => {
      const injected = globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD};
      const root = document;
      ${strictVisibleSelectorSetup(target.selector)}
      ${guard}
      return ${expression};
    })()`
    return (await this.evaluate(context, script, true)).value
  }

  /** 解析帧链并返回最终目标(帧上下文 + 边界四边形链 + 末段 selector)。 */
  private async resolveTarget(selector: string): Promise<LocatorResolvedTarget> {
    const segments = frameSegments(selector)
    let parent = await this.mainFrame()
    const boundaries: LocatorFrameBoundary[] = []
    for (const segment of segments.slice(0, -1)) {
      const parentContext = await this.context(parent)
      const resolved = await this.evaluate(parentContext, `(() => {
          const injected = globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD};
          const root = document;
          ${strictVisibleSelectorSetup(segment)}
          if (!resolvedElement) {
            throw new Error(${JSON.stringify(`frame locator resolved to no elements: ${segment}`)});
          }
          return resolvedElement;
        })()`, false)
      if (!resolved.objectId || resolved.subtype === "null") throw new Error("frame locator became detached")
      try {
        const described = await this.send<CdpDescribeNodeResponse>(parentContext, "DOM.describeNode", {
          objectId: resolved.objectId,
        })
        const frameId = described.node?.frameId
        if (!frameId) throw new Error("frame locator did not resolve to a frame owner")
        const backendNodeId = described.node?.backendNodeId
        if (!backendNodeId) throw new Error("frame locator returned no backend node identity")
        const quad = (await this.send<CdpContentQuadsResponse>(parent, "DOM.getContentQuads", {
          backendNodeId,
        })).quads?.[0]
        if (!quad || quad.length !== 8 || !quad.every((value) => Number.isFinite(value))) {
          throw new Error("frame owner returned no valid content quad")
        }
        const child = await this.childFrame(parent, frameId)
        const childContext = await this.context(child)
        const viewport = (await this.evaluate(childContext, "({ width: globalThis.innerWidth, height: globalThis.innerHeight })", true)).value as { width?: unknown; height?: unknown } | undefined
        if (!viewport || typeof viewport.width !== "number" || typeof viewport.height !== "number"
          || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
          || viewport.width <= 0 || viewport.height <= 0) {
          throw new Error("child frame returned no valid viewport size")
        }
        boundaries.push({
          childSize: {
            height: viewport.height,
            width: viewport.width,
          },
          contentQuad: quad,
          ownerBackendNodeId: backendNodeId,
          parent,
        })
        parent = child
      } finally {
        await this.send(parentContext, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => {})
      }
    }
    return {
      boundaries,
      frame: parent,
      selector: segments.at(-1) as string,
    }
  }

  /** 主帧解析(缓存):根会话 Page/Runtime/DOM.enable + Page.getFrameTree。 */
  private async mainFrame(): Promise<FrameContextRequest> {
    if (this.rootFrame) return this.rootFrame
    await this.view.cdp.send("Page.enable")
    await this.view.cdp.send("Runtime.enable")
    await this.view.cdp.send("DOM.enable")
    const frameTree = await this.view.cdp.send("Page.getFrameTree") as CdpGetFrameTreeResponse
    const frameId = frameTree.frameTree?.frame?.id
    if (!frameId) throw new Error("Page.getFrameTree returned no main frame id")
    this.rootFrame = { frameId }
    return this.rootFrame
  }

  /**
   * 子帧目标解析:同进程子帧直接以父会话 + frameId 建上下文;
   * 失败(OOPIF)则 Target.attachToTarget{flatten} 附加专属会话并 enable。
   */
  private async childFrame(parent: FrameContextRequest, frameId: string): Promise<FrameContextRequest> {
    const candidate: FrameContextRequest = {
      frameId,
      sessionId: parent.sessionId,
    }
    try {
      return await this.context(candidate), candidate
    } catch {
      const attached = await this.view.cdp.send("Target.attachToTarget", {
        flatten: true,
        targetId: frameId,
      }).catch(() => {}) as CdpAttachResponse | undefined
      if (!attached?.sessionId) throw new Error(`unable to attach frame target ${frameId}`)
      this.attachedSessionIds.add(attached.sessionId)
      const attachedTarget: FrameContextRequest = {
        ...candidate,
        sessionId: attached.sessionId,
      }
      await this.send(attachedTarget, "Page.enable")
      await this.send(attachedTarget, "Runtime.enable")
      await this.send(attachedTarget, "DOM.enable")
      return await this.context(attachedTarget), attachedTarget
    }
  }

  private contextKey(target: FrameContextRequest): string {
    return `${target.sessionId ?? "root"}:${target.frameId}`
  }

  /** 帧执行上下文(隔离世界)缓存:每 `${sessionId}:${frameId}` 一个。 */
  async context(target: FrameContextRequest): Promise<LocatorEvaluateTarget> {
    if (this.signal?.aborted) throw locatorAbortError()
    const key = this.contextKey(target)
    const cached = this.contexts.get(key)
    if (cached) return cached
    const world = await this.send<CdpCreateIsolatedWorldResponse>(target, "Page.createIsolatedWorld", {
      frameId: target.frameId,
      grantUniveralAccess: false,
      worldName: LOCATOR_WORLD_NAME,
    })
    if (!world.executionContextId) throw new Error(`unable to create locator world for ${target.frameId}`)
    const contextTarget: LocatorEvaluateTarget = {
      ...target,
      contextId: world.executionContextId,
    }
    await this.inject(contextTarget)
    this.contexts.set(key, contextTarget)
    return contextTarget
  }

  /** 注入官方 playwright InjectedScript 到隔离世界(幂等,全局字段探测)。 */
  private async inject(target: LocatorEvaluateTarget): Promise<void> {
    if ((await this.evaluate(target, `Boolean(globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD})`, true)).value === true) return
    const injectedOptions = {
      browserName: "chromium",
      customEngines: [],
      isUnderTest: false,
      sdkLanguage: "javascript",
      stableRafCount: 1,
      testIdAttributeName: "data-testid",
    }
    const bootstrap = `(() => {
      const module = {};
      ${getPlaywrightInjectedScriptSource()}
      globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD} = new (module.exports.InjectedScript())(
        globalThis,
        ${JSON.stringify(injectedOptions)}
      );
      return true;
    })()`
    if ((await this.evaluate(target, bootstrap, true)).value !== true) {
      throw new Error("unable to initialize Playwright locator runtime")
    }
  }

  /**
   * 隔离世界求值:abort 时挂 Runtime.terminateExecution 监听终止页内执行;
   * 异常文本经 locatorRuntimeError 归一后抛出;返回 remote object。
   * (public:actions.ts 的 host 接口回调所需,下同。)
   */
  async evaluate(target: LocatorEvaluateTarget, expression: string, returnByValue: boolean, timeoutMs: number = this.timeoutMs): Promise<CdpRemoteObject> {
    if (this.signal?.aborted) throw locatorAbortError()
    const terminate = () => {
      this.view.cdp.send("Runtime.terminateExecution", undefined, target.sessionId).catch(() => {})
    }
    this.signal?.addEventListener("abort", terminate, { once: true })
    try {
      const response = await this.send<CdpEvaluateResponse>(target, "Runtime.evaluate", {
        awaitPromise: true,
        contextId: target.contextId,
        expression,
        returnByValue,
        timeout: timeoutMs,
      })
      const error = locatorRuntimeError(response)
      if (error) throw new Error(error)
      return response.result ?? {}
    } finally {
      this.signal?.removeEventListener("abort", terminate)
    }
  }

  /** 按目标 sessionId 发送 CDP 命令(abort 时直接拒绝)。 */
  send<T = unknown>(target: FrameContextRequest, method: string, params?: Record<string, unknown>): Promise<T> {
    return this.signal?.aborted
      ? Promise.reject(locatorAbortError())
      : this.view.cdp.send(method, params, target.sessionId) as Promise<T>
  }

  /** 可中断延迟:超时返回 true,abort 返回 false。(public:host 接口所需。) */
  delay(timeoutMs: number): Promise<boolean> {
    if (this.signal?.aborted) return Promise.resolve(false)
    return new Promise((resolve) => {
      const finish = (completed: boolean) => {
        clearTimeout(timer)
        this.signal?.removeEventListener("abort", onAbort)
        resolve(completed)
      }
      const timer = setTimeout(() => finish(true), timeoutMs)
      const onAbort = () => finish(false)
      this.signal?.addEventListener("abort", onAbort, { once: true })
    })
  }
}

/**
 * ZCode 原名 ca/executeIabPlaywrightLocator:一次性入口 —— 建会话 → execute →
 * finally dispose。装配层将结果适配为 dispatcher.ts 的
 * PlaywrightActionExecutorPort.locator 契约(done→ok)。
 */
export async function executeIabPlaywrightLocator(
  view: ControlledView,
  action: LocatorAction,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  input: LocatorInputPorts,
  debug?: (message: string, details?: Record<string, unknown>) => void,
): Promise<LocatorOutcome> {
  const session = new IabPlaywrightLocatorSession({ view, timeoutMs, signal, input, debug })
  try {
    return await session.execute(action)
  } finally {
    await session.dispose()
  }
}
