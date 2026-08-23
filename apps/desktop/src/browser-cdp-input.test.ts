import { describe, expect, test } from "bun:test"
import {
  dispatchBrowserClick,
  dispatchBrowserKey,
  dispatchBrowserText,
  focusBrowserPoint,
  pointerPath,
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
    expect(sender.calls[1]?.params).toEqual({ x: 10, y: 21, includeUserAgentShadowDOM: false })
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

  test("natural click walks a pointer path before pressing and holds the button briefly", async () => {
    const sender = recorder()
    const sleeps = numberRecorder()

    await dispatchBrowserClick(sender, { x: 400, y: 300 }, 1, { natural: true, from: { x: 40, y: 40 }, sleep: sleeps.step })

    const moves = sender.calls.filter((call) => call.params.type === "mouseMoved")
    const presses = sender.calls.filter((call) => call.params.type === "mousePressed")
    const releases = sender.calls.filter((call) => call.params.type === "mouseReleased")
    expect(moves.length).toBeGreaterThanOrEqual(6)
    expect(presses).toHaveLength(1)
    expect(releases).toHaveLength(1)
    expect(sender.calls.indexOf(presses[0])).toBeGreaterThan(sender.calls.indexOf(moves.at(-1)!))
    expect(presses[0].params.x).toBe(400)
    expect(releases[0].params.y).toBe(300)
    // press→release 之间有驻留，move 帧间也有节奏
    expect(sleeps.values.length).toBe(moves.length + 1)
    expect(sleeps.values.every((value) => value > 0 && value < 600)).toBe(true)
  })

  test("pointer path starts away from the target and lands exactly on it", () => {
    const path = pointerPath({ x: 0, y: 0 }, { x: 600, y: 0 })

    expect(path.points.length).toBeGreaterThanOrEqual(6)
    expect(path.points.at(-1)!.x).toBeCloseTo(600, 0)
    expect(path.points.at(-1)!.y).toBeCloseTo(0, 0)
    expect(path.stepMs).toHaveLength(path.points.length)
    expect(path.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true)
  })

  test("natural text types per-character key events instead of insertText", async () => {
    const sender = recorder()
    const sleeps = numberRecorder()

    await dispatchBrowserText(sender, "hi", { platform: "win32", replace: false, natural: true, sleep: sleeps.step })

    const keyEvents = sender.calls.filter((call) => call.method === "Input.dispatchKeyEvent")
    expect(keyEvents.map((call) => [call.params.type, call.params.text])).toEqual([
      ["keyDown", "h"],
      ["keyUp", undefined],
      ["keyDown", "i"],
      ["keyUp", undefined],
    ])
    expect(sender.calls.some((call) => call.method === "Input.insertText")).toBe(false)
    // 每个字符一个驻留，无停顿插入（2 字符 < 停顿阈值）
    expect(sleeps.values).toHaveLength(2)
    expect(sleeps.values.every((value) => value >= 40 && value <= 160)).toBe(true)
  })

  test("natural fill types faster than natural type", async () => {
    const typeSender = recorder()
    const fillSender = recorder()
    const typeSleeps = numberRecorder()
    const fillSleeps = numberRecorder()
    const text = "speed"

    await dispatchBrowserText(typeSender, text, { platform: "win32", replace: false, natural: true, sleep: typeSleeps.step })
    await dispatchBrowserText(fillSender, text, { platform: "win32", replace: false, natural: true, speed: "fill", sleep: fillSleeps.step })

    const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length
    expect(average(fillSleeps.values)).toBeLessThan(average(typeSleeps.values))
  })

  test("natural replace clears via select-all and backspace, then types per character", async () => {
    const sender = recorder()
    const sleeps = numberRecorder()

    await dispatchBrowserText(sender, "ok", { platform: "win32", replace: true, natural: true, sleep: sleeps.step })

    const keys = sender.calls.filter((call) => call.method === "Input.dispatchKeyEvent").map((call) => [call.params.type, call.params.key])
    expect(keys.slice(0, 6)).toEqual([
      ["rawKeyDown", "Control"],
      ["rawKeyDown", "a"],
      ["keyUp", "a"],
      ["keyUp", "Control"],
      ["rawKeyDown", "Backspace"],
      ["keyUp", "Backspace"],
    ])
    expect(sender.calls.some((call) => call.method === "Input.insertText")).toBe(false)
    expect(keys.filter((entry) => entry[1] === "o" || entry[1] === "k")).toHaveLength(4)
  })

  test("natural key holds the key down briefly between keyDown and keyUp", async () => {
    const sender = recorder()
    const sleeps = numberRecorder()

    await dispatchBrowserKey(sender, "Enter", { natural: true, sleep: sleeps.step })

    expect(sender.calls.map((call) => [call.params.type, call.params.text])).toEqual([
      ["keyDown", "\r"],
      ["keyUp", undefined],
    ])
    expect(sleeps.values).toHaveLength(1)
    expect(sleeps.values[0]).toBeGreaterThanOrEqual(40)
    expect(sleeps.values[0]).toBeLessThanOrEqual(130)
  })
})

function numberRecorder(): { values: number[]; step: (milliseconds: number) => Promise<void> } {
  const values: number[] = []
  return {
    values,
    async step(milliseconds: number) {
      values.push(milliseconds)
    },
  }
}

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
