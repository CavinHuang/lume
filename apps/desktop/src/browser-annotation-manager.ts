import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow, screen, type WebContents } from 'electron'
import type { AgentBrowserAnchor, AgentBrowserAnnotationAttachment, BrowserAnnotationSessionSnapshot } from '../../../packages/shared/src/types/agent'
import type { BrowserTabDescriptor } from '../../../packages/shared/src/types/browser-runtime'
import { positionBrowserAnnotationPopup } from './browser-annotation-position'
import { BrowserAnnotationSessionStore } from './browser-annotation-session'
import { isSafeBrowserAnnotationThreadId } from './browser-annotation-security'

type AnnotationGuestPayload = {
  type?: string
  tabId?: unknown
  generation?: unknown
  threadId?: unknown
  annotationId?: unknown
  anchor?: unknown
  status?: unknown
  rect?: unknown
  mode?: unknown
  purpose?: unknown
  originalStyles?: unknown
  requestId?: unknown
  body?: unknown
  action?: unknown
}

type AnnotationPopupCommand = { command?: unknown; body?: unknown }

type AnnotationRuntimeTab = BrowserTabDescriptor & {
  webContents: WebContents | null
  surfaceBounds?: Electron.Rectangle
  zoomFactor?: number
}

type PopupRecord = {
  window: BrowserWindow
  threadId: string
  tabId: string
  annotationId?: string
  anchor: AgentBrowserAnchor
  point: { x: number; y: number }
}

export class BrowserAnnotationManager {
  readonly store: BrowserAnnotationSessionStore
  private readonly popups = new Map<number, PopupRecord>()
  private readonly tabPopupIds = new Map<string, number>()
  private readonly previewHiddenPopupTabs = new Set<string>()
  private readonly screenshotWaiters = new Map<string, { tabId: string; generation: number; threadId: string; timer: ReturnType<typeof setTimeout>; resolve: (ready: boolean) => void }>()

  constructor(private readonly options: {
    configDir: () => string
    getParentWindow: () => BrowserWindow | null
    annotationPopupPreloadPath: string
    rendererUrl: () => string
    emit: (method: string, params: Record<string, unknown>) => void
    resolveTab?: (tabId: string) => AnnotationRuntimeTab | undefined
    getScreenshotMode: () => 'off' | 'necessary' | 'always'
    captureScreenshot: (tab: AnnotationRuntimeTab) => Promise<{ data: Buffer; width?: number; height?: number; deviceScaleFactor?: number }>
  }) {
    this.store = new BrowserAnnotationSessionStore(options.configDir)
  }

  session(tab: AnnotationRuntimeTab, threadId: string): BrowserAnnotationSessionSnapshot {
    const snapshot = this.store.get(threadId, tab.tabId, tab.url, tab.generation)
    this.emitSnapshot(snapshot)
    return snapshot
  }

  setMode(tab: AnnotationRuntimeTab, threadId: string, mode: 'browse' | 'comment', purpose: 'annotation' | 'tweaks' = 'annotation', theme?: string): BrowserAnnotationSessionSnapshot {
    const snapshot = this.store.setMode(threadId, tab.tabId, tab.url, tab.generation, mode, purpose, theme)
    if (mode === 'browse') this.closePopup(tab.tabId)
    this.syncGuest(tab, snapshot)
    this.emitSnapshot(snapshot)
    return snapshot
  }

  delete(tab: AnnotationRuntimeTab, threadId: string, annotationId: string): BrowserAnnotationSessionSnapshot {
    const before = this.store.get(threadId, tab.tabId, tab.url, tab.generation)
    const snapshot = this.store.deleteComment(threadId, tab.tabId, annotationId, tab.url, tab.generation)
    this.deleteUnreferencedScreenshots(threadId, before.comments.map((comment) => comment.screenshotRef).filter((ref): ref is string => Boolean(ref)), snapshot)
    this.syncGuest(tab, snapshot)
    this.emitSnapshot(snapshot)
    return snapshot
  }

  clear(tab: AnnotationRuntimeTab, threadId: string): BrowserAnnotationSessionSnapshot {
    const current = this.store.get(threadId, tab.tabId, tab.url, tab.generation)
    const snapshot = this.store.clearComments(threadId, tab.tabId, tab.url, tab.generation)
    this.deleteUnreferencedScreenshots(threadId, current.comments.filter((comment) => comment.tab.url === tab.url).map((comment) => comment.screenshotRef).filter((ref): ref is string => Boolean(ref)), snapshot)
    this.closePopup(tab.tabId)
    this.syncGuest(tab, snapshot)
    this.emitSnapshot(snapshot)
    return snapshot
  }

