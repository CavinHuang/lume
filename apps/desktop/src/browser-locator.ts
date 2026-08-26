import type { BrowserLocator, BrowserLocatorStep, BrowserTextMatcher } from '@lume/shared'

export type ResolvedBrowserTarget = { x: number; y: number; width: number; height: number; tagName: string; role?: string; editable: boolean; enabled: boolean; readOnly?: boolean; /** 内部字段：语义 ref 解析出的节点，供 auto-wait 廉价稳定复测使用(#605) */ backendNodeId?: number; /** 内部字段：解析时的 document URL，坐标注入前重验以防页面自导航盲击(#614)；locator 兜底路径不填则跳过校验 */ documentUrl?: string }
export type BrowserLocatorQuery = "target" | "element" | "focus" | "evaluate" | "count" | "allTextContents" | "readAll" | "getAttribute" | "innerText" | "textContent" | "inputValue" | "editableValue" | "isVisible" | "isEnabled" | "isChecked" | "select"

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
  const supported = new Set(["role", "text", "label", "placeholder", "testId", "css", "locator", "frame", "nth", "first", "last", "filter", "and", "or"])
  for (const step of locator.steps) {
    if (!step || typeof step !== "object" || typeof (step as BrowserLocatorStep).kind !== "string") throw new Error("invalid_browser_request")
    const kind = (step as BrowserLocatorStep).kind
    if (!supported.has(kind)) throw new Error("invalid_browser_request")
    if (["css", "locator", "frame"].includes(kind) && (!('selector' in step) || typeof step.selector !== "string" || step.selector.length > 4096)) throw new Error("invalid_browser_request")
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
  const role = (element: Element) => {
    const explicit = element.getAttribute("role")
    if (explicit) return explicit
    if (element instanceof HTMLInputElement) {
      if (["button", "submit", "reset", "image"].includes(element.type)) return "button"
      if (element.type === "checkbox") return "checkbox"
      if (element.type === "radio") return "radio"
      return "textbox"
    }
    return ({ A: "link", BUTTON: "button", TEXTAREA: "textbox", SELECT: "combobox" } as Record<string, string>)[element.tagName] || "generic"
  }
  const normalizedText = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim()
  const name = (element: Element) => {
    const labelledBy = normalizedText((element.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean)
      .map(id => element.ownerDocument.getElementById(id)?.textContent || "").join(" "))
    if (labelledBy) return labelledBy
    const ariaLabel = normalizedText(element.getAttribute("aria-label"))
    if (ariaLabel) return ariaLabel
    const labels = "labels" in element && element.labels ? Array.from(element.labels as NodeListOf<HTMLLabelElement>) : []
    const label = normalizedText(labels.map(item => (item as HTMLElement).innerText || item.textContent || "").join(" "))
    if (label) return label
    if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type) && element.value) return normalizedText(element.value)
    const content = normalizedText((element as HTMLElement).innerText || element.textContent)
    if (content) return content
    return normalizedText(element.getAttribute("title") || element.getAttribute("placeholder") || element.getAttribute("alt"))
  }
  const visible = (element: Element) => { const rect = (element as HTMLElement).getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" }
  const enabled = (element: Element) => !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true"
  const all = (scope: Element | Document, selector = "*") => Array.from(scope.querySelectorAll(selector))
  const resolve = (ast: BrowserLocator, scope: Element | Document = document): Element[] => {
    let current: Element[] = [scope instanceof Document ? document.documentElement : scope]
    for (const step of ast.steps) {
      if (step.kind === "nth" || step.kind === "first" || step.kind === "last") { current = step.kind === "nth" ? (current[step.index] ? [current[step.index]] : []) : step.kind === "first" ? current.slice(0, 1) : current.slice(-1); continue }
      if (step.kind === "and" || step.kind === "or") { const nested = resolve(step.locator, scope); current = step.kind === "and" ? current.filter((element) => nested.includes(element)) : Array.from(new Set([...current, ...nested])); continue }
      if (step.kind === "frame") {
        const frames = current.flatMap((element) => all(element, step.selector)).filter((element): element is HTMLIFrameElement => ["iframe", "frame"].includes(element.tagName.toLowerCase()))
        if (frames.length !== 1 || !frames[0].contentDocument) return []
        current = [frames[0].contentDocument.documentElement]
        continue
      }
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
    attributes: Object.fromEntries(Array.from(element.attributes).slice(0, 200).map((attribute) => [attribute.name, attribute.value.slice(0, 10_000)])),
    inner_text: ((element as HTMLElement).innerText || "").slice(0, 100_000),
    text_content: element.textContent?.slice(0, 100_000) ?? null,
  }))
  if (elements.length !== 1) throw new Error(elements.length === 0 ? "stale_target" : "strict_locator_violation")
  const element = elements[0]
  if (operation === "element") return element
  if (operation === "getAttribute") return element.getAttribute(argument || "")
  if (operation === "innerText") return (element as HTMLElement).innerText || ""
  if (operation === "textContent") return element.textContent
  if (operation === "inputValue") {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) throw new Error("action_denied")
    return element.value
  }
  if (operation === "editableValue") {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value
    if ((element as HTMLElement).isContentEditable) return element.textContent || ""
    throw new Error("action_denied")
  }
  if (operation === "isVisible") return visible(element)
  if (operation === "isEnabled") return enabled(element)
  if (operation === "isChecked") {
    if (!(element instanceof HTMLInputElement) || !["checkbox", "radio"].includes(element.type)) throw new Error("action_denied")
    return element.checked
  }
  if (operation === "select") {
    if (!(element instanceof HTMLSelectElement)) throw new Error("action_denied")
    const values = JSON.parse(argument || "[]")
    for (const option of Array.from(element.options)) option.selected = Array.isArray(values) && values.includes(option.value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
    return true
  }
  if (!visible(element)) throw new Error("element_not_visible")
  if (!enabled(element)) throw new Error("element_disabled")
  let rect = (element as HTMLElement).getBoundingClientRect()
  const view = element.ownerDocument.defaultView
  if (view && (rect.bottom <= 0 || rect.right <= 0 || rect.top >= view.innerHeight || rect.left >= view.innerWidth)) {
    ;(element as HTMLElement).scrollIntoView({ block: "center", inline: "center" })
    rect = (element as HTMLElement).getBoundingClientRect()
  }
  const x = Math.max(rect.left, Math.min(rect.right, rect.left + rect.width / 2))
  const y = Math.max(rect.top, Math.min(rect.bottom, rect.top + rect.height / 2))
  const ownerDocument = element.ownerDocument
  const top = ownerDocument.elementFromPoint(x, y)
  const hitLabel = top instanceof HTMLElement ? top.closest("label") : null
  if (top && top !== element && !element.contains(top) && (!(hitLabel instanceof HTMLLabelElement) || hitLabel.control !== element)) throw new Error("element_occluded")
  let topX = x
  let topY = y
  let frame = ownerDocument.defaultView?.frameElement
  while (frame && ["iframe", "frame"].includes(frame.tagName.toLowerCase())) {
    const frameRect = frame.getBoundingClientRect()
    topX += frameRect.left
    topY += frameRect.top
    frame = frame.ownerDocument.defaultView?.frameElement
  }
  const isInput = element instanceof HTMLInputElement
  const editable = (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
    ? !element.readOnly && !element.disabled
    : (element as HTMLElement).isContentEditable
  return { x: topX, y: topY, width: rect.width, height: rect.height, tagName: element.tagName.toLowerCase(), role: role(element), ...(isInput && element.readOnly ? { readOnly: true } : {}), editable, enabled: enabled(element) }
}
