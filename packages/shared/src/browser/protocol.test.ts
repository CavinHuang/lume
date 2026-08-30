/**
 * 浏览器协议包单测:命令 zod 解析 / 视口边界 / 能力矩阵 / 错误码语义。
 * 运行:`cd packages/shared && bun test ./browser`
 */
import { describe, expect, test } from "bun:test"

import {
  BROWSER_CAPABILITIES,
  BROWSER_API_SUPPORT_MATRIX,
  BROWSER_PARTITION,
  BROWSER_PROTOCOL_VERSION,
  BROWSER_PROTOCOL_VERSION_MAX,
  BROWSER_PROTOCOL_VERSION_MIN,
  BROWSER_RECORDING_MAX_DURATION_MS,
  BROWSER_RESTORE_URL,
  BROWSER_VIEW_IPC_CHANNELS,
  browserErrorPayload,
  browserExecuteRequestSchema,
  browserCommandSchema,
  browserRecordingOptionsSchema,
  browserResultMetaSchema,
  browserViewportSchema,
  cancellationSideEffect,
  hasBrowserCapabilities,
  isBrowserErrorCode,
  isSideEffectingCommand,
  resolveBrowserApiSupport,
  type BrowserCommandContext,
} from "./index"

/* ── 测试夹具 ── */

function context(overrides: Partial<BrowserCommandContext> = {}): BrowserCommandContext {
  return {
    requestId: "req-1",
    sessionId: "sess-1",
    workspaceKey: "ws-1",
    browserId: "iab:abc",
    browserGeneration: 1,
    clientMode: "desktop-continuous",
    ...overrides,
  }
}

/* ── constants ── */

describe("constants", () => {
  test("协议版本固定为 1(新协议新起点)", () => {
    expect(BROWSER_PROTOCOL_VERSION).toBe(1)
    expect(BROWSER_PROTOCOL_VERSION_MIN).toBe(1)
    expect(BROWSER_PROTOCOL_VERSION_MAX).toBe(1)
  })

  test("分区与恢复协议按 Lume 前缀替换", () => {
    expect(BROWSER_PARTITION).toBe("persist:lume-browser")
    expect(BROWSER_RESTORE_URL).toBe("lume-browser-restore://pending")
  })

  test("事件频道名表覆盖 ZCode BrowserView* 全量", () => {
    expect(BROWSER_VIEW_IPC_CHANNELS.ready).toBe("lume:browser-view-ready")
    expect(BROWSER_VIEW_IPC_CHANNELS.screenshotSurfacePrepare).toBe(
      "lume:browser-view-screenshot-surface-prepare",
    )
    expect(BROWSER_VIEW_IPC_CHANNELS.screenshotSurfaceReady).toBe(
      "lume:browser-view-screenshot-surface-ready",
    )
    expect(BROWSER_VIEW_IPC_CHANNELS.attachGuest).toBe("lume:browser-view-attach-guest")
    expect(BROWSER_VIEW_IPC_CHANNELS.restoreTabs).toBe("lume:browser-view-restore-tabs")
    expect(BROWSER_VIEW_IPC_CHANNELS.embeddedBrowserJavaScriptDialog).toBe(
      "lume:embedded-browser-javascript-dialog",
    )
  })
})

/* ── protocol:命令解析 ── */

