/**
 * 输入原语 —— CUA 坐标/键盘输入的规范实现(经 webContents.debugger CDP 下发,
 * 不使用 OS 级输入注入)。
 *
 * 来源:
 *   - D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *     08-input-primitives.clean.js(ZCode Desktop 3.10.1 out/main/index.js
 *     @846000-876500 的手工清洁版)
 *   - 02-execution-engine.source.js(gde/Dj/hde/yde/$j/wde/Rn 原始字节,
 *     KEY_TABLE 以 02 的 Dj 为准:完整 10 条目)
 *
 * ZCode 原名对照:
 *   gde → MODIFIER_BITS                 Dj → KEY_TABLE(10 条:Enter/Tab/Escape/
 *                                          Backspace/Delete/Arrow×4/Space)
 *   hde → MODIFIER_KEY_TABLE            yde → normalizeCuaKey
 *   $j  → asModifier                    wde → keyDefinition
 *   Rn  → modifiersBitmask              ci  → dispatchClickAt
 *   Nj  → dispatchDrag                  Lj  → dispatchDragPath
 *   nM  → dispatchScrollGesture         Uj  → dispatchKeyPress
 *   Ng  → dispatchKey                   rM  → isAllowedBrowserUrl
 *   He  → readState                     Lg  → safe(模块内私有)
 *   Bj  → settleNavigation              Vd  → BrowserNavigationTimeoutError(已并入 ./types)
 *
 * 语义偏差(仅以下已声明项):
 *   - 08 清洁版 MODIFIER_BITS 额外收录小写别名(control/ctrl/meta/Command/Cmd/
 *     shift)且带 ?? 0 兜底;本实现按 02 原始字节 gde 仅收五个规范键名
 *     (位或 undefined 与 ?? 0 等价)。keyDefinition 的单字符兜底同样取 02 的
 *     KeyX/DigitX 形式(08 为不带 code 的简化版)。
 *   - Uj 内 n.toReversed() 以 slice().reverse() 等价改写(lib ES2022 无 toReversed)。
 *   - 平台:ref 注册表命名保持 ZCode 内部标识(__zcodeRefs),由注入脚本层管理。
 *
 * 注意:executor/dispatcher.ts 当前内联了本模块的同名副本(键表/鼠标/拖拽/
 * 滚动/键盘/导航状态原语);集成者删除其副本并改从本模块 import 即可完成去重。
 */
import {
  BrowserNavigationTimeoutError,
  type ControlledView,
  type ControlledWebContents,
} from "./types"

/* ── 坐标形状 ──────────────────────────────────────────────────────── */

/** 视口坐标点(dispatchClickAt/dispatchDrag/dispatchScrollGesture 入参)。 */
export interface CommandPoint { cx: number; cy: number }

/** 显式二维坐标(dispatchDragPath / cuaDrag 参数路径点)。 */
export interface Point2D { x: number; y: number }

/** readState 返回的页面状态(导航/交互结果的统一 state 载荷)。 */
export interface BrowserPageState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
}

/* ── 键表 ──────────────────────────────────────────────────────────── */

/** ZCode 原名 gde:修饰键 → CDP 位掩码(ControlOrMeta 在 darwin 映射 Meta)。 */
const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
}

/**
 * ZCode 原名 Dj:命名键 → key/code/windowsVirtualKeyCode 完整键表(10 条目)。
 */
export const KEY_TABLE: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
}

/** ZCode 原名 hde:修饰键 → code/windowsVirtualKeyCode(darwin 用 MetaLeft)。 */
const MODIFIER_KEY_TABLE: Record<string, { code: string; windowsVirtualKeyCode: number }> = {
  Alt: { code: "AltLeft", windowsVirtualKeyCode: 18 },
  Control: { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  ControlOrMeta: process.platform === "darwin"
    ? { code: "MetaLeft", windowsVirtualKeyCode: 91 }
    : { code: "ControlLeft", windowsVirtualKeyCode: 17 },
  Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91 },
  Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16 },
}

