/**
 * 浏览器命令协议稳定错误码 —— ZCode 模型反馈协议(guide §4.3)。
 *
 * 语义来源:
 *   - 错误码:`duplicate_request_id / navigation_blocked / timeout / execution_error /
 *     cancelled / capability_unsupported / backend_unavailable`(chunk47 共享 zod;
 *     `browser_internal_error` 为 desktop 核心的归一化兜底码,不属于 ZCode 稳定码集)
 *   - sideEffect 语义:guide §1.3 决策 8 "取消语义显式化";
 *     NH(raceBackendExecution) `_M(r) ? "uncertain" : "none"`
 *   - 副作用命令分类:`_M`(isSideEffecting,01 还原源码)
 */

/** ZCode 稳定错误码集(跨进程稳定,模型可见,不得增删改语义) */
export const BROWSER_ERROR_CODES = [
  "duplicate_request_id",
  "navigation_blocked",
  "timeout",
  "execution_error",
  "cancelled",
  "capability_unsupported",
  "backend_unavailable",
] as const

/** 稳定错误码类型 */
export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number]

/**
 * 取消类结果的副作用标注。
 * - `"none"`:命令确定未产生副作用(尚未派发,或命令本身只读);
 * - `"uncertain"`:命令已派发后才被取消,副作用可能已发生且不回滚 —— 模型重试决策依据。
 */
export type BrowserErrorSideEffect = "none" | "uncertain"

/** 判断任意字符串是否为稳定错误码(归一化闸前使用) */
export function isBrowserErrorCode(code: string): code is BrowserErrorCode {
  return (BROWSER_ERROR_CODES as readonly string[]).includes(code)
}

/**
 * `_M`(isSideEffecting)—— 命令是否具有写副作用。
 *
 * - playwright.locator:仅 pointer/输入/下载类操作算副作用
 *   (click/dblclick/downloadMedia/fill/press/selectOption/setChecked);
 *   playwright.evaluate 一律视为副作用(任意页面脚本)。
 * - 顶层方法按 ZCode 白名单判定(逐字对照还原源码,顺序保留)。
 */
export function isSideEffectingCommand(
  command: { method: string; action?: { name?: unknown; operation?: unknown } },
): boolean {
  const action = command.action
  if (command.method === "playwright" && action) {
    if (action.name === "locator") {
      return (
        typeof action.operation === "string" &&
        ["click", "dblclick", "downloadMedia", "fill", "press", "selectOption", "setChecked"].includes(
          action.operation,
        )
      )
    }
    if (action.name === "evaluate") return true
    return false
  }
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

/**
 * 取消结果的 sideEffect 标注助手(NH 语义)。
 *
 * @param command  被取消的命令(用于副作用分类)
 * @param dispatched 命令是否已派发到后端(guest/执行器);未派发恒为 "none"
 */
export function cancellationSideEffect(
  command: Parameters<typeof isSideEffectingCommand>[0],
  dispatched: boolean,
): BrowserErrorSideEffect {
  return dispatched && isSideEffectingCommand(command) ? "uncertain" : "none"
}

/** 稳定错误负载(协议线上形态;sideEffect 仅取消/不确定路径携带) */
export interface BrowserErrorPayload {
  code: BrowserErrorCode
  message: string
  sideEffect?: BrowserErrorSideEffect
}

/** 构造稳定错误负载(供后端各拒绝路径复用,文案与 ZCode 逐条对齐由调用方负责) */
export function browserErrorPayload(
  code: BrowserErrorCode,
  message: string,
  sideEffect?: BrowserErrorSideEffect,
): BrowserErrorPayload {
  return sideEffect === undefined ? { code, message } : { code, message, sideEffect }
}
