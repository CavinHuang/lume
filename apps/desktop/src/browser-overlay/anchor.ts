// Anchor pure functions — copied verbatim from apps/desktop/src/browser-guest-preload.ts (lines 414-527)
// Semantics MUST stay identical to guest preload so overlay anchors match guest semantics.

export type Rect = { x: number; y: number; width: number; height: number }
export type Located = { rect: Rect; status: 'attached' | 'degraded'; target?: Element }

export function buildAnchor(kind: 'element' | 'text' | 'region', rect: Rect, element: Element | null | undefined, exact: string | undefined, generation: number, framePath: string[], win: Window, range?: Range): Record<string, unknown> {
  const text = String(exact ?? element?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 20_000)
  const source = String(element?.textContent ?? '')
  const index = text ? source.indexOf(text) : -1
  return {
    kind, url: topWindow(win).location.href, generation, framePath, ...(framePath.length ? { frameUrl: win.location.href } : {}),
    ...(element ? { domPath: domPath(element), selector: selectorFor(element), role: boundedText(element.getAttribute('role'), 256) || undefined, name: boundedText(element.getAttribute('aria-label'), 512) || undefined, title: boundedText(element.getAttribute('title'), 512) || undefined } : {}),
    ...(range ? { textRange: rangeDescriptor(range) } : {}),
    ...(text ? { textQuote: { exact: text, ...(index >= 0 ? { prefix: source.slice(Math.max(0, index - 1000), index), suffix: source.slice(index + text.length, index + text.length + 1000) } : {}) }, selectedContent: text, immediateText: text, nearbyText: source.slice(Math.max(0, index - 200), index + text.length + 200).slice(0, 1000) } : {}),
    viewport: { width: win.innerWidth, height: win.innerHeight, deviceScaleFactor: win.devicePixelRatio, scrollX: win.scrollX, scrollY: win.scrollY }, markerPoint: { x: rect.x + rect.width / 2, y: rect.y }, fixed: Boolean(element && win.getComputedStyle(element).position === 'fixed'), rect,
  }
}

export function locateAnchor(anchor: Record<string, unknown>, doc: Document, win: Window): Located | undefined {
  if (typeof anchor.url !== 'string' || !urlsMatch(anchor.url, topWindow(win).location.href)) return undefined
  if (Array.isArray(anchor.framePath) && anchor.framePath.length > 0 && typeof anchor.frameUrl === 'string' && anchor.frameUrl !== win.location.href) return undefined
  let element: Element | null = null
  for (const query of [anchor.selector, anchor.domPath]) {
    if (typeof query !== 'string' || query.length > 4096) continue
    try { element = doc.querySelector(query); if (element) return { rect: rectOf(element), status: 'attached', target: element } } catch { /* try the next locator */ }
  }
  if (typeof anchor.role === 'string' && anchor.role.length <= 256) {
    const role = [...doc.querySelectorAll(`[role="${cssEscape(anchor.role)}"]`)].find((candidate) => !anchor.name || candidate.getAttribute('aria-label') === anchor.name)
    if (role) return { rect: rectOf(role), status: 'attached', target: role }
  }
  const range = resolveRange(anchor, doc)
  if (range) return { rect: rectOf(range), status: 'attached', target: range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement ?? undefined }
  const quote = isRecord(anchor.textQuote) && typeof anchor.textQuote.exact === 'string' ? anchor.textQuote.exact.slice(0, 20_000) : ''
  if (quote) {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text
      const index = node.nodeValue?.indexOf(quote) ?? -1
      if (index < 0) continue
      const textRange = doc.createRange(); textRange.setStart(node, index); textRange.setEnd(node, index + quote.length)
      return { rect: rectOf(textRange), status: 'attached', target: node.parentElement ?? undefined }
    }
  }
  return isRecord(anchor.rect) ? { rect: sanitizeRect(anchor.rect), status: 'degraded' } : undefined
}

export function resolveRange(anchor: Record<string, unknown>, doc: Document): Range | undefined {
  if (!isRecord(anchor.textRange)) return undefined
  const start = resolvePathNode(doc, anchor.textRange.startPath)
  const end = resolvePathNode(doc, anchor.textRange.endPath)
  if (!start || !end) return undefined
  const range = doc.createRange()
  try { range.setStart(start, boundedOffset(anchor.textRange.startOffset, start)); range.setEnd(end, boundedOffset(anchor.textRange.endOffset, end)); return range } catch { return undefined }
}

export function resolvePathNode(doc: Document, value: unknown): Node | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined
  try { return doc.querySelector(value)?.firstChild ?? doc.querySelector(value) ?? undefined } catch { return undefined }
}

export function rangeDescriptor(range: Range): Record<string, unknown> {
  const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  return { startPath: startElement ? domPath(startElement) : undefined, startOffset: range.startOffset, endPath: endElement ? domPath(endElement) : undefined, endOffset: range.endOffset }
}

export function domPath(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && parts.length < 32) {
    const parent = current.parentElement
    const siblings = parent ? [...parent.children].filter((candidate) => candidate.tagName === current?.tagName) : []
    parts.unshift(`${current.tagName.toLowerCase()}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`)
    current = parent
  }
  return parts.join(' > ')
}

export function selectorFor(element: Element): string | undefined {
  if (element.id && element.id.length <= 256) return `#${cssEscape(element.id)}`
  const name = element.getAttribute('data-testid') || element.getAttribute('name')
  if (name && name.length <= 256) return `[${element.hasAttribute('data-testid') ? 'data-testid' : 'name'}="${cssEscape(name)}"]`
  return undefined
}

export function topWindow(win: Window): Window { let current = win; while (current.parent !== current) { try { current = current.parent } catch { break } } return current }
export function rectOf(value: Element | Range): Rect { const rect = value.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
export function sanitizeRect(value: Record<string, unknown>): Rect { return { x: boundedNumber(value.x), y: boundedNumber(value.y), width: Math.max(0, boundedNumber(value.width)), height: Math.max(0, boundedNumber(value.height)) } }
export function boundedNumber(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(-100_000, Math.min(100_000, value)) : 0 }
export function boundedOffset(value: unknown, node: Node): number { const max = node instanceof Text ? node.length : node.childNodes.length; return Math.max(0, Math.min(max, typeof value === 'number' && Number.isInteger(value) ? value : 0)) }
export function boundedText(value: unknown, max: number): string { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
export function cssEscape(value: string): string { return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') }
export function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }

// 语义 URL 比较：HTTP(S) 仅比较 origin+pathname+search，忽略 hash（对齐 Codex hs）。
// 避免 SPA hash 路由/锚点跳转导致 marker 降级；非 HTTP(S) 退化为精确字符串比较。
export function urlsMatch(a: string, b: string): boolean {
  try {
    const ua = new URL(a), ub = new URL(b)
    if (ua.protocol === 'http:' || ua.protocol === 'https:') {
      return ua.origin === ub.origin && ua.pathname === ub.pathname && ua.search === ub.search
    }
    return a === b
  } catch { return a === b }
}
