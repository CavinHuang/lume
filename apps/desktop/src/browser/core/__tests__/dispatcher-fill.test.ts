/**
 * fill 命令分发测试 —— handleFill 路由的端到端(fake ControlledView,无真实
 * CDP/Electron):ref 点击聚焦 → Fj 虚拟剪贴板粘贴管线以 replaceInputValue:true
 * 替换投递;ref 缺失返回 ref_not_found。
 *
 * 背景:ZCode 执行器 jg 无 fill 分支(Lume 扩展,见 dispatcher.ts 头注);
 * 语义取自 02 源码 locator perform 的 fill 操作(replace !== false → 替换)。
 */
import { describe, expect, test } from "bun:test"
import { executeBrowserCommandOnView } from "../executor/dispatcher"
import type { ControlledView, ControlledWebContents } from "../types"

/** fake 视图:ref 解析/CDP Input/CDP Runtime.evaluate 全内存桩,截取粘贴载荷。 */
function fakeView(options: { refCenter?: { cx: number; cy: number } | null } = {}) {
  const clickEvents: Array<Record<string, unknown>> = []
  let pastePayload: Record<string, unknown> | undefined
  const webContents: ControlledWebContents = {
    loadURL: async () => {},
    getURL: () => "https://example.com/",
    getTitle: () => "Example",
    canGoBack: () => false,
    canGoForward: () => false,
    goBack: () => {},
    goForward: () => {},
    reload: () => {},
    async executeJavaScript(code) {
      if (code.includes("__zcodeRefs")) return options.refCenter ?? null
      throw new Error(`unexpected executeJavaScript: ${code.slice(0, 60)}`)
    },
  }
  const view: ControlledView = {
    webContents,
    normalizeScreenshotToCssPixels: false,
    cdp: {
      async send(method, params) {
        if (method === "Input.dispatchMouseEvent") {
          clickEvents.push(params ?? {})
          return {}
        }
        if (method === "Runtime.evaluate") {
          const expression = String((params as { expression?: string }).expression ?? "")
          // Sde 聚焦帧探针(returnByValue:false):无 objectId → 根目标直返。
          if (expression.includes("focusedFrameElementInRoot")) return { result: {} }
          // Fj 粘贴管线包装:截取 payload(载荷 JSON 不含右括号,非贪婪截取安全)。
          const match = expression.match(/pageFunction\((\{.*?\})\)/s)
          if (match) pastePayload = JSON.parse(match[1]!) as Record<string, unknown>
          return { result: { value: { ok: true, data: {} } } }
        }
        return {}
      },
    },
  }
  return { view, clickEvents, pastePayload: () => pastePayload }
}

describe("fill 命令分发(handleFill)", () => {
  test("带 ref:点击聚焦 → Fj 粘贴管线以替换语义投递文本", async () => {
    const { view, clickEvents, pastePayload } = fakeView({ refCenter: { cx: 10, cy: 20 } })
    const result = await executeBrowserCommandOnView(view, {
      method: "fill",
      params: { ref: "e3", text: "hello" },
    })
    expect(result.ok).toBe(true)
    expect(result.elapsedMs).toBeNumber()
    expect(result.state).toEqual({ url: "https://example.com/", title: "Example", canGoBack: false, canGoForward: false })
    // ci/dispatchClickAt:mouseMoved → mousePressed → mouseReleased(单击,左键)。
    expect(clickEvents.map((event) => event.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"])
    expect(clickEvents[0]).toMatchObject({ x: 10, y: 20 })
    expect(clickEvents[1]).toMatchObject({ button: "left", clickCount: 1 })
    // replace !== false 协议缺省:fill 恒替换(replaceInputValue:true),无 token。
    const payload = pastePayload()
    expect(payload).toBeDefined()
    expect(payload?.replaceInputValue).toBe(true)
    expect(payload?.inputTargetToken).toBeUndefined()
    expect((payload?.clipboardItems as Array<{ entries: Array<{ mime_type: string; text: string }> }>)[0]?.entries[0])
      .toEqual({ mime_type: "text/plain", text: "hello" })
  })

  test("无 ref:聚焦元素直投替换粘贴", async () => {
    const { view, clickEvents, pastePayload } = fakeView()
    const result = await executeBrowserCommandOnView(view, {
      method: "fill",
      params: { text: "typed" },
    })
    expect(result.ok).toBe(true)
    expect(clickEvents).toEqual([])
    expect(pastePayload()?.replaceInputValue).toBe(true)
  })

  test("ref 解析失败:ref_not_found,不进入粘贴管线", async () => {
    const { view, clickEvents, pastePayload } = fakeView({ refCenter: null })
    const result = await executeBrowserCommandOnView(view, {
      method: "fill",
      params: { ref: "e404", text: "hello" },
    })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("ref_not_found")
    expect(result.error?.message).toContain("e404")
    expect(clickEvents).toEqual([])
    expect(pastePayload()).toBeUndefined()
  })
})