describe("protocol:命令解析", () => {
  test("navigate(上下文 + 平铺命令)", () => {
    const request = browserExecuteRequestSchema.parse({
      context: context(),
      command: { method: "navigate", url: "https://example.com" },
    })
    expect(request.command.method).toBe("navigate")
    expect(request.context.browserId).toBe("iab:abc")
  })

  test("click:ref 定位(带 button/modifiers)", () => {
    const command = browserCommandSchema.parse({
      method: "click",
      tabId: "iab-tab:1",
      ref: "e12",
      button: "right",
      doubleClick: true,
      modifiers: ["ControlOrMeta", "Shift"],
    })
    expect(command).toMatchObject({ method: "click", ref: "e12", doubleClick: true })
  })

  test("click:坐标定位与 tabId 缺省均可解析(ref/x,y 的二选一由执行器裁决)", () => {
    expect(browserCommandSchema.parse({ method: "click", x: 10, y: 20 })).toMatchObject({ method: "click" })
  })

  test("playwright.locator(click 操作全字段)", () => {
    const command = browserCommandSchema.parse({
      method: "playwright",
      action: {
        name: "locator",
        selector: "role=button[name=\"Submit\"]",
        operation: "click",
        timeoutMs: 5000,
        force: true,
        button: "left",
        modifiers: ["Alt"],
      },
    })
    if (command.method !== "playwright") throw new Error("expected playwright command")
    expect(command.action.name).toBe("locator")
    if (command.action.name !== "locator") throw new Error("expected locator action")
    expect(command.action.operation).toBe("click")
  })

  test("playwright.evaluate(function 形态,arg 透传)", () => {
    const command = browserCommandSchema.parse({
      method: "playwright",
      tabId: "iab-tab:1",
      action: {
        name: "evaluate",
        expression: "(element, arg) => element.textContent + arg.suffix",
        expressionKind: "function",
        arg: { suffix: "!" },
      },
    })
    if (command.method !== "playwright") throw new Error("expected playwright command")
    expect(command.action.name).toBe("evaluate")
  })

  test("recordingStart:options + 数据化动作 DSL(wait/click/wheel/drag)", () => {
    const options = browserRecordingOptionsSchema.parse({
      viewport: { width: 1280, height: 720 },
      fps: 25,
      maxDurationMs: 60_000,
      settleMs: 300,
      showCursor: true,
      actions: [
        { type: "wait", durationMs: 500 },
        { type: "click", selector: "#go", doubleClick: false, delayAfterMs: 100 },
        { type: "wheel", deltaY: 240, times: 3, intervalMs: 50 },
        { type: "drag", path: [{ x: 0, y: 0 }, { x: 40, y: 40 }, { x: 80, y: 80 }], durationMs: 300 },
      ],
    })
    expect(options.actions).toHaveLength(4)
  })

  test("recordingStart:maxDurationMs ≤ 90000,超限拒绝", () => {
    expect(browserRecordingOptionsSchema.safeParse({ maxDurationMs: BROWSER_RECORDING_MAX_DURATION_MS }).success).toBe(true)
    expect(browserRecordingOptionsSchema.safeParse({ maxDurationMs: BROWSER_RECORDING_MAX_DURATION_MS + 1 }).success).toBe(false)
  })

  test("结果 meta(withMeta 形状)", () => {
    const meta = browserResultMetaSchema.parse({
      browserUse: true,
      backendType: "iab",
      browserId: "iab:abc",
      browserGeneration: 3,
      openTabIds: ["iab-tab:1", "iab-tab:2"],
      tabId: "iab-tab:1",
      currentUrl: "https://example.com/",
      lifecycle: "active",
    })
    expect(meta.openTabIds).toHaveLength(2)
  })
})

/* ── protocol:视口边界 ── */

describe("protocol:视口 320~3840×320~2160 校验", () => {
  test("边界值可用(含 browserViewportSet 平铺字段)", () => {
    expect(browserViewportSchema.parse({ width: 320, height: 320 })).toEqual({ width: 320, height: 320 })
    expect(browserViewportSchema.parse({ width: 3840, height: 2160 })).toEqual({ width: 3840, height: 2160 })
    const command = browserCommandSchema.parse({ method: "browserViewportSet", width: 1280, height: 720 })
    expect(command).toMatchObject({ method: "browserViewportSet", width: 1280, height: 720 })
  })

  test.each([
    { width: 319, height: 720, label: "width 低于下限" },
    { width: 3841, height: 720, label: "width 超上限" },
    { width: 1280, height: 319, label: "height 低于下限" },
    { width: 1280, height: 2161, label: "height 超上限" },
    { width: 1279.5, height: 720, label: "非整数" },
  ])("拒绝:$label", ({ width, height }) => {
    expect(browserViewportSchema.safeParse({ width, height }).success).toBe(false)
    expect(
      browserCommandSchema.safeParse({ method: "browserViewportSet", width, height }).success,
    ).toBe(false)
  })
})

/* ── protocol:命令面冻结 ── */

describe("protocol:命令面冻结", () => {
  test("method 全集与 ZCode 共享枚举一致(架构文档 §46 命令枚举)", () => {
    const methods = browserCommandSchema.options.map((option) => option.shape.method.value).sort()
    expect(methods).toEqual(
      [
        "navigate",
        "back",
        "forward",
        "reload",
        "getState",
        "snapshot",
        "screenshot",
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
        "elementInfo",
        "evaluate",
        "waitFor",
        "getDialog",
        "handleDialog",
        "playwright",
        "playwrightWaitForTimeout",
        "capabilities",
        "browserVisibilityGet",
        "browserVisibilitySet",
        "browserViewportSet",
        "browserViewportReset",
        "recordingStart",
        "recordingStatus",
        "recordingCancel",
        "activateTab",
        "newTab",
        "claimTab",
        "list",
        "listUserTabs",
        "nameSession",
        "finalize",
        "finalizeTabs",
        "markDeliverable",
        "markHandoff",
        "close",
        "cancelRequest",
        "turnEnded",
        "closeSession",
      ].sort(),
    )
  })

  test("未知 method 与平铺多余键拒绝(strict)", () => {
    expect(browserCommandSchema.safeParse({ method: "fileUpload" }).success).toBe(false)
    expect(
      browserCommandSchema.safeParse({ method: "getState", unknownKey: true }).success,
    ).toBe(false)
    expect(
      browserExecuteRequestSchema.safeParse({ context: context({ extra: true }), command: { method: "list" } })
        .success,
    ).toBe(false)
  })
})