  migrate(value: unknown): { imported: number } {
    return { imported: this.store.importLegacy(value) }
  }

  onGuestReady(tab: AnnotationRuntimeTab): void {
    if (!tab.ownerThreadId) return
    this.syncGuest(tab, this.store.get(tab.ownerThreadId, tab.tabId, tab.url, tab.generation))
  }

  destroy(): void {
    for (const popup of this.popups.values()) if (!popup.window.isDestroyed()) popup.window.close()
    this.popups.clear()
    this.tabPopupIds.clear()
    this.previewHiddenPopupTabs.clear()
    for (const waiter of this.screenshotWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.resolve(false)
    }
    this.screenshotWaiters.clear()
  }

  onGuestMessage(tab: AnnotationRuntimeTab, raw: unknown): void {
    if (!isRecord(raw) || JSON.stringify(raw).length > 1_000_000) return
    const payload = raw as AnnotationGuestPayload
    if (payload.tabId !== tab.tabId || payload.generation !== tab.generation || typeof payload.threadId !== 'string' || payload.threadId !== tab.ownerThreadId) return
    if (payload.type === 'mode-changed') {
      if (payload.mode === 'browse' || payload.mode === 'comment') this.setMode(tab, payload.threadId, payload.mode, 'annotation')
      return
    }
    if (payload.type === 'screenshot-ready') {
      const requestId = text(payload.requestId, 128)
      const waiter = this.screenshotWaiters.get(requestId)
      if (!waiter || waiter.tabId !== tab.tabId || waiter.generation !== tab.generation || waiter.threadId !== payload.threadId) return
      clearTimeout(waiter.timer)
      this.screenshotWaiters.delete(requestId)
      waiter.resolve(true)
      return
    }
    if (payload.type === 'anchor-state') {
      const popupId = this.tabPopupIds.get(tab.tabId)
      const popup = popupId ? this.popups.get(popupId) : undefined
      const annotationId = text(payload.annotationId, 256)
      const matchesPopup = popup && (popup.annotationId === annotationId || (!popup.annotationId && !annotationId))
      if (matchesPopup && isRecord(payload.rect)) {
        const rect = sanitizeRect(payload.rect)
        popup.point = { x: rect.x + rect.width / 2, y: rect.y }
        popup.anchor = { ...popup.anchor, rect, markerPoint: popup.point }
        this.positionPopup(tab, popup)
      }
      this.options.emit('browser:annotation-anchor', {
        tabId: tab.tabId,
        threadId: payload.threadId,
        annotationId,
        status: payload.status === 'attached' ? 'attached' : 'stale',
        ...(isRecord(payload.rect) ? { rect: sanitizeRect(payload.rect) } : {}),
      })
      return
    }
    if (payload.type === 'preview-open' || payload.type === 'preview-close') {
      this.options.emit('browser:annotation-preview', {
        tabId: tab.tabId,
        threadId: payload.threadId,
        annotationId: text(payload.annotationId, 256),
        open: payload.type === 'preview-open',
        ...(isRecord(payload.rect) ? { rect: sanitizeRect(payload.rect) } : {}),
      })
      return
    }
    // 编辑器 overlay 提交/取消/删除：anchor 从 store activeDraft 取（单一来源），不依赖 overlay 传入。
    if (payload.type === 'editor-submit') {
      const action = payload.action === 'send' ? 'send' : 'add'
      const body = text(payload.body, 20_000)
      if (!body) return
      const session = this.store.get(payload.threadId, tab.tabId, tab.url, tab.generation)
      const draft = session.activeDraft
      if (!draft?.anchor) return
      const saved = this.saveAttachment(tab, payload.threadId, draft.id, draft.anchor, body)
      this.options.emit(action === 'send' ? 'browser:annotation-direct-submit' : 'browser:annotation-added', { threadId: payload.threadId, tabId: tab.tabId, attachment: saved.attachment, snapshot: saved.snapshot })
      return
    }
    if (payload.type === 'editor-cancel') {
      const snapshot = this.store.clearDraft(payload.threadId, tab.tabId, tab.url, tab.generation)
      this.syncGuest(tab, snapshot)
      this.emitSnapshot(snapshot)
      return
    }
    if (payload.type === 'editor-delete') {
      const session = this.store.get(payload.threadId, tab.tabId, tab.url, tab.generation)
      const id = session.activeDraft?.id
      if (id) this.delete(tab, payload.threadId, id)
      return
    }
    if (payload.type !== 'open-editor' || !isRecord(payload.anchor)) return
    const anchor = sanitizeAnchor(payload.anchor, tab.url, tab.generation)
    if (!anchor) return
    const id = text(payload.annotationId, 256)
    const purpose = payload.purpose === 'tweaks' ? 'tweaks' : 'annotation'
    if (purpose === 'tweaks') {
      this.options.emit('browser:annotation-selection', {
        tabId: tab.tabId,
        threadId: payload.threadId,
        purpose,
        anchor,
        originalStyles: sanitizeStyles(payload.originalStyles),
      })
      return
    }
    const snapshot = this.store.setDraft({ threadId: payload.threadId, tabId: tab.tabId, url: tab.url, generation: tab.generation, ...(id ? { id } : {}), anchor, body: id ? this.store.get(payload.threadId, tab.tabId, tab.url, tab.generation).comments.find((comment) => comment.id === id)?.body ?? '' : '' })
    this.openPopup(tab, payload.threadId, anchor, id || undefined, payload.anchor)
    this.syncGuest(tab, snapshot)
    this.emitSnapshot(snapshot)
  }

