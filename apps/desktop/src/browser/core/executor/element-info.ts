/**
 * 元素信息 —— ELEMENT_AT_POINT 直连查询 + playwright 隔离世界 runtime 序列化。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js(handleElementInfo 与 辅助 evaluate 通道)
 *       injected-scripts/runtime-exact/elementInfoRuntime.exact.js
 *       injected-scripts/runtime-exact/overlayRuntime.exact.js
 *
 * ZCode 原名对照:
 *   rH → handleElementInfo                 A$ → (zod schema,见 PortingGap)
 *   yM → serializeRuntimeCall              ple → elementInfoRuntime(序列化字节
 *         存于 injecteds/generated-literals.ts 的 ELEMENT_INFO_RUNTIME_FN_SOURCE)
 *   IH → overlayRuntime(序列化字节同上 OVERLAY_RUNTIME_FN_SOURCE)
 *   wM → evaluateInPlaywrightIsolatedWorld
 *
 * PortingGap:ZCode 的 A$ zod schema 未在提取源中,parseElementAtPointResult
 * 按 ELEMENT_AT_POINT_SCRIPT 的返回契约重建(必需字段 + 可选字段类型校验),
 * 失败路径语义一致(safeParse → issues[0].message)。
 *
 * 语义偏差:
 *   - ZCode 以 fn.toString() 序列化 ple/IH;Bun 的 TS 转译会改写函数体字节,
 *     故以字节恒定的字符串常量保存序列化结果(测试保证与 runtime-exact 一致)。
 *   - ple 序列化体内保留 ZCode 压缩器的 s(fn,"name") displayName 调用与原名
 *     ple/IH(注入字符串字节恒定要求,不参与语义重命名)。
 */
import type { BrowserCommandResult, ControlledView } from "../types"
import { executionError, type CommandDone, type ElementInfoCommandParams } from "./dispatcher"
import { elementAtPointScript } from "./injecteds/generators"

/* ── handleElementInfo(rH) ─────────────────────────────────────────── */

/** ELEMENT_AT_POINT_SCRIPT 返回的元素详情(shape 与快照元素一致)。 */
export interface ElementAtPointResult {
  ref: string
  tag: string
  selector: string
  xpath: string
  rect: { x: number; y: number; width: number; height: number }
  inViewport: boolean
  role?: string
  name?: string
  text?: string
  value?: string
  disabled?: boolean
  checked?: boolean
}

export type ParseFailure = { success: false; error: { issues: Array<{ message: string }> } }
export type ParseSuccess<T> = { success: true; data: T }
export type ParseResult<T> = ParseSuccess<T> | ParseFailure

/**
 * 失败分支类型守卫。(tsconfig 关闭 strictNullChecks 时布尔字面量判别联合
 * 会被加宽,三元/!parsed.success 窄化不可靠,故用谓词守卫。)
 */
export function isParseFailure<T>(result: ParseResult<T>): result is ParseFailure {
  return result.success !== true
}

const isString = (value: unknown): value is string => typeof value === "string"
const isNumber = (value: unknown): value is number => typeof value === "number"
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean"
const failure = (message: string): ParseFailure => ({ success: false, error: { issues: [{ message }] } })

/**
 * PortingGap(重建 A$):校验 ELEMENT_AT_POINT_SCRIPT 的返回形状。
 * 消息格式 "<field>: expected <type>" 与 zod issues[0].message 用法兼容。
 */
export function parseElementAtPointResult(value: unknown): ParseResult<ElementAtPointResult> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return failure("element: expected object")
  const record = value as Record<string, unknown>
  for (const [key, guard] of [["ref", isString], ["tag", isString], ["selector", isString], ["xpath", isString], ["inViewport", isBoolean]] as const) {
    if (!guard(record[key])) return failure(`${key}: expected ${guard === isString ? "string" : "boolean"}`)
  }
  const rect = record.rect
  if (!rect || typeof rect !== "object") return failure("rect: expected object")
  for (const key of ["x", "y", "width", "height"] as const) {
    if (!isNumber((rect as Record<string, unknown>)[key])) return failure(`rect.${key}: expected number`)
  }
  if (record.role !== undefined && !isString(record.role)) return failure("role: expected string")
  if (record.name !== undefined && !isString(record.name)) return failure("name: expected string")
  if (record.text !== undefined && !isString(record.text)) return failure("text: expected string")
  if (record.value !== undefined && !isString(record.value)) return failure("value: expected string")
  if (record.disabled !== undefined && !isBoolean(record.disabled)) return failure("disabled: expected boolean")
  if (record.checked !== undefined && !isBoolean(record.checked)) return failure("checked: expected boolean")
  return { success: true, data: value as ElementAtPointResult }
}

/**
 * ZCode 原名 rH/handleElementInfo:ELEMENT_AT_POINT_SCRIPT 查询 (x,y) 元素;
 * 无元素返回 {ok:true};结果经 schema 校验,失败报 execution_error。
 */
export async function handleElementInfo(view: ControlledView, params: ElementInfoCommandParams, done: CommandDone): Promise<BrowserCommandResult> {
  const result = await view.webContents.executeJavaScript(elementAtPointScript(params.x, params.y))
  if (result == null) return done({ ok: true })
  const parsed = parseElementAtPointResult(result)
  if (isParseFailure(parsed)) {
    return done(executionError(`invalid element result shape: ${parsed.error.issues[0]?.message ?? "unknown"}`))
  }
  return done({
    ok: true,
    element: parsed.data,
  })
}

/* ── 隔离世界 runtime 序列化(yM/ple/IH/wM) ────────────────────────── */

/**
 * ZCode 原名 yM/serializeRuntimeCall:runtime 函数序列化调用串
 * `(fnSource)(args...)`,参数 JSON.stringify。
 */
export function serializeRuntimeCall(runtimeFnSource: string, ...args: Array<unknown>): string {
  return `(${runtimeFnSource})(${args.map((arg) => JSON.stringify(arg)).join(",")})`
}

/**
 * ZCode 原名 wM/evaluateInPlaywrightIsolatedWorld:Page.createIsolatedWorld
 * (worldName "zcode-playwright-helper")→ Runtime.evaluate(隔离世界上下文);
 * 主帧缺失/世界创建失败/异常均抛错。
 */
export async function evaluateInPlaywrightIsolatedWorld(view: ControlledView, expression: string): Promise<unknown> {
  const frameTree = await view.cdp.send("Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } }
  const frameId = frameTree.frameTree?.frame?.id
  if (!frameId) throw new Error("Playwright isolated world requires a main frame id")
  const world = await view.cdp.send("Page.createIsolatedWorld", {
    frameId,
    grantUniveralAccess: false,
    worldName: "zcode-playwright-helper",
  }) as { executionContextId?: unknown }
  if (typeof world.executionContextId !== "number") throw new Error("Playwright isolated world was not created")
  const response = await view.cdp.send("Runtime.evaluate", {
    expression,
    contextId: world.executionContextId,
    awaitPromise: true,
    returnByValue: true,
  }) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Playwright isolated-world evaluation failed")
  }
  return response.result?.value
}
