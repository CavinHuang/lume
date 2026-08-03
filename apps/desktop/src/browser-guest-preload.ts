import { ipcRenderer } from 'electron'

type AnnotationMessage = {
  type: 'sync' | 'prepare-screenshot' | 'restore' | 'close'
  tabId?: unknown
  generation?: unknown
  threadId?: unknown
  requestId?: unknown
  purpose?: 'annotation' | 'tweaks'
  mode?: 'browse' | 'comment'
  theme?: unknown
  comments?: Array<Record<string, unknown>>
  activeDraft?: Record<string, unknown>
}

type GuestState = {
  tabId: string
  generation: number
  threadId: string
  mode: 'browse' | 'comment'
  purpose: 'annotation' | 'tweaks'
  theme?: string
  comments: Array<Record<string, unknown>>
  activeDraft?: Record<string, unknown>
}

type Located = { rect: Rect; status: 'attached' | 'degraded'; target?: Element }
type Rect = { x: number; y: number; width: number; height: number }

const bootstrapUrl = window.location.href
if (bootstrapUrl.startsWith('about:blank#lume-browser-mount=')) ipcRenderer.send('lume:browser-guest-mounted', bootstrapUrl)

const start = () => new GuestAnnotationRuntime().start()
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true })
else start()

class GuestAnnotationRuntime {
  private state: GuestState | null = null
  private top: AnnotationDocumentRuntime | null = null
  private frameRefreshTimer = 0

  start(): void {
    if (this.top) return
    this.top = new AnnotationDocumentRuntime(document, window, [], null, (payload) => this.send(payload), () => this.state)
    this.top.start()
    ipcRenderer.on('lume:browser-annotation-guest', (_event, raw: unknown) => this.receive(raw))
    const refresh = () => {
      if (this.frameRefreshTimer) return
      this.frameRefreshTimer = window.setTimeout(() => { this.frameRefreshTimer = 0; this.top?.syncFrames() }, 50)
    }
    const observer = new MutationObserver(refresh)
    observer.observe(document.documentElement, { subtree: true, childList: true })
    window.addEventListener('load', refresh, true)
  }

  private receive(raw: unknown): void {
    if (!isRecord(raw) || typeof raw.type !== 'string') return
    const message = raw as AnnotationMessage
    if (message.type === 'close') {
      this.state = null
      this.top?.applyState(null)
      return
    }
    if (message.type === 'prepare-screenshot') {
      const requestId = boundedText(message.requestId, 128)
      if (!requestId || !this.state || message.tabId !== this.state.tabId || message.generation !== this.state.generation || message.threadId !== this.state.threadId) return
      this.top?.setScreenshotPrepared(true)
      this.send({ type: 'screenshot-ready', tabId: this.state.tabId, generation: this.state.generation, threadId: this.state.threadId, requestId })
      return
    }
    if (message.type !== 'sync' && message.type !== 'restore') return
    if (typeof message.tabId !== 'string' || message.tabId.length < 1 || message.tabId.length > 256 || typeof message.generation !== 'number' || !Number.isInteger(message.generation) || message.generation < 1 || message.generation > 2_000_000 || typeof message.threadId !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(message.threadId)) return
    const generation = message.generation
    const theme = safeThemeColor(message.theme)
    this.state = {
      tabId: message.tabId,
      generation,
      threadId: message.threadId,
      mode: message.mode === 'comment' ? 'comment' : 'browse',
      purpose: message.purpose === 'tweaks' ? 'tweaks' : 'annotation',
      ...(theme ? { theme } : {}),
      comments: Array.isArray(message.comments) ? message.comments.slice(0, 100).filter((item) => isRecord(item) && validComment(item)) : [],
      ...(message.activeDraft && isRecord(message.activeDraft) && validDraft(message.activeDraft) ? { activeDraft: message.activeDraft } : {}),
    }
    this.top?.setScreenshotPrepared(false)
    this.top?.applyState(this.state)
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.state || JSON.stringify(payload).length > 1_000_000) return
    ipcRenderer.send('lume:browser-annotation-guest', { ...payload, tabId: this.state.tabId, generation: this.state.generation, threadId: this.state.threadId })
  }
}

