import { describe, expect, test } from "bun:test"
import {
  dispatchBrowserClick,
  dispatchBrowserKey,
  dispatchBrowserText,
  focusBrowserPoint,
  type BrowserCdpCommandSender,
} from "./browser-cdp-input"

describe("browser CDP input", () => {
  test("dispatches a complete real mouse click sequence", async () => {
    const sender = recorder()

    await dispatchBrowserClick(sender, { x: 12, y: 34 })

    expect(sender.calls.map((call) => [call.method, call.params.type, call.params.clickCount])).toEqual([
      ["Input.dispatchMouseEvent", "mouseMoved", undefined],
      ["Input.dispatchMouseEvent", "mousePressed", 1],
      ["Input.dispatchMouseEvent", "mouseReleased", 1],
    ])
  })

  test("replaces text with select-all, backspace and insertText", async () => {
    const sender = recorder()

    await dispatchBrowserText(sender, "Lume", { platform: "win32", replace: true })

    expect(sender.calls.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => [call.params.type, call.params.key])).toEqual([
      ["rawKeyDown", "Control"],
      ["rawKeyDown", "a"],
      ["keyUp", "a"],
      ["keyUp", "Control"],
      ["rawKeyDown", "Backspace"],
      ["keyUp", "Backspace"],
    ])
    expect(sender.calls.at(-1)).toEqual({ method: "Input.insertText", params: { text: "Lume" } })
  })

  test("dispatches modifier key lifecycles around the main key", async () => {
    const sender = recorder()

    await dispatchBrowserKey(sender, "Control+Shift+P")

    expect(sender.calls.map((call) => [call.params.type, call.params.key, call.params.modifiers])).toEqual([
      ["rawKeyDown", "Control", 2],
      ["rawKeyDown", "Shift", 10],
      ["rawKeyDown", "P", 10],
      ["keyUp", "P", 10],
      ["keyUp", "Shift", 2],
      ["keyUp", "Control", 0],
    ])
  })

  test("dispatches Enter as a native text-producing key event", async () => {
    const sender = recorder()

    await dispatchBrowserKey(sender, "Enter")

    expect(sender.calls.map((call) => [call.params.type, call.params.key, call.params.text])).toEqual([
      ["keyDown", "Enter", "\r"],
      ["keyUp", "Enter", undefined],
    ])
  })

  test("focuses the deepest DOM node at a page coordinate", async () => {
    const sender = recorder({ backendNodeId: 42 })

    await focusBrowserPoint(sender, { x: 10.2, y: 20.7 })

    expect(sender.calls.map((call) => call.method)).toEqual([
      "DOM.enable",
      "DOM.getNodeForLocation",
      "DOM.focus",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ])
    expect(sender.calls[1]?.params).toEqual({ x: 10, y: 21, includeUserAgentShadowDOM: true })
    expect(sender.calls[2]?.params).toEqual({ backendNodeId: 42 })
    expect(sender.calls[5]?.params).toEqual({ objectId: "object-1" })
  })

  test("focuses the associated control when the physical hit node is a label", async () => {
    const sender = recorder({ backendNodeId: 42 }, true)

    await focusBrowserPoint(sender, { x: 10, y: 20 })

    expect(sender.calls.map((call) => call.method)).toEqual([
      "DOM.enable",
      "DOM.getNodeForLocation",
      "DOM.focus",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      "Runtime.releaseObject",
    ])
    expect(sender.calls.find((call) => call.method === "Runtime.callFunctionOn")?.params.functionDeclaration).toContain("label?.control")
  })
})

function recorder(result: unknown = {}, failFocus = false): BrowserCdpCommandSender & { calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  return {
    calls,
    async sendCommand(method, params = {}) {
      calls.push({ method, params })
      if (method === "DOM.getNodeForLocation") return result
      if (method === "DOM.focus" && failFocus) throw new Error("Element is not focusable")
      if (method === "DOM.resolveNode") return { object: { objectId: "object-1" } }
      if (method === "Runtime.callFunctionOn") return { result: { value: true } }
      return {}
    },
  }
}