/** ZCode 原名 yde/normalizeCuaKey:CUA 键别名归一(esc/return/方向键等)。 */
export function normalizeCuaKey(key: string): string {
  const trimmed = key.trim()
  return {
    alt: "Alt",
    option: "Alt",
    control: "Control",
    ctrl: "Control",
    controlormeta: process.platform === "darwin" ? "Meta" : "Control",
    cmd: "Meta",
    meta: "Meta",
    super: "Meta",
    win: "Meta",
    shift: "Shift",
    esc: "Escape",
    return: "Enter",
    space: "Space",
    left: "ArrowLeft",
    right: "ArrowRight",
    up: "ArrowUp",
    down: "ArrowDown",
  }[trimmed.toLowerCase()] ?? trimmed
}

/** ZCode 原名 $j/asModifier:仅接受五个修饰键名。 */
export function asModifier(key: string): string | undefined {
  return ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(key) ? key : undefined
}

/** ZCode 原名 wde/keyDefinition:键表 → 修饰键表 → 单字符 KeyX/DigitX 兜底。 */
export function keyDefinition(key: string): { key: string; code?: string; windowsVirtualKeyCode?: number } {
  const known = KEY_TABLE[key]
  if (known) return known
  const modifier = asModifier(key)
  if (modifier) return { key: modifier, ...MODIFIER_KEY_TABLE[modifier] }
  if (/^[a-z]$/iu.test(key)) {
    const upper = key.toUpperCase()
    return { key, code: `Key${upper}`, windowsVirtualKeyCode: upper.charCodeAt(0) }
  }
  return /^[0-9]$/u.test(key)
    ? { key, code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0) }
    : { key }
}

/** ZCode 原名 Rn/modifiersBitmask:修饰键数组 → 位掩码。 */
export function modifiersBitmask(modifiers?: string[]): number {
  if (!modifiers || modifiers.length === 0) return 0
  let mask = 0
  for (const modifier of modifiers) mask |= MODIFIER_BITS[modifier]
  return mask
}

/* ── 鼠标/滚动手势 ─────────────────────────────────────────────────── */

/**
 * ZCode 原名 ci/dispatchClickAt:mouseMoved → mousePressed → mouseReleased
 * (clickCount 双击=2,modifiers>0 时附带修饰态)。
 */
export async function dispatchClickAt(view: ControlledView, point: CommandPoint, button: string, doubleClick: boolean, modifiers = 0): Promise<void> {
  const clickCount = doubleClick ? 2 : 1
  const mods = modifiers > 0 ? { modifiers } : {}
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.cx, y: point.cy, ...mods })
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.cx, y: point.cy, button, clickCount, ...mods })
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.cx, y: point.cy, button, clickCount, ...mods })
}

/** ZCode 原名 Nj/dispatchDrag:press → 10 步线性插值 move → release。 */
export async function dispatchDrag(view: ControlledView, from: CommandPoint, to: CommandPoint, modifiers = 0): Promise<void> {
  const mods = modifiers > 0 ? { modifiers } : {}
  const steps = 10
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.cx, y: from.cy, ...mods })
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.cx, y: from.cy, button: "left", clickCount: 1, ...mods })
  for (let step = 1; step <= steps; step++) {
    const x = Math.round(from.cx + (to.cx - from.cx) * step / steps)
    const y = Math.round(from.cy + (to.cy - from.cy) * step / steps)
    await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, ...mods })
  }
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.cx, y: to.cy, button: "left", clickCount: 1, ...mods })
}

/** ZCode 原名 Lj/dispatchDragPath:按显式路径逐点拖拽(finally 保证释放)。 */
export async function dispatchDragPath(view: ControlledView, path: Point2D[], modifiers = 0): Promise<void> {
  const [first, ...rest] = path
  if (!first) throw new Error("cua_drag requires a non-empty path")
  const mods = modifiers > 0 ? { modifiers } : {}
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: first.x, y: first.y, ...mods })
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: first.x, y: first.y, button: "left", clickCount: 1, ...mods })
  let last = first
  try {
    for (const point of rest) {
      last = point
      await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "left", buttons: 1, ...mods })
    }
  } finally {
    await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, button: "left", clickCount: 1, ...mods })
  }
}

/**
 * ZCode 原名 nM/dispatchScrollGesture:mouseMoved + mouseWheel(deltaX/deltaY)。
 * 注意:不用 Input.synthesizeScrollGesture,而是 mouseWheel 型 dispatchMouseEvent。
 */
