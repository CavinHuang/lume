import { describe, expect, test } from "bun:test"
import { Window } from "happy-dom"
import { browserLocatorScript, type BrowserLocatorQuery } from "./browser-locator"
import type { BrowserLocator } from "../../../packages/shared/src/types/browser-runtime"

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
