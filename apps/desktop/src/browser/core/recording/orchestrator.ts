/**
 * 录制编排 —— recordBrowserVideo(AH)+ 光标 overlay + 录制场景动作执行。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\01-browser-guest-manager.source.js
 * (录制编排切片;guest-manager.ts 已随本文件移植同款实现, 本模块提供
 *  可独立装配/测试的等价形态, 集成者二选一接线)。契约: ../types.ts。
 *
 * ZCode 原名对照(s(X,"name")/guest-manager 对照核实):
 * | 本文件标识符                        | ZCode 原名 |
 * |------------------------------------|------------|
 * | recordBrowserVideo                 | AH         |
 * | abortError                         | vle/sr     |
 * | throwIfAborted                     | Hg         |
 * | waitForDelay                       | Cr         |
 * | executeRecordingActions            | 录制场景分发(guest-manager 同名私有方法) |
 * | executeRecordingAction             | 单动作分发(同上) |
 * | executeRecordingBrowserCommand     | 命令执行包装(同上) |
 * | resolveRecordingSelectorPoint      | 选择器中心点解析(同上) |
 * | resolveRecordingSelectorScrollTarget | 选择器滚动目标解析(同上) |
 * | moveRecordingPointer               | 指针插值移动(≤60 步 × duration/16ms) |
 * | animateRecordingScroll             | 滚动插值(≤60 步) |
 * | installRecordingCursorOverlay      | 光标 overlay 安装(同上) |
 * | removeRecordingCursorOverlay       | 光标 overlay 移除(同上) |
 * | isBrowserPointValue                | UH         |
 *
 * 语义偏差(应仅剩命名/结构注入):
 * 1. locator 执行器(A4 ca)与命令执行器(jg)由内敛方法改为注入端口
 *    RecordingLocatorExecutor / RecordingCommandExecutor(结构签名与
 *    guest-manager.ts 导出的 IabPlaywrightLocatorExecutor / CommandExecutor 一致)。
 * 2. RecordingScenarioAction / RecordingActionCommand 为 guest-manager.ts 同形状
 *    PortingGap 复本(跨代理不得互相 import);结构兼容, 集成时可直接传递。
 * 3. recordBrowserVideo 的 recordingId 在本函数内做 `[^A-Za-z0-9._-] → -` 清洗;
 *    guest-manager 调用点已预清洗, 清洗幂等, 两者结果一致。
 */

import { rm, stat } from "fs/promises"
import { join } from "path"
import type { WebContents, WebFrameMain } from "electron"
import type {
  BrowserCommandResult,
  BrowserRecordingRecord,
  BrowserViewportOverride,
  ControlledView,
  RecordingRecorder,
  RecordingRecorderOptions,
} from "../types"

/* ════════════════════════════════════════════════════════════════════
 * PortingGap —— types.ts 契约之外、本文件内声明的结构性类型。
 * ════════════════════════════════════════════════════════════════════ */

/** PortingGap: 录制场景动作(与 guest-manager.ts 导出的 RecordingScenarioAction 同形状) */
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

/** PortingGap: 坐标型命令载荷(结构兼容 guest-manager.ts 的 BrowserGuestCommand) */
export interface RecordingActionCommand {
  method: string
  x?: number
  y?: number
  button?: string
  doubleClick?: boolean
}

/** PortingGap: locator 结果判别(与 guest-manager.ts 的 IabPlaywrightLocatorOutcome 同形状) */
export type RecordingLocatorOutcome =
  | { kind: "done"; value: unknown }
  | { kind: "cancelled" }
  | { kind: "timeout"; reason: string }

