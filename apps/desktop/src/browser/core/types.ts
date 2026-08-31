/**
 * 浏览器核心契约 —— 全部 browser/core 模块的公共类型。
 *
 * 本文件是重写的"施工接口":各模块(guest-manager/residency/executor/input/
 * screenshot-surface/recording/dialog-controller)只依赖此处类型与 errors,
 * 相互之间不直接 import,由 guest-manager 装配。
 *
 * 语义来源:ZCode 桌面端逆向还原(见 docs/plans/2026-08-30-browser-rewrite-design.md
 * 与 .zcode/analysis/extracted/)。命名与 ZCode 原始函数名对齐。
 */
import type { BrowserWindow } from "electron"

/* ── 驻留 ─────────────────────────────────────────────────────────── */

export type BrowserResidency =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring"

export type BrowserLifecycle = "active" | "closed" | "deliverable" | "handoff"

/* ── 命令上下文(归属五元组) ───────────────────────────────────────── */

export interface BrowserOwnerContext {
  requestId: string
  browserId: string
  browserGeneration: number
  windowId: number
  workspaceKey: string
  remoteSessionId?: string
  sessionId: string
  clientMode: "desktop-continuous" | "web-remote-replayable"
  turnId?: string
  /** 旧版单参数上下文(attachGuest 直传 tabId 字符串时构造) */
  legacy?: boolean
}

export function scopeKey(owner: BrowserOwnerContext): string {
  return owner.legacy
    ? "legacy"
    : [owner.browserId, String(owner.browserGeneration), String(owner.windowId), owner.workspaceKey, owner.remoteSessionId ?? "", owner.sessionId, owner.clientMode].join("\0")
}

export function sameScope(a: BrowserOwnerContext, b: BrowserOwnerContext): boolean {
  return (a.legacy === true && b.legacy === true) || scopeKey(a) === scopeKey(b)
}

/* ── tab 记录(管理器内部态) ───────────────────────────────────────── */

export interface GuestMountGrant {
  token: string
  tabId: string
  generation: number
  partition: string
  ownerWebContentsId: number
  expiresAt: number
  state: "issued" | "attaching"
}

export interface BrowserViewportOverride {
  width: number
  height: number
}

export interface BrowserDialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload"
  message: string
  defaultPrompt?: string
}

export interface BrowserDownloadRecord {
  tabId: string
  path: string | null
  state: "pending" | "completed" | "cancelled" | "interrupted"
}

export interface BrowserRecordingRecord {
  id: string
  context: BrowserOwnerContext
  tabId: string
  controller: AbortController
  status: "running" | "completed" | "cancelled" | "failed"
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "cancelled" | "failed"
  progress: number
  startedAt: number
  updatedAt: number
  artifact?: { path: string; mimeType: string; width: number; height: number; fps: number; durationMs: number; frameCount: number }
  error?: string
  cleanupTimer?: ReturnType<typeof setTimeout>
}

export interface BrowserTabRecord {
  tabId: string
  owner: BrowserOwnerContext
  /** 释放给用户后的原始归属(unclaimed 形态) */
  userOwner?: BrowserOwnerContext
  guest?: Electron.WebContents
  guestLifecycle: "detached" | "attached" | "detaching" | "destroyed"
  guestGeneration: number
  hasAttachedGuest: boolean
  rebindRequested: boolean
  attachFailure?: string
  guestTeardownFlight?: Promise<boolean>
  cdpAttached: boolean
  pendingCdpCommands: number
  lifecycle: BrowserLifecycle
  origin: "agent" | "user"
  claimable: boolean
  active: boolean
  loading: boolean
  mediaActive: boolean
  cachedUrl: string
  cachedTitle: string
  cachedFaviconUrl: string | null
  openedAt: number
  viewportOverride?: BrowserViewportOverride
  backgroundViewportFallback?: BrowserViewportOverride
  desktopZoomFactor?: number
  viewportMutation?: Promise<void>
  mountToken?: string
  dialogInfo?: BrowserDialogInfo
  downloads: Map<string, BrowserDownloadRecord>
  downloadWaiters: Array<{ resolve: (downloadId: string | null) => void; timer: ReturnType<typeof setTimeout>; signal?: AbortSignal; onAbort?: () => void }>
  queuedDownloads: string[]
}

/* ── 命令与结果 ───────────────────────────────────────────────────── */

export interface BrowserCommand {
  method: string
  params?: Record<string, unknown>
}

export interface BrowserCommandError {
  code: string
  message: string
  sideEffect?: "none" | "uncertain"
}

