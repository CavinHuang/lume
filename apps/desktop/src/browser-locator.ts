import type { BrowserLocator, BrowserLocatorStep, BrowserTextMatcher } from "../../../packages/shared/src/types/browser-runtime"

export type ResolvedBrowserTarget = { x: number; y: number; width: number; height: number; tagName: string; role?: string; editable: boolean; enabled: boolean }
export type BrowserLocatorQuery = "target" | "count" | "allTextContents" | "readAll" | "getAttribute" | "innerText" | "textContent" | "inputValue" | "isVisible" | "isEnabled" | "isChecked"

export function isBrowserLocator(value: unknown): value is BrowserLocator {
  return Boolean(value) && typeof value === "object" && Array.isArray((value as { steps?: unknown }).steps)
}

export function validateBrowserLocator(locator: BrowserLocator): void {
  validateBrowserLocatorDepth(locator, 0)
}

function validateBrowserLocatorDepth(locator: BrowserLocator, depth: number): void {
  if (depth > 8) throw new Error("invalid_browser_request")
  if (locator.version !== undefined && locator.version !== 1) throw new Error("invalid_browser_request")
  if (locator.steps.length === 0 || locator.steps.length > 32) throw new Error("invalid_browser_request")
  const supported = new Set(["role", "text", "label", "placeholder", "testId", "css", "locator", "nth", "first", "last", "filter", "and", "or"])
  for (const step of locator.steps) {
    if (!step || typeof step !== "object" || typeof (step as BrowserLocatorStep).kind !== "string") throw new Error("invalid_browser_request")
    const kind = (step as BrowserLocatorStep).kind
    if (!supported.has(kind)) throw new Error("invalid_browser_request")
    if (["css", "locator"].includes(kind) && (!('selector' in step) || typeof step.selector !== "string" || step.selector.length > 4096)) throw new Error("invalid_browser_request")
    if (kind === "nth") {
      const index = (step as { index?: unknown }).index
      if (!Number.isInteger(index) || (index as number) < 0 || (index as number) > 10000) throw new Error("invalid_browser_request")
    }
    if (kind === "and" || kind === "or") {
      const nested = (step as { locator?: unknown }).locator
      if (!isBrowserLocator(nested)) throw new Error("invalid_browser_request")
      validateBrowserLocatorDepth(nested, depth + 1)
    }
    for (const value of Object.values(step)) {
      if (typeof value === "string" && value.length > 4096) throw new Error("invalid_browser_request")
      if (value && typeof value === "object" && "mode" in value && (value as { mode?: unknown }).mode === "regex") throw new Error("invalid_browser_request")
    }
  }
}

export function browserLocatorScript(): string {
  return `(${queryLocatorInPage.toString()})`
}

