import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { browserLocatorScript, type BrowserLocatorQuery } from "./browser-locator"
import type { BrowserLocator } from '@lume/shared'

describe("browser locator semantics", () => {
  test("resolves textbox names from aria-labelledby, label, title and placeholder", () => {
    const window = new Window()
    window.document.body.innerHTML = `
      <span id="aria-name">ARIA search</span><input id="by-aria" aria-labelledby="aria-name">
      <label for="by-label">Label search</label><input id="by-label">
      <input id="by-title" title="Title search">
      <input id="by-placeholder" placeholder="Placeholder search">
    `
    const query = browserQuery(window)

    for (const expected of ["ARIA search", "Label search", "Title search", "Placeholder search"]) {
      expect(query(roleTextbox(expected), "count")).toBe(1)
    }
  })

  test("accepts an associated label covering the input hit point", () => {
    const window = new Window()
    window.document.body.innerHTML = '<label for="kw">搜索</label><input id="kw" title="搜索">'
    const input = window.document.querySelector("#kw") as unknown as HTMLInputElement
    const label = window.document.querySelector("label") as unknown as HTMLLabelElement
    input.getBoundingClientRect = () => rect(10, 20, 200, 40)
    Object.defineProperty(window.document, "elementFromPoint", { value: () => label })

    const target = browserQuery(window)(roleTextbox("搜索"), "target") as { x: number; y: number; editable: boolean }

    expect(target).toMatchObject({ x: 110, y: 40, editable: true })
  })

  test("maps submit inputs to the button role and value name", () => {
    const window = new Window()
    window.document.body.innerHTML = '<input type="submit" value="百度一下">'

    expect(browserQuery(window)({ version: 1, steps: [{ kind: "role", role: "button", name: "百度一下", exact: true }] }, "count")).toBe(1)
  })

  test("reports distinct stable codes for invisible, disabled, occluded, and readonly targets", () => {
    const hidden = new Window()
    hidden.document.body.innerHTML = '<input id="kw" title="搜索" style="display:none">'
    expect(() => browserQuery(hidden)(roleTextbox("搜索"), "target")).toThrow("element_not_visible")

    const disabled = new Window()
    disabled.document.body.innerHTML = '<button disabled>提交</button>'
    const disabledButton = disabled.document.querySelector("button") as unknown as HTMLButtonElement
    disabledButton.getBoundingClientRect = () => rect(10, 20, 120, 36)
    expect(() => browserQuery(disabled)({ version: 1, steps: [{ kind: "role", role: "button", name: "提交", exact: true }] }, "target")).toThrow("element_disabled")

    const occluded = new Window()
    occluded.document.body.innerHTML = '<input id="kw" title="搜索"><div id="cover" style="position:absolute;width:400px;height:60px"></div>'
    const coveredInput = occluded.document.querySelector("#kw") as unknown as HTMLInputElement
    coveredInput.getBoundingClientRect = () => rect(10, 20, 200, 40)
    Object.defineProperty(occluded.document, "elementFromPoint", { value: () => occluded.document.querySelector("#cover") })
    expect(() => browserQuery(occluded)(roleTextbox("搜索"), "target")).toThrow("element_occluded")

    const readonly = new Window()
    readonly.document.body.innerHTML = '<label for="kw">搜索</label><input id="kw" readonly>'
    const input = readonly.document.querySelector("#kw") as unknown as HTMLInputElement
    input.getBoundingClientRect = () => rect(10, 20, 200, 40)
    Object.defineProperty(readonly.document, "elementFromPoint", { value: () => input })
    const target = browserQuery(readonly)(roleTextbox("搜索"), "target") as { readOnly?: boolean; editable: boolean }

    expect(target).toMatchObject({ readOnly: true, editable: false })
  })
})

function browserQuery(window: Window): (locator: BrowserLocator, operation?: BrowserLocatorQuery, argument?: string) => unknown {
  const names = [
    "document", "innerHeight", "innerWidth", "getComputedStyle", "Element", "HTMLElement", "Document",
    "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "HTMLLabelElement", "HTMLButtonElement",
    "HTMLAnchorElement", "InputEvent", "Event", "MouseEvent", "KeyboardEvent",
  ]
  const values = [
    window.document, window.innerHeight, window.innerWidth, window.getComputedStyle.bind(window), window.Element, window.HTMLElement, window.Document,
    window.HTMLInputElement, window.HTMLTextAreaElement, window.HTMLSelectElement, window.HTMLLabelElement, window.HTMLButtonElement,
    window.HTMLAnchorElement, window.InputEvent, window.Event, window.MouseEvent, window.KeyboardEvent,
  ]
  return Function(...names, `return ${browserLocatorScript()}`)(...values) as (locator: BrowserLocator, operation?: BrowserLocatorQuery, argument?: string) => unknown
}

function roleTextbox(name: string): BrowserLocator {
  return { version: 1, steps: [{ kind: "role", role: "textbox", name, exact: true }] }
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, right: x + width, bottom: y + height, left: x, toJSON: () => ({}) } as DOMRect
}