/** PortingGap: A4 接线 —— executeIabPlaywrightLocator(ca)注入端口 */
export type RecordingLocatorExecutor = (
  view: ControlledView,
  action: Record<string, unknown>,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<RecordingLocatorOutcome>

/** PortingGap: A4/A5 接线 —— executeBrowserCommandOnView(jg)注入端口 */
export type RecordingCommandExecutor = (
  view: ControlledView,
  command: RecordingActionCommand,
) => Promise<BrowserCommandResult>

/** 录制产物(recordBrowserVideo 返回, 即 BrowserRecordingRecord["artifact"]) */
export type BrowserRecordingArtifact = NonNullable<BrowserRecordingRecord["artifact"]>

/* ── 小工具(命名对照见文件头) ─────────────────────────────────────── */

/** vle/sr —— 标准中止异常 */
function abortError(message = "Browser recording cancelled"): DOMException {
  return new DOMException(message, "AbortError")
}

/** Hg —— 已中止则抛出 */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError()
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

/** UH —— 页面坐标点形状守卫(类型谓词) */
function isBrowserPointValue(value: unknown): value is { x: number; y: number } {
  if (!value || typeof value !== "object") return false
  const candidate = value as { x?: unknown; y?: unknown }
  return typeof candidate.x === "number" && typeof candidate.y === "number"
}

/* ════════════════════════════════════════════════════════════════════
 * recordBrowserVideo(ZCode AH)
 * ════════════════════════════════════════════════════════════════════ */

export interface RecordBrowserVideoOptions {
  tempRoot: string
  recordingId: string
  targetFrame: WebFrameMain
  viewport: BrowserViewportOverride
  fps: number
  signal: AbortSignal
  now?: () => number
  onPhase?: (phase: "capturing" | "finalizing") => void
  onCaptureComplete?: () => void
  executeScenario: () => Promise<void>
  createRecorder: (options: RecordingRecorderOptions) => Promise<RecordingRecorder>
}

/**
 * AH —— 录制编排:建录制器→执行场景→按墙钟计时长→停录→校验产物非空;
 * 任一阶段中止即抛 AbortError;失败/取消路径 cancel 录制器并删除临时文件。
 * 产物路径 join(tempRoot, 清洗后的 recordingId + ".webm")。
 */
export async function recordBrowserVideo(options: RecordBrowserVideoOptions): Promise<BrowserRecordingArtifact> {
  const recordingId = options.recordingId.replace(/[^A-Za-z0-9._-]/gu, "-")
  const artifactPath = join(options.tempRoot, `${recordingId}.webm`)
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
 * 光标 overlay(录制期间在 guest 页面渲染伪光标)
 * ════════════════════════════════════════════════════════════════════ */

/** 安装 18px #ff4d4f 伪光标(捕获期 mousemove 跟随, 按下 scale(.72), z-index 2147483647) */
export async function installRecordingCursorOverlay(guest: WebContents): Promise<void> {
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

/** 移除伪光标(guest 已销毁时跳过;清理脚本自身异常静默) */
export async function removeRecordingCursorOverlay(guest: WebContents): Promise<void> {
  if (guest.isDestroyed()) return
  await guest.executeJavaScript('window["__zcodeBrowserRecordingCursorCleanup"]?.()').catch(() => {})
}

/* ════════════════════════════════════════════════════════════════════
 * 录制场景动作执行(wait/click/type/waitFor/hover/move/scroll/scrollTo/wheel/drag)
 * ════════════════════════════════════════════════════════════════════ */

export interface ExecuteRecordingActionsOptions {
  view: ControlledView
  actions: RecordingScenarioAction[]
  signal: AbortSignal
  viewport: { width: number; height: number }
  /** A4/A5 命令执行器(jg;坐标 click / 滚轮 scroll 派发) */
  executeCommand: RecordingCommandExecutor
  /** A4 locator 执行器(ca;选择器 click/fill/waitFor 与 evaluate 取点) */
  executeLocator: RecordingLocatorExecutor
}

/** 录制场景顺序执行:动作间可插 delayAfterMs;任一时刻中止即抛 AbortError */
export async function executeRecordingActions(options: ExecuteRecordingActionsOptions): Promise<void> {
  const pointer = { x: options.viewport.width / 2, y: options.viewport.height / 2 }
  for (const action of options.actions) {
    if (options.signal.aborted) throw abortError()
    await executeRecordingAction(options, action, pointer)
    const delayAfterMs = action.delayAfterMs
    if (delayAfterMs && !(await waitForDelay(delayAfterMs, options.signal))) throw abortError()
  }
}

/** 单动作分发(类型齐全即穷尽;drag 走 CDP 原始鼠标序列) */
async function executeRecordingAction(
  options: ExecuteRecordingActionsOptions,
  action: RecordingScenarioAction,
  pointer: { x: number; y: number },
): Promise<void> {
  const { view, signal } = options
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
      const outcome = await options.executeLocator(
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
    await executeRecordingBrowserCommand(options, {
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
      const point = await resolveRecordingSelectorPoint(options, action.selector)
      await moveRecordingPointer(options, point.x, point.y, action.durationMs ?? 0, pointer)
    } else if (typeof action.x === "number" && typeof action.y === "number") {
      await moveRecordingPointer(options, action.x, action.y, action.durationMs ?? 0, pointer)
    } else {
      throw new Error("recording hover requires selector or (x,y)")
    }
    return
  }
  if (action.type === "move") {
    await moveRecordingPointer(options, action.x ?? 0, action.y ?? 0, action.durationMs ?? 0, pointer)
    return
  }
  if (action.type === "scroll") {
    await animateRecordingScroll(options, action.deltaX ?? 0, action.deltaY ?? 0, action.durationMs ?? 0)
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
      ? await resolveRecordingSelectorScrollTarget(options, action.selector)
      : { x: action.x ?? currentX, y: action.y ?? currentY }
    await animateRecordingScroll(options, target.x - currentX, target.y - currentY, action.durationMs ?? 0)
    return
  }
  if (action.type === "wheel") {
    const times = action.times ?? 1
    for (let index = 0; index < times; index += 1) {
      await executeRecordingBrowserCommand(options, {
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

/** 坐标命令执行包装(执行器失败即抛) */
async function executeRecordingBrowserCommand(
  options: ExecuteRecordingActionsOptions,
  command: RecordingActionCommand,
): Promise<void> {
  const result = await options.executeCommand(options.view, command)
  if (!result.ok) throw new Error(result.error?.message ?? `recording action ${command.method} failed`)
}

/** 选择器中心点解析(locator evaluate getBoundingClientRect) */
async function resolveRecordingSelectorPoint(
  options: ExecuteRecordingActionsOptions,
  selector: string,
): Promise<{ x: number; y: number }> {
  const outcome = await options.executeLocator(
    options.view,
    {
      name: "locator",
      selector,
      operation: "evaluate",
      expressionKind: "function",
      expression:
        "(element) => { const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; }",
    },
    3000,
    options.signal,
  )
  if (outcome.kind !== "done" || !isBrowserPointValue(outcome.value)) {
    throw new Error(`recording selector '${selector}' has no visible point`)
  }
  return outcome.value
}

/** 选择器滚动目标解析(页面绝对坐标 = scroll + rect) */
async function resolveRecordingSelectorScrollTarget(
  options: ExecuteRecordingActionsOptions,
  selector: string,
): Promise<{ x: number; y: number }> {
  const outcome = await options.executeLocator(
    options.view,
    {
      name: "locator",
      selector,
      operation: "evaluate",
      expressionKind: "function",
      expression:
        "(element) => { const rect = element.getBoundingClientRect(); return { x: window.scrollX + rect.left, y: window.scrollY + rect.top }; }",
    },
    3000,
    options.signal,
  )
  if (outcome.kind !== "done" || !isBrowserPointValue(outcome.value)) {
    throw new Error(`recording selector '${selector}' has no scroll target`)
  }
  return outcome.value
}

/** 指针插值移动:≤60 步(每步 ≈ durationMs/16ms), 步间可中止 */
async function moveRecordingPointer(
  options: ExecuteRecordingActionsOptions,
  x: number,
  y: number,
  durationMs: number,
  pointer: { x: number; y: number },
): Promise<void> {
  const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)))
  const startX = pointer.x
  const startY = pointer.y
  for (let step = 1; step <= steps; step += 1) {
    if (options.signal.aborted) throw abortError()
    const progress = step / steps
    await options.view.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: startX + (x - startX) * progress,
      y: startY + (y - startY) * progress,
    })
    if (durationMs > 0 && step < steps && !(await waitForDelay(durationMs / steps, options.signal))) {
      throw abortError()
    }
  }
  pointer.x = x
  pointer.y = y
}

/** 滚动插值:≤60 步均分 delta, 经坐标 scroll 命令派发 */
async function animateRecordingScroll(
  options: ExecuteRecordingActionsOptions,
  deltaX: number,
  deltaY: number,
  durationMs: number,
): Promise<void> {
  const steps = Math.max(1, Math.min(60, Math.round(durationMs / 16)))
  for (let step = 0; step < steps; step += 1) {
    await executeRecordingBrowserCommand(options, { method: "scroll", x: deltaX / steps, y: deltaY / steps })
    if (durationMs > 0 && step + 1 < steps && !(await waitForDelay(durationMs / steps, options.signal))) {
      throw abortError()
    }
  }
}
