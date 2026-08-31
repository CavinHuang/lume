/**
 * 网页元素选取器 —— ZCode ETt/DTt/OTt/kTt(S1-element-picker.b.js)的 Lume 落法。
 *
 * 契约:注入页面的启动脚本挂 window.__zcodeWebElementPicker(含 cancel()),
 * hover 高亮遮罩 + 点击捕获,resolve {status:"selected", element} / Esc
 * {status:"cancelled"};取消脚本调用 picker.cancel()。
 * 偏差:选择器算法为简化 CSS 路径(id 优先 + nth-of-type);ZCode 选取结果
 * 进 selection-side-chat 元素上下文,Lume 暂以剪贴板承载。
 */

export interface PickedElement {
  selector: string
  outerHTML: string
  text: string
  rect: { x: number; y: number; width: number; height: number }
}

export interface ElementPickerResult {
  status: "selected" | "cancelled"
  element?: PickedElement
}

/** ZCode TTt 默认:outerHTML 截断上限。 */
export const ELEMENT_PICKER_MAX_HTML_CHARS = 4000

export function isElementPickerResult(value: unknown): value is ElementPickerResult {
  if (typeof value !== "object" || value === null) return false
  const result = value as ElementPickerResult
  return result.status === "cancelled"
    || (result.status === "selected" && typeof result.element === "object" && result.element !== null)
}

/** 注入页面的选取器主体(hover 遮罩 + 点击捕获 + Esc 取消)。 */
function elementPickerMain(config: { maxHtmlChars: number }): void {
  const w = window as unknown as {
    __zcodeWebElementPicker?: { cancel: () => void }
  }
  w.__zcodeWebElementPicker?.cancel()
  const overlay = document.createElement("div")
  overlay.setAttribute("data-lume-web-element-picker", "overlay")
  Object.assign(overlay.style, {
    background: "rgba(37, 99, 235, 0.12)",
    border: "2px solid #2563eb",
    borderRadius: "4px",
    boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.10)",
    boxSizing: "border-box",
    display: "none",
    left: "0",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    zIndex: "2147483646",
  })
  const buildSelector = (element: Element): string => {
    if (element.id) return `#${CSS.escape(element.id)}`
    const segments: string[] = []
    let current: Element | null = element
    while (current && current !== document.body && segments.length < 6) {
      const node: Element = current
      const tag = node.tagName.toLowerCase()
      const parent: Element | null = node.parentElement
      if (parent) {
        const siblings: Element[] = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
        segments.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag)
      } else segments.unshift(tag)
      current = parent
    }
    return segments.join(" > ")
  }
  let target: Element | null = null
  const onMove = (event: Event) => {
    const point = event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : null
    if (!point) return
    const candidate = document.elementFromPoint(point.x, point.y)
    if (!candidate || candidate === overlay || overlay.contains(candidate)) return
    target = candidate
    const rect = candidate.getBoundingClientRect()
    Object.assign(overlay.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    })
  }
  const cleanup = () => {
    overlay.remove()
    document.removeEventListener("mousemove", onMove, true)
    document.removeEventListener("click", onClick, true)
    document.removeEventListener("keydown", onKey, true)
    delete w.__zcodeWebElementPicker
  }
  const finish = (result: ElementPickerResult) => {
    cleanup()
    resolveRef(result)
  }
  let resolveRef!: (result: ElementPickerResult) => void
  const promise = new Promise<ElementPickerResult>((resolve) => { resolveRef = resolve })
  const onClick = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    const element = target
    if (!element) return
    const rect = element.getBoundingClientRect()
    finish({
      status: "selected",
      element: {
        selector: buildSelector(element),
        outerHTML: element.outerHTML.slice(0, config.maxHtmlChars),
        text: (element.textContent ?? "").trim().slice(0, 500),
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      },
    })
  }
  const onKey = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key === "Escape") finish({ status: "cancelled" })
  }
  document.addEventListener("mousemove", onMove, true)
  document.addEventListener("click", onClick, true)
  document.addEventListener("keydown", onKey, true)
  document.documentElement.appendChild(overlay)
  w.__zcodeWebElementPicker = { cancel: () => finish({ status: "cancelled" }) }
  void promise
}

export function buildElementPickerStartScript(
  config: { maxHtmlChars?: number } = {},
): string {
  return `(${elementPickerMain.toString()})(${JSON.stringify({ maxHtmlChars: config.maxHtmlChars ?? ELEMENT_PICKER_MAX_HTML_CHARS })})`
}

/** ZCode OTt:取消脚本(调用页面内 picker.cancel)。 */
export function buildElementPickerCancelScript(): string {
  return [
    "(() => {",
    "const picker = window.__zcodeWebElementPicker;",
    "if (picker && typeof picker.cancel === 'function') picker.cancel();",
    "})()",
  ].join("\n")
}