  async prepareScreenshot(tab: AnnotationRuntimeTab, threadId: string, restorePopup = true): Promise<BrowserAnnotationSessionSnapshot> {
    const snapshot = this.store.get(threadId, tab.tabId, tab.url, tab.generation)
    const mode = this.options.getScreenshotMode()
    const currentComments = snapshot.comments.filter((comment) => comment.tab.url === tab.url)
    const needsScreenshot = mode === 'always' || (mode === 'necessary' && currentComments.some((comment) => comment.anchor.kind !== 'element'))
    if (!needsScreenshot || currentComments.length === 0) return snapshot
    if (!isSafeThreadId(threadId)) throw new Error('invalid_thread_id')
    const popupId = this.tabPopupIds.get(tab.tabId)
    const popup = popupId ? this.popups.get(popupId) : undefined
    const restoreVisible = restorePopup && Boolean(popup && !popup.window.isDestroyed() && popup.window.isVisible())
    this.hidePopup(tab.tabId)
    try {
      const requestId = randomUUID()
      const ready = this.waitForScreenshotReady(requestId, tab, threadId)
      tab.webContents?.send('lume:browser-annotation-guest', { type: 'prepare-screenshot', requestId, tabId: tab.tabId, generation: tab.generation, threadId })
      if (!await ready) throw new Error('browser_unavailable')
      const captured = await this.options.captureScreenshot(tab)
      const directory = join(this.options.configDir(), 'browser', 'review-resources', threadId)
      mkdirSync(directory, { recursive: true })
      const id = randomUUID()
      const filename = `${id}.png`
      const ref = `browser-review-screenshot:${threadId}:${id}`
      const path = join(directory, filename)
      if (captured.data.length === 0 || captured.data.length > 20 * 1024 * 1024) return snapshot
      requireWrite(path, captured.data)
      const next = this.store.setScreenshot(threadId, tab.tabId, tab.url, tab.generation, { ref, filename, mode, ...(captured.width ? { width: captured.width } : {}), ...(captured.height ? { height: captured.height } : {}), ...(captured.deviceScaleFactor ? { deviceScaleFactor: captured.deviceScaleFactor } : {}) })
      this.deleteUnreferencedScreenshots(threadId, currentComments.map((comment) => comment.screenshotRef).filter((ref): ref is string => Boolean(ref)), next)
      this.syncGuest(tab, next)
      this.emitSnapshot(next)
      return next
    } finally {
      this.syncGuest(tab, this.store.get(threadId, tab.tabId, tab.url, tab.generation))
      if (restoreVisible && popup && !popup.window.isDestroyed()) popup.window.show()
    }
  }

  async requestBatchSubmit(tab: AnnotationRuntimeTab, threadId: string): Promise<BrowserAnnotationSessionSnapshot> {
    const snapshot = await this.prepareScreenshot(tab, threadId, false)
    this.options.emit('browser:annotation-batch-submit', snapshot as unknown as Record<string, unknown>)
    return snapshot
  }

