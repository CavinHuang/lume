/**
 * playwright 引擎装配桥 —— dispatcher.ts 的 PlaywrightActionExecutorPort 具体实现。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js [SECTION] handlePlaywrightAction (TH)
 *       (ZCode 的 TH 直接调用 _H/captureCodexDomSnapshot 与 ca/
 *        executeIabPlaywrightLocator;Lume 侧拆为 PlaywrightActionExecutorPort
 *        端口 + 本装配桥,由 guest-manager 装配层注入 opts.playwright)
 *
 * ZCode 原名对照:
 *   _H → captureCodexDomSnapshot(实现见 dom-snapshot-session.ts)
 *   ca → executeIabPlaywrightLocator(实现见 locator-session.ts)
 *   TH 的 domSnapshot/locator 分支 → createPlaywrightActionExecutor 适配逻辑
 *
 * 语义偏差(已声明项):
 *   - ZCode 的 TH 内联调用改为端口注入;locator 结果 kind 适配(done→ok)在
 *     本桥完成(TH 判定 cancelled/timeout,其余 ok + value)。
 *   - elementInfo 不在本桥:dispatcher 的 handlePlaywrightAction 已内建经
 *     executor/element-info.ts 的 evaluateInPlaywrightIsolatedWorld 执行,
 *     端口契约(PlaywrightActionExecutorPort)亦不含该动作。
 *   - locator 输入原语(ci/Ng/Ug/Zj)复用 executor/dispatcher.ts 的同名实现,
 *     与 ZCode 同一执行引擎内的函数复用等价。
 *   - 共享 zod 协议已在调用方完成校验,locator 分支动作经断言收窄为
 *     LocatorAction(运行期形状由协议保证)。
 */
import type { ControlledView } from "../types"
import {
  assertFocusedInputTarget,
  dispatchClickAt,
  dispatchKey,
  pasteTextIntoFocusedTarget,
  type PlaywrightActionExecution,
  type PlaywrightActionExecutorPort,
  type PlaywrightActionRequest,
} from "./dispatcher"
import { captureCodexDomSnapshot } from "./dom-snapshot-session"
import {
  executeIabPlaywrightLocator,
  type LocatorAction,
  type LocatorInputPorts,
  type LocatorOutcome,
} from "./locator-session"

/** locator 会话的鼠标/键盘/粘贴原语端口(dispatcher.ts 同名原语直接复用)。 */
const LOCATOR_INPUT_PORTS: LocatorInputPorts = {
  assertFocusedInputTarget,
  dispatchClickAt,
  dispatchKey,
  pasteTextIntoFocusedTarget,
}

/** ZCode TH locator 分支的 kind 适配:done→ok,timeout/cancelled 原样透传。 */
function adaptLocatorOutcome(outcome: LocatorOutcome): PlaywrightActionExecution {
  if (outcome.kind === "done") return { kind: "ok", value: outcome.value }
  if (outcome.kind === "cancelled") return { kind: "cancelled" }
  return { kind: "timeout", reason: outcome.reason }
}

/**
 * 装配 PlaywrightActionExecutorPort:domSnapshot 走 PlaywrightDomSnapshotSession
 * (captureCodexDomSnapshot,主帧 3000ms/iframe 总 1000ms/单帧 500ms 预算);
 * locator 走 IabPlaywrightLocatorSession(executeIabPlaywrightLocator,一次性
 * 会话 + finally dispose)。debug 仅透传给 locator 会话的结构化日志端口。
 */
export function createPlaywrightActionExecutor(options?: {
  debug?: (message: string, details?: Record<string, unknown>) => void
}): PlaywrightActionExecutorPort {
  return {
    domSnapshot: (view: ControlledView, signal?: AbortSignal) => captureCodexDomSnapshot(view, signal),
    locator: async (view: ControlledView, action: PlaywrightActionRequest, timeoutMs: number, signal?: AbortSignal) => {
      const outcome = await executeIabPlaywrightLocator(
        view,
        action as unknown as LocatorAction,
        timeoutMs,
        signal,
        LOCATOR_INPUT_PORTS,
        options?.debug,
      )
      return adaptLocatorOutcome(outcome)
    },
  }
}
