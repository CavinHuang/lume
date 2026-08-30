/**
 * waitFor 命令分发测试 —— handleWaitFor 路由的端到端(fake ControlledView,无
 * 真实 CDP/Electron):合成 locator 动作(operation:"waitFor")委托 playwright
 * 引擎端口(locator-session waitForState 轮询);timeout/cancelled 适配稳定
 * 错误码,端口缺失 → capability_unsupported。
 *
 * 背景:ZCode 执行器 jg 无顶层 waitFor 分支(Lume 扩展,见 dispatcher.ts 头注);
 * 协议形状与 locator.waitFor 同构 {selector, state?, timeoutMs?}。
 */
import { describe, expect, test } from "bun:test"
import {
  executeBrowserCommandOnView,
  type PlaywrightActionExecution,
  type PlaywrightActionExecutorPort,
  type PlaywrightActionRequest,
} from "../executor/dispatcher"
import type { ControlledView, ControlledWebContents } from "../types"

/** fake 视图:waitFor 全程走注入端口,webContents/CDP 不应被触碰。 */
function fakeView() {
  const webContents: ControlledWebContents = {
    loadURL: async () => {},
    getURL: () => "https://example.com/",
    getTitle: () => "Example",
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => {},
    goForward: () => {},
    reload: () => {},
    executeJavaScript: async () => {
      throw new Error("waitFor must not touch webContents")
    },
  }
  const view: ControlledView = {
    webContents,
    normalizeScreenshotToCssPixels: false,
    cdp: {
      send: async () => {
        throw new Error("waitFor must not touch cdp")
      },
    },
  }
  return view
}

/** fake 端口:返回既定 outcome 并截取 locator 动作与归一后超时。 */
function fakePort(
  outcome: PlaywrightActionExecution,
  captured: { action?: PlaywrightActionRequest; timeoutMs?: number },
): PlaywrightActionExecutorPort {
  return {
    domSnapshot: async () => {
      throw new Error("waitFor must not touch domSnapshot")
    },
    locator: async (_view, action, timeoutMs) => {
      captured.action = action
      captured.timeoutMs = timeoutMs
      return outcome
    },
  }
}

describe("waitFor 命令分发(handleWaitFor)", () => {
  test("路由到 playwright 端口:合成 locator waitFor 动作(state/timeoutMs 透传)", async () => {
    const captured: { action?: PlaywrightActionRequest; timeoutMs?: number } = {}
    const result = await executeBrowserCommandOnView(fakeView(), {
      method: "waitFor",
      params: { selector: "css=#done", state: "hidden", timeoutMs: 1500 },
    }, { playwright: fakePort({ kind: "ok" }, captured) })
    expect(result.ok).toBe(true)
    expect(result.elapsedMs).toBeNumber()
    expect(captured.action).toEqual({
      name: "locator",
      selector: "css=#done",
      operation: "waitFor",
      state: "hidden",
      timeoutMs: 1500,
    })
    expect(captured.timeoutMs).toBe(1500)
  })

  test("state/timeoutMs 缺省:动作不带 state,超时归一 3000ms(locator 面同款)", async () => {
    const captured: { action?: PlaywrightActionRequest; timeoutMs?: number } = {}
    const result = await executeBrowserCommandOnView(fakeView(), {
      method: "waitFor",
      params: { selector: "text=ready" },
    }, { playwright: fakePort({ kind: "ok" }, captured) })
    expect(result.ok).toBe(true)
    expect(captured.action).toEqual({ name: "locator", selector: "text=ready", operation: "waitFor" })
    expect(captured.timeoutMs).toBe(3000)
  })

  test("超时:timeout 错误码 + locator 超时文案(reason 透传)", async () => {
    const result = await executeBrowserCommandOnView(fakeView(), {
      method: "waitFor",
      params: { selector: "css=#slow" },
    }, { playwright: fakePort({ kind: "timeout", reason: "css=#slow to be visible" }, {}) })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("timeout")
    expect(result.error?.message).toContain("css=#slow to be visible")
    expect(result.error?.message).toContain("Do not retry the same locator")
  })

  test("取消:cancelled 错误码", async () => {
    const result = await executeBrowserCommandOnView(fakeView(), {
      method: "waitFor",
      params: { selector: "css=#x" },
    }, { playwright: fakePort({ kind: "cancelled" }, {}) })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("cancelled")
  })

  test("playwright 端口未装配:capability_unsupported", async () => {
    const result = await executeBrowserCommandOnView(fakeView(), {
      method: "waitFor",
      params: { selector: "css=#x" },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("capability_unsupported")
  })
})