  setOriginalPreview(tab: AnnotationRuntimeTab, threadId: string, original: boolean): BrowserAnnotationSessionSnapshot {
    const snapshot = this.store.get(threadId, tab.tabId, tab.url, tab.generation)
    if (original) {
      const popupId = this.tabPopupIds.get(tab.tabId)
      const popup = popupId ? this.popups.get(popupId) : undefined
      if (popup && !popup.window.isDestroyed() && popup.window.isVisible()) {
        this.previewHiddenPopupTabs.add(tab.tabId)
        popup.window.hide()
      }
      tab.webContents?.send('lume:browser-annotation-guest', { type: 'close', tabId: tab.tabId, generation: tab.generation, threadId })
      return snapshot
    }
    this.syncGuest(tab, snapshot)
    if (this.previewHiddenPopupTabs.delete(tab.tabId)) {
      const popupId = this.tabPopupIds.get(tab.tabId)
      const popup = popupId ? this.popups.get(popupId) : undefined
      if (popup && !popup.window.isDestroyed()) popup.window.show()
    }
    return snapshot
  }

  readScreenshot(threadId: string, screenshotRef: string): Buffer {
    if (!isSafeThreadId(threadId)) throw new Error('action_denied')
    const match = /^browser-review-screenshot:([a-zA-Z0-9._-]{1,200}):([a-f0-9-]{36})$/i.exec(screenshotRef)
    if (!match || match[1] !== threadId) throw new Error('action_denied')
    const path = join(this.options.configDir(), 'browser', 'review-resources', threadId, `${match[2]}.png`)
    if (!existsSync(path)) throw new Error('stale_target')
    return readFileSync(path)
  }

  isPopupSender(senderId: number): boolean { return this.popups.has(senderId) }

  reposition(tab: AnnotationRuntimeTab): void {
    const popupId = this.tabPopupIds.get(tab.tabId)
    if (!popupId) return
    const popup = this.popups.get(popupId)
    if (!popup) return
    this.positionPopup(tab, popup)
  }

  private syncGuest(tab: AnnotationRuntimeTab, snapshot: BrowserAnnotationSessionSnapshot): void {
    if (!tab.webContents || tab.webContents.isDestroyed()) return
    tab.webContents.send('lume:browser-annotation-guest', {
      type: 'sync', tabId: tab.tabId, generation: tab.generation, threadId: snapshot.threadId, mode: snapshot.mode,
      purpose: snapshot.selectionPurpose ?? 'annotation',
      ...(snapshot.theme ? { theme: snapshot.theme } : {}),
      comments: snapshot.comments.filter((comment) => comment.tab.url === tab.url),
      ...(snapshot.activeDraft?.anchor.url === tab.url ? { activeDraft: snapshot.activeDraft } : {}),
    })
  }

  private deleteUnreferencedScreenshots(threadId: string, refs: string[], snapshot: BrowserAnnotationSessionSnapshot): void {
    for (const ref of new Set(refs)) if (!snapshot.comments.some((comment) => comment.screenshotRef === ref)) this.deleteScreenshotFile(threadId, ref)
  }