/* ── errors:稳定错误码 + sideEffect ── */

describe("errors", () => {
  test("稳定错误码判定", () => {
    expect(isBrowserErrorCode("timeout")).toBe(true)
    expect(isBrowserErrorCode("backend_unavailable")).toBe(true)
    expect(isBrowserErrorCode("browser_internal_error")).toBe(false)
  })

  test("副作用命令分类(_M)", () => {
    expect(isSideEffectingCommand({ method: "navigate" })).toBe(true)
    expect(isSideEffectingCommand({ method: "snapshot" })).toBe(false)
    expect(isSideEffectingCommand({ method: "getState" })).toBe(false)
    expect(isSideEffectingCommand({ method: "newTab" })).toBe(true)
    expect(isSideEffectingCommand({ method: "playwright", action: { name: "locator", operation: "click" } })).toBe(true)
    expect(isSideEffectingCommand({ method: "playwright", action: { name: "locator", operation: "textContent" } })).toBe(false)
    expect(isSideEffectingCommand({ method: "playwright", action: { name: "evaluate" } })).toBe(true)
  })

  test("取消结果 sideEffect 标注(派发后才取消 → uncertain)", () => {
    expect(cancellationSideEffect({ method: "navigate" }, true)).toBe("uncertain")
    expect(cancellationSideEffect({ method: "navigate" }, false)).toBe("none")
    expect(cancellationSideEffect({ method: "snapshot" }, true)).toBe("none")
  })

  test("错误负载构造(sideEffect 可选)", () => {
    expect(browserErrorPayload("timeout", "boom")).toEqual({ code: "timeout", message: "boom" })
    expect(browserErrorPayload("cancelled", "boom", "uncertain")).toEqual({
      code: "cancelled",
      message: "boom",
      sideEffect: "uncertain",
    })
  })
})

/* ── capabilities ── */

describe("capabilities", () => {
  test("唯一 capability 描述符 visibility", () => {
    expect(BROWSER_CAPABILITIES).toHaveLength(1)
    expect(BROWSER_CAPABILITIES[0]?.name).toBe("visibility")
  })

  test("claimTab/finalize/markDeliverable/markHandoff:iab 强制开,cdp 默认禁用", () => {
    expect(resolveBrowserApiSupport("browser.user.claimTab", "iab")).toBe(true)
    expect(resolveBrowserApiSupport("browser.user.claimTab", "cdp")).toBe(false)
    expect(resolveBrowserApiSupport("tab.finalize", "iab")).toBe(true)
    expect(resolveBrowserApiSupport("tab.finalize", "cdp")).toBe(false)
    expect(resolveBrowserApiSupport("tab.markDeliverable", "iab")).toBe(true)
    expect(resolveBrowserApiSupport("tab.markHandoff", "cdp")).toBe(false)
  })

  test("recording.* 通配 override 对 iab 生效", () => {
    expect(resolveBrowserApiSupport("tab.recording.start", "iab")).toBe(true)
    expect(resolveBrowserApiSupport("tab.recording.status", "iab")).toBe(true)
    expect(resolveBrowserApiSupport("tab.recording.cancel", "iab")).toBe(true)
    expect(resolveBrowserApiSupport("tab.recording.start", "cdp")).toBe(false)
  })

  test("未声明成员默认可用;文件上传对 iab/cdp 均禁用", () => {
    expect(resolveBrowserApiSupport("tab.playwright.domSnapshot", "iab")).toBe(true)
    expect(resolveBrowserApiSupport("tab.cua.click", "cdp")).toBe(true)
    expect(resolveBrowserApiSupport("tab.playwright.fileChooserSetFiles", "iab")).toBe(false)
    expect(resolveBrowserApiSupport("tab.playwright.fileChooserSetFiles", "cdp")).toBe(false)
    expect(
      BROWSER_API_SUPPORT_MATRIX.some((entry) => entry.api === "tab.playwright.waitForFileChooser"),
    ).toBe(true)
  })

  test("requiresCapabilities 核对", () => {
    expect(hasBrowserCapabilities(undefined, [])).toBe(true)
    expect(hasBrowserCapabilities(["visibility"], ["visibility"])).toBe(true)
    expect(hasBrowserCapabilities(["visibility"], [])).toBe(false)
  })
})
