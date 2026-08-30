import { createRoot } from 'react-dom/client'
import { contextBridge, ipcRenderer } from 'electron'
import type { AgentBrowserDesignDeclaration } from '@lume/shared'
import { createWebMcpShim } from './webmcp-shim'
import { AnnotationOverlay } from './browser-overlay/AnnotationOverlay'
import { createGuestBridge } from './browser-overlay/guest-state'
import { overlayStyles } from './browser-overlay/overlay.css'

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

// 顶层 IPC 缓冲：did-navigate 在 DOMContentLoaded 之前触发，sync/restore 消息会在
// bridge / GuestAnnotationRuntime 注册 listener 之前到达 → 永久丢失 → 导航回来注释消失。
// preload 加载时立即注册 listener 缓冲早期 sync/restore；start() 一次性取出交付两个消费者。
let pendingGuestMessage: unknown = null
let guestBridgeReady = false

ipcRenderer.on('lume:browser-annotation-guest', (_event, raw: unknown) => {
  if (!raw || typeof raw !== 'object') return
  const m = raw as Record<string, unknown>
  if (m.type === 'close') { pendingGuestMessage = null; return }
  if (m.type === 'sync' || m.type === 'restore') {
    if (guestBridgeReady) return // bridge 已就绪，由消费者自身 listener 处理
    pendingGuestMessage = raw
  }
})

// start() 调用：取出缓冲消息并标记就绪（此后新消息直交消费者 listener）
function takePendingGuestMessage(): unknown {
  const msg = pendingGuestMessage
  pendingGuestMessage = null
  guestBridgeReady = true
  return msg
}

const bootstrapUrl = window.location.href
if (bootstrapUrl.startsWith('about:blank#lume-browser-mount=')) ipcRenderer.send('lume:browser-guest-mounted', bootstrapUrl)

// DOM 加载前注入 Web MCP（additive：不影响下方 GuestAnnotationRuntime 注释 overlay）。
qe()

const start = () => {
  const pending = takePendingGuestMessage()
  new GuestAnnotationRuntime().start(pending)
  startReactOverlay(pending)
}
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', start, { once: true })
else start()

// Plan 8 Task 101/102：React AnnotationOverlay 作为唯一渲染层。
// Shadow DOM host + overlayStyles + createGuestBridge + createRoot render。
// host 标记 data-lume-annotation-overlay；Task 102 已退役原生 DOM 渲染层，
// 本 overlay 独占注释渲染（marker/preview/editor/interaction/hover/cursor），
// GuestAnnotationRuntime 仅保留 IPC dispatch + syncFrames iframe 骨架。
function startReactOverlay(pendingMessage?: unknown): void {
  if (document.querySelector('div[data-lume-annotation-overlay]')) return
  const host = document.createElement('div')
  host.setAttribute('data-lume-annotation-overlay', '')
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:layout style;'
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = overlayStyles
  shadow.append(style)
  document.documentElement.append(host)
  const bridge = createGuestBridge(pendingMessage)
  createRoot(shadow).render(<AnnotationOverlay bridge={bridge} host={host} />)
}

// Web MCP 注入（移植自 Codex comment-preload.js qe()）。
//
// 设计要点（对齐 Codex qe()，键名 __lumeWebMcpModelContext 替代 __codexWebMcpModelContext）：
// - 开关：主进程 sync IPC `lume:get-browser-webmcp-enabled`（Task 83 main.ts 处理；
//   未配置/返回非 true 时默认关闭）。
// - shim：createWebMcpShim({locationLike: location})。工具变更通知推送链
//   （lume:browser-page-event → browser:webmcp-changed）已移除——无任何消费方，
//   消费侧始终按需拉取 webmcp:list。
// - 暴露：contextBridge.exposeInMainWorld('__lumeWebMcpModelContext', shim) +
//   Object.defineProperty(document/navigator, 'modelContext', {configurable:false,
//   enumerable:false, writable:false})。
// - 容错：每步 try/catch，已存在或失败均忽略（不破坏第三方页面加载）。
export function qe(): void {
  let enabled = false
  try {
    enabled = ipcRenderer.sendSync('lume:get-browser-webmcp-enabled') === true
  } catch {
    enabled = false
  }
  if (!enabled) return

  const shim = createWebMcpShim({
    locationLike: { origin: window.location.origin, href: window.location.href },
  })

  try {
    contextBridge.exposeInMainWorld('__lumeWebMcpModelContext', shim)
  } catch {
    // 已存在或不可用则忽略（不破坏页面加载）
  }

  const descriptor: PropertyDescriptor = { value: shim, configurable: false, enumerable: false, writable: false }
  try { Object.defineProperty(document, 'modelContext', descriptor) } catch { /* 已存在则保留既有定义 */ }
  try { Object.defineProperty(navigator, 'modelContext', descriptor) } catch { /* 已存在则保留既有定义 */ }
}

