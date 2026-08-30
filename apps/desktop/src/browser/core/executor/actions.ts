/**
 * locator 求值与等待 —— evaluate(Runtime.callFunctionOn)与 waitFor 状态轮询。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js [SECTION] IabPlaywrightLocatorSession
 *       (hM 类内 evaluateLocator/waitForState/waitForUnique 三方法)
 *
 * ZCode 原名对照:
 *   evaluateLocator → evaluateLocator(Runtime.callFunctionOn 于已解析
 *                     objectId,finally Runtime.releaseObject)
 *   waitForState    → waitForState(visible/hidden/attached/detached 轮询)
 *   waitForUnique   → waitForUnique(等待元素唯一命中,count===1 前置)
 *
 * 结构说明:三方法在 ZCode 为 IabPlaywrightLocatorSession(hM)类方法;此处
 * 以独立函数 + IabPlaywrightLocatorSessionHost 结构化接口承载(会话类满足该
 * 接口后以 this 调用)。与 locator-session.ts 之间为函数声明提升绑定的 ESM
 * 活绑定循环引用(strictVisibleSelectorSetup/locatorRuntimeError/RETRY_DELAY_MS
 * 仅在运行期调用,见 locator-session.ts 文件头说明)。
 *
 * 语义偏差(已声明项):
 *   - s(X,"name") 压缩器 displayName 元数据一律去除;其余逐行等价。
 */
import {
  PLAYWRIGHT_INJECTED_GLOBAL_FIELD,
} from "./injected-loader"
import {
  RETRY_DELAY_MS,
  locatorRuntimeError,
  strictVisibleSelectorSetup,
} from "./locator-session"
import type {
  CdpEvaluateResponse,
  LocatorEvaluateTarget,
  LocatorAction,
  LocatorOutcome,
  LocatorResolvedTarget,
} from "./locator-session"

/**
 * 三个动作函数对会话的依赖面(结构化接口,IabPlaywrightLocatorSession 满足)。
 */
export interface IabPlaywrightLocatorSessionHost {
  readonly timeoutMs: number
  readonly signal?: AbortSignal
  context(target: { frameId: string; sessionId?: string }): Promise<LocatorEvaluateTarget>
  evaluate(target: { contextId: number }, expression: string, returnByValue: boolean, timeoutMs?: number): Promise<{ objectId?: string; subtype?: string; value?: unknown }>
  send<T>(target: { sessionId?: string }, method: string, params?: Record<string, unknown>): Promise<T>
  queryValue(target: LocatorResolvedTarget, expression: string): Promise<unknown>
  querySingleValue(target: LocatorResolvedTarget, expression: string, options?: { allowMissing?: boolean }): Promise<unknown>
  delay(timeoutMs: number): Promise<boolean>
}

/**
 * ZCode hM#evaluateLocator:在隔离世界解析目标元素为 remote object,再对其
 * objectId 执行 Runtime.callFunctionOn(函数注入 this=元素,arg 为动作参数);
 * finally 释放 objectId。表达式按 expressionKind 分为"function(this,arg)"与
 * "取值表达式"两种包装。
 */
export async function evaluateLocator(host: IabPlaywrightLocatorSessionHost, target: LocatorResolvedTarget, action: LocatorAction): Promise<unknown> {
  const context = await host.context(target.frame)
  const resolved = await host.evaluate(context, `(() => {
        const injected = globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD};
        const root = document;
        ${strictVisibleSelectorSetup(target.selector)}
        if (!resolvedElement) throw new Error("No element matched selector");
        return resolvedElement;
      })()`, false)
  if (!resolved.objectId || resolved.subtype === "null") throw new Error("locator resolved to no elements")
  const functionDeclaration = action.expressionKind === "function"
    ? `function(arg) { return (${action.expression})(this, arg); }`
    : `function(arg) { const element = this; return (${action.expression}); }`
  try {
    const response = await host.send<CdpEvaluateResponse>(context, "Runtime.callFunctionOn", {
      objectId: resolved.objectId,
      functionDeclaration,
      arguments: [{
        value: action.arg,
      }],
      awaitPromise: true,
      returnByValue: true,
    })
    const error = locatorRuntimeError(response)
    if (error) throw new Error(`playwright.evaluate failed: ${error}`)
    return response.result?.value
  } finally {
    await host.send(context, "Runtime.releaseObject", { objectId: resolved.objectId }).catch(() => {})
  }
}

/**
 * ZCode hM#waitForState:waitFor 状态轮询(默认 visible)。判据经单次页内
 * 查询返回 {exists, visible};50ms 步进,超时报 `selector to be state`。
 */
export async function waitForState(host: IabPlaywrightLocatorSessionHost, target: LocatorResolvedTarget, action: LocatorAction): Promise<LocatorOutcome> {
  const state = action.state ?? "visible"
  const deadline = Date.now() + host.timeoutMs
  for (;;) {
    if (host.signal?.aborted) return { kind: "cancelled" }
    const presence = await host.queryValue(target, "({ exists: elements.length > 0, visible: Boolean(elements[0] && injected.elementState(elements[0], 'visible').matches) })") as { exists?: unknown; visible?: unknown }
    const matched = state === "attached"
      ? presence.exists
      : state === "detached"
        ? !presence.exists
        : state === "visible"
          ? presence.visible
          : !presence.visible
    if (matched) return { kind: "done", value: undefined }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { kind: "timeout", reason: `${action.selector} to be ${state}` }
    if (!await host.delay(Math.min(RETRY_DELAY_MS, remaining))) return { kind: "cancelled" }
  }
}

/**
 * ZCode hM#waitForUnique:textContent/innerText/getAttribute/evaluate 的
 * 前置等待 —— 元素唯一命中(Boolean(elements[0]))即返回;allowMissing
 * 使查询在零命中时不抛"未命中"守卫异常。50ms 步进。
 */
export async function waitForUnique(host: IabPlaywrightLocatorSessionHost, target: LocatorResolvedTarget, selector: string): Promise<LocatorOutcome> {
  const deadline = Date.now() + host.timeoutMs
  for (;;) {
    if (host.signal?.aborted) return { kind: "cancelled" }
    if (await host.querySingleValue(target, "Boolean(elements[0])", { allowMissing: true }) === true) {
      return { kind: "done", value: undefined }
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { kind: "timeout", reason: `locator ${selector}` }
    if (!await host.delay(Math.min(RETRY_DELAY_MS, remaining))) return { kind: "cancelled" }
  }
}