function queryLocatorInPage(locator: BrowserLocator, operation: BrowserLocatorQuery = "target", argument?: string): unknown {
  const matcher = (value: string, expected: BrowserTextMatcher, exact = false) => {
    const item = typeof expected === "string" ? { value: expected, mode: exact ? "exact" : "contains" } : expected
    if (item.mode === "regex") { try { return new RegExp(item.value).test(value) } catch { return false } }
    return item.mode === "exact" ? value === item.value : value.includes(item.value)
  }
  const role = (element: Element) => element.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: (element as HTMLInputElement).type === "checkbox" ? "checkbox" : "textbox", TEXTAREA: "textbox", SELECT: "combobox" } as Record<string, string>)[element.tagName] || "generic"
  const name = (element: Element) => element.getAttribute("aria-label") || (element as HTMLElement).innerText || element.textContent || ""
  const visible = (element: Element) => { const rect = (element as HTMLElement).getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" }
  const enabled = (element: Element) => !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true"
  const all = (scope: Element | Document, selector = "*") => Array.from(scope.querySelectorAll(selector))
  const resolve = (ast: BrowserLocator, scope: Element | Document = document): Element[] => {
    let current: Element[] = [scope instanceof Document ? document.documentElement : scope]
    for (const step of ast.steps) {
      if (step.kind === "nth" || step.kind === "first" || step.kind === "last") { current = step.kind === "nth" ? (current[step.index] ? [current[step.index]] : []) : step.kind === "first" ? current.slice(0, 1) : current.slice(-1); continue }
      if (step.kind === "and" || step.kind === "or") { const nested = resolve(step.locator, scope); current = step.kind === "and" ? current.filter((element) => nested.includes(element)) : Array.from(new Set([...current, ...nested])); continue }
      const candidates = current.flatMap((element) => all(element, step.kind === "css" || step.kind === "locator" ? step.selector : "*"))
      if (step.kind === "css" || step.kind === "locator") current = candidates
      else if (step.kind === "role") current = candidates.filter((element) => role(element) === step.role && (!step.name || matcher(name(element), step.name, step.exact)))
      else if (step.kind === "text") current = candidates.filter((element) => matcher((element as HTMLElement).innerText || element.textContent || "", step.text, step.exact))
      else if (step.kind === "label") current = candidates.filter((element) => matcher((element as HTMLLabelElement).innerText || element.textContent || "", step.text, step.exact)).flatMap((element) => { const target = element.getAttribute("for"); return target ? [document.getElementById(target)].filter(Boolean) as Element[] : [element.querySelector("input,textarea,select")].filter(Boolean) as Element[] })
      else if (step.kind === "placeholder") current = candidates.filter((element) => matcher(element.getAttribute("placeholder") || "", step.text, step.exact))
      else if (step.kind === "testId") current = candidates.filter((element) => element.getAttribute("data-testid") === step.testId)
      else if (step.kind === "filter") current = current.filter((element) => (!step.hasText || matcher((element as HTMLElement).innerText || element.textContent || "", step.hasText)) && (!step.hasNotText || !matcher((element as HTMLElement).innerText || element.textContent || "", step.hasNotText)))
    }
    return current
  }
  const elements = resolve(locator)
  if (operation === "count") return elements.length
  if (operation === "allTextContents") return elements.slice(0, 1000).map((element) => element.textContent || "")
  if (operation === "readAll") return elements.slice(0, 500).map((element) => ({
    tagName: element.tagName.toLowerCase(),
    role: role(element),
    text: ((element as HTMLElement).innerText || element.textContent || "").slice(0, 10_000),
    ariaLabel: element.getAttribute("aria-label"),
    value: "value" in element ? String((element as HTMLInputElement).value).slice(0, 100_000) : undefined,
    checked: "checked" in element ? Boolean((element as HTMLInputElement).checked) : undefined,
    disabled: !enabled(element),
    visible: visible(element),
  }))
  if (elements.length !== 1) throw new Error(elements.length === 0 ? "stale_target" : "strict_locator_violation")
  const element = elements[0]
  if (operation === "getAttribute") return element.getAttribute(argument || "")
  if (operation === "innerText") return (element as HTMLElement).innerText || ""
  if (operation === "textContent") return element.textContent
  if (operation === "inputValue") {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error("action_denied")
    return element.value
  }
  if (operation === "isVisible") return visible(element)
  if (operation === "isEnabled") return enabled(element)
  if (operation === "isChecked") return (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) ? element.checked : false
  if (!visible(element) || !enabled(element)) throw new Error("action_denied")
  const rect = (element as HTMLElement).getBoundingClientRect()
  const x = Math.max(rect.left, Math.min(rect.right, rect.left + rect.width / 2))
  const y = Math.max(rect.top, Math.min(rect.bottom, rect.top + rect.height / 2))
  const top = document.elementFromPoint(x, y)
  if (top && top !== element && !element.contains(top)) throw new Error("action_denied")
  return { x, y, width: rect.width, height: rect.height, tagName: element.tagName.toLowerCase(), role: role(element), editable: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element as HTMLElement).isContentEditable, enabled: enabled(element) }
}