// Plan 8 Task 102：GuestAnnotationRuntime 仅保留 IPC dispatch。
//
// 渲染职责已交由 React AnnotationOverlay（startReactOverlay 挂载于顶层 document）。
// 本类维持：
// - 主进程 IPC 监听（lume:browser-annotation-guest）：close/sync/restore/prepare-screenshot
// - 状态校验 + 应用到顶层 AnnotationDocumentRuntime（iframe 骨架）
// - 出站 IPC：screenshot-ready（prepare-screenshot 回执）
// 其余出站消息（open-editor/mode-changed/preview-open/preview-close/anchor-state 等）
// 改由 React overlay（useAnnotationInteraction / createGuestBridge.send）发起。
class GuestAnnotationRuntime {
  private state: GuestState | null = null
  private top: AnnotationDocumentRuntime | null = null
  private frameRefreshTimer = 0

  start(pendingMessage?: unknown): void {
    if (this.top) return
    this.top = new AnnotationDocumentRuntime(document, window, [])
    this.top.start()
    ipcRenderer.on('lume:browser-annotation-guest', (_event, raw: unknown) => this.receive(raw))
    // 交付 preload 顶层缓冲的早期 sync/restore（did-navigate 早于 DOMContentLoaded）
    if (pendingMessage !== undefined && pendingMessage !== null) this.receive(pendingMessage)
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
      // DOM 渲染已退役：原 setScreenshotPrepared（隐藏 marker/preview）不再适用，
      // React overlay 的截图前隐藏留待后续 task（overlay 层感知 prepare-screenshot）。
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
    this.top?.applyState(this.state)
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.state || JSON.stringify(payload).length > 1_000_000) return
    ipcRenderer.send('lume:browser-annotation-guest', { ...payload, tabId: this.state.tabId, generation: this.state.generation, threadId: this.state.threadId })
  }
}

// Plan 8 Task 102：iframe 遍历骨架（DOM 渲染层已退役）。
//
// 渲染由顶层 React AnnotationOverlay 独占（不进入子 iframe 文档）。本类仅维持：
// - syncFrames：遍历同源 iframe → 创建子 runtime → 递归 applyState/destroy
// - crossOriginFrames：记录跨域 frame（保留供未来扩展，如截图流程或子 iframe 渲染）
// 子 iframe 内的批注渲染留待后续 task 评估；当前骨架保证 iframe 递归能力不丢失
// （manager 截图/同步流程仍可遍历到嵌套 frame）。
class AnnotationDocumentRuntime {
  private state: GuestState | null = null
  private children = new Map<string, AnnotationDocumentRuntime>()
  private crossOriginFrames = new Map<string, HTMLIFrameElement>()
  private initialized = false

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly framePath: string[],
  ) {}

  start(): void {
    if (this.initialized) return
    this.initialized = true
    this.syncFrames()
  }

  applyState(state: GuestState | null): void {
    this.state = state
    this.syncFrames()
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
          child = new AnnotationDocumentRuntime(childDocument, childWindow, path)
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
    this.children.forEach((child) => child.destroy())
    this.children.clear()
    this.crossOriginFrames.clear()
  }
}

// 设计编辑 declaration baseline：逐属性输出 AgentBrowserDesignDeclaration，
// previousValue 初始 = value（Codex A.6 对齐）。键集：20 CSS 属性 + textContent。
export function styleSnapshotDeclarations(element: Element, win: Window): AgentBrowserDesignDeclaration[] {
  const computed = win.getComputedStyle(element)
  const keys = ['color', 'backgroundColor', 'fontFamily', 'fontSize', 'fontWeight', 'borderRadius', 'borderWidth', 'borderStyle', 'borderColor', 'width', 'height', 'display', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'rowGap', 'columnGap', 'padding', 'margin']
  const declarations: AgentBrowserDesignDeclaration[] = keys.map((property) => {
    const value = String(computed.getPropertyValue(property) || '').slice(0, 4096)
    return { property, value, previousValue: value }
  })
  const text = String(element.textContent ?? '').slice(0, 4096)
  if (text) declarations.push({ property: 'textContent', value: text, previousValue: text })
  return declarations
}

function boundedText(value: unknown, max: number): string { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function safeThemeColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128 || !CSS.supports('color', value)) return undefined
  return value
}
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