export async function dispatchScrollGesture(view: ControlledView, point: CommandPoint, deltaX: number, deltaY: number, modifiers = 0): Promise<void> {
  const mods = modifiers > 0 ? { modifiers } : {}
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.cx, y: point.cy, ...mods })
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.cx, y: point.cy, deltaX, deltaY, ...mods })
}

/* ── 键盘 ──────────────────────────────────────────────────────────── */

/**
 * ZCode 原名 Uj/dispatchKeyPress:"+"拆键,修饰键按序 down → 末键 down/up →
 * 修饰键逆序 up;按住中的修饰键累积进 bitmask(Chromium 要求每次事件携带
 * 完整修饰态)。(toReversed 以 slice().reverse() 等价改写)
 */
export async function dispatchKeyPress(view: ControlledView, comboKeys: string[]): Promise<void> {
  const parts = comboKeys.flatMap((key) => key.split("+")).filter(Boolean).map(normalizeCuaKey)
  const mainKey = parts.at(-1)
  if (!mainKey) throw new Error("keypress requires at least one key")
  const modifierKeys = parts.slice(0, -1)
  const held = new Set<string>()
  const dispatch = async (type: string, key: string): Promise<void> => {
    const modifier = asModifier(key)
    if (type === "keyDown" && modifier) held.add(modifier)
    if (type === "keyUp" && modifier) held.delete(modifier)
    const definition = keyDefinition(key)
    const mask = modifiersBitmask([...held])
    await view.cdp.send("Input.dispatchKeyEvent", {
      type,
      ...definition,
      ...(mask > 0 ? { modifiers: mask } : {}),
    })
  }
  for (const modifier of modifierKeys) await dispatch("keyDown", modifier)
  await dispatch("keyDown", mainKey)
  await dispatch("keyUp", mainKey)
  for (const modifier of modifierKeys.slice().reverse()) await dispatch("keyUp", modifier)
}

/**
 * ZCode 原名 Ng/dispatchKey:单键 keyDown + keyUp;
 * sessionId 传入时定向到子 CDP session(OOPIF 场景)。
 */
export async function dispatchKey(view: ControlledView, key: string, modifiers = 0, sessionId?: string): Promise<void> {
  const known = KEY_TABLE[key]
  const definition = known
    ? { key: known.key, code: known.code, windowsVirtualKeyCode: known.windowsVirtualKeyCode }
    : { key }
  const mods = modifiers > 0 ? { modifiers } : {}
  const sendKey = (type: string) => sessionId == null
    ? view.cdp.send("Input.dispatchKeyEvent", { type, ...definition, ...mods })
    : view.cdp.send("Input.dispatchKeyEvent", { type, ...definition, ...mods }, sessionId)
  await sendKey("keyDown")
  await sendKey("keyUp")
}

/* ── 导航白名单与状态 ──────────────────────────────────────────────── */

/** ZCode 原名 rM/isAllowedBrowserUrl:只放行 about:blank 与 http/https。 */
export function isAllowedBrowserUrl(url: string): boolean {
  if (url === "about:blank") return true
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

/** ZCode 原名 Lg/safe:吞异常取默认值(readState 内部使用)。 */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/** ZCode 原名 He/readState:url/title/canGoBack/canGoForward(全部 safe 包裹)。 */
export function readState(webContents: ControlledWebContents): BrowserPageState {
  return {
    url: safe(() => webContents.getURL(), ""),
    title: safe(() => webContents.getTitle(), ""),
    canGoBack: safe(() => webContents.canGoBack(), false),
    canGoForward: safe(() => webContents.canGoForward(), false),
  }
}

/**
 * ZCode 原名 Bj/settleNavigation:导航 Promise 与超时/abort 三方竞速。
 * 超时抛 BrowserNavigationTimeoutError;abort 抛 DOMException("AbortError")。
 */
export async function settleNavigation(navigation: Promise<unknown>, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("aborted", "AbortError")
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new BrowserNavigationTimeoutError(`Navigation timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new DOMException("aborted", "AbortError"))
    signal?.addEventListener("abort", onAbort, { once: true })
  })
  try {
    await Promise.race([navigation, timeout, aborted])
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}