export interface BrowserResultMeta {
  browserUse: true
  backendType: "iab"
  browserId: string
  browserGeneration: number
  openTabIds: string[]
  tabId?: string
  currentUrl?: string
  lifecycle?: BrowserLifecycle
}

export interface BrowserCommandResult {
  ok: boolean
  elapsedMs?: number
  error?: BrowserCommandError
  meta?: BrowserResultMeta
  [key: string]: unknown
}

/* ── 受控视图(执行器操作面) ───────────────────────────────────────── */

export interface ControlledWebContents {
  loadURL(url: string): Promise<unknown>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  goBack(): void
  goForward(): void
  reload(): void
  executeJavaScript(code: string): Promise<unknown>
}

export interface ControlledView {
  webContents: ControlledWebContents
  cdp: { send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> }
  /** 表面协议就绪后的 Electron capturePage 通道 */
  captureViewportScreenshot?: () => Promise<string | undefined>
  normalizeScreenshotToCssPixels: boolean
  resizeScreenshotToCssPixels?: (base64: string, viewport: { width: number; height: number }) => Promise<string | undefined>
}

/* ── 装配依赖(由宿主 main 注入) ───────────────────────────────────── */

export type BrowserEventSink = (event: { method: string; params: Record<string, unknown> }) => void

export interface BrowserManagerDeps {
  log: (message: string) => void
  warn: (message: string, error?: unknown) => void
  emit: BrowserEventSink
  getWindow: () => BrowserWindow | null
  /** webContents.fromId 的可注入形态(测试用) */
  webContentsFromId: (id: number) => Electron.WebContents | undefined
  /** Electron webContents 类型守卫:guest 必须是 webview */
  isWebviewType: (contents: Electron.WebContents) => boolean
  /** 文本右键菜单弹层(ZCode Pve + Menu.popup;缺省不挂菜单) */
  popupContextMenu?: (guest: Electron.WebContents, params: { selectionText?: string; editFlags?: { canCopy?: boolean }; x: number; y: number }) => void
  attachTimeoutMs?: number
  tabLimit?: number
  now?: () => number
  screenshotSurfaceCoordinator?: ScreenshotSurfaceCoordinatorPort
  resizeScreenshotToCssPixels?: (base64: string, viewport: { width: number; height: number }) => Promise<string | undefined>
  recording?: { createRecorder: (options: RecordingRecorderOptions) => Promise<RecordingRecorder>; tempRoot?: string }
}

/* ── 截图表面协议端口(实现见 screenshot-surface.ts) ─────────────────── */

export interface ScreenshotSurfacePrepareRequest {
  requestId: string
  windowId: number
  workspaceKey: string
  sessionId: string
  browserId: string
  browserGeneration: number
  tabId: string
  webContentsId: number
  viewport: { width: number; height: number }
  surfaceScaleMode?: "current" | "unscaled"
  signal: AbortSignal
  activityTimeoutMs?: number
}

export interface ScreenshotSurfaceLease {
  invalidated: AbortSignal
  surfaceScale: number
  webContentsId: number
  viewport: { width: number; height: number }
  release: () => void
}

export interface ScreenshotSurfaceCoordinatorPort {
  prepare(request: ScreenshotSurfacePrepareRequest): Promise<ScreenshotSurfaceLease>
}

/* ── 录制端口(实现见 recording/) ──────────────────────────────────── */

export interface RecordingRecorderOptions {
  outputPath: string
  targetFrame: Electron.WebFrameMain
  viewport: { width: number; height: number }
  fps: number
  signal: AbortSignal
}

export interface RecordingRecorder {
  stop(): Promise<void>
  cancel(): Promise<void>
}

export interface RecordingScenarioCommand {
  method: string
  params?: Record<string, unknown>
}

/* ── 错误码(ZCode 稳定码) ─────────────────────────────────────────── */

export const BROWSER_ERROR_CODES = [
  "duplicate_request_id",
  "navigation_blocked",
  "timeout",
  "execution_error",
  "cancelled",
  "capability_unsupported",
  "backend_unavailable",
  "browser_internal_error",
] as const

export type BrowserErrorCode = (typeof BROWSER_ERROR_CODES)[number]

export class BrowserNavigationTimeoutError extends Error {
  override name = "BrowserNavigationTimeoutError"
}

export function browserError(code: string): Error {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}

export function stableBrowserErrorCode(error: unknown): string {
  const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : error instanceof Error ? error.message : ""
  return (BROWSER_ERROR_CODES as readonly string[]).includes(code) ? code : "browser_internal_error"
}