  private waitForScreenshotReady(requestId: string, tab: AnnotationRuntimeTab, threadId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.screenshotWaiters.delete(requestId)
        resolve(false)
      }, 1_500)
      this.screenshotWaiters.set(requestId, { tabId: tab.tabId, generation: tab.generation, threadId, timer, resolve })
    })
  }

  private openPopup(tab: AnnotationRuntimeTab, threadId: string, anchor: AgentBrowserAnchor, annotationId: string | undefined, rawAnchor: unknown): void {
    this.closePopup(tab.tabId)
    const parent = this.options.getParentWindow()
    if (!parent || parent.isDestroyed() || !isAbsolute(this.options.annotationPopupPreloadPath)) return
    const popupWidth = browserAnnotationPopupWidth(tab.surfaceBounds?.width)
    const popup = new BrowserWindow({
      parent,
      frame: false,
      transparent: true,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      movable: false,
      skipTaskbar: true,
      width: popupWidth,
      height: 76,
      webPreferences: { preload: this.options.annotationPopupPreloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
    })
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    popup.webContents.on('will-navigate', (event) => event.preventDefault())
    const record: PopupRecord = { window: popup, threadId, tabId: tab.tabId, ...(annotationId ? { annotationId } : {}), anchor, point: anchor.markerPoint ?? { x: anchor.rect.x, y: anchor.rect.y } }
    this.popups.set(popup.webContents.id, record)
    this.tabPopupIds.set(tab.tabId, popup.webContents.id)
    popup.on('closed', () => { this.popups.delete(popup.webContents.id); if (this.tabPopupIds.get(tab.tabId) === popup.webContents.id) this.tabPopupIds.delete(tab.tabId) })
    popup.webContents.once('did-finish-load', () => {
      if (popup.isDestroyed()) return
      popup.webContents.send('lume:browser-annotation-popup-state', {
        sessionId: `${threadId}:${tab.tabId}`,
        ...(annotationId ? { annotationId } : {}),
        body: annotationId ? this.store.get(threadId, tab.tabId, tab.url, tab.generation).comments.find((comment) => comment.id === annotationId)?.body ?? '' : '',
        target: targetLabel(anchor),
        mode: annotationId ? 'edit' : 'add',
        canDelete: Boolean(annotationId),
      })
      this.positionPopup(tab, record)
      popup.show()
    })
    void popup.loadURL(`${this.options.rendererUrl()}${this.options.rendererUrl().includes('?') ? '&' : '?'}view=browser-annotation&popup=1`)
  }

  private positionPopup(tab: AnnotationRuntimeTab, record: PopupRecord): void {
    if (record.window.isDestroyed()) return
    const parent = this.options.getParentWindow()
    const bounds = tab.surfaceBounds
    if (!parent || !bounds) return
    const parentBounds = parent.getContentBounds()
    const viewport = record.anchor.viewport
    const scaleX = viewport?.width ? bounds.width / viewport.width : 1
    const scaleY = viewport?.height ? bounds.height / viewport.height : 1
    const display = screen.getDisplayNearestPoint({ x: parentBounds.x + bounds.x + record.point.x * scaleX, y: parentBounds.y + bounds.y + record.point.y * scaleY })
    const size = record.window.getBounds()
    const position = positionBrowserAnnotationPopup({
      parent: parentBounds,
      surface: bounds,
      point: record.point,
      popup: size,
      ...(viewport ? { viewport } : {}),
      display: display.workArea,
    })
    const current = record.window.getBounds()
    if (current.x !== position.x || current.y !== position.y) record.window.setPosition(position.x, position.y, false)
  }

  private closePopup(tabId: string): void {
    this.previewHiddenPopupTabs.delete(tabId)
    const popupId = this.tabPopupIds.get(tabId)
    if (!popupId) return
    const popup = this.popups.get(popupId)
    if (popup && !popup.window.isDestroyed()) popup.window.close()
    this.popups.delete(popupId)
    this.tabPopupIds.delete(tabId)
  }

  private hidePopup(tabId: string): void {
    const popupId = this.tabPopupIds.get(tabId)
    const popup = popupId ? this.popups.get(popupId) : undefined
    if (popup && !popup.window.isDestroyed()) popup.window.hide()
  }

  private emitSnapshot(snapshot: BrowserAnnotationSessionSnapshot): void { this.options.emit('browser:annotation-state', snapshot as unknown as Record<string, unknown>) }

  handlePopupCommand(senderId: number, raw: unknown): { ok: true } {
    const record = this.popups.get(senderId)
    if (!record || !isRecord(raw)) throw new Error('action_denied')
    const command = text((raw as AnnotationPopupCommand).command, 32)
    if (command === 'cancel') {
      const tab = this.options.resolveTab?.(record.tabId)
      if (tab) {
        const snapshot = this.store.clearDraft(record.threadId, record.tabId, tab.url, tab.generation)
        this.syncGuest(tab, snapshot)
        this.emitSnapshot(snapshot)
      }
      record.window.close()
      return { ok: true }
    }
    if (command === 'resize') {
      let size: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(typeof (raw as AnnotationPopupCommand).body === 'string' ? (raw as AnnotationPopupCommand).body as string : '')
        if (isRecord(parsed)) size = parsed
      } catch { /* retain the default popup size */ }
      const width = bounded(size.width)
      const height = bounded(size.height)
      const current = record.window.getBounds()
      record.window.setSize(Math.round(Math.max(180, Math.min(360, width || current.width))), Math.round(Math.max(76, Math.min(240, height || current.height))))
      const tab = this.options.resolveTab?.(record.tabId)
      if (tab) this.positionPopup(tab, record)
      return { ok: true }
    }
    const tab = this.options.resolveTab?.(record.tabId)
    if (!tab) throw new Error('tab_not_found')
    if (command === 'delete' && record.annotationId) {
      this.delete(tab, record.threadId, record.annotationId)
      record.window.close()
      return { ok: true }
    }
    if (command !== 'add' && command !== 'send') throw new Error('invalid_browser_request')
    const body = text((raw as AnnotationPopupCommand).body, 20_000)
    if (!body) throw new Error('invalid_browser_request')
    const saved = this.saveAttachment(tab, record.threadId, record.annotationId, record.anchor, body)
    record.window.close()
    this.options.emit(command === 'send' ? 'browser:annotation-direct-submit' : 'browser:annotation-added', { threadId: record.threadId, tabId: record.tabId, attachment: saved.attachment, snapshot: saved.snapshot })
    return { ok: true }
  }

  private saveAttachment(tab: AnnotationRuntimeTab, threadId: string, annotationId: string | undefined, anchor: AgentBrowserAnchor, body: string): { attachment: AgentBrowserAnnotationAttachment; snapshot: BrowserAnnotationSessionSnapshot } {
    const session = this.store.get(threadId, tab.tabId, tab.url, tab.generation)
    const existing = annotationId ? session.comments.find((comment) => comment.id === annotationId) : undefined
    const attachment: AgentBrowserAnnotationAttachment = {
      id: annotationId ?? `browser-annotation:${randomUUID()}`,
      origin: 'browser-annotation',
      tab: { id: `browser-tab:${tab.tabId}:${tab.generation}`, origin: 'browser-tab', backend: 'iab', browserId: 'lume-iab', tabId: tab.tabId, ...(tab.providerTabId ? { providerTabId: tab.providerTabId } : {}), title: tab.title, url: tab.url, generation: tab.generation, ...(tab.lastOpenedAt ? { lastOpenedAt: tab.lastOpenedAt } : {}), ...(threadId ? { ownerThreadId: threadId } : {}) },
      anchor,
      body,
      ...(session.theme ? { theme: session.theme } : {}),
      ...(existing?.screenshotRef ? { screenshotRef: existing.screenshotRef, screenshot: existing.screenshot } : {}),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
    const snapshot = this.store.saveComment(attachment)
    this.syncGuest(tab, snapshot)
    this.emitSnapshot(snapshot)
    return { attachment, snapshot }
  }

  private deleteScreenshotFile(threadId: string, screenshotRef: string): void {
    const match = /^browser-review-screenshot:([a-zA-Z0-9._-]{1,200}):([a-f0-9-]{36})$/i.exec(screenshotRef)
    if (!match || match[1] !== threadId) return
    const path = join(this.options.configDir(), 'browser', 'review-resources', threadId, `${match[2]}.png`)
    if (existsSync(path)) unlinkSync(path)
  }
}