class AnnotationDocumentRuntime {
  private root: ShadowRoot | null = null
  private host: HTMLDivElement | null = null
  private markerLayer: HTMLDivElement | null = null
  private preview: HTMLDivElement | null = null
  private hoverBox: HTMLDivElement | null = null
  private cursorBadge: HTMLDivElement | null = null
  private state: GuestState | null = null
  private children = new Map<string, AnnotationDocumentRuntime>()
  private crossOriginFrames = new Map<string, HTMLIFrameElement>()
  private scheduled = 0
  private dragging: { x: number; y: number } | null = null
  private suppressNextClick = false
  private previewTimer = 0
  private previewHideTimer = 0
  private screenshotPrepared = false
  private cleanup: Array<() => void> = []
  private anchorResizeObserver: ResizeObserver | null = null

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly framePath: string[],
    private readonly parent: AnnotationDocumentRuntime | null,
    private readonly send: (payload: Record<string, unknown>) => void,
    private readonly getRootState: () => GuestState | null,
  ) {}

  start(): void {
    if (this.host) return
    this.host = this.doc.createElement('div')
    this.host.setAttribute('data-lume-annotation-host', '')
    this.host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style;'
    this.root = this.host.attachShadow({ mode: 'closed' })
    this.root.innerHTML = `<style>:host{all:initial;--annotation-accent:#0b84ff}*{box-sizing:border-box}.marker-layer{position:fixed;inset:0;pointer-events:none;font:12px system-ui,-apple-system,sans-serif;color:#fff}.marker{position:fixed;pointer-events:auto;width:24px;height:24px;border-radius:999px;border:2px solid #fff;background:var(--annotation-accent);color:#fff;box-shadow:0 3px 12px #0006;display:flex;align-items:center;justify-content:center;font-weight:700;cursor:pointer}.marker.draft{border-style:dashed}.marker.stale{background:#8f95a3}.marker.detached{opacity:.62}.marker:hover,.marker:focus-visible{outline:3px solid color-mix(in srgb,var(--annotation-accent) 55%,white);outline-offset:2px}.preview{position:fixed;max-width:300px;padding:8px 10px;border:1px solid #ffffff33;border-radius:9px;background:#17181c;color:#f5f5f5;box-shadow:0 10px 30px #0005;pointer-events:auto;white-space:pre-wrap;line-height:1.45}.selection{position:fixed;border:2px solid var(--annotation-accent);border-radius:3px;background:color-mix(in srgb,var(--annotation-accent) 9%,transparent);box-shadow:0 0 0 1px #fff6 inset;pointer-events:none}.cursor-badge{position:fixed;display:flex;width:28px;height:28px;align-items:center;justify-content:center;border:2px solid #fff;border-radius:999px;background:var(--annotation-accent);color:#fff;box-shadow:0 5px 15px #0004;pointer-events:none}.cursor-badge svg{width:15px;height:15px;fill:currentColor}.frame-target{position:fixed;pointer-events:auto;border:2px dashed var(--annotation-accent);background:color-mix(in srgb,var(--annotation-accent) 5%,transparent);cursor:crosshair}</style><div class="marker-layer"></div>`
    this.markerLayer = this.root.querySelector('.marker-layer') as HTMLDivElement
    this.doc.documentElement.append(this.host)
    const schedule = () => this.scheduleRender()
    this.addListener(this.win, 'scroll', schedule, true)
    this.addListener(this.win, 'resize', schedule)
    this.addListener(this.doc, 'pointerdown', (event) => this.onPointerDown(event as PointerEvent), true)
    this.addListener(this.doc, 'pointermove', (event) => this.onPointerMove(event as PointerEvent), true)
    this.addListener(this.doc, 'pointerout', (event) => this.onPointerOut(event as PointerEvent), true)
    this.addListener(this.doc, 'pointerup', (event) => this.onPointerUp(event as PointerEvent), true)
    this.addListener(this.doc, 'click', (event) => this.onClick(event as MouseEvent), true)
    this.addListener(this.doc, 'mouseup', () => this.openTextSelection(), true)
    this.addListener(this.doc, 'pointerover', (event) => this.onHover(event as PointerEvent), true)
    this.addListener(this.doc, 'keydown', (event) => this.onKeyDown(event as KeyboardEvent), true)
    const mutation = new MutationObserver(schedule)
    mutation.observe(this.doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true })
    const resize = new ResizeObserver(schedule)
    resize.observe(this.doc.documentElement)
    this.cleanup.push(() => mutation.disconnect(), () => resize.disconnect())
    this.syncFrames()
  }

  applyState(state: GuestState | null): void {
    this.state = state
    const accent = state?.theme ?? '#0b84ff'
    if (this.host && this.host.style.getPropertyValue('--annotation-accent') !== accent) this.host.style.setProperty('--annotation-accent', accent)
    this.syncFrames()
    this.render()
  }

  setScreenshotPrepared(value: boolean): void {
    this.screenshotPrepared = value
    if (value) {
      this.clearPreviewTimers()
      this.preview?.remove()
      this.preview = null
    }
    this.render()
    this.children.forEach((child) => child.setScreenshotPrepared(value))
  }

  syncFrames(): void {
    const frames = [...this.doc.querySelectorAll('iframe,frame')]
    const seen = new Set<string>()
    this.crossOriginFrames.clear()
    frames.forEach((frame, index) => {
      const path = [...this.framePath, String(index)]
      const key = path.join('.')
      let child = this.children.get(key)
      if (!child) {
        try {
          const childDocument = (frame as HTMLIFrameElement).contentDocument
          const childWindow = (frame as HTMLIFrameElement).contentWindow
          if (!childDocument || !childWindow || childWindow.location.origin !== this.win.location.origin) {
            this.crossOriginFrames.set(key, frame as HTMLIFrameElement)
            return
          }
          child = new AnnotationDocumentRuntime(childDocument, childWindow, path, this, this.send, this.getRootState)
          child.start()
          this.children.set(key, child)
        } catch { this.crossOriginFrames.set(key, frame as HTMLIFrameElement); return }
      }
      seen.add(key)
      child.applyState(this.state)
    })
    this.children.forEach((child, key) => { if (!seen.has(key)) child.destroy(); if (!seen.has(key)) this.children.delete(key) })
  }

  destroy(): void {
    if (this.scheduled) this.win.cancelAnimationFrame(this.scheduled)
    this.clearPreviewTimers()
    this.anchorResizeObserver?.disconnect()
    this.anchorResizeObserver = null
    this.cleanup.splice(0).forEach((dispose) => dispose())
    this.children.forEach((child) => child.destroy())
    this.children.clear()
    this.crossOriginFrames.clear()
    this.host?.remove()
    this.host = null
  }

  private scheduleRender(): void {
    if (this.scheduled) return
    this.scheduled = this.win.requestAnimationFrame(() => { this.scheduled = 0; this.syncFrames(); this.render() })
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.screenshotPrepared || this.state?.mode !== 'comment' || this.state.purpose === 'tweaks' || event.button !== 0 || this.isOverlayTarget(event.target)) return
    this.dragging = { x: event.clientX, y: event.clientY }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || this.screenshotPrepared || this.state?.mode !== 'comment') return
    event.preventDefault()
    event.stopImmediatePropagation()
    this.send({ type: 'mode-changed', mode: 'browse' })
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.screenshotPrepared || this.state?.mode !== 'comment' || this.state.purpose === 'tweaks' || this.isOverlayTarget(event.target)) return
    const element = event.target instanceof Element ? event.target : this.doc.elementFromPoint(event.clientX, event.clientY)
    if (!(element instanceof Element) || element === this.host) return
    const rect = rectOf(element)
    if (!this.hoverBox) {
      this.hoverBox = this.doc.createElement('div')
      this.hoverBox.className = 'selection'
      this.markerLayer?.append(this.hoverBox)
    }
    const local = this.toLocalRect(this.toTopRect(rect))
    this.hoverBox.style.left = `${local.x}px`; this.hoverBox.style.top = `${local.y}px`; this.hoverBox.style.width = `${local.width}px`; this.hoverBox.style.height = `${local.height}px`
    if (!this.cursorBadge) {
      this.cursorBadge = this.doc.createElement('div')
      this.cursorBadge.className = 'cursor-badge'
      this.cursorBadge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H9l-5.2 3.2A.5.5 0 0 1 3 20.8V7a3 3 0 0 1 2-3Z"/></svg>'
      this.markerLayer?.append(this.cursorBadge)
    }
    this.cursorBadge.style.left = `${Math.max(4, Math.min(this.win.innerWidth - 32, event.clientX + 14))}px`
    this.cursorBadge.style.top = `${Math.max(4, Math.min(this.win.innerHeight - 32, event.clientY + 14))}px`
  }

  private onPointerOut(event: PointerEvent): void {
    if (event.relatedTarget) return
    this.hoverBox?.remove(); this.hoverBox = null
    this.cursorBadge?.remove(); this.cursorBadge = null
  }

  private onHover(event: PointerEvent): void {
    if (this.screenshotPrepared || this.state?.mode !== 'comment' || this.isOverlayTarget(event.target)) return
    if (!(event.target instanceof Element)) return
    if (event.target.matches('html,body')) return
    this.onPointerMove(event)
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.screenshotPrepared || !this.dragging || !this.state || event.button !== 0 || this.isOverlayTarget(event.target)) return
    const start = this.dragging
    this.dragging = null
    const rect = { x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY), width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y) }
    if (rect.width < 6 || rect.height < 6) return
    this.suppressNextClick = true
    this.win.setTimeout(() => { this.suppressNextClick = false }, 0)
    event.preventDefault(); event.stopImmediatePropagation()
    this.openAnchor('region', rect)
  }

  private onClick(event: MouseEvent): void {
    if (this.screenshotPrepared || this.state?.mode !== 'comment' || this.isOverlayTarget(event.target)) return
    if (this.suppressNextClick) { event.preventDefault(); event.stopImmediatePropagation(); return }
    if (this.win.getSelection()?.toString().trim()) return
    const element = event.target instanceof Element ? event.target : this.doc.elementFromPoint(event.clientX, event.clientY)
    if (!(element instanceof Element) || this.host?.contains(element)) return
    event.preventDefault(); event.stopImmediatePropagation()
    const rect = rectOf(element)
    this.openAnchor('element', rect, element)
  }

  private openTextSelection(): void {
    if (this.screenshotPrepared || this.state?.mode !== 'comment' || this.state.purpose === 'tweaks') return
    const selection = this.win.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return
    const range = selection.getRangeAt(0)
    const rect = rectOf(range)
    if (rect.width <= 0 || rect.height <= 0) return
    this.openAnchor('text', rect, range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement, selection.toString(), range)
  }

  private openAnchor(kind: 'element' | 'text' | 'region', rect: Rect, element?: Element | null, exact?: string, range?: Range): void {
    if (!this.state) return
    const anchor = buildAnchor(kind, this.toTopRect(rect), element, exact, this.state.generation, this.framePath, this.win, range)
    this.send({ type: 'open-editor', annotationId: undefined, purpose: this.state.purpose, anchor, ...(this.state.purpose === 'tweaks' && element ? { originalStyles: styleSnapshot(element, this.win) } : {}) })
  }

  private render(): void {
    if (!this.markerLayer) return
    this.markerLayer.replaceChildren()
    this.preview = null
    this.hoverBox = null
    this.cursorBadge = null
    this.anchorResizeObserver?.disconnect()
    this.anchorResizeObserver = null
    const state = this.state ?? this.getRootState()
    if (!state) return
    const comments = state.comments.filter((comment) => framePathOf(comment.anchor) === this.framePath.join('/'))
    const resolvedTargets: Element[] = []
    comments.forEach((comment, index) => this.renderMarker(comment, globalCommentIndex(comment, state, index), false, state, resolvedTargets))
    const draft = state.activeDraft
    if (draft && framePathOf(draft.anchor) === this.framePath.join('/')) this.renderMarker({ id: draft.id ?? 'draft', body: draft.body, anchor: draft.anchor }, comments.length, true, state, resolvedTargets)
    if (resolvedTargets.length > 0) {
      this.anchorResizeObserver = new ResizeObserver(() => this.scheduleRender())
      resolvedTargets.forEach((target) => this.anchorResizeObserver?.observe(target))
    }
    if (state.mode === 'comment' && !this.screenshotPrepared) this.crossOriginFrames.forEach((frame) => {
      const overlay = this.doc.createElement('div')
      overlay.className = 'frame-target'
      const rect = rectOf(frame)
      overlay.style.left = `${rect.x}px`; overlay.style.top = `${rect.y}px`; overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`
      overlay.setAttribute('aria-label', '选择跨域网页框架')
      overlay.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.openAnchor('element', rect, frame) })
      this.markerLayer?.append(overlay)
    })
  }

  private renderMarker(comment: Record<string, unknown>, index: number, draft: boolean, state: GuestState, resolvedTargets: Element[] = []): void {
    const anchor = isRecord(comment.anchor) ? comment.anchor : undefined
    if (!anchor || anchor.url !== currentPageUrl(state)) return
    const located = locateAnchor(anchor, this.doc, this.win)
    if (located?.target) resolvedTargets.push(located.target)
    const marker = this.doc.createElement('button')
    marker.type = 'button'
    marker.className = `marker${draft ? ' draft' : ''}${located ? (located.status === 'degraded' ? ' detached' : '') : ' stale detached'}`
    marker.textContent = draft ? '•' : String(index + 1)
    marker.setAttribute('aria-label', draft ? '当前批注草稿' : located ? `批注 ${index + 1}` : `批注 ${index + 1} 已失效`)
    const fallback = isRecord(anchor.rect) ? sanitizeRect(anchor.rect) : { x: 8, y: 8 + index * 28, width: 1, height: 1 }
    const topRect = located ? this.toTopRect(located.rect) : fallback
    const localRect = this.toLocalRect(topRect)
    marker.style.left = `${Math.max(0, Math.min(this.win.innerWidth - 24, localRect.x + localRect.width - 12))}px`
    marker.style.top = `${Math.max(0, Math.min(this.win.innerHeight - 24, localRect.y - 12))}px`
    if (!draft) {
      const body = String(comment.body ?? '')
      marker.addEventListener('mouseenter', () => this.schedulePreview(marker, body, String(comment.id ?? '')))
      marker.addEventListener('focus', () => this.schedulePreview(marker, body, String(comment.id ?? '')))
      marker.addEventListener('mouseleave', () => this.scheduleHidePreview())
      marker.addEventListener('blur', () => this.scheduleHidePreview())
      marker.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.send({ type: 'open-editor', annotationId: boundedText(comment.id, 256), anchor }) })
    }
    this.markerLayer.append(marker)
    this.send({ type: 'anchor-state', annotationId: draft ? '' : boundedText(comment.id, 256), status: located?.status ?? 'stale', ...(located ? { rect: topRect } : {}) })
  }

  private schedulePreview(marker: HTMLElement, body: string, annotationId: string): void {
    this.clearPreviewTimers()
    this.previewTimer = this.win.setTimeout(() => {
      this.showPreview(marker, body, annotationId)
    }, 120)
  }

  private showPreview(marker: HTMLElement, body: string, annotationId: string): void {
    if (!this.root || !body) return
    const preview = this.doc.createElement('div')
    preview.className = 'preview'
    preview.textContent = body
    const rect = marker.getBoundingClientRect()
    preview.style.left = `${Math.max(8, Math.min(this.win.innerWidth - 316, rect.left - 308))}px`
    preview.style.top = `${Math.max(8, Math.min(this.win.innerHeight - 100, rect.top))}px`
    preview.addEventListener('mouseenter', () => { if (this.previewHideTimer) this.win.clearTimeout(this.previewHideTimer) })
    preview.addEventListener('mouseleave', () => this.scheduleHidePreview())
    this.markerLayer?.append(preview)
    this.preview = preview
    this.send({ type: 'preview-open', annotationId, rect: rectOf(preview) })
  }

  private scheduleHidePreview(): void {
    if (this.previewHideTimer) this.win.clearTimeout(this.previewHideTimer)
    this.previewHideTimer = this.win.setTimeout(() => {
      if (this.preview) this.send({ type: 'preview-close' })
      this.preview?.remove(); this.preview = null
    }, 260)
  }

  private clearPreviewTimers(): void {
    if (this.previewTimer) this.win.clearTimeout(this.previewTimer)
    if (this.previewHideTimer) this.win.clearTimeout(this.previewHideTimer)
    this.previewTimer = 0; this.previewHideTimer = 0
  }

  private isOverlayTarget(target: EventTarget | null): boolean { return Boolean(this.host && target instanceof Node && this.host.contains(target)) }
  private addListener(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, capture)
    this.cleanup.push(() => target.removeEventListener(type, listener, capture))
  }
  private toTopRect(rect: Rect): Rect {
    const frame = this.win.frameElement
    if (!frame || !this.parent) return rect
    const frameRect = frame.getBoundingClientRect()
    return this.parent.toTopRect({ x: rect.x + frameRect.x, y: rect.y + frameRect.y, width: rect.width, height: rect.height })
  }
  private toLocalRect(rect: Rect): Rect {
    const frame = this.win.frameElement
    if (!frame || !this.parent) return rect
    const frameRect = frame.getBoundingClientRect()
    const parentRect = this.parent.toLocalRect(rect)
    return { x: parentRect.x - frameRect.x, y: parentRect.y - frameRect.y, width: rect.width, height: rect.height }
  }
}

function buildAnchor(kind: 'element' | 'text' | 'region', rect: Rect, element: Element | null | undefined, exact: string | undefined, generation: number, framePath: string[], win: Window, range?: Range): Record<string, unknown> {
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

function locateAnchor(anchor: Record<string, unknown>, doc: Document, win: Window): Located | undefined {
  if (typeof anchor.url !== 'string' || anchor.url !== topWindow(win).location.href) return undefined
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

function resolveRange(anchor: Record<string, unknown>, doc: Document): Range | undefined {
  if (!isRecord(anchor.textRange)) return undefined
  const start = resolvePathNode(doc, anchor.textRange.startPath)
  const end = resolvePathNode(doc, anchor.textRange.endPath)
  if (!start || !end) return undefined
  const range = doc.createRange()
  try { range.setStart(start, boundedOffset(anchor.textRange.startOffset, start)); range.setEnd(end, boundedOffset(anchor.textRange.endOffset, end)); return range } catch { return undefined }
}

function resolvePathNode(doc: Document, value: unknown): Node | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined
  try { return doc.querySelector(value)?.firstChild ?? doc.querySelector(value) ?? undefined } catch { return undefined }
}

function rangeDescriptor(range: Range): Record<string, unknown> {
  const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const endElement = range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement
  return { startPath: startElement ? domPath(startElement) : undefined, startOffset: range.startOffset, endPath: endElement ? domPath(endElement) : undefined, endOffset: range.endOffset }
}

function domPath(element: Element): string {
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

function selectorFor(element: Element): string | undefined {
  if (element.id && element.id.length <= 256) return `#${cssEscape(element.id)}`
  const name = element.getAttribute('data-testid') || element.getAttribute('name')
  if (name && name.length <= 256) return `[${element.hasAttribute('data-testid') ? 'data-testid' : 'name'}="${cssEscape(name)}"]`
  return undefined
}

function topWindow(win: Window): Window { let current = win; while (current.parent !== current) { try { current = current.parent } catch { break } } return current }
function framePathOf(anchor: unknown): string { return isRecord(anchor) && Array.isArray(anchor.framePath) ? anchor.framePath.filter((item) => typeof item === 'string').join('/') : '' }
function currentPageUrl(_state: GuestState): string { return topWindow(window).location.href }
function globalCommentIndex(comment: Record<string, unknown>, state: GuestState, fallback: number): number {
  const id = boundedText(comment.id, 256)
  const index = id ? state.comments.findIndex((item) => item.id === id) : -1
  return index >= 0 ? index : fallback
}
function styleSnapshot(element: Element, win: Window): Record<string, string> {
  const computed = win.getComputedStyle(element)
  return Object.fromEntries(['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'borderRadius', 'borderWidth', 'borderStyle', 'borderColor', 'width', 'height', 'display', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'rowGap', 'columnGap', 'padding', 'margin', 'textContent'].map((key) => [key, key === 'textContent' ? String(element.textContent ?? '').slice(0, 4096) : String(computed.getPropertyValue(key) || '').slice(0, 4096)]))
}
function rectOf(value: Element | Range): Rect { const rect = value.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
function sanitizeRect(value: Record<string, unknown>): Rect { return { x: boundedNumber(value.x), y: boundedNumber(value.y), width: Math.max(0, boundedNumber(value.width)), height: Math.max(0, boundedNumber(value.height)) } }
function boundedNumber(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(-100_000, Math.min(100_000, value)) : 0 }
function boundedOffset(value: unknown, node: Node): number { const max = node instanceof Text ? node.length : node.childNodes.length; return Math.max(0, Math.min(max, typeof value === 'number' && Number.isInteger(value) ? value : 0)) }
function boundedText(value: unknown, max: number): string { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function safeThemeColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128 || !CSS.supports('color', value)) return undefined
  return value
}
function cssEscape(value: string): string { return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function validComment(value: Record<string, unknown>): boolean { return typeof value.id === 'string' && value.id.length <= 256 && typeof value.body === 'string' && value.body.length <= 20_000 && validAnchor(value.anchor) }
function validDraft(value: Record<string, unknown>): boolean { return typeof value.body === 'string' && value.body.length <= 20_000 && validAnchor(value.anchor) }
function validAnchor(value: unknown): boolean {
  if (!isRecord(value) || (value.kind !== 'element' && value.kind !== 'text' && value.kind !== 'region') || typeof value.url !== 'string' || value.url.length < 1 || value.url.length > 4_096 || !Number.isInteger(value.generation) || Number(value.generation) < 1 || Number(value.generation) > 2_000_000 || !isRecord(value.rect)) return false
  const rect = value.rect
  if (![rect.x, rect.y, rect.width, rect.height].every((item) => typeof item === 'number' && Number.isFinite(item) && Math.abs(item) <= 100_000) || Number(rect.width) < 0 || Number(rect.height) < 0) return false
  if (value.framePath !== undefined && (!Array.isArray(value.framePath) || value.framePath.length > 16 || !value.framePath.every((item) => typeof item === 'string' && /^\d{1,6}$/.test(item)))) return false
  for (const key of ['frameUrl', 'selector', 'domPath', 'title', 'selectedContent', 'immediateText', 'nearbyText'] as const) if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > (key.includes('Text') ? 20_000 : 4_096))) return false
  return true
}