function text(value: unknown, max: number): string { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function isSafeThreadId(value: string): boolean { return isSafeBrowserAnnotationThreadId(value) }
function sanitizeRect(value: Record<string, unknown>): { x: number; y: number; width: number; height: number } { return { x: bounded(value.x), y: bounded(value.y), width: Math.max(0, bounded(value.width)), height: Math.max(0, bounded(value.height)) } }
function bounded(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(-100_000, Math.min(100_000, value)) : 0 }
function sanitizeAnchor(value: Record<string, unknown>, url: string, generation: number): AgentBrowserAnchor | undefined {
  if (value.kind !== 'element' && value.kind !== 'text' && value.kind !== 'region') return undefined
  const rect = isRecord(value.rect) ? sanitizeRect(value.rect) : undefined
  if (!rect || typeof value.url !== 'string' || value.url !== url || value.url.length > 4096 || value.generation !== generation) return undefined
  if (value.framePath !== undefined && (!Array.isArray(value.framePath) || value.framePath.length > 16 || !value.framePath.every((item) => typeof item === 'string' && /^\d{1,6}$/.test(item)))) return undefined
  const framePath = Array.isArray(value.framePath) ? value.framePath : []
  const textQuote = isRecord(value.textQuote) && typeof value.textQuote.exact === 'string' && value.textQuote.exact.length <= 20_000
    ? { exact: value.textQuote.exact, ...(typeof value.textQuote.prefix === 'string' ? { prefix: value.textQuote.prefix.slice(0, 1_000) } : {}), ...(typeof value.textQuote.suffix === 'string' ? { suffix: value.textQuote.suffix.slice(0, 1_000) } : {}) }
    : undefined
  const textRange = isRecord(value.textRange) && (!value.textRange.startOffset || Number.isInteger(value.textRange.startOffset)) && (!value.textRange.endOffset || Number.isInteger(value.textRange.endOffset))
    ? { ...(typeof value.textRange.startPath === 'string' ? { startPath: value.textRange.startPath.slice(0, 4_096) } : {}), ...(typeof value.textRange.startOffset === 'number' ? { startOffset: Math.max(0, Math.min(100_000, value.textRange.startOffset)) } : {}), ...(typeof value.textRange.endPath === 'string' ? { endPath: value.textRange.endPath.slice(0, 4_096) } : {}), ...(typeof value.textRange.endOffset === 'number' ? { endOffset: Math.max(0, Math.min(100_000, value.textRange.endOffset)) } : {}) }
    : undefined
  const copy = {
    kind: value.kind, url, generation, framePath, rect,
    ...(typeof value.frameUrl === 'string' && value.frameUrl.length <= 4096 ? { frameUrl: value.frameUrl } : {}),
    ...(typeof value.selector === 'string' && value.selector.length <= 4096 ? { selector: value.selector } : {}),
    ...(typeof value.role === 'string' && value.role.length <= 256 ? { role: value.role } : {}),
    ...(typeof value.name === 'string' && value.name.length <= 512 ? { name: value.name } : {}),
    ...(typeof value.title === 'string' && value.title.length <= 512 ? { title: value.title } : {}),
    ...(typeof value.domPath === 'string' && value.domPath.length <= 4096 ? { domPath: value.domPath } : {}),
    ...(textQuote ? { textQuote } : {}), ...(textRange ? { textRange } : {}),
    ...(typeof value.selectedContent === 'string' ? { selectedContent: value.selectedContent.slice(0, 20_000) } : {}),
    ...(typeof value.immediateText === 'string' ? { immediateText: value.immediateText.slice(0, 20_000) } : {}),
    ...(typeof value.nearbyText === 'string' ? { nearbyText: value.nearbyText.slice(0, 20_000) } : {}),
    ...(isRecord(value.viewport) ? { viewport: { width: bounded(value.viewport.width), height: bounded(value.viewport.height), ...(typeof value.viewport.deviceScaleFactor === 'number' ? { deviceScaleFactor: Math.max(0.1, Math.min(10, value.viewport.deviceScaleFactor)) } : {}), ...(typeof value.viewport.scrollX === 'number' ? { scrollX: bounded(value.viewport.scrollX) } : {}), ...(typeof value.viewport.scrollY === 'number' ? { scrollY: bounded(value.viewport.scrollY) } : {}) } } : {}),
    ...(isRecord(value.markerPoint) ? { markerPoint: { x: bounded(value.markerPoint.x), y: bounded(value.markerPoint.y) } } : {}),
    ...(typeof value.fixed === 'boolean' ? { fixed: value.fixed } : {}),
  }
  return copy as AgentBrowserAnchor
}
function targetLabel(anchor: AgentBrowserAnchor): string { return anchor.textQuote?.exact?.slice(0, 80) || anchor.title || anchor.selector || anchor.domPath || (anchor.kind === 'region' ? '所选区域' : '所选元素') }
function browserAnnotationPopupWidth(surfaceWidth: number | undefined): number {
  if (!surfaceWidth || !Number.isFinite(surfaceWidth)) return 260
  return Math.round(Math.max(180, Math.min(280, surfaceWidth * 0.56, surfaceWidth - 16)))
}
function sanitizeStyles(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).slice(0, 32).filter(([key, item]) => /^[a-zA-Z][a-zA-Z0-9-]{0,127}$/.test(key) && typeof item === 'string').map(([key, item]) => [key, (item as string).slice(0, 4096)]))
}
function requireWrite(path: string, data: Buffer): void { writeFileSyncSafe(path, data) }
function writeFileSyncSafe(path: string, data: Buffer): void { writeFileSync(path, data, { mode: 0o600 }) }
