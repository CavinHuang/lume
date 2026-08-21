import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, session, shell, type IpcMainEvent } from "electron"
import {
  BROWSER_PROTOCOL_MAX_SUPPORTED,
  BROWSER_PROTOCOL_MIN_SUPPORTED,
  BROWSER_PROTOCOL_VERSION,
  DEFAULT_BROWSER_SETTINGS,
  type BrowserActionRequest,
  type BrowserAuthFieldRequest,
  type BrowserAuthOption,
  type BrowserAuthRequest,
  type BrowserAuthResult,
  type BrowserErrorCode,
  type BrowserExtensionDescriptor,
  type BrowserHistoryEntry,
  type BrowserGuestMountDescriptor,
  type BrowserLocator,
  type BrowserRequestContext,
  type BrowserRuntimeDescriptor,
  type BrowserSettings,
  type BrowserSitePermissionOverride,
  type BrowserTabDescriptor,
  type BrowserViewportPreset,
  type BrowserViewportState,
} from "../../../packages/shared/src/types/browser-runtime"
import { BROWSER_API_REGISTRY, browserApiSupportForBackend, browserMutatingRuntimeMethods } from "../../../packages/shared/src/browser-api-registry"
import {
  selectBrowserPartition,
  shouldInstallAdvancedCdpPolicy,
  shouldInstallAgentSessionPolicy,
} from "./browser-runtime-policy"
import { browserLocatorScript, isBrowserLocator, validateBrowserLocator, type BrowserLocatorQuery, type ResolvedBrowserTarget } from "./browser-locator"
import { createCursorUpdateScript } from "./browser-cursor"
import { canAgentClaim, canAgentUse, revokeSharedLease } from "./browser-sharing-policy"
import { isIP } from "node:net"
import { BrowserNetworkGuard, isPublicAddress } from "./browser-network-guard"
import { BrowserAuditLog } from "./browser-audit"
import { AGENT_DOWNLOAD_LIMITS, AgentDownloadQuota, BrowserDownloadHistory, completeDownload, prepareDownload, removePartialDownload, safeDownloadFilename } from "./browser-downloads"
import { BrowserCredentialVault } from "./browser-credentials"
import { BrowserWorkspaceStore } from "./browser-workspace-store"
import { BrowserReferenceGrantStore } from "./browser-reference-grants"
import { BrowserAnnotationManager } from "./browser-annotation-manager"
import { buildBrowserSemanticTree, type BrowserSemanticLine, type BrowserSemanticRef } from "./browser-semantic-snapshot"
import { normalizeBrowserAgentScriptResult, prepareBrowserAgentScript, type BrowserAgentScriptResult } from "./browser-agent-script"

type BrowserEvent = { method: string; params: Record<string, unknown> }
type BrowserRuntimeOptions = {
  getWindow: () => BrowserWindow | null
  configDir: () => string
  emit: (event: BrowserEvent) => void
  isAgentPluginEnabled?: () => boolean
  initialSettings?: Partial<BrowserSettings>
  persistSettings?: (settings: BrowserSettings) => void
  journalEncryption?: { available: boolean; encrypt: (value: string) => Buffer; decrypt?: (value: Buffer) => string }
  credentialStorage: { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
  authPreloadPath?: string
  onInternalError?: (details: { method: string; actor: BrowserRequestContext["actor"]; tabId?: string; message: string }) => void
}

type BrowserTab = BrowserTabDescriptor & {
  webContents: Electron.WebContents | null
  partition: string
  context?: BrowserRequestContext
  inputSequence: number
  agentDispatching?: boolean
  lastUserActivationAt?: number
  dialogOpen?: boolean
  dialogInfo?: { id: string; type: "alert" | "beforeunload" | "confirm" | "prompt"; message?: string; defaultValue?: string }
  recentAgentContext?: { browserSessionId: string; browserTurnId: string; expiresAt: number }
  agentLease?: { browserSessionId: string; browserTurnId: string; generation: number }
  agentViewportOverride?: { browserSessionId: string; browserTurnId: string; previous: BrowserViewportState }
  handoff?: { browserSessionId: string; status: "handoff" | "deliverable"; reason?: string }
  approvedPrivateOrigins?: Set<string>
  findRequestId?: number
  findMatches?: { activeMatchOrdinal: number; matches: number }
  navigationStack: string[]
  navigationIndex: number
  pendingNavigationIndex?: number
  consoleLogs: Array<{ level: "debug" | "info" | "log" | "warn" | "error"; message: string; timestamp: string; url?: string }>
  domNodes?: Map<string, { generation: number; x: number; y: number }>
  surfaceBounds?: Electron.Rectangle
  pendingUrl?: string
  mountToken?: string
  mountWaiters: Array<{ resolve: (contents: Electron.WebContents) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>
  viewportQueue: Promise<void>
}

type BrowserGuestMountGrant = {
  token: string
  tabId: string
  generation: number
  partition: string
  ownerWebContentsId: number
  expiresAt: number
  state: "issued" | "attaching"
}

type JournalEntry = {
  operationId: string
  method: string
  tabGeneration: number
  parameterHash: string
  status: "prepared" | "committed" | "acknowledged" | "executed_unknown"
  timestamp: number
}

type SessionPolicy = {
  session: Electron.Session
  partition: string
  agent: boolean
  disposed: boolean
  downloadHandler?: (...args: any[]) => void
  networkGuard?: BrowserNetworkGuard
  networkReady?: Promise<void>
}

type BrowserDownloadWaiter = {
  browserSessionId: string
  browserTurnId: string
  resolve: (value: { download_id: string }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type BrowserFileChooserWaiter = {
  browserSessionId: string
  browserTurnId: string
  resolve: (value: { file_chooser_id: string; is_multiple: boolean }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const FILE_CHOOSER_IDLE_EXPIRY_MS = 120_000

type BrowserFileChooserEntry = {
  tabId: string
  backendNodeId: number
  isMultiple: boolean
  browserSessionId: string
  browserTurnId: string
  generation: number
  expiryTimer?: ReturnType<typeof setTimeout>
}

type BrowserPageAsset = {
  id: string
  kind: "script" | "font" | "image" | "stylesheet" | "video" | "other"
  name: string
  sources: Array<{ kind: "attribute" | "computedStyle" | "resource"; nodeId?: number; property?: string }>
  url: string
}

type BrowserPageAssetInventory = {
  id: string
  tabId: string
  generation: number
  browserSessionId: string
  browserTurnId: string
  assets: BrowserPageAsset[]
}

type BrowserSemanticRefSession = {
  byIdentity: Map<string, string>
  entries: Map<string, BrowserSemanticRef & { generation: number; snapshotId: string; tabId: string }>
  nextRef: number
}

type BrowserSemanticSnapshotCursor = {
  generation: number
  limit: number
  lines: BrowserSemanticLine[]
  offset: number
  refs: BrowserSemanticRef[]
  sessionId: string
  snapshotId: string
  tabId: string
  title: string
  url: string
}

type BrowserAuthSession = {
  window: BrowserWindow
  tabId: string
  generation: number
  inputSequence: number
  origin: string
  request: BrowserAuthRequest
  settled: boolean
  timer: ReturnType<typeof setTimeout>
  resolve: (result: BrowserAuthResult) => void
}

const MUTATING_METHODS = new Set([
  ...browserMutatingRuntimeMethods(),
  "navigate", "back", "forward", "reload", "click", "doubleClick", "hover", "fill", "type", "typeActive",
  "press", "pressActive", "select", "check", "uncheck", "scroll", "drag", "contactFill", "dialog:handle",
  "upload", "pageAssets:bundle", "webmcp:invoke", "agentScript:evaluate",
])
const GUEST_OPTIONAL_METHODS = new Set([
  "url", "title", "site-info", "dialog:get", "secrets:list", "wait:download", "download:path",
  "screenshot:attachment:delete", "clipboard:read", "clipboard:readText", "clipboard:write", "clipboard:writeText",
  "annotation:session", "annotation:mode", "annotation:clear", "annotation:delete",
  "annotation:preview", "annotation:screenshot:prepare", "annotation:submit", "annotation:screenshot:read",
  "annotation:resolve", "annotation:mark-read",
])
const REGISTERED_BROWSER_RUNTIME_METHODS = new Set(BROWSER_API_REGISTRY.map((entry) => entry.runtimeMethod))

export class BrowserRuntime {
  private readonly tabs = new Map<string, BrowserTab>()
  private readonly guestMounts = new Map<string, BrowserGuestMountGrant>()
  private readonly sessionPolicies = new WeakMap<Electron.Session, SessionPolicy>()
  private readonly ownedSessionPolicies = new Set<SessionPolicy>()
  private settings: BrowserSettings
  private backendGeneration = 1
  private readonly journal: BrowserOperationJournal
  private readonly audit: BrowserAuditLog
  private readonly downloadQuota = new AgentDownloadQuota()
  private readonly downloadHistory: BrowserDownloadHistory
  private readonly browsingHistory: BrowserHistoryStore
  private readonly extensions: BrowserExtensionStore
  private readonly credentials: BrowserCredentialVault
  private readonly workspaces: BrowserWorkspaceStore
  private readonly referenceGrants = new BrowserReferenceGrantStore()
  private readonly annotations: BrowserAnnotationManager
  private readonly semanticRefSessions = new Map<string, BrowserSemanticRefSession>()
  private readonly semanticSnapshotCursors = new Map<string, BrowserSemanticSnapshotCursor>()
  private annotationSweepTimer: ReturnType<typeof setTimeout> | null = null
  private annotationSweepInterval: ReturnType<typeof setInterval> | null = null
  private agentPluginEnabled = false
  private cursorOverlay: BrowserWindow | null = null
  private cursorState: { x: number; y: number; pulse: boolean } | null = null
  private readonly popupTokens = new Map<string, { sourceTabId: string; url: string; expiresAt: number }>()
  private readonly policyTokens = new Map<string, { bindingHash: string; expiresAt: number }>()
  private readonly downloadRefs = new Map<string, { path: string; browserSessionId: string; browserTurnId: string }>()
  private readonly sessionNames = new Map<string, string>()
  private readonly claimSnapshots = new Map<string, { tabId: string; providerTabId?: string; title: string; url: string; generation: number }>()
  private readonly downloadWaiters = new Map<string, BrowserDownloadWaiter[]>()
  private readonly downloadResults = new Map<string, { browserSessionId: string; browserTurnId: string; state: "pending" | "completed" | "failed"; fileRef?: string; waiters: Array<(value: string | null) => void> }>()
  private readonly fileChooserWaiters = new Map<string, BrowserFileChooserWaiter[]>()
  private readonly fileChoosers = new Map<string, BrowserFileChooserEntry>()
  private readonly pageAssetInventories = new Map<string, BrowserPageAssetInventory>()
  private readonly authSessions = new Map<number, BrowserAuthSession>()
  private readonly browserAuthMessageHandler = (event: IpcMainEvent, payload: unknown): void => {
    const auth = this.authSessions.get(event.sender.id)
    if (!auth || auth.window.isDestroyed()) return
    void this.handleBrowserAuthMessage(auth, payload)
  }
  private readonly browserAnnotationGuestMessageHandler = (event: IpcMainEvent, payload: unknown): void => {
    const tab = this.tabForContents(event.sender)
    if (tab) this.annotations.onGuestMessage(tab, payload)
  }
  private readonly loginHandler = (event: Electron.Event, webContents: Electron.WebContents, _details: Electron.AuthenticationResponseDetails, authInfo: Electron.AuthInfo, callback: (username?: string, password?: string) => void): void => {
    const tab = this.tabForContents(webContents)
    if (!tab) return
    event.preventDefault()
    if (tab.context?.actor === "agent") { callback(); return }
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) { callback(); return }
    void dialog.showMessageBox(win, { type: "warning", buttons: ["知道了"], title: "HTTP 身份验证", message: `${authInfo.host} 请求 HTTP 身份验证。`, detail: "Lume 不会把 HTTP Auth 凭据交给 Agent。请改用网页登录或系统浏览器。" }).finally(() => callback())
  }
  private readonly certificateErrorHandler = (event: Electron.Event, webContents: Electron.WebContents, url: string, error: string, _certificate: Electron.Certificate, callback: (isTrusted: boolean) => void): void => {
    const tab = this.tabForContents(webContents)
    if (!tab) return
    event.preventDefault()
    if (tab.context?.actor === "agent") { callback(false); return }
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) { callback(false); return }
    void dialog.showMessageBox(win, { type: "warning", buttons: ["仅此次继续", "返回安全页面"], defaultId: 1, cancelId: 1, title: "证书验证失败", message: `${safeOrigin(url) ?? "此网站"} 的证书无法验证。`, detail: error.slice(0, 160) }).then((result) => callback(result.response === 0)).catch(() => callback(false))
  }
  private readonly clientCertificateHandler = (event: Electron.Event, webContents: Electron.WebContents, url: string, certificates: Electron.Certificate[], callback: (certificate?: Electron.Certificate) => void): void => {
    const tab = this.tabForContents(webContents)
    if (!tab) return
    event.preventDefault()
    if (tab.context?.actor === "agent" || certificates.length === 0) { callback(); return }
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) { callback(); return }
    const choices = certificates.slice(0, 8)
    void dialog.showMessageBox(win, { type: "question", buttons: [...choices.map((certificate) => certificate.subjectName || "未命名证书"), "取消"], defaultId: choices.length, cancelId: choices.length, title: "选择客户端证书", message: `${safeOrigin(url) ?? "此网站"} 请求客户端证书。` }).then((result) => callback(choices[result.response])).catch(() => callback())
  }

  constructor(private readonly options: BrowserRuntimeOptions) {
    this.settings = { ...DEFAULT_BROWSER_SETTINGS, ...(options.initialSettings ?? {}) }
    if (this.settings.annotationScreenshots === "ask") this.settings.annotationScreenshots = "necessary"
    this.journal = new BrowserOperationJournal(options.configDir, options.journalEncryption)
    this.audit = new BrowserAuditLog(options.configDir)
    this.downloadHistory = new BrowserDownloadHistory(options.configDir)
    this.browsingHistory = new BrowserHistoryStore(options.configDir)
    this.extensions = new BrowserExtensionStore(options.configDir)
    this.credentials = new BrowserCredentialVault(options.configDir, options.credentialStorage)
    this.workspaces = new BrowserWorkspaceStore(options.configDir)
    nativeTheme.on("updated", this.onThemeUpdated)
    this.annotations = new BrowserAnnotationManager({
      configDir: options.configDir,
      emit: (method, params) => this.options.emit({ method, params }),
      getScreenshotMode: () => this.settings.annotationScreenshots === 'always' ? 'always' : this.settings.annotationScreenshots === 'off' ? 'off' : 'necessary',
      captureScreenshot: async (tab) => {
        const data = Buffer.from(await this.screenshot(tab as BrowserTab, { fullPage: false }), 'base64')
        const image = nativeImage.createFromBuffer(data)
        const size = image.getSize()
        return { data: image.toPNG(), width: size.width, height: size.height, deviceScaleFactor: tab.zoomFactor ?? 1 }
      },
    })
    void this.restoreBrowserExtensions()
    // 历史存量孤儿截图 GC(#188)：启动后延迟跑一次 + 每 24h 一次，unref 不阻塞退出；
    // 增量丢弃路径(FIFO 淘汰/评论截断)已由 #130 即时清理，此处只兜存量
    this.annotationSweepTimer = setTimeout(() => {
      this.annotationSweepTimer = null
      this.annotations.runOrphanScreenshotSweep()
    }, 30_000)
    this.annotationSweepTimer.unref?.()
    this.annotationSweepInterval = setInterval(() => this.annotations.runOrphanScreenshotSweep(), 24 * 60 * 60_000)
    this.annotationSweepInterval.unref?.()
    app.on("login", this.loginHandler)
    app.on("certificate-error", this.certificateErrorHandler)
    app.on("select-client-certificate", this.clientCertificateHandler)
    ipcMain.on("lume:browser-auth", this.browserAuthMessageHandler)
    ipcMain.on("lume:browser-annotation-guest", this.browserAnnotationGuestMessageHandler)
  }

  descriptor(): BrowserRuntimeDescriptor {
    const capabilities = [
      { id: "tabs", description: "Create, close, switch and inspect in-app tabs." },
      { id: "navigation", description: "Navigate and control ordinary HTTP(S) pages." },
      { id: "locator-actions", description: "Use the constrained snapshot and locator input facade." },
      { id: "semanticSnapshot", description: "Read a compact accessibility-tree snapshot with stable element references." },
      { id: "agentScript", description: "Run a bounded, confirmed Agent script in an isolated world on its task-owned tab." },
      { id: "screenshot", description: "Capture viewport or full-page screenshots." },
      { id: "agentCursor", description: "Show the virtual Agent cursor for controlled actions." },
      { id: "guardedUpload", description: "Upload only task-bound Lume file references after confirmation." },
      { id: "agentDownload", description: "Save confirmed downloads to a quota-bound task resource directory." },
      { id: "history", description: "Persist and inspect the user browser history after explicit approval." },
      { id: "responsiveViewport", description: "Apply per-tab responsive viewport overrides." },
      { id: "tabContent", description: "Read bounded page content from controlled tabs." },
      { id: "pageAssets", description: "Inventory and export bounded assets observed in the current page state." },
      { id: "webmcp", description: "Invoke page-defined WebMCP tools announced by browser notifications." },
      { id: "devLogs", description: "Read bounded console logs captured for a controlled tab." },
      { id: "visibility", description: "Show or hide tabs owned by the current browser session." },
      { id: "viewport", description: "Set or reset a responsive viewport for the current browser session." },
    ]
    if (this.settings.advancedCdpEnabled) capabilities.push({ id: "advancedCdp", description: "Use full CDP in an isolated session after per-origin and per-action approval." })
    if (this.options.authPreloadPath) capabilities.push({ id: "browserAuth", description: "Collect and submit requested credentials in an isolated authentication window." })
    const registeredMethods = new Set(REGISTERED_BROWSER_RUNTIME_METHODS)
    if (!this.options.authPreloadPath) registeredMethods.delete("browserAuth:request")
    const apiSupportOverrides = browserApiSupportForBackend("iab", registeredMethods)
    return {
      id: "lume-iab",
      backend: "iab",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      minSupported: BROWSER_PROTOCOL_MIN_SUPPORTED,
      maxSupported: BROWSER_PROTOCOL_MAX_SUPPORTED,
      capabilityHash: capabilityHash([
        ...capabilities.map((item) => item.id),
        ...Object.entries(apiSupportOverrides).flatMap(([api, supported]) => supported ? [api] : []),
      ]),
      generation: this.backendGeneration,
      capabilities,
      apiSupportOverrides,
    }
  }

  getSettings(): BrowserSettings { return { ...this.settings } }

  // main.ts lume:browser-page-event handler 的转发目标。
  // 通过 tabForContents 反查 sender 对应的 tab，再委托给模块级 handleBrowserPageEvent。
  handlePageEvent(sender: Electron.WebContents, payload: unknown): void {
    handleBrowserPageEvent(this.tabForContents(sender), payload, this.options.emit)
  }

  authorizeGuestMount(ownerWebContentsId: number, bootstrapUrl: string, requestedPartition: string): { token: string; partition: string } | null {
    const token = guestMountTokenFromUrl(bootstrapUrl)
    const grant = token ? this.guestMounts.get(token) : undefined
    if (!grant || grant.state !== "issued" || grant.expiresAt < Date.now()) return null
    const tab = this.tabs.get(grant.tabId)
    if (!tab || tab.generation !== grant.generation || grant.ownerWebContentsId !== ownerWebContentsId || requestedPartition !== grant.partition) return null
    grant.state = "attaching"
    return { token: grant.token, partition: grant.partition }
  }

  guestMountRejectionDetails(ownerWebContentsId: number, bootstrapUrl: string, requestedPartition: string): Record<string, unknown> {
    const token = guestMountTokenFromUrl(bootstrapUrl)
    const grant = token ? this.guestMounts.get(token) : undefined
    const tab = grant ? this.tabs.get(grant.tabId) : undefined
    return {
      reason: !token
        ? "invalid_bootstrap_url"
        : !grant
          ? "unknown_or_replayed_token"
          : grant.state !== "issued"
            ? "token_already_attaching"
            : grant.expiresAt < Date.now()
              ? "token_expired"
              : !tab
                ? "tab_not_found"
                : tab.generation !== grant.generation
                  ? "generation_changed"
                  : grant.ownerWebContentsId !== ownerWebContentsId
                    ? "owner_mismatch"
                    : requestedPartition !== grant.partition
                      ? "partition_mismatch"
                      : "unknown",
      hasToken: Boolean(token),
      hasGrant: Boolean(grant),
      grantState: grant?.state,
      requestedPartition,
      expectedPartition: grant?.partition,
      requestedOwnerWebContentsId: ownerWebContentsId,
      expectedOwnerWebContentsId: grant?.ownerWebContentsId,
      requestedGeneration: tab?.generation,
      expectedGeneration: grant?.generation,
    }
  }

  attachGuest(ownerWebContentsId: number, bootstrapUrl: string, contents: Electron.WebContents): boolean {
    const token = guestMountTokenFromUrl(bootstrapUrl)
    const grant = token ? this.guestMounts.get(token) : undefined
    if (!grant || grant.state !== "attaching" || grant.expiresAt < Date.now() || grant.ownerWebContentsId !== ownerWebContentsId) return false
    const tab = this.tabs.get(grant.tabId)
    if (!tab || tab.generation !== grant.generation || contents.session !== session.fromPartition(grant.partition)) return false
    this.guestMounts.delete(token!)
    if (tab.mountToken === token) tab.mountToken = undefined
    const previous = tab.webContents
    if (previous && previous !== contents) closeWebContentsAfterRenderer(previous)
    tab.webContents = contents
    tab.guestState = "attaching"
    tab.lifecycle = tab.visible ? "active" : "background"
    contents.setZoomFactor(tab.zoomFactor ?? 1)
    this.installPolicies(tab, shouldInstallAgentSessionPolicy(tab.partition), shouldInstallAdvancedCdpPolicy(tab.partition))
    contents.once("destroyed", () => this.markGuestGone(tab, contents))
    contents.once("dom-ready", () => {
      if (tab.webContents !== contents || contents.isDestroyed()) return
      tab.guestState = "ready"
      const waiters = tab.mountWaiters.splice(0)
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.resolve(contents) }
      const targetUrl = tab.pendingUrl || tab.url
      tab.pendingUrl = undefined
      if (targetUrl) void contents.loadURL(targetUrl).catch(() => undefined)
      this.syncTabColorScheme(tab)
      if (tab.scrollPosition) {
        contents.once("did-finish-load", () => {
          const scroll = tab.scrollPosition
          if (scroll) void contents.executeJavaScriptInIsolatedWorld(999, [{ code: `scrollTo(${scroll.x},${scroll.y})` }], true).catch(() => undefined)
        })
      }
      this.annotations.onGuestReady(tab)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    return true
  }

  // 页面 prefers-color-scheme 跟随应用主题（对齐 Codex setEmulatedMedia 同步）；
  // runtime 为应用级单例，nativeTheme 监听随进程生命周期，无需拆卸
  private readonly onThemeUpdated = () => {
    for (const tab of this.tabs.values()) {
      if (tab.webContents && !tab.webContents.isDestroyed()) this.syncTabColorScheme(tab)
    }
  }

  private syncTabColorScheme(tab: BrowserTab): void {
    const scheme = nativeTheme.shouldUseDarkColors ? "dark" : "light"
    void withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    })).catch(() => undefined)
  }

  private markGuestGone(tab: BrowserTab, contents: Electron.WebContents, details: { reason?: string; exitCode?: number } = {}): void {
    if (tab.webContents !== contents) return
    tab.webContents = null
    tab.guestState = "gone"
    tab.lifecycle = "crashed"
    tab.isLoading = false
    tab.generation += 1
    tab.inputSequence += 1
    if (tab.context?.actor === "agent") {
      tab.agentLease = { browserSessionId: tab.context.browserSessionId, browserTurnId: tab.context.browserTurnId, generation: tab.generation }
    }
    this.options.emit({ method: "browser:tab-error", params: { tabId: tab.tabId, code: "browser_internal_error", recoverable: true, ...details } })
    this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
  }

  private recoverGuest(tab: BrowserTab): BrowserTabDescriptor {
    if (tab.mountToken) this.guestMounts.delete(tab.mountToken)
    tab.mountToken = undefined
    tab.webContents = null
    tab.guestState = "unmounted"
    tab.lifecycle = tab.visible ? "active" : "background"
    tab.isLoading = false
    const descriptor = publicTab(tab)
    this.options.emit({ method: "browser:tab-changed", params: descriptor as unknown as Record<string, unknown> })
    this.options.emit({ method: "browser:guest-mount-required", params: { tabId: tab.tabId, generation: tab.generation } })
    return descriptor
  }

  updateSettings(input: Partial<BrowserSettings>): BrowserSettings {
    const previous = JSON.stringify(this.settings)
    const advancedCdpWasEnabled = this.settings.advancedCdpEnabled
    this.settings = {
      ...this.settings,
      schemaVersion: 3,
      ...(typeof input.browserEnabled === "boolean" ? { browserEnabled: input.browserEnabled } : {}),
      ...(typeof input.browserUseEnabled === "boolean" ? { browserUseEnabled: input.browserUseEnabled } : {}),
      ...(input.browserApprovalMode === "alwaysAsk" || input.browserApprovalMode === "neverAsk" ? { browserApprovalMode: input.browserApprovalMode } : {}),
      ...(input.iabHistoryApprovalMode === "alwaysAsk" || input.iabHistoryApprovalMode === "neverAsk" || input.iabHistoryApprovalMode === "disabled" ? { iabHistoryApprovalMode: input.iabHistoryApprovalMode } : {}),
      ...(input.chromeHistoryApprovalMode === "alwaysAsk" || input.chromeHistoryApprovalMode === "neverAsk" || input.chromeHistoryApprovalMode === "disabled" ? { chromeHistoryApprovalMode: input.chromeHistoryApprovalMode } : {}),
      ...(typeof input.agentCursorVisible === "boolean" ? { agentCursorVisible: input.agentCursorVisible } : {}),
      ...(input.linkOpenTarget === "lume" || input.linkOpenTarget === "system" ? { linkOpenTarget: input.linkOpenTarget } : {}),
      ...(input.localUrlTarget === "lume" || input.localUrlTarget === "system" ? { localUrlTarget: input.localUrlTarget } : {}),
      ...(typeof input.advancedCdpEnabled === "boolean" ? { advancedCdpEnabled: input.advancedCdpEnabled } : {}),
      ...(typeof input.extensionBackendEnabled === "boolean" ? { extensionBackendEnabled: input.extensionBackendEnabled } : {}),
      ...(input.annotationScreenshots === "off" || input.annotationScreenshots === "necessary" || input.annotationScreenshots === "always" ? { annotationScreenshots: input.annotationScreenshots } : {}),
      ...(typeof input.downloadDirectory === "string" ? { downloadDirectory: input.downloadDirectory.slice(0, 1024) } : {}),
      ...(typeof input.downloadAskBeforeSave === "boolean" ? { downloadAskBeforeSave: input.downloadAskBeforeSave } : {}),
      ...(typeof input.downloadHistoryEnabled === "boolean" ? { downloadHistoryEnabled: input.downloadHistoryEnabled } : {}),
      ...(input.sitePermissionDefault === "ask" || input.sitePermissionDefault === "deny" ? { sitePermissionDefault: input.sitePermissionDefault } : {}),
      ...(input.siteOverrides && typeof input.siteOverrides === "object" && !Array.isArray(input.siteOverrides) ? { siteOverrides: sanitizeSiteOverrides(input.siteOverrides as Record<string, unknown>) } : {}),
      ...(input.sitePermissionOverrides && typeof input.sitePermissionOverrides === "object" && !Array.isArray(input.sitePermissionOverrides)
        ? { sitePermissionOverrides: sanitizeSitePermissionOverrides(input.sitePermissionOverrides as Record<string, unknown>) }
        : {}),
    }
    this.options.persistSettings?.(this.settings)
    if (advancedCdpWasEnabled && !this.settings.advancedCdpEnabled) {
      const win = this.options.getWindow()
      for (const [tabId, tab] of this.tabs) {
        if (!shouldInstallAdvancedCdpPolicy(tab.partition)) continue
        const contents = tab.webContents
        const browserSession = contents?.session ?? session.fromPartition(tab.partition)
        if (contents) closeWebContentsAfterRenderer(contents)
        this.tabs.delete(tabId)
        this.disposeOwnedSessionIfUnused(tab.partition, browserSession)
        this.options.emit({ method: "browser:tab-closed", params: { tabId } })
      }
    }
    if (JSON.stringify(this.settings) !== previous) {
      this.revokeAgentLeases()
      this.backendGeneration += 1
      this.options.emit({ method: "browser:backend-changed", params: { backend: "iab", generation: this.backendGeneration, settingsChanged: true } })
    }
    return this.getSettings()
  }

  setAgentPluginEnabled(enabled: boolean): void {
    if (this.agentPluginEnabled === enabled) return
    this.agentPluginEnabled = enabled
    if (!enabled) this.revokeAgentLeases()
    this.backendGeneration += 1
    this.options.emit({ method: "browser:backend-changed", params: { backend: "iab", generation: this.backendGeneration, agentEnabled: enabled } })
  }

  revokeAgentLeases(): void {
    this.hideAgentCursor()
    for (const tab of this.tabs.values()) {
      if (tab.context?.actor !== "agent" && !tab.agentLease && !tab.handoff) continue
      if (tab.agentViewportOverride) this.restoreAgentViewportOverride(tab, tab.agentViewportOverride)
      if (tab.context?.actor === "agent") tab.context = undefined
      tab.agentLease = undefined
      tab.handoff = undefined
      tab.generation += 1
      tab.inputSequence += 1
      this.options.emit({ method: "browser:lease-revoked", params: { tabId: tab.tabId, generation: tab.generation } })
    }
  }

  resetAgentCursor(): void { this.hideAgentCursor() }

  async dispatch(request: BrowserActionRequest): Promise<unknown> {
    const context = validateContext(request.context)
    const startedAt = Date.now()
    const method = request.method === "setChecked" && request.params?.checked === false ? "uncheck" : normalizeBrowserMethod(request.method)
    const auditBase = {
      correlationId: request.requestId,
      actor: context.actor,
      ...(context.threadId ? { threadId: context.threadId } : {}),
      browserSessionId: context.browserSessionId,
      ...(typeof request.params?.tabId === "string" ? { tabId: request.params.tabId } : context.tabId ? { tabId: context.tabId } : {}),
      backend: "iab" as const,
      generation: this.backendGeneration,
      action: method,
    }
    this.audit.record({ ...auditBase, decision: "allow", status: "started" })
    try {
      const result = await this.dispatchInternal(request, context, method)
      const tabId = typeof request.params?.tabId === "string" ? request.params.tabId : context.tabId
      const origin = tabId ? this.tabs.get(tabId)?.url : undefined
      this.audit.record({ ...auditBase, ...(origin ? { origin } : {}), decision: "allow", status: "committed", durationMs: Date.now() - startedAt })
      return result
    } catch (error) {
      const code = stableBrowserErrorCode(error)
      this.audit.record({ ...auditBase, decision: "error", status: "failed", errorCode: code, durationMs: Date.now() - startedAt })
      if (code === "browser_internal_error") {
        this.options.onInternalError?.({
          method,
          actor: context.actor,
          ...(auditBase.tabId ? { tabId: auditBase.tabId } : {}),
          message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        })
      }
      if ((error as { code?: unknown })?.code === code) throw error
      throw browserError(code)
    }
  }

  private async dispatchInternal(request: BrowserActionRequest, context: BrowserRequestContext, method: string): Promise<unknown> {
    const params = request.params ?? {}
    if (method === "policy:confirm") return this.confirmBrowserAction(context, params)
    if (method === "policy:consume") return this.consumeBrowserAction(context, params)
    if (this.settings.browserEnabled === false) throw browserError("browser_unavailable")
    if (context.actor === "agent" && (this.settings.browserUseEnabled === false || !this.agentPluginEnabled || !this.options.isAgentPluginEnabled?.())) {
      throw browserError("browser_unavailable")
    }
    if (method === "handshake") return this.descriptor()
    if (method === "nameSession") {
      if (context.actor !== "agent") throw browserError("action_denied")
      const name = String(params.name ?? "").trim().slice(0, 160)
      if (!name) throw browserError("invalid_browser_request")
      this.sessionNames.set(context.browserSessionId, name)
      return { ok: true }
    }
    if (method === "list") return [...this.tabs.values()].map(publicTab)
    if (method === "referenceGrant:create") return this.createReferenceGrant(context, params)
    if (method === "referenceGrant:revoke") return this.revokeReferenceGrant(context, params)
    if (method === "openTabs") {
      const tabs = [...this.tabs.values()]
        .filter((tab) => tab.partition === "persist:lume-browser" && (context.actor !== "agent" || tab.ownerThreadId === context.threadId))
        .sort((left, right) => String(right.lastOpenedAt ?? "").localeCompare(String(left.lastOpenedAt ?? "")))
      if (context.actor === "agent") {
        this.clearClaimSnapshots(context)
        return tabs.map((tab) => {
          const claimHandle = randomUUID()
          this.claimSnapshots.set(claimSnapshotKey(context, claimHandle), {
            tabId: tab.tabId,
            providerTabId: tab.providerTabId,
            title: tab.title,
            url: tab.url,
            generation: tab.generation,
          })
          return { id: claimHandle, providerTabId: tab.providerTabId, url: tab.url, title: tab.title, generation: tab.generation, lastOpened: tab.lastOpenedAt }
        })
      }
      return tabs.map((tab) => ({ id: tab.tabId, tabId: tab.tabId, providerTabId: tab.providerTabId, url: tab.url, title: tab.title, lastOpened: tab.lastOpenedAt }))
    }
    if (method === "history:list") {
      if (context.actor === "agent") {
        if (params.__policyRequired !== true) throw browserError("confirmation_unavailable")
        this.consumePolicyToken(String(params.__policyConfirmation ?? ""), String(params.__policyBindingHash ?? ""))
      }
      const queries = Array.isArray(params.queries) ? params.queries.filter((value): value is string => typeof value === "string") : []
      return this.browsingHistory.list(
        queries.length ? queries.join(" ") : String(params.query ?? ""),
        boundedNumber(params.limit ?? 200, 1, 500),
        typeof params.from === "string" ? params.from : undefined,
        typeof params.to === "string" ? params.to : undefined,
      )
    }
    if (method === "history:delete") {
      if (context.actor !== "user") throw browserError("action_denied")
      return { deleted: this.browsingHistory.delete(String(params.id ?? "")) }
    }
    if (method === "history:clear") {
      if (context.actor !== "user") throw browserError("action_denied")
      this.browsingHistory.clear()
      return { ok: true }
    }
    if (method.startsWith("workspace:")) return this.dispatchWorkspace(method, params, context)
    if (method === "ensure") return this.ensureTab(String(params.tabId ?? randomUUID()), context, params)
    if (method === "mount:prepare") return this.prepareGuestMount(String(params.tabId ?? context.tabId ?? ""), context)
    if (method === "mount:release") return this.releaseGuestMount(String(params.tabId ?? context.tabId ?? ""), context, String(params.mountToken ?? ""))
    if (method === "get") return publicTab(this.requireTab(String(params.tabId ?? context.tabId ?? ""), context))
    if (method === "selected") {
      const selected = [...this.tabs.values()].find((tab) => tab.visible && canContextUseTab(tab, context))
      return selected ? publicTab(selected) : {}
    }
    if (method === "release") return this.releaseTabs(context, params)
    if (method === "handoff") return this.handoffTabs(context, params)
    if (method === "resumeHandoff") return this.resumeHandoffTabs(context)
    if (method === "finalize") return this.finalizeTabs(context, params)
    if (method === "share") return this.shareTab(String(params.tabId ?? context.tabId ?? ""), context)
    if (method === "unshare") return this.unshareTab(String(params.tabId ?? context.tabId ?? ""), context)
    if (method === "claim") return this.claimTab(String(params.tabId ?? context.tabId ?? ""), context, params)
    if (method === "close") return this.closeTab(String(params.tabId ?? context.tabId ?? ""), context)
    if (method === "bounds") return this.updateBounds(String(params.tabId ?? context.tabId ?? ""), params)
    if (method === "visible") return this.setVisible(String(params.tabId ?? context.tabId ?? ""), params.visible === true)
    if (method === "move-owner") {
      if (context.actor !== "user") throw browserError("action_denied")
      const tab = this.requireTab(String(params.tabId ?? context.tabId ?? ""), context)
      const ownerThreadId = typeof params.ownerThreadId === "string" ? params.ownerThreadId.slice(0, 200) : undefined
      if (!ownerThreadId) throw browserError("invalid_browser_request")
      const previousOwnerThreadId = tab.ownerThreadId
      this.referenceGrants.invalidateTab(tab.tabId)
      this.workspaces.move(publicTab(tab), ownerThreadId, { partition: tab.partition, handoffBrowserSessionId: tab.handoff?.browserSessionId })
      tab.ownerThreadId = ownerThreadId
      if (previousOwnerThreadId) this.emitWorkspace(this.workspaces.get(previousOwnerThreadId))
      this.emitWorkspace(this.workspaces.get(ownerThreadId))
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      return publicTab(tab)
    }
    if (method === "focus") return this.focus(String(params.tabId ?? context.tabId ?? ""))
    if (method === "settings:get") return this.getSettings()
    if (method === "settings:update") return this.updateSettings(params as Partial<BrowserSettings>)
    if (method === "openExternal") return this.openExternal(String(params.url ?? ""))
    if (method === "openPopup") return this.openPopup(String(params.activationToken ?? ""), context)
    if (method === "vault:summary") return this.vaultSummary()
    if (method === "vault:list-passwords") {
      if (context.actor !== "user") throw browserError("action_denied")
      return this.credentials.listPasswords()
    }
    if (method === "vault:delete-password") {
      if (context.actor !== "user") throw browserError("action_denied")
      return { deleted: this.credentials.deletePassword(String(params.id ?? "")) }
    }
    if (method === "contacts:list") return this.credentials.listContacts()
    if (method === "contacts:upsert") {
      if (context.actor !== "user") throw browserError("action_denied")
      return this.credentials.upsertContact(params)
    }
    if (method === "contacts:delete") {
      if (context.actor !== "user") throw browserError("action_denied")
      return { deleted: this.credentials.deleteContact(String(params.id ?? "")) }
    }
    if (method === "downloads:list") return context.actor === "user" ? this.downloadHistory.list() : Promise.reject(browserError("action_denied"))
    if (method === "downloads:clear") {
      if (context.actor !== "user") throw browserError("action_denied")
      this.downloadHistory.clear()
      return { ok: true }
    }
    if (method === "extensions:list") {
      if (context.actor !== "user") throw browserError("action_denied")
      return this.extensions.list()
    }
    if (method === "extensions:install") return this.installBrowserExtension(context)
    if (method === "extensions:remove") return this.removeBrowserExtension(context, String(params.id ?? ""))
    if (method === "extensions:set-enabled") return this.setBrowserExtensionEnabled(context, String(params.id ?? ""), params.enabled === true)
    if (method === "clear-data") return this.clearData(context, params)
    if (method === "tabs:content") return this.loadBackgroundContent(context, params)
    if (method === "browser_capabilities_list") return this.descriptor().capabilities
    if (method === "tab_capabilities_list") return this.descriptor().capabilities.filter((capability) => ["advancedCdp", "browserAuth", "pageAssets", "webmcp"].includes(capability.id))
    if (method === "browser_capability_documentation" || method === "tab_capability_documentation") {
      return browserCapabilityDocumentation(String(params.capabilityId ?? params.capability_id ?? ""))
    }
    if (method === "browser:visibility:get") return { visible: [...this.tabs.values()].some((tab) => canContextUseTab(tab, context) && tab.visible) }
    if (method === "browser:visibility:set") {
      for (const tab of this.tabs.values()) {
        if (!canContextUseTab(tab, context)) continue
        tab.visible = params.visible === true
        tab.lifecycle = tab.visible ? "active" : "background"
        if (tab.webContents && !tab.webContents.isDestroyed()) tab.webContents.setBackgroundThrottling(!tab.visible)
      }
      return {}
    }
    if (method === "browser:viewport:set" || method === "browser:viewport:reset") {
      for (const tab of this.tabs.values()) {
        if (!canContextUseTab(tab, context)) continue
        if (context.actor === "agent") this.captureAgentViewportOverride(tab, context)
        else tab.agentViewportOverride = undefined
        if (method === "browser:viewport:set") await this.setViewport(tab, params)
        else await this.resetViewport(tab)
      }
      return {}
    }
    if (method === "annotation:migrate") {
      if (context.actor !== "user") throw browserError("action_denied")
      return this.annotations.migrate(params.sessions)
    }

    const tab = this.requireTab(String(params.tabId ?? context.tabId ?? ""), context)
    if (tab.dialogOpen && method !== "dialog:handle" && method !== "dialog:get") throw browserError("dialog_blocking")
    if ((method === "reload" || method === "hardReload") && (!tab.webContents || tab.webContents.isDestroyed() || tab.guestState === "gone")) {
      return this.recoverGuest(tab)
    }
    if ((method === "contactFill" || method === "secretFill" || method === "upload" || method === "filechooser:setFiles" || method === "content:export" || method === "pageAssets:bundle" || method === "cdp" || method === "agentScript:evaluate" || method === "clipboard:read" || method === "clipboard:readText" || method === "clipboard:write" || method === "clipboard:writeText") && params.__policyRequired !== true) throw browserError("confirmation_unavailable")
    if (params.__policyRequired === true) this.consumePolicyToken(String(params.__policyConfirmation ?? ""), String(params.__policyBindingHash ?? ""))
    if (MUTATING_METHODS.has(method)) {
      const operationId = request.idempotencyKey || request.requestId || randomUUID()
      this.journal.write({
        operationId,
        method,
        tabGeneration: tab.generation,
        parameterHash: keyedParameterHash(method, params),
        status: "prepared",
        timestamp: Date.now(),
      })
      try {
        const result = await this.dispatchAction(tab, method, params, context)
        this.journal.write({
          operationId,
          method,
          tabGeneration: tab.generation,
          parameterHash: keyedParameterHash(method, params),
          status: "committed",
          timestamp: Date.now(),
        })
        this.journal.complete(operationId)
        return result
      } catch (error) {
        this.journal.write({
          operationId,
          method,
          tabGeneration: tab.generation,
          parameterHash: keyedParameterHash(method, params),
          status: "executed_unknown",
          timestamp: Date.now(),
        })
        throw error
      }
    }
    if (!GUEST_OPTIONAL_METHODS.has(method)) await this.waitForGuest(tab)
    if (method === "snapshot") return this.snapshot(tab)
    if (method === "semanticSnapshot") return this.semanticSnapshot(tab, params, context)
    if (method === "secrets:list") {
      const origin = safeOrigin(tab.url)
      return origin ? this.credentials.listPasswords().filter((entry) => entry.origin === origin) : []
    }
    if (method === "wait:download") return this.waitForDownload(tab, context, boundedNumber(params.timeoutMs ?? params.timeout_ms ?? 10_000, 1, 30_000))
    if (method === "download:path") return this.downloadPath(context, String(params.downloadId ?? params.download_id ?? ""), boundedNumber(params.timeoutMs ?? params.timeout_ms ?? 10_000, 1, 30_000))
    if (method === "wait:filechooser") return this.waitForFileChooser(tab, context, boundedNumber(params.timeoutMs ?? params.timeout_ms ?? 10_000, 1, 30_000))
    if (method === "pageAssets:list") return this.listPageAssets(tab, context)
    if (method === "webmcp:list") return listWebMcpTools(tab)
    if (method === "webmcp:invoke") return invokeWebMcpTool(tab, params)
    if (method === "content") return this.pageContent(tab, params)
    if (method === "scroll:get") {
      const position = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{ code: `({ x: scrollX, y: scrollY })` }], true) as { x?: unknown; y?: unknown }
      tab.scrollPosition = { x: Math.max(0, finiteNumber(position.x)), y: Math.max(0, finiteNumber(position.y)) }
      this.rememberTab(tab)
      return tab.scrollPosition
    }
    if (method === "scroll:set") {
      const x = boundedNumber(params.x, 0, 10_000_000)
      const y = boundedNumber(params.y, 0, 10_000_000)
      await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{ code: `scrollTo(${JSON.stringify(x)}, ${JSON.stringify(y)}); ({ x: scrollX, y: scrollY })` }], true)
      tab.scrollPosition = { x, y }
      this.rememberTab(tab)
      return { x, y }
    }
    if (method === "clipboard:readText") return { text: clipboard.readText().slice(0, 1_000_000) }
    if (method === "clipboard:writeText") {
      const text = String(params.text ?? "")
      if (text.length > 1_000_000) throw browserError("invalid_browser_request")
      clipboard.writeText(text)
      return {}
    }
    if (method === "clipboard:read") return this.readBrowserClipboard()
    if (method === "clipboard:write") return this.writeBrowserClipboard(params)
    if (method === "dom:visible") return this.visibleDom(tab)
    if (method === "dom:click" || method === "dom:doubleClick" || method === "dom:scroll") return this.dispatchDomAction(tab, method, params)
    if (method === "dom:type") { await this.applyTextToActive(tab, String(params.text ?? "")); return {} }
    if (method === "dom:keypress") {
      const keys = Array.isArray(params.keys) ? params.keys.filter((value): value is string => typeof value === "string") : []
      for (const key of keys.slice(0, 100)) await this.dispatchKey(tab, key)
      return {}
    }
    if (method === "elementInfo") return this.elementInfo(tab, params)
    if (method === "elementScreenshot") return { data: await this.elementScreenshot(tab, params) }
    if (method === "evaluate:readonly") return this.evaluateReadonly(tab, params)
    if (method === "dev:logs") return this.readConsoleLogs(tab, params)
    if (method === "stop") { browserContents(tab).stop(); return publicTab(tab) }
    if (method === "hardReload") {
      browserContents(tab).reloadIgnoringCache()
      return publicTab(tab)
    }
    if (method === "dialog:get") return tab.dialogInfo
    if (method.startsWith("locator:")) return this.queryLocator(tab, method.slice("locator:".length), params)
    if (method === "wait:url") return this.waitForUrl(tab, String(params.url ?? ""), boundedNumber(params.timeoutMs ?? (params.options as Record<string, unknown> | undefined)?.timeoutMs, 0, 30_000) || 10_000)
    if (method === "wait:load") return this.waitForLoad(tab, boundedNumber(params.timeoutMs, 0, 30_000) || 10_000)
    if (method === "wait:timeout") { await delay(boundedNumber(params.timeoutMs, 0, 30_000)); return undefined }
    if (method === "screenshot") return this.screenshot(tab, params)
    if (method === "screenshot:save") return this.saveScreenshot(tab, params)
    if (method === "screenshot:attachment") return this.saveReviewScreenshot(tab, params, context)
    if (method === "screenshot:attachment:delete") return this.deleteReviewScreenshot(tab, params, context)
    if (method === "find") {
      tab.findRequestId = browserContents(tab).findInPage(String(params.text ?? "").slice(0, 500), { forward: params.forward !== false, findNext: params.findNext === true })
      return { requestId: tab.findRequestId, ...(tab.findMatches ?? { activeMatchOrdinal: 0, matches: 0 }) }
    }
    if (method === "find:stop") {
      browserContents(tab).stopFindInPage(params.action === "activate" ? "activateSelection" : "clearSelection")
      tab.findRequestId = undefined
      tab.findMatches = undefined
      return { ok: true }
    }
    if (method === "zoom:get") return { factor: browserContents(tab).getZoomFactor() }
    if (method === "zoom:set") { const factor = Math.max(0.25, Math.min(5, Number(params.factor) || 1)); browserContents(tab).setZoomFactor(factor); tab.zoomFactor = factor; this.rememberTab(tab); return { factor } }
    if (method === "viewport:commit") return this.commitViewport(tab, params, context)
    if (method === "emulate" || method === "viewport:set" || method === "viewport:reset") {
      if (context.actor === "agent") this.captureAgentViewportOverride(tab, context)
      else tab.agentViewportOverride = undefined
      if (method === "emulate") return this.emulateDevice(tab, String(params.preset ?? "desktop"), params)
      if (method === "viewport:set") return this.setViewport(tab, params)
      return this.resetViewport(tab)
    }
    if (method === "screenshot:clipboard") return this.copyScreenshot(tab, params)
    if (method === "print") return this.printPage(tab)
    if (method === "devtools") {
      if (context.actor !== "user") throw browserError("action_denied")
      browserContents(tab).openDevTools({ mode: "detach", activate: true })
      return { ok: true }
    }
    if (method === "view-source") {
      if (context.actor !== "user" || !tab.url) throw browserError("action_denied")
      return this.ensureTab(randomUUID(), context, { url: `view-source:${tab.url}`, ownerThreadId: tab.ownerThreadId, openerTabId: tab.tabId })
    }
    if (method === "site-info") return {
      origin: safeOrigin(tab.url),
      securityState: tab.securityState,
      permissions: safeOrigin(tab.url) ? this.settings.sitePermissionOverrides?.[safeOrigin(tab.url)!] ?? {} : {},
    }
    if (method === "annotation:session") {
      if (context.actor !== "user") throw browserError("action_denied")
      const threadId = annotationThreadId(tab, params)
      return this.annotations.session(tab, threadId)
    }
    if (method === "annotation:mode") {
      if (context.actor !== "user") throw browserError("action_denied")
      const threadId = annotationThreadId(tab, params)
      if (params.mode !== 'browse' && params.mode !== 'comment') throw browserError("invalid_browser_request")
      if (params.purpose !== undefined && params.purpose !== 'annotation' && params.purpose !== 'tweaks') throw browserError("invalid_browser_request")
      const theme = safeAnnotationTheme(params.theme)
      return this.annotations.setMode(tab, threadId, params.mode, params.purpose === 'tweaks' ? 'tweaks' : 'annotation', theme)
    }
    if (method === "annotation:clear") {
      if (context.actor !== "user") throw browserError("action_denied")
      return this.annotations.clear(tab, annotationThreadId(tab, params))
    }
    if (method === "annotation:delete") {
      if (context.actor !== "user") throw browserError("action_denied")
      const threadId = annotationThreadId(tab, params)
      const annotationId = String(params.annotationId ?? '').trim().slice(0, 256)
      if (!threadId || !annotationId) throw browserError("invalid_browser_request")
      return this.annotations.delete(tab, threadId, annotationId)
    }
    if (method === "annotation:preview") {
      if (context.actor !== "user") throw browserError("action_denied")
      return this.annotations.setOriginalPreview(tab, annotationThreadId(tab, params), params.original === true)
    }
    if (method === "annotation:screenshot:prepare") {
      if (context.actor !== "user") throw browserError("action_denied")
      const threadId = annotationThreadId(tab, params)
      return this.annotations.prepareScreenshot(tab, threadId)
    }
    if (method === "annotation:submit") {
      if (context.actor !== "user") throw browserError("action_denied")
      const threadId = annotationThreadId(tab, params)
      return this.annotations.requestBatchSubmit(tab, threadId)
    }
    if (method === "annotation:resolve") {
      if (context.actor !== "user") throw browserError("action_denied")
      const threadId = annotationThreadId(tab, params)
      const annotationId = String(params.annotationId ?? '').trim().slice(0, 256)
      if (!threadId || !annotationId) throw browserError("invalid_browser_request")
      const resolvedBy = params.resolvedBy === 'agent' ? 'agent' : 'user'
      return this.annotations.resolve(tab, threadId, annotationId, resolvedBy)
    }
    if (method === "annotation:mark-read") {
      if (context.actor !== "user") throw browserError("action_denied")
      const threadId = annotationThreadId(tab, params)
      const annotationId = String(params.annotationId ?? '').trim().slice(0, 256)
      if (!threadId || !annotationId) throw browserError("invalid_browser_request")
      return this.annotations.markRead(tab, threadId, annotationId)
    }
    if (method === "annotation:screenshot:read") {
      if (context.actor !== "user") throw browserError("action_denied")
      const threadId = annotationThreadId(tab, params)
      const ref = String(params.screenshotRef ?? '').trim().slice(0, 4096)
      if (!threadId || !ref || tab.ownerThreadId !== threadId) throw browserError("action_denied")
      const data = this.annotations.readScreenshot(threadId, ref)
      return { data: data.toString('base64'), mediaType: 'image/png', size: data.length }
    }
    if (method === "tweaks:apply") return this.applyPageTweaks(tab, params, context)
    if (method === "tweaks:reset") return this.resetPageTweaks(tab, params, context)
    if (method === "cdp") return this.cdp(tab, params)
    if (method === "url") return tab.url
    if (method === "title") return tab.title
    throw browserError("unsupported")
  }

  private dispatchWorkspace(method: string, params: Record<string, unknown>, context: BrowserRequestContext): unknown {
    if (context.actor !== "user") throw browserError("action_denied")
    if (method === "workspace:list") return this.workspaces.list()
    const ownerThreadId = String(params.ownerThreadId ?? context.threadId ?? "").trim().slice(0, 200)
    if (!ownerThreadId) throw browserError("invalid_browser_request")
    if (method === "workspace:get") {
      this.restoreWorkspaceTabs(ownerThreadId, context)
      return this.workspaces.get(ownerThreadId)
    }
    if (method === "workspace:activate") {
      const descriptor = this.workspaces.activate(ownerThreadId, String(params.tabId ?? ""))
      this.emitWorkspace(descriptor)
      return descriptor
    }
    if (method === "workspace:reorder") {
      const orderedTabIds = Array.isArray(params.orderedTabIds)
        ? params.orderedTabIds.filter((value): value is string => typeof value === "string").slice(0, 100)
        : []
      const descriptor = this.workspaces.reorder(ownerThreadId, orderedTabIds)
      this.emitWorkspace(descriptor)
      return descriptor
    }
    if (method === "workspace:restore-closed") {
      const restored = this.workspaces.restoreClosed(ownerThreadId)
      const tab = restored ? this.ensureTab(restored.tabId, context, { ...restored, ownerThreadId }) : null
      this.emitWorkspace(this.workspaces.get(ownerThreadId))
      return tab
    }
    if (method === "workspace:import-legacy") {
      const descriptor = this.workspaces.importLegacy(ownerThreadId, params.tabs, params.activeTabId)
      this.restoreWorkspaceTabs(ownerThreadId, context)
      this.emitWorkspace(descriptor)
      return descriptor
    }
    throw browserError("unsupported")
  }

  private restoreWorkspaceTabs(ownerThreadId: string, context: BrowserRequestContext): void {
    for (const tab of this.workspaces.persistedTabs(ownerThreadId)) {
      if (this.tabs.has(tab.tabId)) continue
      this.ensureTab(tab.tabId, context, { ...tab, ownerThreadId }, tab.partition)
    }
  }

  private rememberTab(tab: BrowserTab): void {
    this.workspaces.rememberTab(publicTab(tab), { partition: tab.partition, handoffBrowserSessionId: tab.handoff?.browserSessionId })
    if (tab.ownerThreadId && (tab.profileKind === "user" || Boolean(tab.handoff))) this.emitWorkspace(this.workspaces.get(tab.ownerThreadId))
  }

  private emitWorkspace(descriptor: import("../../../packages/shared/src/types/browser-runtime").BrowserWorkspaceDescriptor): void {
    this.options.emit({ method: "browser:workspace-changed", params: descriptor as unknown as Record<string, unknown> })
  }

  destroy(): void {
    if (this.annotationSweepTimer) { clearTimeout(this.annotationSweepTimer); this.annotationSweepTimer = null }
    if (this.annotationSweepInterval) { clearInterval(this.annotationSweepInterval); this.annotationSweepInterval = null }
    this.annotations.destroy()
    this.hideAgentCursor()
    if (this.cursorOverlay && !this.cursorOverlay.isDestroyed()) this.cursorOverlay.close()
    this.cursorOverlay = null
    app.off("login", this.loginHandler)
    app.off("certificate-error", this.certificateErrorHandler)
    app.off("select-client-certificate", this.clientCertificateHandler)
    ipcMain.off("lume:browser-auth", this.browserAuthMessageHandler)
    ipcMain.off("lume:browser-annotation-guest", this.browserAnnotationGuestMessageHandler)
    for (const auth of this.authSessions.values()) if (!auth.window.isDestroyed()) auth.window.close()
    this.authSessions.clear()
    this.workspaces.flush()
    this.referenceGrants.clear()
    for (const tab of this.tabs.values()) {
      this.clearTabWaiters(tab.tabId)
      for (const waiter of tab.mountWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(browserError("browser_unavailable")) }
      if (tab.webContents) closeWebContentsSafely(tab.webContents)
    }
    this.tabs.clear()
    this.guestMounts.clear()
    this.downloadRefs.clear()
    this.pageAssetInventories.clear()
    this.semanticRefSessions.clear()
    this.semanticSnapshotCursors.clear()
    for (const policy of this.ownedSessionPolicies) {
      policy.disposed = true
      policy.session.webRequest.onBeforeRequest(null)
      if (policy.downloadHandler) policy.session.off("will-download", policy.downloadHandler)
      void policy.networkGuard?.close()
    }
    this.ownedSessionPolicies.clear()
    this.backendGeneration += 1
  }

  private ensureTab(tabId: string, context: BrowserRequestContext, params: Record<string, unknown>, restoredPartition?: string): BrowserTabDescriptor {
    const existing = this.tabs.get(tabId)
    if (existing) {
      if (context.actor === "agent") {
        if (!existing.agentLease && existing.shareable && existing.partition === "persist:lume-browser") {
          existing.agentLease = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: existing.generation }
        }
        if (!existing.agentLease || existing.agentLease.browserSessionId !== context.browserSessionId || existing.agentLease.browserTurnId !== context.browserTurnId) throw browserError("action_denied")
      }
      if (!existing.url && typeof params.url === "string" && params.url.trim()) void this.navigate(existing, params.url, context).catch(() => undefined)
      this.rememberTab(existing)
      return publicTab(existing)
    }
    const partition = restoredPartition ?? selectBrowserPartition(context, params)
    const isolatedAgent = shouldInstallAgentSessionPolicy(partition)
    const advancedCdp = shouldInstallAdvancedCdpPolicy(partition)
    const agentOwned = context.actor === "agent"
    const restoredAgent = params.profileKind === "agent"
    const profileKind: NonNullable<BrowserTabDescriptor["profileKind"]> = advancedCdp
      ? "advanced-cdp"
      : agentOwned || restoredAgent || isolatedAgent
        ? "agent"
        : "user"
    if (advancedCdp && !this.settings.advancedCdpEnabled) throw browserError("action_denied")
    const tab: BrowserTab = {
      tabId,
      providerTabId: randomUUID(),
      ...(typeof params.ownerThreadId === "string" ? { ownerThreadId: params.ownerThreadId.slice(0, 200) } : {}),
      ...(typeof params.openerTabId === "string" ? { openerTabId: params.openerTabId.slice(0, 200) } : {}),
      profileKind,
      backend: "iab",
      generation: 1,
      url: "",
      title: "浏览器",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      lastOpenedAt: new Date().toISOString(),
      securityState: "unknown",
      mediaState: { audible: false, camera: false, microphone: false },
      lifecycle: "background",
      zoomFactor: 1,
      visible: false,
      surface: null,
      guestState: "unmounted",
      viewportRevision: 0,
      webContents: null,
      partition,
      ...(agentOwned ? { context, agentLease: { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: 1 } } : {}),
      inputSequence: 0,
      navigationStack: Array.isArray(params.navigationEntries)
        ? params.navigationEntries.filter((value): value is string => typeof value === "string" && /^https?:/i.test(value)).map(stripUrl).filter(Boolean).slice(-200)
        : [],
      navigationIndex: Number.isInteger(params.navigationIndex) ? boundedNumber(params.navigationIndex, 0, 199) : -1,
      consoleLogs: [],
      mountWaiters: [],
      viewportQueue: Promise.resolve(),
    }
    if (profileKind === "agent" && (params.handoffStatus === "handoff" || params.handoffStatus === "deliverable") && typeof params.handoffBrowserSessionId === "string") {
      tab.handoff = { browserSessionId: params.handoffBrowserSessionId.slice(0, 200), status: params.handoffStatus }
    }
    const initialZoomFactor = Math.max(.25, Math.min(5, Number(params.zoomFactor) || 1))
    tab.zoomFactor = initialZoomFactor
    this.tabs.set(tabId, tab)
    this.ensureSessionPolicy(session.fromPartition(partition), partition, isolatedAgent || advancedCdp)
    const initialUrl = typeof params.url === "string" && params.url.trim() ? params.url : undefined
    if (initialUrl) {
      const normalized = normalizeNavigableUrl(initialUrl)
      tab.url = normalized
      tab.pendingUrl = normalized
      tab.securityState = securityStateForUrl(normalized)
    }
    if (params.viewport && typeof params.viewport === "object") {
      const viewport = params.viewport as Record<string, unknown>
      tab.viewport = viewport.enabled === false ? desktopViewportState() : sanitizeViewportState(viewport)
    }
    const initialScroll = params.scrollPosition && typeof params.scrollPosition === "object" ? params.scrollPosition as Record<string, unknown> : undefined
    if (initialScroll) {
      tab.scrollPosition = { x: boundedNumber(initialScroll.x, 0, 10_000_000), y: boundedNumber(initialScroll.y, 0, 10_000_000) }
    }
    this.rememberTab(tab)
    this.enforceBackgroundLimit()
    return publicTab(tab)
  }

  private installPolicies(tab: BrowserTab, agent: boolean, advancedCdp: boolean): void {
    const wc = browserContents(tab)
    this.ensureSessionPolicy(wc.session, tab.partition, agent || advancedCdp)
    wc.setWindowOpenHandler(({ url }) => {
      const now = Date.now()
      const userInitiated = tab.lastUserActivationAt !== undefined && now - tab.lastUserActivationAt <= 5_000
      tab.lastUserActivationAt = undefined
      if (userInitiated && (url === "about:blank" || isAllowedNavigation(url, agent, this.settings, tab.approvedPrivateOrigins))) {
        const parent = this.options.getWindow()
        return {
          action: "allow",
          outlivesOpener: false,
          overrideBrowserWindowOptions: {
            ...(parent && !parent.isDestroyed() ? { parent } : {}),
            autoHideMenuBar: true,
            webPreferences: {
              partition: tab.partition,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
              webSecurity: true,
            },
          },
        }
      }
      const agentInitiated = agent || Boolean(tab.recentAgentContext && tab.recentAgentContext.expiresAt >= Date.now())
      const target = isPrivateUrl(url) ? this.settings.localUrlTarget : this.settings.linkOpenTarget
      if (!agentInitiated && target === "system" && isAllowedNavigation(url, false)) {
        void shell.openExternal(new URL(url).toString())
        return { action: "deny" }
      }
      const activationToken = randomUUID()
      this.popupTokens.set(activationToken, { sourceTabId: tab.tabId, url: stripUrl(url), expiresAt: Date.now() + 60_000 })
      this.options.emit({ method: "browser:popup-request", params: { tabId: tab.tabId, activationToken, origin: safeOrigin(url), url: stripUrl(url) } })
      return { action: "deny" }
    })
    wc.on("did-create-window", (popup) => {
      popup.setMenuBarVisibility(false)
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
      popup.webContents.on("will-navigate", (event, url) => {
        if (!isAllowedNavigation(url, agent, this.settings, tab.approvedPrivateOrigins)) event.preventDefault()
      })
    })
    wc.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url, agent, this.settings, tab.approvedPrivateOrigins)) event.preventDefault()
    })
    wc.on("did-navigate", (_event, url) => {
      if (guestMountTokenFromUrl(url)) return
      this.referenceGrants.invalidateTab(tab.tabId)
      this.hideAgentCursor()
      this.closeAuthSessionsForTab(tab.tabId, safeOrigin(url) === safeOrigin(tab.url) ? "page_changed" : "origin_changed")
      tab.url = stripUrl(url)
      tab.securityState = securityStateForUrl(tab.url)
      tab.isLoading = wc.isLoading()
      tab.lifecycle = tab.visible ? "active" : "background"
      tab.lastOpenedAt = new Date().toISOString()
      const pendingNavigationIndex = tab.pendingNavigationIndex
      tab.pendingNavigationIndex = undefined
      if (pendingNavigationIndex !== undefined && tab.navigationStack[pendingNavigationIndex] === tab.url) {
        tab.navigationIndex = pendingNavigationIndex
      } else if (tab.navigationStack[tab.navigationIndex] !== tab.url) {
        tab.navigationStack = [...tab.navigationStack.slice(0, tab.navigationIndex + 1), tab.url].slice(-200)
        tab.navigationIndex = tab.navigationStack.length - 1
      }
      tab.canGoBack = tab.navigationIndex > 0
      tab.canGoForward = tab.navigationIndex >= 0 && tab.navigationIndex < tab.navigationStack.length - 1
      this.browsingHistory.record(tab.url, tab.title)
      tab.generation += 1
      tab.inputSequence += 1
      tab.domNodes = undefined
      if (tab.context?.actor === "agent") tab.agentLease = { browserSessionId: tab.context.browserSessionId, browserTurnId: tab.context.browserTurnId, generation: tab.generation }
      else {
        if (tab.agentViewportOverride) this.restoreAgentViewportOverride(tab, tab.agentViewportOverride)
        tab.agentLease = undefined
      }
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      this.annotations.onGuestReady(tab)
      this.rememberTab(tab)
    })
    wc.on("did-navigate-in-page", (_event, url) => {
      if (guestMountTokenFromUrl(url)) return
      this.referenceGrants.invalidateTab(tab.tabId)
      this.closeAuthSessionsForTab(tab.tabId, "page_changed")
      tab.url = stripUrl(url)
      tab.securityState = securityStateForUrl(tab.url)
      tab.lastOpenedAt = new Date().toISOString()
      tab.generation += 1
      tab.inputSequence += 1
      tab.domNodes = undefined
      if (tab.context?.actor === "agent") tab.agentLease = { browserSessionId: tab.context.browserSessionId, browserTurnId: tab.context.browserTurnId, generation: tab.generation }
      else tab.agentLease = undefined
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      this.annotations.onGuestReady(tab)
      this.rememberTab(tab)
    })
    wc.on("did-start-loading", () => {
      tab.isLoading = true
      tab.loadError = undefined
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("did-stop-loading", () => {
      tab.isLoading = false
      tab.canGoBack = tab.navigationIndex > 0
      tab.canGoForward = tab.navigationIndex >= 0 && tab.navigationIndex < tab.navigationStack.length - 1
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("did-finish-load", () => {
      if (tab.webContents !== wc || wc.isDestroyed()) return
      this.annotations.onGuestReady(tab)
    })
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.isLoading = false
      tab.loadError = { errorCode, errorDescription: errorDescription.slice(0, 300), url: stripUrl(validatedURL) }
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      this.options.emit({ method: "browser:tab-error", params: { tabId: tab.tabId, code: "load_failed", errorCode, errorDescription: errorDescription.slice(0, 300), url: stripUrl(validatedURL), recoverable: true } })
    })
    wc.on("page-favicon-updated", (_event, favicons) => {
      const faviconUrl = favicons.find((value) => /^https?:|^data:image\//i.test(value))
      tab.faviconUrl = faviconUrl?.slice(0, 4096)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      this.rememberTab(tab)
    })
    wc.on("found-in-page", (_event, result) => {
      if (tab.findRequestId !== result.requestId) return
      tab.findMatches = { activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches }
      this.options.emit({ method: "browser:find-result", params: { tabId: tab.tabId, requestId: result.requestId, activeMatchOrdinal: result.activeMatchOrdinal, matches: result.matches, finalUpdate: result.finalUpdate } })
    })
    wc.on("media-started-playing", () => {
      tab.mediaState = { ...(tab.mediaState ?? { camera: false, microphone: false }), audible: true }
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      this.enforceBackgroundLimit()
    })
    wc.on("media-paused", () => {
      tab.mediaState = { ...(tab.mediaState ?? { camera: false, microphone: false }), audible: false }
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      this.enforceBackgroundLimit()
    })
    wc.on("before-input-event", (event, input) => {
      const key = input.key.toLowerCase()
      const modifier = input.control || input.meta
      const action = modifier && key === "l"
        ? "focus-address"
        : modifier && key === "f"
          ? "find"
          : (modifier && key === "r") || key === "f5"
            ? input.shift ? "hard-reload" : "reload"
            : undefined
      if (!tab.agentDispatching) {
        tab.inputSequence += 1
        if (!action && input.type === "keyDown" && !input.isAutoRepeat) tab.lastUserActivationAt = Date.now()
      }
      if (!action) return
      event.preventDefault()
      this.options.emit({ method: "browser:shortcut", params: { tabId: tab.tabId, action } })
    })
    wc.on("before-mouse-event", (_event, mouse) => {
      if (!tab.agentDispatching) {
        tab.inputSequence += 1
        if (mouse.type === "mouseDown" && (mouse.button === "left" || mouse.button === "middle")) tab.lastUserActivationAt = Date.now()
      }
    })
    wc.on("page-title-updated", (_event, title) => {
      tab.title = title.slice(0, 256)
      if (tab.url) this.browsingHistory.updateTitle(tab.url, tab.title)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      this.rememberTab(tab)
    })
    wc.on("console-message", (details) => {
      const level: BrowserTab["consoleLogs"][number]["level"] = details.level === "error"
        ? "error"
        : details.level === "warning"
          ? "warn"
          : details.level === "debug"
            ? "debug"
            : "info"
      tab.consoleLogs = [...tab.consoleLogs, {
        level,
        message: details.message.slice(0, 20_000),
        timestamp: new Date().toISOString(),
        ...(/^https?:/i.test(details.sourceId) ? { url: stripUrl(details.sourceId) } : {}),
      }].slice(-500)
    })
    wc.on("render-process-gone", (_event, details) => {
      this.markGuestGone(tab, wc, { reason: details.reason, exitCode: details.exitCode })
    })
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3")
      void wc.debugger.sendCommand("Page.enable").catch(() => undefined)
      wc.debugger.on("detach", (_event, reason) => {
        this.options.emit({ method: "browser:debugger-detached", params: { tabId: tab.tabId, generation: tab.generation, reason } })
      })
      wc.debugger.on("message", (_event, method, params) => {
        if (method === "Page.javascriptDialogOpening") {
          tab.dialogOpen = true
          const detail = params as Record<string, unknown>
          const type = String(detail.type ?? "alert")
          tab.dialogInfo = {
            id: randomUUID(),
            type: (["alert", "beforeunload", "confirm", "prompt"].includes(type) ? type : "alert") as NonNullable<BrowserTab["dialogInfo"]>["type"],
            ...(typeof detail.message === "string" ? { message: detail.message.slice(0, 10_000) } : {}),
            ...(typeof detail.defaultPrompt === "string" ? { defaultValue: detail.defaultPrompt.slice(0, 10_000) } : {}),
          }
          this.options.emit({
            method: "browser:dialog",
            params: {
              tabId: tab.tabId,
              generation: tab.generation,
              dialogId: tab.dialogInfo.id,
              type: tab.dialogInfo.type,
              ...(tab.dialogInfo.message ? { message: tab.dialogInfo.message } : {}),
              ...(tab.dialogInfo.defaultValue ? { defaultValue: tab.dialogInfo.defaultValue } : {}),
            },
          })
        }
        if (method === "Page.javascriptDialogClosed") {
          const dialogId = tab.dialogInfo?.id
          tab.dialogOpen = false
          tab.dialogInfo = undefined
          if (dialogId) this.options.emit({ method: "browser:dialog-closed", params: { tabId: tab.tabId, generation: tab.generation, dialogId } })
        }
        if (method === "Page.fileChooserOpened") {
          const detail = params as Record<string, unknown>
          const backendNodeId = Number(detail.backendNodeId)
          const waiters = this.fileChooserWaiters.get(tab.tabId) ?? []
          const waiter = waiters.shift()
          if (waiters.length) this.fileChooserWaiters.set(tab.tabId, waiters)
          else this.fileChooserWaiters.delete(tab.tabId)
          if (!waiter || !Number.isInteger(backendNodeId) || backendNodeId <= 0) return
          clearTimeout(waiter.timer)
          const fileChooserId = randomUUID()
          const isMultiple = detail.mode === "selectMultiple"
          const chooser: BrowserFileChooserEntry = {
            tabId: tab.tabId,
            backendNodeId,
            isMultiple,
            browserSessionId: waiter.browserSessionId,
            browserTurnId: waiter.browserTurnId,
            generation: tab.generation,
          }
          chooser.expiryTimer = setTimeout(() => {
            if (this.fileChoosers.get(fileChooserId) !== chooser) return
            this.fileChoosers.delete(fileChooserId)
            this.disableFileChooserInterceptIfIdle(tab.tabId)
          }, FILE_CHOOSER_IDLE_EXPIRY_MS)
          this.fileChoosers.set(fileChooserId, chooser)
          waiter.resolve({ file_chooser_id: fileChooserId, is_multiple: isMultiple })
        }
      })
    } catch { /* debugger capability remains unavailable for this tab */ }
  }

  private ensureSessionPolicy(browserSession: Electron.Session, partition: string, agent: boolean): void {
    if (this.sessionPolicies.has(browserSession)) return
    const policy: SessionPolicy = { session: browserSession, partition, agent, disposed: false }
    this.sessionPolicies.set(browserSession, policy)
    this.ownedSessionPolicies.add(policy)
    browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = safeOrigin(contents.getURL())
      const permissionTab = this.tabForContents(contents)
      const agentControlled = policy.agent || Boolean(permissionTab?.agentLease)
      const legacyOverride = origin ? this.settings.siteOverrides[origin] : undefined
      const requestedMediaTypes = (details as { mediaTypes?: unknown } | undefined)?.mediaTypes
      const mediaTypes = Array.isArray(requestedMediaTypes) ? requestedMediaTypes : []
      const permissionKey = permission === "media"
        ? mediaTypes.includes("video") ? "camera" : mediaTypes.includes("audio") ? "microphone" : undefined
        : undefined
      const override = origin && permissionKey ? this.settings.sitePermissionOverrides?.[origin]?.[permissionKey] : legacyOverride
      if (agentControlled || override === "deny" || (!override && this.settings.sitePermissionDefault === "deny")) {
        callback(false)
        return
      }
      if (override === "allow") {
        if (permissionTab && permissionKey) {
          permissionTab.mediaState = {
            ...(permissionTab.mediaState ?? { audible: false, camera: false, microphone: false }),
            [permissionKey]: true,
          }
          this.options.emit({ method: "browser:tab-changed", params: publicTab(permissionTab) as unknown as Record<string, unknown> })
        }
        callback(true)
        return
      }
      const win = this.options.getWindow()
      if (!win || win.isDestroyed()) {
        callback(false)
        return
      }
      void dialog.showMessageBox(win, {
        type: "question",
        buttons: ["允许", "拒绝"],
        defaultId: 1,
        cancelId: 1,
        title: "网站权限请求",
        message: `${origin ?? "此网站"} 请求使用${permissionKey === "camera" ? "摄像头" : permissionKey === "microphone" ? "麦克风" : permission}权限。`,
      }).then((result) => {
        const allowed = result.response === 0
        if (allowed && origin && permissionKey) {
          if (permissionTab) {
            permissionTab.mediaState = {
              ...(permissionTab.mediaState ?? { audible: false, camera: false, microphone: false }),
              [permissionKey]: true,
            }
            this.options.emit({ method: "browser:tab-changed", params: publicTab(permissionTab) as unknown as Record<string, unknown> })
          }
        }
        callback(allowed)
      }).catch(() => callback(false))
    })
    const downloadHandler = (_event: Electron.Event, item: Electron.DownloadItem, webContents: Electron.WebContents): void => {
      if (policy.disposed) { item.cancel(); return }
      const tab = [...this.tabs.values()].find((candidate) => candidate.webContents === webContents)
      item.pause()
      void this.handleDownload(policy, tab, item).catch(() => item.cancel())
    }
    policy.downloadHandler = downloadHandler
    browserSession.on("will-download", downloadHandler)
    browserSession.webRequest.onBeforeRequest({ urls: ["*://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
      const claimedGlobalTab = [...this.tabs.values()].find((tab) => tab.webContents?.id === details.webContentsId && Boolean(tab.agentLease))
      const guarded = policy.agent || Boolean(claimedGlobalTab)
      callback({ cancel: policy.disposed || (guarded && !isAllowedNavigation(details.url, true, this.settings, claimedGlobalTab?.approvedPrivateOrigins)) })
    })
    if (!agent) return
    const guard = new BrowserNetworkGuard({
      allowPrivateOrigin: (origin) => this.settings.siteOverrides[origin] === "allow" || [...this.tabs.values()].some((tab) => tab.webContents?.session === browserSession && tab.approvedPrivateOrigins?.has(origin)),
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
    })
    policy.networkGuard = guard
    policy.networkReady = guard.start().then(() => browserSession.setProxy({ proxyRules: guard.proxyRules(), proxyBypassRules: "<-loopback>" })).catch((error) => {
      policy.disposed = true
      throw error
    })
  }

  private async handleDownload(policy: SessionPolicy, tab: BrowserTab | undefined, item: Electron.DownloadItem): Promise<void> {
    const filename = safeDownloadFilename(item.getFilename())
    const recentAgent = tab?.recentAgentContext && tab.recentAgentContext.expiresAt >= Date.now() ? tab.recentAgentContext : undefined
    const agent = Boolean(recentAgent)
    const generation = tab?.generation
    const mustConfirm = agent || this.settings.downloadAskBeforeSave
      || (safeOrigin(tab?.url ?? "") ? this.settings.sitePermissionOverrides?.[safeOrigin(tab?.url ?? "")!]?.download !== "allow" : false)
    if (mustConfirm) {
      const win = this.options.getWindow()
      if (!win || win.isDestroyed()) { item.cancel(); return }
      const result = await dialog.showMessageBox(win, { type: "question", buttons: ["保存", "取消"], defaultId: 1, cancelId: 1, title: agent ? "确认 Agent 下载" : "确认下载", message: `保存下载文件“${filename}”？`, detail: agent ? "批准仅适用于当前标签页和这一次下载。" : undefined })
      if (result.response !== 0 || policy.disposed || (generation !== undefined && tab?.generation !== generation)) { item.cancel(); return }
    }
    const actor = agent ? "agent" : "user"
    const sessionId = recentAgent ? `${recentAgent.browserSessionId}:${recentAgent.browserTurnId}` : "user"
    const quotaId = agent ? this.downloadQuota.begin(sessionId, Math.max(0, item.getTotalBytes())) : null
    if (agent && !quotaId) { item.cancel(); return }
    const directory = recentAgent
      ? join(this.options.configDir(), "browser", "downloads", safePartition(recentAgent.browserSessionId), safePartition(recentAgent.browserTurnId))
      : this.settings.downloadDirectory || app.getPath("downloads")
    const prepared = prepareDownload(directory, filename)
    item.setSavePath(agent ? prepared.partialPath : prepared.finalPath)
    if (agent && tab && recentAgent) {
      this.downloadResults.set(prepared.id, {
        browserSessionId: recentAgent.browserSessionId,
        browserTurnId: recentAgent.browserTurnId,
        state: "pending",
        waiters: [],
      })
      const waiters = this.downloadWaiters.get(tab.tabId) ?? []
      const waiterIndex = waiters.findIndex((waiter) => waiter.browserSessionId === recentAgent.browserSessionId && waiter.browserTurnId === recentAgent.browserTurnId)
      const waiter = waiterIndex >= 0 ? waiters.splice(waiterIndex, 1)[0] : undefined
      if (waiters.length) this.downloadWaiters.set(tab.tabId, waiters)
      else this.downloadWaiters.delete(tab.tabId)
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve({ download_id: prepared.id })
      }
    }
    let quotaExceeded = false
    const timeout = agent ? setTimeout(() => { quotaExceeded = true; item.cancel() }, AGENT_DOWNLOAD_LIMITS.maxDurationMs) : undefined
    let lastProgressEventAt = 0
    this.options.emit({
      method: "browser:download",
      params: {
        tabId: tab?.tabId,
        id: prepared.id,
        state: "progressing",
        started: true,
        filename: prepared.filename,
        actor,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: Math.max(0, item.getTotalBytes()),
      },
    })
    item.on("updated", () => {
      if (agent && quotaId && !this.downloadQuota.update(sessionId, quotaId, item.getReceivedBytes())) {
        quotaExceeded = true
        item.cancel()
      }
      const now = Date.now()
      if (now - lastProgressEventAt < 250) return
      lastProgressEventAt = now
      this.options.emit({
        method: "browser:download",
        params: {
          tabId: tab?.tabId,
          id: prepared.id,
          state: "progressing",
          filename: prepared.filename,
          actor,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: Math.max(0, item.getTotalBytes()),
        },
      })
    })
    item.once("done", (_event, electronState) => {
      if (timeout) clearTimeout(timeout)
      const completed = electronState === "completed" && !quotaExceeded
      if (agent && quotaId) this.downloadQuota.finish(sessionId, quotaId, completed)
      try {
        if (agent) {
          if (completed) completeDownload(prepared)
          else removePartialDownload(prepared)
        }
      } catch { removePartialDownload(prepared) }
      const state = completed ? "completed" : electronState === "cancelled" ? "cancelled" : "interrupted"
      if (this.settings.downloadHistoryEnabled) this.downloadHistory.record({ id: prepared.id, filename: prepared.filename, actor, state, receivedBytes: item.getReceivedBytes(), createdAt: new Date().toISOString() })
      if (agent && completed && recentAgent) this.downloadRefs.set(prepared.id, { path: prepared.finalPath, browserSessionId: recentAgent.browserSessionId, browserTurnId: recentAgent.browserTurnId })
      const downloadResult = this.downloadResults.get(prepared.id)
      if (downloadResult) {
        downloadResult.state = completed ? "completed" : "failed"
        downloadResult.fileRef = completed ? `browser-download:${prepared.id}` : undefined
        for (const resolveWaiter of downloadResult.waiters.splice(0)) resolveWaiter(downloadResult.fileRef ?? null)
      }
      this.options.emit({
        method: "browser:download",
        params: {
          tabId: tab?.tabId,
          id: prepared.id,
          state,
          filename: prepared.filename,
          actor,
          receivedBytes: item.getReceivedBytes(),
          totalBytes: Math.max(0, item.getTotalBytes()),
          ...(agent && completed ? { fileRef: `browser-download:${prepared.id}` } : {}),
        },
      })
    })
    item.resume()
  }

  private requireTab(tabId: string, context: BrowserRequestContext): BrowserTab {
    const tab = this.tabs.get(tabId)
    if (!tab) throw browserError("tab_not_found")
    if (context.actor === "agent") {
      if (!canAgentUse(tab, context.browserSessionId, context.browserTurnId, tab.generation)) throw browserError("action_denied")
      if (context.tabId && context.tabId !== tab.tabId) throw browserError("action_denied")
    }
    return tab
  }

  private waitForGuest(tab: BrowserTab, timeoutMs = 10_000): Promise<Electron.WebContents> {
    const contents = tab.webContents
    if (contents && !contents.isDestroyed()) return Promise.resolve(contents)
    this.options.emit({ method: "browser:guest-mount-required", params: { tabId: tab.tabId, generation: tab.generation } })
    return new Promise((resolveGuest, rejectGuest) => {
      const waiter = {
        resolve: resolveGuest,
        reject: rejectGuest,
        timer: setTimeout(() => {
          tab.mountWaiters = tab.mountWaiters.filter((candidate) => candidate !== waiter)
          rejectGuest(browserError("browser_unavailable"))
        }, timeoutMs),
      }
      tab.mountWaiters.push(waiter)
    })
  }

  private tabForContents(contents: Electron.WebContents): BrowserTab | undefined {
    return [...this.tabs.values()].find((tab) => tab.webContents === contents)
  }

  private async dispatchAction(tab: BrowserTab, method: string, params: Record<string, unknown>, context: BrowserRequestContext): Promise<unknown> {
    if (method === "browserAuth:request") {
      await this.waitForGuest(tab)
      return this.requestBrowserAuth(tab, params, context)
    }
    if (tab.lifecycle === "suspended") void this.setTabSuspended(tab, false)
    if (context.actor === "agent") tab.recentAgentContext = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, expiresAt: Date.now() + 30_000 }
    if (method === "mark") {
      if (context.actor !== "agent" || (params.status !== "handoff" && params.status !== "deliverable")) throw browserError("invalid_browser_request")
      tab.handoff = { browserSessionId: context.browserSessionId, status: params.status }
      this.rememberTab(tab)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      return {}
    }
    if (method === "navigate") return this.navigate(tab, String(params.url ?? ""), context, params.__policyRequired === true)
    await this.waitForGuest(tab)
    if (method === "back") {
      if (tab.navigationIndex <= 0) return undefined
      tab.pendingNavigationIndex = tab.navigationIndex - 1
      const contents = browserContents(tab)
      if (contents.canGoBack()) return contents.goBack()
      return contents.loadURL(tab.navigationStack[tab.pendingNavigationIndex]!).catch(() => { tab.pendingNavigationIndex = undefined })
    }
    if (method === "forward") {
      if (tab.navigationIndex < 0 || tab.navigationIndex >= tab.navigationStack.length - 1) return undefined
      tab.pendingNavigationIndex = tab.navigationIndex + 1
      const contents = browserContents(tab)
      if (contents.canGoForward()) return contents.goForward()
      return contents.loadURL(tab.navigationStack[tab.pendingNavigationIndex]!).catch(() => { tab.pendingNavigationIndex = undefined })
    }
    if (method === "reload") return browserContents(tab).reload()
    if (method === "dialog:handle") {
      if (!tab.dialogInfo || params.dialogId !== tab.dialogInfo.id) throw browserError("stale_target")
      await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Page.handleJavaScriptDialog", { accept: params.accept === true, ...(typeof params.promptText === "string" ? { promptText: params.promptText.slice(0, 10_000) } : {}) }))
      tab.dialogOpen = false
      tab.dialogInfo = undefined
      return { ok: true }
    }
    if (method === "contactFill") return this.fillSavedContact(tab, params)
    if (method === "secretFill") return this.fillSavedPassword(tab, params, context)
    if (method === "upload") return this.uploadFileRefs(tab, params, context)
    if (method === "filechooser:setFiles") return this.setFileChooserFiles(tab, params, context)
    if (method === "downloadMedia") return this.downloadMedia(tab, params, context)
    if (method === "content:export") return this.exportPageContent(tab, context)
    if (method === "pageAssets:bundle") return this.bundlePageAssets(tab, params, context)
    if (method === "webmcp:invoke") return invokeWebMcpTool(tab, params)
    if (method === "agentScript:evaluate") return this.evaluateAgentScript(tab, params, context)
    if (method === "typeActive") { await this.applyTextToActive(tab, String(params.text ?? "")); return { ok: true } }
    if (method === "pressActive") { await this.dispatchKey(tab, String(params.key ?? "Enter")); return { ok: true } }
    if (["click", "doubleClick", "hover", "scroll", "drag", "fill", "type", "press", "select", "check", "uncheck"].includes(method)) {
      if (context.actor === "agent" && !context.capability) throw browserError("action_denied")
      const generation = tab.generation
      const inputSequence = tab.inputSequence
      if (isBrowserLocator(params.locator)
        && splitFrameLocator(params.locator)
        && ["click", "doubleClick", "scroll", "fill", "type", "press", "select", "check", "uncheck"].includes(method)) {
        if (tab.generation !== generation || tab.inputSequence !== inputSequence) throw browserError("stale_target")
        const argument = method === "fill" || method === "type"
          ? String(params.text ?? "")
          : method === "press"
            ? String(params.key ?? "Enter")
            : method === "select"
              ? JSON.stringify(Array.isArray(params.value) ? params.value : [String(params.value ?? "")])
              : undefined
        const rawFrameAutoWait = params.timeoutMs ?? params.timeout_ms
        const frameAutoWaitMs = rawFrameAutoWait === 0 ? 0 : (boundedNumber(rawFrameAutoWait, 0, 30_000) || 3_000)
        await this.runFrameLocatorActionWithAutoWait(tab, generation, inputSequence, params, method as BrowserLocatorQuery, argument, frameAutoWaitMs)
        return { ok: true, inputSequence: tab.inputSequence }
      }
      // 显式 timeoutMs:0 = 关闭 auto-wait（boundedNumber 的 || 3_000 会吞掉 0）
      const rawAutoWait = params.timeoutMs ?? params.timeout_ms
      const autoWaitMs = rawAutoWait === 0 ? 0 : (boundedNumber(rawAutoWait, 0, 30_000) || 3_000)
      const target = await this.resolveTargetWithAutoWait(tab, generation, params, autoWaitMs, context)
      if (tab.generation !== generation || tab.inputSequence !== inputSequence) throw browserError("stale_target")
      tab.inputSequence += 1
      tab.agentDispatching = true
      try {
        if (method === "fill" || method === "type") {
          const text = String(params.text ?? "")
          if (text.length > 100_000) throw browserError("invalid_browser_request")
          await this.dispatchMouse(tab, "click", target)
          await this.applyText(tab, target, text, method === "fill")
        } else if (method === "press") {
          await this.dispatchMouse(tab, "hover", target)
          await this.pressTarget(tab, target, String(params.key ?? "Enter"))
        } else if (method === "select") {
          await this.dispatchMouse(tab, "click", target)
          await this.applySelect(tab, params)
        } else if (method === "check" || method === "uncheck") {
          await this.dispatchMouse(tab, method === "check" ? "click" : "click", target)
          await this.applyChecked(tab, params, method === "check")
        } else if (method === "scroll") {
          await this.dispatchScroll(tab, target, params)
        } else if (method === "drag") {
          await this.dispatchDrag(tab, target, params)
        } else {
          await this.dispatchMouse(tab, method, target)
        }
      } finally {
        tab.agentDispatching = false
      }
      return { ok: true, inputSequence: tab.inputSequence }
    }
    throw browserError("unsupported")
  }

  private async navigate(tab: BrowserTab, url: string, context: BrowserRequestContext, privateOriginApproved = false): Promise<BrowserTabDescriptor> {
    if (privateOriginApproved && isPrivateUrl(url)) {
      const origin = safeOrigin(url)
      if (origin) (tab.approvedPrivateOrigins ??= new Set()).add(origin)
    }
    if (!isAllowedNavigation(url, context.actor === "agent", this.settings, tab.approvedPrivateOrigins)) throw browserError(isPrivateUrl(url) ? "private_origin_confirmation_required" : "invalid_url")
    const contents = tab.webContents
    const policy = this.sessionPolicies.get(contents?.session ?? session.fromPartition(tab.partition))
    if (policy?.networkReady) {
      try { await policy.networkReady } catch { throw browserError("browser_unavailable") }
    }
    if (!contents || contents.isDestroyed()) {
      tab.url = normalizeNavigableUrl(url)
      tab.pendingUrl = tab.url
      tab.securityState = securityStateForUrl(tab.url)
      tab.lastOpenedAt = new Date().toISOString()
      this.rememberTab(tab)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      return publicTab(tab)
    }
    await contents.loadURL(normalizeNavigableUrl(url))
    return publicTab(tab)
  }

  private async requestBrowserAuth(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<BrowserAuthResult> {
    if (context.actor !== "agent" || !this.options.authPreloadPath) throw browserError("action_denied")
    const request = sanitizeBrowserAuthRequest(params)
    const origin = safeOrigin(tab.url)
    const expiresAt = Date.parse(request.expiresAt)
    if (!origin || request.tabId !== tab.tabId || request.generation !== tab.generation) return { status: "page_changed" }
    if (request.origin !== origin) return { status: "origin_changed" }
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return { status: "expired" }
    if (expiresAt > Date.now() + 5 * 60_000) throw browserError("invalid_browser_request")
    try {
      for (const field of request.fields) await this.validateBrowserAuthField(tab, field)
      if (request.submit?.kind === "click") await this.resolveTarget(tab, { locator: combineAuthLocators(request.submit.frameLocator, request.submit.locator) })
    } catch { return { status: "locator_invalid" } }
    const parent = this.options.getWindow()
    if (!parent || parent.isDestroyed()) throw browserError("browser_unavailable")
    this.closeAuthSessionsForTab(tab.tabId, "cancelled")
    const authWindow = new BrowserWindow({
      parent,
      modal: true,
      frame: false,
      show: false,
      width: 440,
      height: Math.min(680, 250 + request.fields.length * 74),
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: "#151517",
      webPreferences: { preload: this.options.authPreloadPath, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false },
    })
    authWindow.setMenuBarVisibility(false)
    authWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    return new Promise((resolveAuth) => {
      const auth: BrowserAuthSession = {
        window: authWindow,
        tabId: tab.tabId,
        generation: tab.generation,
        inputSequence: tab.inputSequence,
        origin,
        request,
        settled: false,
        timer: setTimeout(() => this.settleBrowserAuth(auth, { status: "expired" }), Math.max(1, expiresAt - Date.now())),
        resolve: resolveAuth,
      }
      this.authSessions.set(authWindow.webContents.id, auth)
      const id = authWindow.webContents.id
      authWindow.once("closed", () => {
        clearTimeout(auth.timer)
        this.authSessions.delete(id)
        if (!auth.settled) { auth.settled = true; auth.resolve({ status: "cancelled" }) }
      })
      authWindow.once("ready-to-show", () => { authWindow.show(); authWindow.focus() })
      void authWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(browserAuthHtml(request))}`).catch(() => this.settleBrowserAuth(auth, { status: "cancelled" }))
    })
  }

  private async validateBrowserAuthField(tab: BrowserTab, field: BrowserAuthFieldRequest): Promise<ResolvedBrowserTarget> {
    const locator = combineAuthLocators(field.frameLocator, field.locator)
    const target = await this.resolveTarget(tab, { locator })
    if (!target.editable) throw browserError("stale_target")
    const actualTypeValue = await this.queryLocator(tab, "getAttribute", { locator, name: "type" })
    const actualAutocompleteValue = await this.queryLocator(tab, "getAttribute", { locator, name: "autocomplete" })
    const actualRequiredValue = await this.queryLocator(tab, "getAttribute", { locator, name: "required" })
    const actualType = String(actualTypeValue ?? "text").toLowerCase()
    const requestedType = field.inputType === "otp" ? "text" : field.inputType
    if (actualType !== requestedType && !(requestedType === "text" && actualType === "")) throw browserError("stale_target")
    if (field.autocomplete !== undefined && String(actualAutocompleteValue ?? "") !== field.autocomplete) throw browserError("stale_target")
    if (field.required !== (actualRequiredValue !== null && actualRequiredValue !== undefined)) throw browserError("stale_target")
    return target
  }

  private async handleBrowserAuthMessage(auth: BrowserAuthSession, payload: unknown): Promise<void> {
    if (!isRecord(payload) || auth.settled) return
    if (payload.cancel === true) { this.settleBrowserAuth(auth, { status: "cancelled" }); return }
    if (payload.decline === true) { this.settleBrowserAuth(auth, { status: "declined" }); return }
    if (!isRecord(payload.values)) return
    const tab = this.tabs.get(auth.tabId)
    if (!tab || tab.generation !== auth.generation || tab.inputSequence !== auth.inputSequence) { this.settleBrowserAuth(auth, { status: "page_changed" }); return }
    if (safeOrigin(tab.url) !== auth.origin) { this.settleBrowserAuth(auth, { status: "origin_changed" }); return }
    const selectedOption = typeof payload.selectedOption === "string" ? payload.selectedOption : undefined
    const option = auth.request.options?.find((item) => item.id === selectedOption)
    if (auth.request.options?.length && !option) return
    // method-only 选项：用户选择登录方式，主进程点击对应按钮，不填写任何字段
    if (option?.locator) {
      try {
        const target = await this.resolveTarget(tab, { locator: combineAuthLocators(option.frameLocator, option.locator) })
        if (auth.settled) return
        if (tab.generation !== auth.generation || tab.inputSequence !== auth.inputSequence) {
          this.settleBrowserAuth(auth, { status: "page_changed" })
          return
        }
        if (safeOrigin(tab.url) !== auth.origin) {
          this.settleBrowserAuth(auth, { status: "origin_changed" })
          return
        }
        tab.inputSequence += 1
        tab.agentDispatching = true
        try {
          await this.dispatchMouse(tab, "click", target)
        } finally {
          tab.agentDispatching = false
        }
        this.settleBrowserAuth(auth, { status: "submitted", selected_option: selectedOption })
      } catch {
        this.settleBrowserAuth(auth, { status: "submission_failed" })
      }
      return
    }
    const enabledFieldIds = new Set(option?.fields ?? auth.request.fields.map((field) => field.id))
    const values = new Map<string, string>()
    for (const field of auth.request.fields) {
      if (!enabledFieldIds.has(field.id)) continue
      const value = payload.values[field.id]
      if (typeof value !== "string" || value.length > 100_000 || (field.required && !value)) return
      values.set(field.id, value)
    }
    try {
      const targets = new Map<string, ResolvedBrowserTarget>()
      for (const field of auth.request.fields) if (values.has(field.id)) targets.set(field.id, await this.validateBrowserAuthField(tab, field))
      if (tab.generation !== auth.generation || tab.inputSequence !== auth.inputSequence) { this.settleBrowserAuth(auth, { status: "page_changed" }); return }
      tab.agentDispatching = true
      try {
        for (const field of auth.request.fields) {
          const value = values.get(field.id)
          const target = targets.get(field.id)
          if (value === undefined || !target) continue
          await this.dispatchMouse(tab, "click", target)
          await this.applyText(tab, target, value, true)
        }
        const submit = auth.request.submit
        if (submit?.kind === "click") {
          const target = await this.resolveTarget(tab, { locator: combineAuthLocators(submit.frameLocator, submit.locator) })
          await this.dispatchMouse(tab, "click", target)
        } else if (submit?.kind === "press_enter") {
          const targetField = auth.request.fields.find((field) => field.id === submit.fieldId) ?? [...auth.request.fields].reverse().find((field) => values.has(field.id))
          const target = targetField ? targets.get(targetField.id) : undefined
          if (!target) throw browserError("stale_target")
          await this.pressTarget(tab, target, "Enter")
        }
      } finally {
        tab.agentDispatching = false
        tab.inputSequence += 1
        values.clear()
      }
      this.settleBrowserAuth(auth, { status: "submitted", ...(selectedOption ? { selected_option: selectedOption } : {}) })
    } catch {
      values.clear()
      this.settleBrowserAuth(auth, { status: "submission_failed" })
    }
  }

  private settleBrowserAuth(auth: BrowserAuthSession, result: BrowserAuthResult): void {
    if (auth.settled) return
    auth.settled = true
    clearTimeout(auth.timer)
    auth.resolve(result)
    if (!auth.window.isDestroyed()) auth.window.close()
  }

  private closeAuthSessionsForTab(tabId: string, status: BrowserAuthResult["status"]): void {
    for (const auth of this.authSessions.values()) if (auth.tabId === tabId) this.settleBrowserAuth(auth, { status })
  }

  private async fillSavedContact(tab: BrowserTab, params: Record<string, unknown>): Promise<{ status: "submitted" }> {
    const value = this.credentials.contactValue(String(params.contactId ?? ""), String(params.field ?? ""))
    if (!value) throw browserError("action_denied")
    await this.fillSecret(tab, params, value)
    return { status: "submitted" }
  }

  private async fillSavedPassword(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<{ status: "submitted" }> {
    const value = this.credentials.passwordForOrigin(String(params.secretId ?? ""), tab.url)
    if (!value) throw browserError("action_denied")
    await this.fillSecret(tab, params, value, context)
    return { status: "submitted" }
  }

  private async fillSecret(tab: BrowserTab, params: Record<string, unknown>, value: string, context?: BrowserRequestContext): Promise<void> {
    const generation = tab.generation
    const inputSequence = tab.inputSequence
    const target = await this.resolveTarget(tab, params, context)
    if (!target.editable || tab.generation !== generation || tab.inputSequence !== inputSequence) throw browserError("stale_target")
    tab.inputSequence += 1
    tab.agentDispatching = true
    try {
      await this.dispatchMouse(tab, "click", target)
      if (tab.generation !== generation) throw browserError("stale_target")
      await this.applyText(tab, target, value, true)
    } finally { tab.agentDispatching = false }
  }

  private async uploadFileRefs(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<{ status: "submitted"; count: number }> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const refs = Array.isArray(params.fileRefs) ? params.fileRefs.filter((value): value is string => typeof value === "string").slice(0, 20) : []
    if (!refs.length) throw browserError("invalid_browser_request")
    const origin = safeOrigin(tab.url)
    if (origin && this.settings.sitePermissionOverrides?.[origin]?.upload === "deny") throw browserError("action_denied")
    const files = refs.map((ref) => {
      const match = /^browser-download:([a-f0-9-]{36})$/i.exec(ref)
      const record = match ? this.downloadRefs.get(match[1]) : undefined
      if (!record || record.browserSessionId !== context.browserSessionId || record.browserTurnId !== context.browserTurnId) throw browserError("action_denied")
      const metadata = lstatSync(record.path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || realpathSync(record.path) !== record.path) throw browserError("action_denied")
      return record.path
    })
    const generation = tab.generation
    const inputSequence = tab.inputSequence
    const target = await this.resolveTarget(tab, params, context)
    if (target.tagName.toLowerCase() !== "input" || tab.generation !== generation || tab.inputSequence !== inputSequence) throw browserError("stale_target")
    await withDebugger(browserContents(tab), async (debuggerRef) => {
      const located = await debuggerRef.sendCommand("DOM.getNodeForLocation", { x: Math.round(target.x), y: Math.round(target.y) }) as { backendNodeId?: number }
      if (!located.backendNodeId || tab.generation !== generation) throw browserError("stale_target")
      await debuggerRef.sendCommand("DOM.setFileInputFiles", { files, backendNodeId: located.backendNodeId })
    })
    tab.inputSequence += 1
    return { status: "submitted", count: files.length }
  }

  private waitForDownload(tab: BrowserTab, context: BrowserRequestContext, timeoutMs: number): Promise<{ download_id: string }> {
    if (context.actor !== "agent") throw browserError("action_denied")
    return new Promise((resolve, reject) => {
      const waiter: BrowserDownloadWaiter = {
        browserSessionId: context.browserSessionId,
        browserTurnId: context.browserTurnId,
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.downloadWaiters.get(tab.tabId) ?? []
          this.downloadWaiters.set(tab.tabId, current.filter((item) => item !== waiter))
          reject(browserError("actionability_failed"))
        }, timeoutMs),
      }
      this.downloadWaiters.set(tab.tabId, [...(this.downloadWaiters.get(tab.tabId) ?? []), waiter])
    })
  }

  private async downloadPath(context: BrowserRequestContext, downloadId: string, timeoutMs: number): Promise<{ path: string | null }> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const result = this.downloadResults.get(downloadId)
    if (!result || result.browserSessionId !== context.browserSessionId || result.browserTurnId !== context.browserTurnId) throw browserError("action_denied")
    if (result.state === "completed") return { path: result.fileRef ?? null }
    if (result.state === "failed") return { path: null }
    return {
      path: await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          result.waiters = result.waiters.filter((waiter) => waiter !== finish)
          resolve(null)
        }, timeoutMs)
        const finish = (value: string | null) => {
          clearTimeout(timer)
          resolve(value)
        }
        result.waiters.push(finish)
      }),
    }
  }

  // ponytail: 兜底关闭用固定 120s 过期，覆盖 agent 拿到 chooser id 后不再 setFiles 的所有路径（含 turn 结束）
  private disableFileChooserInterceptIfIdle(tabId: string): void {
    if (this.fileChooserWaiters.get(tabId)?.length) return
    for (const chooser of this.fileChoosers.values()) if (chooser.tabId === tabId) return
    const tab = this.tabs.get(tabId)
    if (!tab?.webContents || tab.webContents.isDestroyed()) return
    void withDebugger(tab.webContents, (debuggerRef) => debuggerRef.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })).catch(() => undefined)
  }

  private async waitForFileChooser(tab: BrowserTab, context: BrowserRequestContext, timeoutMs: number): Promise<{ file_chooser_id: string; is_multiple: boolean }> {
    if (context.actor !== "agent") throw browserError("action_denied")
    await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }))
    return new Promise((resolve, reject) => {
      const waiter: BrowserFileChooserWaiter = {
        browserSessionId: context.browserSessionId,
        browserTurnId: context.browserTurnId,
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.fileChooserWaiters.get(tab.tabId) ?? []
          this.fileChooserWaiters.set(tab.tabId, current.filter((item) => item !== waiter))
          void withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })).catch(() => undefined)
          reject(browserError("actionability_failed"))
        }, timeoutMs),
      }
      this.fileChooserWaiters.set(tab.tabId, [...(this.fileChooserWaiters.get(tab.tabId) ?? []), waiter])
    })
  }

  private async setFileChooserFiles(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<Record<string, never>> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const chooserId = String(params.fileChooserId ?? params.file_chooser_id ?? "")
    const chooser = this.fileChoosers.get(chooserId)
    if (!chooser
      || chooser.tabId !== tab.tabId
      || chooser.generation !== tab.generation
      || chooser.browserSessionId !== context.browserSessionId
      || chooser.browserTurnId !== context.browserTurnId) throw browserError("stale_target")
    const refs = Array.isArray(params.files) ? params.files.filter((value): value is string => typeof value === "string").slice(0, chooser.isMultiple ? 20 : 1) : []
    const authorizedPaths = context.capability?.startsWith("browser-broker-v1:")
      && Array.isArray(params.__authorizedFiles)
      ? params.__authorizedFiles.filter((value): value is string => typeof value === "string").slice(0, chooser.isMultiple ? 20 : 1)
      : []
    if (!refs.length && !authorizedPaths.length) throw browserError("invalid_browser_request")
    const files = [...refs.map((ref) => {
      const match = /^browser-download:([a-f0-9-]{36})$/i.exec(ref)
      const record = match ? this.downloadRefs.get(match[1]) : undefined
      if (!record || record.browserSessionId !== context.browserSessionId || record.browserTurnId !== context.browserTurnId) throw browserError("action_denied")
      const metadata = lstatSync(record.path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || !samePath(realpathSync(record.path), record.path)) throw browserError("action_denied")
      return record.path
    }), ...authorizedPaths.map((path) => {
      const metadata = lstatSync(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 100 * 1024 * 1024 || !samePath(realpathSync(path), path)) throw browserError("action_denied")
      return path
    })].slice(0, chooser.isMultiple ? 20 : 1)
    try {
      await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId }))
      return {}
    } finally {
      clearTimeout(this.fileChoosers.get(chooserId)?.expiryTimer)
      this.fileChoosers.delete(chooserId)
      await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })).catch(() => undefined)
    }
  }

  private async downloadMedia(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<Record<string, never>> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const nodeId = typeof params.nodeId === "string" ? params.nodeId : typeof params.node_id === "string" ? params.node_id : ""
    const node = nodeId ? tab.domNodes?.get(nodeId) : undefined
    if (nodeId && (!node || node.generation !== tab.generation)) throw browserError("stale_target")
    const target = node
      ? { x: node.x, y: node.y }
      : await this.resolveTarget(tab, params, context)
    const generation = tab.generation
    const mediaUrl = await withDebugger(browserContents(tab), async (debuggerRef) => {
      const located = await debuggerRef.sendCommand("DOM.getNodeForLocation", {
        x: Math.round(target.x),
        y: Math.round(target.y),
        includeUserAgentShadowDOM: true,
      }) as { backendNodeId?: number }
      if (!located.backendNodeId || tab.generation !== generation) throw browserError("stale_target")
      const resolved = await debuggerRef.sendCommand("DOM.resolveNode", { backendNodeId: located.backendNodeId }) as { object?: { objectId?: string } }
      const objectId = resolved.object?.objectId
      if (!objectId) throw browserError("actionability_failed")
      try {
        const called = await debuggerRef.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function () {
            const element = this instanceof Element ? this : null;
            if (!element) return null;
            const candidate = element.closest("a[href]") || element.closest("img[src],video[src],audio[src],source[src]") || element.querySelector("a[href],img[src],video[src],audio[src],source[src]");
            if (!candidate) return null;
            const value = candidate instanceof HTMLAnchorElement ? candidate.href : candidate.currentSrc || candidate.src;
            return typeof value === "string" ? value : null;
          }`,
          returnByValue: true,
          awaitPromise: false,
        }) as { result?: { value?: unknown } }
        return typeof called.result?.value === "string" ? called.result.value : ""
      } finally {
        await debuggerRef.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined)
      }
    })
    if (!mediaUrl || !isAllowedNavigation(mediaUrl, true, this.settings, tab.approvedPrivateOrigins)) throw browserError("actionability_failed")
    const protocol = new URL(mediaUrl).protocol
    if (protocol !== "http:" && protocol !== "https:") throw browserError("action_denied")
    browserContents(tab).downloadURL(mediaUrl)
    return {}
  }

  private async listPageAssets(tab: BrowserTab, context: BrowserRequestContext): Promise<Record<string, unknown>> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const generation = tab.generation
    const observed = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
      code: `(() => {
        const absoluteUrl = value => {
          try {
            const parsed = new URL(value, document.baseURI);
            return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
          } catch { return null; }
        };
        const resources = performance.getEntriesByType("resource").slice(-3000).flatMap(entry => {
          const url = absoluteUrl(entry.name);
          return url ? [{ url, hint: entry.initiatorType || "", source: { kind: "resource" } }] : [];
        });
        const attributes = Array.from(document.querySelectorAll("img[src],img[srcset],source[src],source[srcset],video[src],audio[src],script[src],link[href],a[download][href]")).slice(0, 3000).flatMap((element, index) => {
          const values = [];
          for (const property of ["src", "href"]) {
            const url = absoluteUrl(element[property]);
            if (url) values.push({ url, hint: element.tagName.toLowerCase(), source: { kind: "attribute", nodeId: index + 1, property } });
          }
          const srcset = element.getAttribute("srcset");
          if (srcset) for (const candidate of srcset.split(",")) {
            const url = absoluteUrl(candidate.trim().split(/\\s+/)[0]);
            if (url) values.push({ url, hint: element.tagName.toLowerCase(), source: { kind: "attribute", nodeId: index + 1, property: "srcset" } });
          }
          return values;
        });
        const computed = Array.from(document.querySelectorAll("body *")).slice(0, 1500).flatMap((element, index) => {
          const values = [];
          for (const property of ["backgroundImage", "listStyleImage", "borderImageSource"]) {
            const raw = getComputedStyle(element)[property];
            for (const match of raw.matchAll(/url\\((?:"([^"]+)"|'([^']+)'|([^\\)]+))\\)/g)) {
              const url = absoluteUrl(match[1] || match[2] || match[3]);
              if (url) values.push({ url, hint: "image", source: { kind: "computedStyle", nodeId: index + 1, property } });
            }
          }
          return values;
        });
        const inlineSvgs = Array.from(document.querySelectorAll("svg")).slice(0, 200).flatMap((svg, index) => {
          const markup = svg.outerHTML;
          return markup.length <= 100000 ? [{ id: "svg-" + (index + 1), markup, name: svg.getAttribute("aria-label") || svg.id || "inline-" + (index + 1) + ".svg" }] : [];
        });
        return { resources, attributes, computed, inlineSvgs };
      })()`,
    }], true) as {
      resources?: Array<{ url?: unknown; hint?: unknown; source?: unknown }>
      attributes?: Array<{ url?: unknown; hint?: unknown; source?: unknown }>
      computed?: Array<{ url?: unknown; hint?: unknown; source?: unknown }>
      inlineSvgs?: Array<{ id?: unknown; markup?: unknown; name?: unknown }>
    }
    if (generation !== tab.generation) throw browserError("stale_target")
    const indexed = new Map<string, BrowserPageAsset>()
    for (const item of [...(observed.resources ?? []), ...(observed.attributes ?? []), ...(observed.computed ?? [])]) {
      if (typeof item.url !== "string" || !isAllowedNavigation(item.url, true, this.settings, tab.approvedPrivateOrigins)) continue
      const url = stripUrl(item.url)
      const existing = indexed.get(url)
      const source = normalizePageAssetSource(item.source)
      if (existing) {
        if (source && !existing.sources.some((value) => value.kind === source.kind && value.nodeId === source.nodeId && value.property === source.property)) existing.sources.push(source)
        continue
      }
      indexed.set(url, {
        id: createHash("sha256").update(url).digest("base64url").slice(0, 24),
        kind: pageAssetKind(url, typeof item.hint === "string" ? item.hint : ""),
        name: pageAssetName(url),
        sources: source ? [source] : [],
        url,
      })
      if (indexed.size >= 2000) break
    }
    const assets = [...indexed.values()]
    const inlineSvgs = (observed.inlineSvgs ?? []).flatMap((item) =>
      typeof item.id === "string" && typeof item.markup === "string" && item.markup.length <= 100_000
        ? [{ id: item.id.slice(0, 128), markup: item.markup, name: safeDownloadFilename(String(item.name ?? "inline.svg")) }]
        : [],
    ).slice(0, 200)
    const inventoryId = randomUUID()
    this.pageAssetInventories.set(inventoryId, {
      id: inventoryId,
      tabId: tab.tabId,
      generation,
      browserSessionId: context.browserSessionId,
      browserTurnId: context.browserTurnId,
      assets,
    })
    while (this.pageAssetInventories.size > 50) this.pageAssetInventories.delete(this.pageAssetInventories.keys().next().value!)
    const byKind = Object.fromEntries(["script", "font", "image", "stylesheet", "video", "other"].map((kind) => [kind, assets.filter((asset) => asset.kind === kind).length]))
    return {
      id: inventoryId,
      pageUrl: tab.url || null,
      assets,
      inlineSvgs,
      summary: { byKind, inlineSvgCount: inlineSvgs.length, totalCount: assets.length },
    }
  }

  private async bundlePageAssets(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<Record<string, unknown>> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const inventory = this.pageAssetInventories.get(String(params.inventoryId ?? params.inventory_id ?? ""))
    if (!inventory
      || inventory.tabId !== tab.tabId
      || inventory.generation !== tab.generation
      || inventory.browserSessionId !== context.browserSessionId
      || inventory.browserTurnId !== context.browserTurnId) throw browserError("stale_target")
    const requestedAssetIds = params.assetIds ?? params.asset_ids
    const requestedIds = new Set(Array.isArray(requestedAssetIds) ? requestedAssetIds.filter((value): value is string => typeof value === "string").slice(0, 100) : [])
    const requestedKinds = new Set(Array.isArray(params.kinds) ? params.kinds.filter((value): value is string => ["font", "image", "stylesheet", "video"].includes(String(value))).slice(0, 4) : [])
    const assets = inventory.assets.filter((asset) =>
      ["font", "image", "stylesheet", "video"].includes(asset.kind)
      && (!requestedIds.size || requestedIds.has(asset.id))
      && (!requestedKinds.size || requestedKinds.has(asset.kind)),
    ).slice(0, 100)
    const startedAt = Date.now()
    const directory = join(this.options.configDir(), "browser", "assets", safePartition(context.browserSessionId), safePartition(context.browserTurnId), inventory.id)
    const exported: Array<Record<string, unknown>> = []
    const failures: Array<Record<string, unknown>> = []
    let totalBytes = 0
    for (const asset of assets) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30_000)
      try {
        if (!isAllowedNavigation(asset.url, true, this.settings, tab.approvedPrivateOrigins)) throw new Error("blocked")
        const response = await browserContents(tab).session.fetch(asset.url, { redirect: "follow", signal: controller.signal })
        const finalUrl = response.url || asset.url
        if (!response.ok || !isAllowedNavigation(finalUrl, true, this.settings, tab.approvedPrivateOrigins)) throw new Error(`http_${response.status}`)
        const declaredSize = Number(response.headers.get("content-length") ?? 0)
        if (declaredSize > 20 * 1024 * 1024 || totalBytes + declaredSize > 100 * 1024 * 1024) throw new Error("size_limit")
        const data = Buffer.from(await response.arrayBuffer())
        if (data.length > 20 * 1024 * 1024 || totalBytes + data.length > 100 * 1024 * 1024) throw new Error("size_limit")
        totalBytes += data.length
        const prepared = prepareDownload(directory, `${asset.id.slice(0, 8)}-${asset.name}`)
        writeFileSync(prepared.partialPath, data, { mode: 0o600 })
        completeDownload(prepared)
        exported.push({
          contentType: response.headers.get("content-type"),
          id: asset.id,
          kind: asset.kind,
          name: prepared.filename,
          path: prepared.finalPath,
          url: stripUrl(finalUrl),
        })
      } catch (error) {
        failures.push({
          contentType: null,
          id: asset.id,
          name: asset.name,
          reason: error instanceof Error ? error.message.slice(0, 160) : "download_failed",
          url: asset.url,
        })
      } finally {
        clearTimeout(timer)
      }
    }
    const manifest = prepareDownload(directory, "manifest.json")
    writeFileSync(manifest.partialPath, JSON.stringify({ inventoryId: inventory.id, pageUrl: tab.url, assets: exported, failures }, null, 2), { mode: 0o600 })
    completeDownload(manifest)
    return {
      assets: exported,
      directoryPath: directory,
      failures,
      manifestPath: manifest.finalPath,
      summary: {
        downloadedCount: exported.length,
        elapsedMs: Date.now() - startedAt,
        failedCount: failures.length,
        requestedCount: assets.length,
      },
    }
  }

  private async dispatchMouse(tab: BrowserTab, method: string, params: Record<string, unknown>): Promise<void> {
    const x = boundedNumber(params.x, 0, 100_000)
    const y = boundedNumber(params.y, 0, 100_000)
    this.showAgentCursor(tab, x, y, method === "click" || method === "doubleClick")
    if (method === "click" || method === "doubleClick") {
      const clicked = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
        code: `(() => {
          let frameDocument = document;
          let x = ${JSON.stringify(x)};
          let y = ${JSON.stringify(y)};
          let element = null;
          for (let depth = 0; depth < 8; depth += 1) {
            element = frameDocument.elementFromPoint(x, y);
            if (!(element instanceof frameDocument.defaultView.Element)) return false;
            if (!["iframe", "frame"].includes(element.tagName.toLowerCase()) || !element.contentDocument) break;
            const rect = element.getBoundingClientRect();
            x -= rect.left;
            y -= rect.top;
            frameDocument = element.contentDocument;
          }
          if (!(element instanceof frameDocument.defaultView.Element)) return false;
          const win = frameDocument.defaultView;
          if (typeof element.click === "function") element.click();
          else element.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
          if (${JSON.stringify(method === "doubleClick")}) {
            if (typeof element.click === "function") element.click();
            else element.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
            element.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true, view: win, detail: 2 }));
          }
          return true;
        })()`,
      }], true)
      if (!clicked) throw browserError("stale_target")
      return
    }
    await withDebugger(browserContents(tab), async (debuggerRef) => {
      await debuggerRef.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
      if (method === "hover") return
    })
  }

  private async dispatchKey(tab: BrowserTab, key: string, modifiers: string[] = []): Promise<void> {
    await withDebugger(browserContents(tab), async (debuggerRef) => {
      const modifier = modifiers.includes("CTRL") ? 2 : modifiers.includes("META") ? 4 : 0
      await debuggerRef.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers: modifier })
      await debuggerRef.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers: modifier })
    })
  }

  private async applyText(tab: BrowserTab, target: ResolvedBrowserTarget, text: string, replace: boolean): Promise<void> {
    const applied = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
      code: `(() => {
        let frameDocument = document;
        let x = ${JSON.stringify(target.x)};
        let y = ${JSON.stringify(target.y)};
        let element = null;
        for (let depth = 0; depth < 8; depth += 1) {
          element = frameDocument.elementFromPoint(x, y);
          if (!(element instanceof frameDocument.defaultView.HTMLElement)) return false;
          if (!["iframe", "frame"].includes(element.tagName.toLowerCase()) || !element.contentDocument) break;
          const rect = element.getBoundingClientRect();
          x -= rect.left;
          y -= rect.top;
          frameDocument = element.contentDocument;
        }
        if (!(element instanceof frameDocument.defaultView.HTMLElement)) return false;
        const win = frameDocument.defaultView;
        const text = ${JSON.stringify(text)};
        const replace = ${JSON.stringify(replace)};
        element.focus({ preventScroll: true });
        const nextValue = current => replace ? text : current + text;
        if (element instanceof win.HTMLInputElement) {
          const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
          if (!setter) return false;
          setter.call(element, nextValue(element.value));
        } else if (element instanceof win.HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value")?.set;
          if (!setter) return false;
          setter.call(element, nextValue(element.value));
        } else if (element.isContentEditable) {
          element.textContent = nextValue(element.textContent || "");
        } else {
          return false;
        }
        element.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: replace ? "insertReplacementText" : "insertText", data: text }));
        return true;
      })()`,
    }], true)
    if (!applied) throw browserError("stale_target")
  }

  private async applyTextToActive(tab: BrowserTab, text: string): Promise<void> {
    if (text.length > 100_000) throw browserError("invalid_browser_request")
    const applied = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return false;
      if (element instanceof HTMLInputElement) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (!descriptor?.set) return false;
        descriptor.set.call(element, element.value + ${JSON.stringify(text)});
      } else if (element instanceof HTMLTextAreaElement) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
        if (!descriptor?.set) return false;
        descriptor.set.call(element, element.value + ${JSON.stringify(text)});
      } else if (element.isContentEditable) element.textContent = (element.textContent || "") + ${JSON.stringify(text)};
      else return false;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()` }], true)
    if (!applied) throw browserError("stale_target")
  }

  private async pressTarget(tab: BrowserTab, target: ResolvedBrowserTarget, keySpec: string): Promise<void> {
    if (!keySpec || keySpec.length > 128) throw browserError("invalid_browser_request")
    const pressed = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const element = document.elementFromPoint(${JSON.stringify(target.x)}, ${JSON.stringify(target.y)});
      if (!(element instanceof HTMLElement)) return false;
      element.focus({ preventScroll: true });
      if (document.activeElement !== element && !element.contains(document.activeElement)) return false;
      const parts = ${JSON.stringify(keySpec)}.split("+");
      const key = parts.pop() || "Enter";
      const options = {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: parts.includes("Control") || parts.includes("Ctrl"),
        metaKey: parts.includes("Meta"),
        altKey: parts.includes("Alt"),
        shiftKey: parts.includes("Shift"),
      };
      const proceed = element.dispatchEvent(new KeyboardEvent("keydown", options));
      if (proceed && (key === "Enter" || key === " ")) {
        if (element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement || (element instanceof HTMLInputElement && ["button", "submit", "reset", "checkbox", "radio"].includes(element.type))) {
          HTMLElement.prototype.click.call(element);
        } else if (key === "Enter" && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          element.form?.requestSubmit();
        }
      }
      element.dispatchEvent(new KeyboardEvent("keyup", options));
      return true;
    })()` }], true)
    if (!pressed) throw browserError("stale_target")
  }

  private async queryLocator(tab: BrowserTab, operation: string, params: Record<string, unknown>): Promise<unknown> {
    if (operation === "evaluate") return this.evaluateLocatorReadonly(tab, params)
    const allowed = new Set<BrowserLocatorQuery>(["count", "allTextContents", "readAll", "getAttribute", "innerText", "textContent", "inputValue", "isVisible", "isEnabled", "isChecked"])
    if (!allowed.has(operation as BrowserLocatorQuery)) {
      if (operation === "waitFor") return this.waitForLocator(tab, params)
      throw browserError("unsupported")
    }
    if (operation === "getAttribute" && (typeof params.name !== "string" || params.name.length > 256)) throw browserError("invalid_browser_request")
    return this.executeLocatorQuery(tab, params, operation as BrowserLocatorQuery, typeof params.name === "string" ? params.name : undefined)
  }

  private async evaluateLocatorReadonly(tab: BrowserTab, params: Record<string, unknown>): Promise<unknown> {
    if (!isBrowserLocator(params.locator)) throw browserError("invalid_browser_request")
    const locator = params.locator
    const script = String(params.script ?? params.expression ?? "")
    if (!script || script.length > 100_000) throw browserError("invalid_browser_request")
    validateBrowserLocator(locator)
    const timeoutMs = boundedNumber(params.timeoutMs ?? params.timeout_ms ?? 3_000, 1, 10_000)
    const argument = JSON.stringify({ script, arg: params.arg ?? null, timeoutMs })
    if (splitFrameLocator(locator)) return this.executeFrameLocatorQuery(tab, locator, "evaluate", argument)
    const generation = tab.generation
    const result = await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Runtime.evaluate", {
      expression: locatorReadonlyExpression(locator, script, params.arg),
      awaitPromise: true,
      returnByValue: true,
      throwOnSideEffect: true,
      timeout: timeoutMs,
    })) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
    if (result.exceptionDetails) throw browserError(readonlyLocatorExceptionCode(result.exceptionDetails))
    if (generation !== tab.generation) throw browserError("stale_target")
    return result.result?.value
  }

  private async executeLocatorQuery(tab: BrowserTab, params: Record<string, unknown>, operation: BrowserLocatorQuery, argument?: string): Promise<unknown> {
    if (!isBrowserLocator(params.locator)) throw browserError("invalid_browser_request")
    try {
      validateBrowserLocator(params.locator)
      if (splitFrameLocator(params.locator)) return await this.executeFrameLocatorQuery(tab, params.locator, operation, argument)
      return await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{ code: `(${browserLocatorScript()})(${JSON.stringify(params.locator)},${JSON.stringify(operation)},${JSON.stringify(argument)})` }], true)
    } catch (error) {
      // 已带 code 的 browserError（含 withDebugger 归类的 tab_not_found/stale_target）原样透传，避免被改写
      if (error && typeof error === "object" && "code" in error) throw error
      const message = error instanceof Error ? error.message : ""
      const code = ["stale_target", "strict_locator_violation", "action_denied", "tab_not_found"].find((value) => message.includes(value)) ?? "stale_target"
      throw browserError(code as BrowserErrorCode)
    }
  }

  private async executeFrameLocatorQuery(
    tab: BrowserTab,
    locator: BrowserLocator,
    operation: BrowserLocatorQuery,
    argument?: string,
    actionGuard?: { generation: number; inputSequence: number },
  ): Promise<unknown> {
    const parts = splitFrameLocator(locator)
    if (!parts) throw browserError("invalid_browser_request")
    const evaluation = operation === "evaluate" ? parseLocatorEvaluation(argument) : undefined
    const generation = tab.generation
    return withDebugger(browserContents(tab), async (debuggerRef) => {
      const frameTree = await debuggerRef.sendCommand("Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } }
      let frameId = frameTree.frameTree?.frame?.id
      if (!frameId) throw browserError("stale_target")
      let offsetX = 0
      let offsetY = 0
      for (const selector of parts.frameSelectors) {
        const isolated = await debuggerRef.sendCommand("Page.createIsolatedWorld", {
          frameId,
          worldName: "lume-browser-locator",
          grantUniveralAccess: false,
        }) as { executionContextId?: number }
        if (!isolated.executionContextId) throw browserError("stale_target")
        const evaluated = await debuggerRef.sendCommand("Runtime.evaluate", {
          contextId: isolated.executionContextId,
          expression: `(() => { const frames = Array.from(document.querySelectorAll(${JSON.stringify(selector)})); if (frames.length !== 1) throw new Error(frames.length ? "strict_locator_violation" : "stale_target"); return frames[0]; })()`,
          returnByValue: false,
        }) as { result?: { objectId?: string }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
        if (evaluated.exceptionDetails) throw browserError(frameLocatorExceptionCode(evaluated.exceptionDetails))
        const objectId = evaluated.result?.objectId
        if (!objectId) throw browserError("stale_target")
        try {
          const described = await debuggerRef.sendCommand("DOM.describeNode", { objectId }) as { node?: { frameId?: string } }
          const box = await debuggerRef.sendCommand("DOM.getBoxModel", { objectId }) as { model?: { content?: number[] } }
          const content = box.model?.content
          if (!described.node?.frameId || !content || content.length < 2) throw browserError("stale_target")
          offsetX += finiteNumber(content[0])
          offsetY += finiteNumber(content[1])
          frameId = described.node.frameId
        } finally {
          await debuggerRef.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined)
        }
      }
      const isolated = await debuggerRef.sendCommand("Page.createIsolatedWorld", {
        frameId,
        worldName: "lume-browser-locator",
        grantUniveralAccess: false,
      }) as { executionContextId?: number }
      if (!isolated.executionContextId || generation !== tab.generation) throw browserError("stale_target")
      if (actionGuard) {
        if (tab.generation !== actionGuard.generation || tab.inputSequence !== actionGuard.inputSequence) throw browserError("stale_target")
        tab.inputSequence += 1
        actionGuard.inputSequence = tab.inputSequence
        tab.agentDispatching = true
      }
      let evaluated: { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
      try {
        evaluated = await debuggerRef.sendCommand("Runtime.evaluate", {
          contextId: isolated.executionContextId,
          expression: evaluation
            ? locatorReadonlyExpression(parts.locator, evaluation.script, evaluation.arg)
            : `(${browserLocatorScript()})(${JSON.stringify(parts.locator)},${JSON.stringify(operation)},${JSON.stringify(argument)})`,
          returnByValue: true,
          awaitPromise: true,
          ...(evaluation ? { throwOnSideEffect: true, timeout: evaluation.timeoutMs } : {}),
        }) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
      } finally {
        if (actionGuard) tab.agentDispatching = false
      }
      if (evaluated.exceptionDetails) throw browserError(evaluation ? readonlyLocatorExceptionCode(evaluated.exceptionDetails) : frameLocatorExceptionCode(evaluated.exceptionDetails))
      if (generation !== tab.generation) throw browserError("stale_target")
      const value = evaluated.result?.value
      if (operation === "target" && isRecord(value)) return {
        ...value,
        x: finiteNumber(value.x) + offsetX,
        y: finiteNumber(value.y) + offsetY,
      }
      return value
    })
  }

  private async waitForLocator(tab: BrowserTab, params: Record<string, unknown>): Promise<void> {
    const state = new Set(["attached", "detached", "visible", "hidden"]).has(String(params.state)) ? String(params.state) : "visible"
    const timeoutMs = boundedNumber(params.timeoutMs, 0, 30_000) || 10_000
    const deadline = Date.now() + timeoutMs
    while (true) {
      const count = Number(await this.executeLocatorQuery(tab, params, "count"))
      let matched = state === "attached" ? count > 0 : state === "detached" ? count === 0 : false
      if (!matched && (state === "visible" || state === "hidden")) {
        if (count === 0) matched = state === "hidden"
        else if (count === 1) matched = Boolean(await this.executeLocatorQuery(tab, params, "isVisible")) === (state === "visible")
        else throw browserError("strict_locator_violation")
      }
      if (matched) return
      if (Date.now() >= deadline) throw browserError("actionability_failed")
      await delay(50)
    }
  }

  private async waitForUrl(tab: BrowserTab, expected: string, timeoutMs: number): Promise<void> {
    if (!expected || expected.length > 4096) throw browserError("invalid_browser_request")
    const pattern = new RegExp(`^${expected.split("*").map(escapeRegExp).join(".*")}$`)
    const deadline = Date.now() + timeoutMs
    while (!pattern.test(tab.url)) {
      if (Date.now() >= deadline) throw browserError("actionability_failed")
      await delay(50)
    }
  }

  private async waitForLoad(tab: BrowserTab, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (browserContents(tab).isLoading()) {
      if (Date.now() >= deadline) throw browserError("actionability_failed")
      await delay(50)
    }
  }

  private async resolveTarget(tab: BrowserTab, params: Record<string, unknown>, context?: BrowserRequestContext): Promise<ResolvedBrowserTarget> {
    if (typeof params.semanticRef === "string" || typeof params.semanticSnapshotId === "string") {
      if (!context) throw browserError("invalid_browser_request")
      return this.resolveSemanticRefTarget(tab, params, context)
    }
    if (params.locator === undefined) return { x: boundedNumber(params.x, 0, 100_000), y: boundedNumber(params.y, 0, 100_000), width: 1, height: 1, tagName: "", editable: true, enabled: true }
    if (!isBrowserLocator(params.locator)) throw browserError("invalid_browser_request")
    try {
      validateBrowserLocator(params.locator)
      if (splitFrameLocator(params.locator)) return await this.executeFrameLocatorQuery(tab, params.locator, "target") as ResolvedBrowserTarget
      return await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{ code: `(${browserLocatorScript()})(${JSON.stringify(params.locator)})` }], true) as ResolvedBrowserTarget
    } catch (error) {
      // 已带 code 的 browserError（含 withDebugger 归类的 tab_not_found/stale_target）原样透传，避免被改写
      if (error && typeof error === "object" && "code" in error) throw error
      const message = error instanceof Error ? error.message : ""
      const code = ["stale_target", "strict_locator_violation", "action_denied", "tab_not_found"].find((value) => message.includes(value)) ?? "stale_target"
      throw browserError(code as BrowserErrorCode)
    }
  }

  private async resolveSemanticRefTarget(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<ResolvedBrowserTarget> {
    const ref = typeof params.semanticRef === "string" ? params.semanticRef : ""
    const snapshotId = typeof params.semanticSnapshotId === "string" ? params.semanticSnapshotId : ""
    const entry = this.semanticRefSessions.get(context.browserSessionId)?.entries.get(ref)
    if (!ref || !snapshotId || !entry
      || entry.snapshotId !== snapshotId
      || entry.tabId !== tab.tabId
      || entry.generation !== tab.generation) throw browserError("stale_target")

    return withDebugger(browserContents(tab), async (debuggerRef) => {
      await debuggerRef.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId }).catch(() => undefined)
      const resolved = await debuggerRef.sendCommand("DOM.resolveNode", { backendNodeId: entry.backendNodeId }) as { object?: { objectId?: string } }
      const objectId = resolved.object?.objectId
      if (!objectId) throw browserError("stale_target")
      try {
        const inspected = await debuggerRef.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function () {
            const rect = this.getBoundingClientRect()
            const style = getComputedStyle(this)
            const enabled = !("disabled" in this && this.disabled) && this.getAttribute("aria-disabled") !== "true"
            return {
              editable: this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement || this instanceof HTMLSelectElement || this.isContentEditable,
              enabled,
              role: this.getAttribute("role") || undefined,
              tagName: String(this.tagName || "").toLowerCase(),
              visible: rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden",
            }
          }`,
          returnByValue: true,
        }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
        if (inspected.exceptionDetails) throw browserError("stale_target")
        const details = isRecord(inspected.result?.value) ? inspected.result.value : {}
        if (details.visible !== true || details.enabled === false) throw browserError("action_denied")

        const box = await debuggerRef.sendCommand("DOM.getBoxModel", { backendNodeId: entry.backendNodeId }) as { model?: { border?: number[]; content?: number[] } }
        const quad = box.model?.content ?? box.model?.border
        if (!Array.isArray(quad) || quad.length < 8) throw browserError("stale_target")
        const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number)
        const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number)
        if ([...xs, ...ys].some((value) => !Number.isFinite(value))) throw browserError("stale_target")
        const left = Math.min(...xs)
        const right = Math.max(...xs)
        const top = Math.min(...ys)
        const bottom = Math.max(...ys)
        const x = left + (right - left) / 2
        const y = top + (bottom - top) / 2

        const hit = await debuggerRef.sendCommand("DOM.getNodeForLocation", {
          x: Math.round(x),
          y: Math.round(y),
          includeUserAgentShadowDOM: true,
        }) as { backendNodeId?: number }
        if (!hit.backendNodeId) throw browserError("action_denied")
        if (hit.backendNodeId !== entry.backendNodeId) {
          const hitResolved = await debuggerRef.sendCommand("DOM.resolveNode", { backendNodeId: hit.backendNodeId }) as { object?: { objectId?: string } }
          const hitObjectId = hitResolved.object?.objectId
          if (!hitObjectId) throw browserError("action_denied")
          try {
            const containment = await debuggerRef.sendCommand("Runtime.callFunctionOn", {
              objectId,
              functionDeclaration: "function (hit) { return this === hit || this.contains(hit) }",
              arguments: [{ objectId: hitObjectId }],
              returnByValue: true,
            }) as { result?: { value?: unknown } }
            if (containment.result?.value !== true) throw browserError("action_denied")
          } finally {
            await debuggerRef.sendCommand("Runtime.releaseObject", { objectId: hitObjectId }).catch(() => undefined)
          }
        }
        return {
          x,
          y,
          width: right - left,
          height: bottom - top,
          tagName: typeof details.tagName === "string" ? details.tagName : "",
          ...(typeof details.role === "string" ? { role: details.role } : {}),
          editable: details.editable === true,
          enabled: details.enabled !== false,
        }
      } finally {
        await debuggerRef.sendCommand("Runtime.releaseObject", { objectId }).catch(() => undefined)
      }
    })
  }

  // auto-wait：在 timeoutMs 内重试 resolveTarget，让 locator 操作自动等元素就绪（对齐 Codex mI 循环）。
  // 检查项复用 resolveTarget 已有的 visible/enabled/obstruction；多匹配(strict)不重试立即抛；导航靠 generation 识别。
  private async resolveTargetWithAutoWait(
    tab: BrowserTab,
    generation: number,
    params: Record<string, unknown>,
    timeoutMs: number,
    context?: BrowserRequestContext,
  ): Promise<ResolvedBrowserTarget> {
    // 坐标点目标(无 locator)或 timeoutMs<=0(关闭等待)：直通 one-shot
    if (timeoutMs <= 0 || (params.locator === undefined && params.semanticRef === undefined)) {
      return this.resolveTarget(tab, params, context)
    }
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (tab.generation !== generation) throw browserError("stale_target")
      try {
        return await this.resolveTarget(tab, params, context)
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        if (message.includes("invalid_browser_request")) throw browserError("invalid_browser_request")
        if (message.includes("strict_locator_violation")) throw browserError("strict_locator_violation")
        if (message.includes("tab_not_found")) throw browserError("tab_not_found")
        if (params.semanticRef !== undefined && message.includes("stale_target")) throw browserError("stale_target")
        // resolveTarget 的 action_denied 仅表示目标暂时不可见、不可用或被遮挡；具体动作的永久拒绝发生在后续 dispatch。
        if (Date.now() >= deadline) throw browserError("actionability_failed")
        await delay(50)
      }
    }
  }

  // frame-locator action 的 auto-wait 包装（executeFrameLocatorQuery 单次查询无重试）
  private async runFrameLocatorActionWithAutoWait(
    tab: BrowserTab,
    generation: number,
    inputSequence: number,
    params: Record<string, unknown>,
    operation: BrowserLocatorQuery,
    argument: string | undefined,
    timeoutMs: number,
  ): Promise<void> {
    if (!isBrowserLocator(params.locator)) throw browserError("invalid_browser_request")
    const locator = params.locator
    const actionGuard = { generation, inputSequence }
    if (timeoutMs <= 0) {
      await this.executeFrameLocatorQuery(tab, locator, operation, argument, actionGuard)
      return
    }
    const deadline = Date.now() + timeoutMs
    while (true) {
      if (tab.generation !== generation || tab.inputSequence !== actionGuard.inputSequence) throw browserError("stale_target")
      try {
        await this.executeFrameLocatorQuery(tab, locator, operation, argument, actionGuard)
        return
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        if (message.includes("invalid_browser_request")) throw browserError("invalid_browser_request")
        if (message.includes("strict_locator_violation")) throw browserError("strict_locator_violation")
        if (message.includes("tab_not_found")) throw browserError("tab_not_found")
        if (message.includes("action_denied")) throw browserError("action_denied")
        if (Date.now() >= deadline) throw browserError("actionability_failed")
        await delay(50)
      }
    }
  }

  private async dispatchScroll(tab: BrowserTab, target: ResolvedBrowserTarget, params: Record<string, unknown>): Promise<void> {
    await this.dispatchMouse(tab, "hover", target)
    await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: target.x, y: target.y, deltaX: boundedNumber(params.deltaX, -10000, 10000), deltaY: boundedNumber(params.deltaY ?? params.y, -10000, 10000),
    }))
  }

  private async dispatchDrag(tab: BrowserTab, target: ResolvedBrowserTarget, params: Record<string, unknown>): Promise<void> {
    const endX = boundedNumber(params.toX ?? params.x2, 0, 100_000)
    const endY = boundedNumber(params.toY ?? params.y2, 0, 100_000)
    await this.showAgentCursor(tab, target.x, target.y, false)
    await withDebugger(browserContents(tab), async (debuggerRef) => {
      await debuggerRef.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y })
      await debuggerRef.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 })
      await debuggerRef.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: endX, y: endY, button: "left" })
      await debuggerRef.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: endY, button: "left", clickCount: 1 })
    })
    this.showAgentCursor(tab, endX, endY, false)
  }

  private showAgentCursor(tab: BrowserTab, x: number, y: number, pulse: boolean): void {
    this.options.emit({ method: "browser:agent-cursor", params: { tabId: tab.tabId, x, y, visible: this.settings.agentCursorVisible, pulse } })
    if (!this.settings.agentCursorVisible) return
    const parent = this.options.getWindow()
    if (!parent || parent.isDestroyed()) return
    if (!this.cursorOverlay || this.cursorOverlay.isDestroyed()) {
      this.cursorOverlay = new BrowserWindow({ parent, frame: false, transparent: true, focusable: false, skipTaskbar: true, show: false, alwaysOnTop: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      this.cursorOverlay.setIgnoreMouseEvents(true, { forward: true })
      this.cursorOverlay.webContents.once("did-finish-load", () => { if (this.cursorState) this.updateCursorOverlay(this.cursorState.x, this.cursorState.y, this.cursorState.pulse) })
      void this.cursorOverlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}#cursor{position:fixed;left:0;top:0;width:18px;height:18px;border:2px solid #fff;border-radius:50%;background:#2563eb;box-shadow:0 0 0 2px #1d4ed8,0 2px 8px #0008;transform:translate(-50%,-50%);transition:left 120ms cubic-bezier(.2,.8,.2,1),top 120ms cubic-bezier(.2,.8,.2,1),opacity 120ms}@keyframes pulse{to{box-shadow:0 0 0 2px #1d4ed8,0 0 0 18px transparent}}.pulse{animation:pulse 300ms ease-out}@media(prefers-reduced-motion:reduce){#cursor{transition:none}.pulse{animation:none}}</style><div id="cursor"></div>')}`)
    }
    this.cursorOverlay.setBounds(parent.getContentBounds())
    this.cursorOverlay.showInactive()
    const viewBounds = tab.surfaceBounds ?? { x: 0, y: 0, width: 1, height: 1 }
    this.cursorState = { x: x + viewBounds.x, y: y + viewBounds.y, pulse }
    this.updateCursorOverlay(this.cursorState.x, this.cursorState.y, pulse)
  }

  private updateCursorOverlay(x: number, y: number, pulse: boolean): void {
    if (!this.cursorOverlay || this.cursorOverlay.webContents.isLoading() || this.cursorOverlay.webContents.isDestroyed()) return
    void this.cursorOverlay.webContents.executeJavaScript(createCursorUpdateScript(x, y, pulse), true).catch(() => {
      this.options.emit({ method: "browser:cursor-error", params: { code: "cursor_update_failed" } })
    })
  }

  private hideAgentCursor(): void {
    this.cursorState = null
    if (this.cursorOverlay && !this.cursorOverlay.isDestroyed()) this.cursorOverlay.hide()
  }

  private async applySelect(tab: BrowserTab, params: Record<string, unknown>): Promise<void> {
    const values = Array.isArray(params.value) ? params.value.filter((value): value is string => typeof value === "string") : [String(params.value ?? "")]
    await browserContents(tab).executeJavaScript(`(values => { const select = document.activeElement; if (!(select instanceof HTMLSelectElement)) throw new Error("action_denied"); for (const option of Array.from(select.options)) option.selected = values.includes(option.value); select.dispatchEvent(new Event("input", { bubbles: true })); select.dispatchEvent(new Event("change", { bubbles: true })); })(${JSON.stringify(values)})`, true)
  }

  private async applyChecked(tab: BrowserTab, params: Record<string, unknown>, checked: boolean): Promise<void> {
    if (!params.locator) return
    await browserContents(tab).executeJavaScript(`(locator => { const el = document.activeElement; if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) throw new Error("action_denied"); if (el.checked !== ${checked}) el.click(); })(${JSON.stringify(params.locator)})`, true)
  }

  private async snapshot(tab: BrowserTab): Promise<unknown> {
    const result = await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("DOMSnapshot.captureSnapshot", { computedStyles: [] }))
    // 防 token 爆炸：大页面/SPA 的 DOMSnapshot 可达数 MB，超阈值返回截断提示，
    // 让 agent 改用 tab.screenshot()（视觉）或 playwright locator（精准定位）——对齐 Codex 大页面策略
    const text = JSON.stringify(result)
    if (text.length > 150_000) {
      return { truncated: true, byteLength: text.length, hint: "DOM snapshot too large for one read; use tab.screenshot() for visual context or playwright locators to target specific elements" }
    }
    return result
  }

  private async semanticSnapshot(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<unknown> {
    const requestedCursor = typeof params.cursor === "string" ? params.cursor : undefined
    if (requestedCursor) {
      const cached = this.semanticSnapshotCursors.get(requestedCursor)
      this.semanticSnapshotCursors.delete(requestedCursor)
      if (!cached
        || cached.sessionId !== context.browserSessionId
        || cached.tabId !== tab.tabId
        || cached.generation !== tab.generation) throw browserError("stale_target")
      return this.semanticSnapshotPage(cached)
    }

    const result = await withDebugger(browserContents(tab), async (debuggerRef) => {
      await debuggerRef.sendCommand("DOM.enable")
      await debuggerRef.sendCommand("Accessibility.enable")
      return debuggerRef.sendCommand("Accessibility.getFullAXTree") as Promise<{ nodes?: unknown }>
    })
    const session: BrowserSemanticRefSession = this.semanticRefSessions.get(context.browserSessionId) ?? {
      byIdentity: new Map<string, string>(),
      entries: new Map(),
      nextRef: 1,
    }
    this.semanticRefSessions.set(context.browserSessionId, session)
    const snapshotId = randomUUID()
    const tree = buildBrowserSemanticTree(result.nodes, {
      interactiveOnly: params.interactiveOnly === true || params.interactive_only === true,
      allocateRef: (entry) => {
        const identity = `${tab.tabId}\u0000${tab.generation}\u0000${entry.backendNodeId}`
        let ref = session.byIdentity.get(identity)
        if (!ref) {
          ref = `e${session.nextRef++}`
          session.byIdentity.set(identity, ref)
        }
        session.entries.set(ref, { ...entry, ref, generation: tab.generation, snapshotId, tabId: tab.tabId })
        return ref
      },
    })
    return this.semanticSnapshotPage({
      generation: tab.generation,
      limit: boundedNumber(params.limit ?? 400, 50, 1_000),
      lines: tree.lines,
      offset: 0,
      refs: tree.refs,
      sessionId: context.browserSessionId,
      snapshotId,
      tabId: tab.tabId,
      title: tab.title,
      url: tab.url,
    })
  }

  private semanticSnapshotPage(snapshot: BrowserSemanticSnapshotCursor): Record<string, unknown> {
    const end = Math.min(snapshot.lines.length, snapshot.offset + snapshot.limit)
    const lines = snapshot.lines.slice(snapshot.offset, end)
    const visibleRefs = new Set(lines.flatMap((line) => line.ref ? [line.ref] : []))
    const refs = Object.fromEntries(snapshot.refs
      .filter((entry) => visibleRefs.has(entry.ref))
      .map((entry) => [entry.ref, {
        role: entry.role,
        name: entry.name,
        ...(entry.nth !== undefined ? { nth: entry.nth } : {}),
      }]))
    let nextCursor: string | undefined
    if (end < snapshot.lines.length) {
      nextCursor = randomUUID()
      this.semanticSnapshotCursors.set(nextCursor, { ...snapshot, offset: end })
      while (this.semanticSnapshotCursors.size > 100) {
        const oldest = this.semanticSnapshotCursors.keys().next().value
        if (typeof oldest !== "string") break
        this.semanticSnapshotCursors.delete(oldest)
      }
    }
    return {
      snapshot_id: snapshot.snapshotId,
      tab_id: snapshot.tabId,
      navigation_generation: snapshot.generation,
      url: snapshot.url,
      title: snapshot.title,
      tree: lines.map((line) => line.text).join("\n"),
      refs,
      range: { from: snapshot.offset, to: end, total: snapshot.lines.length },
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    }
  }

  private async screenshot(tab: BrowserTab, params: Record<string, unknown>): Promise<string> {
    if (params.fullPage === true) {
      const result = await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }), 8_000) as { data?: string }
      if (typeof result.data === "string") return result.data
    }
    try {
      const image = await browserPromiseTimeout(browserContents(tab).capturePage(), 5_000)
      return image.toJPEG(80).toString("base64")
    } catch {
      const parent = this.options.getWindow()
      if (tab.visible && tab.surfaceBounds && parent && !parent.isDestroyed()) {
        try {
          const image = await browserPromiseTimeout(parent.webContents.capturePage(tab.surfaceBounds), 5_000)
          if (!image.isEmpty()) return image.toJPEG(80).toString("base64")
        } catch { /* CDP remains the final guest-only fallback. */ }
      }
      const result = await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Page.captureScreenshot", { format: "jpeg", quality: 80, captureBeyondViewport: false }), 8_000) as { data?: string }
      if (typeof result.data === "string") return result.data
      throw browserError("browser_internal_error")
    }
  }

  private async saveScreenshot(tab: BrowserTab, params: Record<string, unknown>): Promise<{ saved: boolean }> {
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) throw browserError("browser_unavailable")
    const selected = await dialog.showSaveDialog(win, { defaultPath: `lume-page-${Date.now()}.png`, filters: [{ name: "PNG", extensions: ["png"] }] })
    if (selected.canceled || !selected.filePath) return { saved: false }
    const data = await this.screenshot(tab, { ...params, fullPage: true })
    // screenshot 可能返回 jpeg（fallback 链），此处契约是 .png 文件——重编码保一致
    writeFileSync(selected.filePath, nativeImage.createFromBuffer(Buffer.from(data, "base64")).toPNG())
    return { saved: true }
  }

  private async saveReviewScreenshot(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<{ screenshotRef: string }> {
    if (context.actor !== "user") throw browserError("action_denied")
    const ownerThreadId = String(params.ownerThreadId ?? "")
    if (!/^[a-zA-Z0-9._-]{1,200}$/.test(ownerThreadId) || tab.ownerThreadId !== ownerThreadId) throw browserError("action_denied")
    const id = randomUUID()
    const directory = join(this.options.configDir(), "browser", "review-resources", ownerThreadId)
    mkdirSync(directory, { recursive: true })
    // screenshot 恒返回 jpeg（视口路径），此处契约是 .png 文件——重编码保一致
    const data = nativeImage.createFromBuffer(Buffer.from(await this.screenshot(tab, { fullPage: false }), "base64")).toPNG()
    if (!data.length || data.length > 20 * 1024 * 1024) throw browserError("browser_internal_error")
    writeFileSync(join(directory, `${id}.png`), data, { mode: 0o600 })
    return { screenshotRef: `browser-review-screenshot:${ownerThreadId}:${id}` }
  }

  private deleteReviewScreenshot(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): { deleted: boolean } {
    if (context.actor !== "user") throw browserError("action_denied")
    const match = /^browser-review-screenshot:([a-zA-Z0-9._-]{1,200}):([a-f0-9-]{36})$/i.exec(String(params.screenshotRef ?? ""))
    if (!match || tab.ownerThreadId !== match[1]) throw browserError("action_denied")
    const path = join(this.options.configDir(), "browser", "review-resources", match[1]!, `${match[2]}.png`)
    if (!existsSync(path)) return { deleted: false }
    unlinkSync(path)
    return { deleted: true }
  }

  private async copyScreenshot(tab: BrowserTab, params: Record<string, unknown>): Promise<{ copied: true }> {
    const data = await this.screenshot(tab, params)
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data, "base64")))
    return { copied: true }
  }

  private async printPage(tab: BrowserTab): Promise<{ printed: boolean }> {
    if (tab.context?.actor === "agent") throw browserError("action_denied")
    return { printed: await new Promise<boolean>((resolve) => {
      browserContents(tab).print({}, (success) => resolve(success))
    }) }
  }

  private async pageContent(tab: BrowserTab, params: Record<string, unknown>): Promise<{ url: string; title: string; text: string; html?: string }> {
    const includeHtml = params.format === "html"
    const result = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
      code: `(() => {
        const text = String(document.body?.innerText ?? "").slice(0, 200000);
        return { text, html: ${includeHtml} ? String(document.documentElement?.outerHTML ?? "").slice(0, 1000000) : undefined };
      })()`,
    }], true) as { text?: unknown; html?: unknown }
    return {
      url: tab.url,
      title: tab.title,
      text: typeof result.text === "string" ? result.text : "",
      ...(includeHtml && typeof result.html === "string" ? { html: result.html } : {}),
    }
  }

  private async exportPageContent(tab: BrowserTab, context: BrowserRequestContext): Promise<{ path: string }> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const content = await this.pageContent(tab, { format: "html" })
    const directory = join(
      this.options.configDir(),
      "browser",
      "content-exports",
      safePartition(context.browserSessionId),
      safePartition(context.browserTurnId),
    )
    const title = safeDownloadFilename(`${tab.title.trim() || "page"}.html`)
    const prepared = prepareDownload(directory, title)
    writeFileSync(prepared.partialPath, content.html ?? content.text, { encoding: "utf8", mode: 0o600 })
    completeDownload(prepared)
    return { path: prepared.finalPath }
  }

  private async loadBackgroundContent(context: BrowserRequestContext, params: Record<string, unknown>): Promise<{ results: Array<{ url: string; title: string | null; content: string | null }> }> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const urls = Array.isArray(params.urls) ? params.urls.filter((value): value is string => typeof value === "string").slice(0, 10) : []
    if (!urls.length) throw browserError("invalid_browser_request")
    const contentType = params.contentType === "html" || params.contentType === "domSnapshot" ? params.contentType : "text"
    const timeoutMs = params.timeoutMs === undefined ? 10_000 : boundedNumber(params.timeoutMs, 1, 30_000)
    const results: Array<{ url: string; title: string | null; content: string | null }> = []
    for (const url of urls) {
      const tabId = `background:${randomUUID()}`
      try {
        this.ensureTab(tabId, context, { ownerThreadId: context.threadId })
        const tab = this.requireTab(tabId, context)
        await this.navigate(tab, url, context)
        await this.waitForLoad(tab, timeoutMs)
        const content = contentType === "domSnapshot"
          ? JSON.stringify(await this.snapshot(tab))
          : await this.pageContent(tab, { format: contentType })
        results.push({
          url: tab.url,
          title: tab.title || null,
          content: typeof content === "string" ? content : contentType === "html" ? content.html ?? null : content.text,
        })
      } catch {
        results.push({ url: stripUrl(url), title: null, content: null })
      } finally {
        if (this.tabs.has(tabId)) this.closeTab(tabId, context)
      }
    }
    return { results }
  }

  private readBrowserClipboard(): { items: Array<{ entries: Array<{ mime_type: string; text?: string; base64?: string }>; presentation_style: "unspecified" }> } {
    const entries: Array<{ mime_type: string; text?: string; base64?: string }> = []
    const text = clipboard.readText()
    if (text) entries.push({ mime_type: "text/plain", text: text.slice(0, 1_000_000) })
    const html = clipboard.readHTML()
    if (html) entries.push({ mime_type: "text/html", text: html.slice(0, 1_000_000) })
    const image = clipboard.readImage()
    if (!image.isEmpty()) {
      const png = image.toPNG()
      if (png.byteLength <= 5_000_000) entries.push({ mime_type: "image/png", base64: png.toString("base64") })
    }
    return { items: entries.length ? [{ entries, presentation_style: "unspecified" }] : [] }
  }

  private writeBrowserClipboard(params: Record<string, unknown>): Record<string, never> {
    const items = Array.isArray(params.items) ? params.items : []
    const first = items[0]
    if (!isRecord(first) || !Array.isArray(first.entries)) throw browserError("invalid_browser_request")
    const data: Electron.Data = {}
    for (const rawEntry of first.entries.slice(0, 10)) {
      if (!isRecord(rawEntry) || typeof rawEntry.mime_type !== "string") continue
      if (rawEntry.mime_type === "text/plain" && typeof rawEntry.text === "string") data.text = rawEntry.text.slice(0, 1_000_000)
      else if (rawEntry.mime_type === "text/html" && typeof rawEntry.text === "string") data.html = rawEntry.text.slice(0, 1_000_000)
      else if (rawEntry.mime_type === "image/png" && typeof rawEntry.base64 === "string") {
        const image = Buffer.from(rawEntry.base64, "base64")
        if (image.byteLength > 5_000_000) throw browserError("invalid_browser_request")
        data.image = nativeImage.createFromBuffer(image)
      }
    }
    if (!data.text && !data.html && !data.image) throw browserError("invalid_browser_request")
    clipboard.write(data)
    return {}
  }

  private async visibleDom(tab: BrowserTab): Promise<{ nodes: Array<Record<string, unknown>> }> {
    const generation = tab.generation
    const nodes = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
      code: `(() => Array.from(document.querySelectorAll("a,button,input,textarea,select,[role],[contenteditable=true]")).slice(0, 2000).flatMap((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth || style.display === "none" || style.visibility === "hidden") return [];
        return [{
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute("role") || undefined,
          name: (element.getAttribute("aria-label") || element.innerText || element.textContent || "").trim().slice(0, 1000),
          value: "value" in element ? String(element.value).slice(0, 1000) : undefined,
          disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        }];
      }).slice(0, 500))()`,
    }], true) as Array<Record<string, unknown>>
    if (generation !== tab.generation) throw browserError("stale_target")
    const index = new Map<string, { generation: number; x: number; y: number }>()
    const result = nodes.map((node, position) => {
      const nodeId = `${generation}:${position}:${createHash("sha256").update(`${node.tag}:${node.name}:${node.x}:${node.y}`).digest("base64url").slice(0, 10)}`
      index.set(nodeId, { generation, x: finiteNumber(node.x), y: finiteNumber(node.y) })
      const { x: _x, y: _y, ...publicNode } = node
      return { node_id: nodeId, ...publicNode }
    })
    tab.domNodes = index
    return { nodes: result }
  }

  private async dispatchDomAction(tab: BrowserTab, method: string, params: Record<string, unknown>): Promise<Record<string, never>> {
    const nodeId = typeof params.nodeId === "string" ? params.nodeId : typeof params.node_id === "string" ? params.node_id : ""
    const node = nodeId ? tab.domNodes?.get(nodeId) : undefined
    if (nodeId && (!node || node.generation !== tab.generation)) throw browserError("stale_target")
    const x = node?.x ?? 0
    const y = node?.y ?? 0
    if (method === "dom:scroll") {
      await this.dispatchScroll(tab, { x, y, width: 1, height: 1, tagName: "document", editable: false, enabled: true }, {
        deltaX: params.scrollX ?? params.scroll_x,
        deltaY: params.scrollY ?? params.scroll_y,
      })
    } else {
      if (!node) throw browserError("stale_target")
      await this.dispatchMouse(tab, method === "dom:doubleClick" ? "doubleClick" : "click", { x, y })
    }
    return {}
  }

  private async elementInfo(tab: BrowserTab, params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const x = boundedNumber(params.x, 0, 100_000)
    const y = boundedNumber(params.y, 0, 100_000)
    return browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
      code: `(() => {
        const elements = document.elementsFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)}).slice(0, 20);
        return elements.map((element) => {
          const rect = element.getBoundingClientRect();
          const tagName = element.tagName.toLowerCase();
          const visibleText = (element.innerText || element.textContent || "").trim().slice(0, 1000) || null;
          const ariaName = element.getAttribute("aria-label");
          const role = element.getAttribute("role");
          const testId = element.getAttribute("data-testid");
          const idSelector = element.id ? "#" + CSS.escape(element.id) : null;
          const testSelector = testId ? "[data-testid=" + JSON.stringify(testId) + "]" : null;
          return {
            nodeId: null, tagName, role, visibleText, ariaName, testId,
            boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            preview: element.outerHTML.slice(0, 2000),
            selector: { primary: idSelector || testSelector, candidates: [idSelector, testSelector, tagName].filter(Boolean), frameSelectors: [] },
          };
        });
      })()`,
    }], true) as Promise<Array<Record<string, unknown>>>
  }

  private async elementScreenshot(tab: BrowserTab, params: Record<string, unknown>): Promise<string> {
    const x = boundedNumber(params.x, 0, 100_000)
    const y = boundedNumber(params.y, 0, 100_000)
    await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
      code: `(() => {
        document.getElementById("__lume_element_probe")?.remove();
        const overlay = document.createElement("div");
        overlay.id = "__lume_element_probe";
        Object.assign(overlay.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "2147483647" });
        const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
        if (target) {
          const rect = target.getBoundingClientRect();
          const box = document.createElement("div");
          Object.assign(box.style, { position: "absolute", left: rect.left + "px", top: rect.top + "px", width: rect.width + "px", height: rect.height + "px", border: "2px solid #ef4444", background: "rgba(239,68,68,.08)" });
          overlay.append(box);
        }
        const point = document.createElement("div");
        Object.assign(point.style, { position: "absolute", left: (${JSON.stringify(x)} - 5) + "px", top: (${JSON.stringify(y)} - 5) + "px", width: "10px", height: "10px", borderRadius: "999px", background: "#ef4444" });
        overlay.append(point);
        document.documentElement.append(overlay);
      })()`,
    }], true)
    try {
      return await this.screenshot(tab, {})
    } finally {
      await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{ code: `document.getElementById("__lume_element_probe")?.remove()` }], true).catch(() => undefined)
    }
  }

  private async evaluateReadonly(tab: BrowserTab, params: Record<string, unknown>): Promise<unknown> {
    const script = String(params.script ?? params.expression ?? "")
    if (!script || script.length > 100_000) throw browserError("invalid_browser_request")
    const expression = `(${script})(${JSON.stringify(params.arg ?? null)})`
    const result = await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      throwOnSideEffect: true,
      timeout: boundedNumber(params.timeoutMs ?? params.timeout_ms ?? 3_000, 1, 10_000),
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (result.exceptionDetails) throw browserError("action_denied")
    return result.result?.value
  }

  private async evaluateAgentScript(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<BrowserAgentScriptResult> {
    if (context.actor !== "agent" || tab.profileKind !== "agent" || tab.ownerThreadId !== context.threadId) throw browserError("action_denied")
    const generation = tab.generation
    const call = prepareBrowserAgentScript(params)
    const result = await withDebugger(browserContents(tab), async (debuggerRef) => {
      const frameTree = await debuggerRef.sendCommand("Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } }
      const frameId = frameTree.frameTree?.frame?.id
      if (!frameId) throw browserError("stale_target")
      const isolated = await debuggerRef.sendCommand("Page.createIsolatedWorld", {
        frameId,
        worldName: `lume-agent-script:${randomUUID()}`,
        grantUniveralAccess: false,
      }) as { executionContextId?: number }
      if (!isolated.executionContextId || generation !== tab.generation) throw browserError("stale_target")
      return debuggerRef.sendCommand("Runtime.evaluate", {
        contextId: isolated.executionContextId,
        ...call,
      })
    }, call.timeout + 2_000)
    if (generation !== tab.generation) throw browserError("stale_target")
    return normalizeBrowserAgentScriptResult(result)
  }

  private readConsoleLogs(tab: BrowserTab, params: Record<string, unknown>): { logs: BrowserTab["consoleLogs"] } {
    const levels = Array.isArray(params.levels) ? new Set(params.levels.filter((value): value is string => typeof value === "string")) : undefined
    const filter = String(params.filter ?? "").trim().toLocaleLowerCase()
    const limit = boundedNumber(params.limit ?? 100, 1, 500)
    return {
      logs: tab.consoleLogs
        .filter((entry) => (!levels?.size || levels.has(entry.level)) && (!filter || entry.message.toLocaleLowerCase().includes(filter)))
        .slice(-limit),
    }
  }

  private async applyPageTweaks(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<{ applied: Record<string, string> }> {
    if (context.actor !== "user") throw browserError("action_denied")
    const domPath = String(params.domPath ?? "").slice(0, 8192)
    const rawStyles = isRecord(params.styles) ? params.styles : {}
    const styles = Object.fromEntries(Object.entries(rawStyles)
      .filter(([key, value]) => TWEAK_STYLE_KEYS.has(key) && typeof value === "string")
      .map(([key, value]) => [key, String(value).slice(0, 4096)]))
    if (!domPath || Object.keys(styles).length === 0) throw browserError("invalid_browser_request")
    const applied = await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
      code: `(${applyPageTweaksScript()})(${JSON.stringify(domPath)}, ${JSON.stringify(styles)})`,
    }], true) as unknown
    if (!isRecord(applied)) throw browserError("stale_target")
    return { applied: Object.fromEntries(Object.entries(applied).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
  }

  private async resetPageTweaks(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<{ ok: true }> {
    if (context.actor !== "user") throw browserError("action_denied")
    const domPath = String(params.domPath ?? "").slice(0, 8192)
    if (!domPath) throw browserError("invalid_browser_request")
    await browserContents(tab).executeJavaScriptInIsolatedWorld(999, [{
      code: `(${resetPageTweaksScript()})(${JSON.stringify(domPath)})`,
    }], true)
    return { ok: true }
  }

  private async emulateDevice(tab: BrowserTab, preset: string, params: Record<string, unknown> = {}): Promise<{ preset: string; viewport: BrowserViewportState }> {
    const devices: Record<string, { width: number; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean }> = {
      desktop: { width: 0, height: 0, deviceScaleFactor: 1, mobile: false, touch: false },
      responsive: { width: 390, height: 844, deviceScaleFactor: 1, mobile: false, touch: false },
      "4k": { width: 2560, height: 1440, deviceScaleFactor: 1, mobile: false, touch: false },
      "laptop-l": { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
      laptop: { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
      "surface-pro-7": { width: 912, height: 1368, deviceScaleFactor: 2, mobile: true, touch: true },
      "ipad-air": { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
      "ipad-mini": { width: 768, height: 1024, deviceScaleFactor: 2, mobile: true, touch: true },
      "surface-duo": { width: 540, height: 720, deviceScaleFactor: 2.5, mobile: true, touch: true },
      "iphone-15-pro-max": { width: 430, height: 932, deviceScaleFactor: 3, mobile: true, touch: true },
      "pixel-8": { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true },
      "iphone-15-pro": { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true },
      "samsung-galaxy-s24-ultra": { width: 384, height: 824, deviceScaleFactor: 3, mobile: true, touch: true },
      "iphone-se": { width: 375, height: 667, deviceScaleFactor: 2, mobile: true, touch: true },
      phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
      tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
      "phone-landscape": { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, touch: true },
      "tablet-landscape": { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true, touch: true },
    }
    const normalizedPreset = sanitizeViewportPreset(preset) ?? preset
    const device = preset === "custom"
      ? {
          width: boundedNumber(params.width, 240, 4096),
          height: boundedNumber(params.height, 160, 4096),
          deviceScaleFactor: Math.max(0.5, Math.min(4, Number(params.deviceScaleFactor) || 1)),
          mobile: params.mobile === true,
          touch: params.touch === true,
        }
      : devices[normalizedPreset]
    if (!device) throw browserError("invalid_browser_request")
    const viewportPreset = preset === "custom"
      ? sanitizeViewportPreset(params.presetId ?? params.preset) ?? "responsive"
      : sanitizeViewportPreset(normalizedPreset) ?? "responsive"
    const viewport: BrowserViewportState = {
      enabled: normalizedPreset !== "desktop",
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.mobile,
      touch: device.touch,
      preset: viewportPreset,
      displayScale: sanitizeViewportDisplayScale(params.displayScale ?? tab.viewport?.displayScale),
    }
    await withDebugger(browserContents(tab), async (debuggerRef) => {
      if (normalizedPreset === "desktop") await debuggerRef.sendCommand("Emulation.clearDeviceMetricsOverride")
      else await debuggerRef.sendCommand("Emulation.setDeviceMetricsOverride", {
        ...device,
        screenWidth: device.width,
        screenHeight: device.height,
        screenOrientation: device.width > device.height
          ? { type: "landscapePrimary", angle: 90 }
          : { type: "portraitPrimary", angle: 0 },
      })
      await debuggerRef.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1 })
    })
    tab.viewport = viewport
    if (params.__deferDescriptor !== true) {
      this.rememberTab(tab)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    }
    return { preset: normalizedPreset, viewport }
  }

  private async commitViewport(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<{ viewport: BrowserViewportState; revision: number }> {
    if (context.actor !== "user") throw browserError("action_denied")
    const requestedGeneration = Number(params.expectedGeneration ?? params.generation)
    const expectedGeneration = Number.isInteger(requestedGeneration) ? requestedGeneration : tab.generation
    if (expectedGeneration !== tab.generation) throw browserError("tab_generation_changed")
    const revision = boundedNumber(params.revision, 1, Number.MAX_SAFE_INTEGER)
    if (revision <= (tab.viewportRevision ?? 0)) throw browserError("stale_target")
    const state = sanitizeViewportState(params.state && typeof params.state === "object" ? params.state as Record<string, unknown> : params)
    const commit = tab.viewportQueue.then(async () => {
      if (tab.generation !== expectedGeneration || revision <= (tab.viewportRevision ?? 0)) throw browserError("tab_generation_changed")
      await this.waitForGuest(tab)
      if (state.enabled) {
        await this.emulateDevice(tab, "custom", { ...state, presetId: state.preset, __deferDescriptor: true })
      } else {
        await this.emulateDevice(tab, "desktop", { __deferDescriptor: true })
      }
      if (tab.generation !== expectedGeneration) throw browserError("tab_generation_changed")
      tab.viewportRevision = revision
      this.rememberTab(tab)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      return { viewport: tab.viewport ?? desktopViewportState(), revision }
    })
    tab.viewportQueue = commit.then(() => undefined, () => undefined)
    return commit
  }

  private setViewport(tab: BrowserTab, params: Record<string, unknown>): Promise<{ viewport: BrowserViewportState }> {
    return this.emulateDevice(tab, "custom", params).then(({ viewport }) => ({ viewport }))
  }

  private resetViewport(tab: BrowserTab): Promise<{ viewport: BrowserViewportState }> {
    return this.emulateDevice(tab, "desktop").then(({ viewport }) => ({ viewport }))
  }

  private captureAgentViewportOverride(tab: BrowserTab, context: BrowserRequestContext): void {
    const current = tab.agentViewportOverride
    if (current?.browserSessionId === context.browserSessionId && current.browserTurnId === context.browserTurnId) return
    tab.agentViewportOverride = {
      browserSessionId: context.browserSessionId,
      browserTurnId: context.browserTurnId,
      previous: tab.viewport ? { ...tab.viewport } : desktopViewportState(),
    }
  }

  private restoreAgentViewportOverride(tab: BrowserTab, context: Pick<BrowserRequestContext, "browserSessionId" | "browserTurnId">): void {
    const override = tab.agentViewportOverride
    if (!override || override.browserSessionId !== context.browserSessionId || override.browserTurnId !== context.browserTurnId) return
    tab.agentViewportOverride = undefined
    const restore = override.previous.enabled
      ? this.setViewport(tab, { ...override.previous, presetId: override.previous.preset })
      : this.resetViewport(tab)
    void restore.catch(() => undefined)
  }

  private async cdp(tab: BrowserTab, params: Record<string, unknown>): Promise<unknown> {
    if (!this.settings.advancedCdpEnabled || !shouldInstallAdvancedCdpPolicy(tab.partition)) throw browserError("action_denied")
    const origin = safeOrigin(tab.url)
    if (origin && this.settings.sitePermissionOverrides?.[origin]?.cdp !== "allow") throw browserError("action_denied")
    const method = String(params.method ?? "")
    if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method) || method.length > 128 || method === "Browser.close") throw browserError("invalid_browser_request")
    const commandParams = params.params && typeof params.params === "object" ? params.params : {}
    if (Buffer.byteLength(JSON.stringify(commandParams)) > 1024 * 1024) throw browserError("invalid_browser_request")
    if (method === "Page.navigate") {
      const url = String((commandParams as Record<string, unknown>).url ?? "")
      return this.navigate(tab, url, tab.context ?? userContext())
    }
    const result = await withDebugger(browserContents(tab), (debuggerRef) => debuggerRef.sendCommand(method, commandParams))
    if (Buffer.byteLength(JSON.stringify(result ?? null)) > 2 * 1024 * 1024) throw browserError("browser_internal_error")
    return result
  }

  private updateBounds(tabId: string, params: Record<string, unknown>): BrowserTabDescriptor {
    const tab = this.requireTab(tabId, userContext())
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) throw browserError("browser_unavailable")
    const contentBounds = win.getContentBounds()
    const x = boundedNumber(params.x, 0, Math.max(0, contentBounds.width - 1))
    const y = boundedNumber(params.y, 0, Math.max(0, contentBounds.height - 1))
    const bounds = {
      x,
      y,
      width: boundedNumber(params.width, 1, Math.max(1, contentBounds.width - x)),
      height: boundedNumber(params.height, 1, Math.max(1, contentBounds.height - y)),
    }
    tab.surfaceBounds = bounds
    tab.surface = params.surface === "main" || params.surface === "right-panel" ? params.surface : null
    tab.visible = params.visible !== false
    tab.lifecycle = tab.visible ? "active" : "background"
    if (tab.visible) tab.lastOpenedAt = new Date().toISOString()
    if (tab.visible && tab.surface === "right-panel" && tab.profileKind === "agent" && tab.context && !tab.handoff) {
      tab.handoff = { browserSessionId: tab.context.browserSessionId, status: "deliverable", reason: "shown_in_right_panel" }
      this.rememberTab(tab)
    }
    tab.webContents?.setBackgroundThrottling(!tab.visible)
    if (tab.visible) void this.setTabSuspended(tab, false)
    this.enforceBackgroundLimit()
    return publicTab(tab)
  }

  private setVisible(tabId: string, visible: boolean): BrowserTabDescriptor | { ok: true } {
    const tab = this.tabs.get(tabId)
    if (!tab) {
      if (!visible) return { ok: true }
      throw browserError("tab_not_found")
    }
    tab.visible = visible
    tab.lifecycle = visible ? "active" : tab.lifecycle === "crashed" ? "crashed" : "background"
    if (visible) tab.lastOpenedAt = new Date().toISOString()
    tab.webContents?.setBackgroundThrottling(!visible)
    if (visible) void this.setTabSuspended(tab, false)
    if (!visible) this.hideAgentCursor()
    this.enforceBackgroundLimit()
    return publicTab(tab)
  }

  private prepareGuestMount(tabId: string, context: BrowserRequestContext): BrowserGuestMountDescriptor | null {
    if (context.actor !== "user") throw browserError("action_denied")
    const tab = this.requireTab(tabId, context)
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) throw browserError("browser_unavailable")
    if (tab.webContents && !tab.webContents.isDestroyed()) return null
    if (tab.mountToken) {
      const pending = this.guestMounts.get(tab.mountToken)
      if (pending
        && pending.state === "issued"
        && pending.tabId === tab.tabId
        && pending.generation === tab.generation
        && pending.ownerWebContentsId === win.webContents.id
        && pending.expiresAt >= Date.now()) {
        return {
          mountToken: pending.token,
          tabId: pending.tabId,
          generation: pending.generation,
          partition: pending.partition,
          bootstrapUrl: `about:blank#lume-browser-mount=${pending.token}`,
          expiresAt: new Date(pending.expiresAt).toISOString(),
        }
      }
      this.guestMounts.delete(tab.mountToken)
      tab.mountToken = undefined
    }
    const token = randomBytes(24).toString("hex")
    const expiresAt = Date.now() + 30_000
    this.guestMounts.set(token, {
      token,
      tabId: tab.tabId,
      generation: tab.generation,
      partition: tab.partition,
      ownerWebContentsId: win.webContents.id,
      expiresAt,
      state: "issued",
    })
    tab.mountToken = token
    tab.guestState = "attaching"
    this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    return {
      mountToken: token,
      tabId: tab.tabId,
      generation: tab.generation,
      partition: tab.partition,
      bootstrapUrl: `about:blank#lume-browser-mount=${token}`,
      expiresAt: new Date(expiresAt).toISOString(),
    }
  }

  private releaseGuestMount(tabId: string, context: BrowserRequestContext, mountToken: string): { released: boolean } {
    if (context.actor !== "user") throw browserError("action_denied")
    const tab = this.tabs.get(tabId)
    if (!tab) {
      if (mountToken) {
        const pending = this.guestMounts.get(mountToken)
        if (pending?.tabId === tabId) this.guestMounts.delete(mountToken)
      }
      return { released: false }
    }
    if (mountToken && mountToken !== tab.mountToken) {
      if (!tab.mountToken) return { released: false }
      throw browserError("stale_target")
    }
    if (tab.mountToken) this.guestMounts.delete(tab.mountToken)
    tab.mountToken = undefined
    if (mountToken) {
      tab.guestState = "unmounted"
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
      return { released: true }
    }
    const contents = tab.webContents
    tab.webContents = null
    tab.guestState = "unmounted"
    this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    if (contents) closeWebContentsAfterRenderer(contents)
    return { released: Boolean(contents) }
  }

  private enforceBackgroundLimit(): void {
    const candidates = [...this.tabs.values()]
      .filter((tab) => !tab.visible
        && tab.lifecycle !== "crashed"
        && !tab.agentLease
        && !tab.handoff
        && !tab.mediaState?.audible
        && !tab.mediaState?.camera
        && !tab.mediaState?.microphone)
      .sort((left, right) => String(right.lastOpenedAt ?? "").localeCompare(String(left.lastOpenedAt ?? "")))
    for (const [index, tab] of candidates.entries()) void this.setTabSuspended(tab, index >= 4)
  }

  private async setTabSuspended(tab: BrowserTab, suspended: boolean): Promise<void> {
    const contents = tab.webContents
    if (!contents || contents.isDestroyed() || tab.lifecycle === "crashed") return
    if (suspended && tab.lifecycle === "suspended") return
    if (!suspended && tab.lifecycle !== "suspended") return
    tab.lifecycle = suspended ? "suspended" : tab.visible ? "active" : "background"
    contents.setBackgroundThrottling(suspended || !tab.visible)
    try {
      await withDebugger(contents, (debuggerRef) => debuggerRef.sendCommand("Page.setWebLifecycleState", { state: suspended ? "frozen" : "active" }))
    } catch { /* Chromium may reject lifecycle control for a tab that is still loading. */ }
    this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
  }

  private focus(tabId: string): BrowserTabDescriptor {
    const tab = this.requireTab(tabId, userContext())
    tab.lastOpenedAt = new Date().toISOString()
    tab.lifecycle = "active"
    void this.setTabSuspended(tab, false)
    tab.webContents?.focus()
    return publicTab(tab)
  }

  private async shareTab(tabId: string, context: BrowserRequestContext): Promise<BrowserTabDescriptor> {
    if (context.actor !== "user") throw browserError("action_denied")
    const tab = this.requireTab(tabId, context)
    if (tab.partition !== "persist:lume-browser") throw browserError("action_denied")
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) throw browserError("confirmation_unavailable")
    const origin = safeOrigin(tab.url) ?? "尚未导航"
    const result = await dialog.showMessageBox(win, { type: "warning", buttons: ["共享当前标签", "取消"], defaultId: 1, cancelId: 1, title: "允许 Agent 控制当前登录标签？", message: `Origin：${origin}`, detail: "Profile：Lume 全局登录 Profile。共享保留 Cookie 与站点存储；其网络隔离弱于 Agent task partition，私网请求仍会被 best-effort 拦截。" })
    if (result.response !== 0) throw browserError("action_denied")
    tab.shareable = true
    this.options.emit({ method: "browser:tab-share-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    return publicTab(tab)
  }

  private createReferenceGrant(context: BrowserRequestContext, params: Record<string, unknown>): { referenceGrantId: string; expiresAt: string } {
    if (context.actor !== "user") throw browserError("action_denied")
    const threadId = String(params.threadId ?? context.threadId ?? "").trim().slice(0, 200)
    const tabId = String(params.tabId ?? "").trim()
    if (!threadId || !tabId || params.access !== "control") throw browserError("invalid_browser_request")
    const tab = this.requireTab(tabId, context)
    if (tab.ownerThreadId !== threadId || tab.backend !== "iab") throw browserError("action_denied")
    const providerTabId = typeof params.providerTabId === "string" ? params.providerTabId : undefined
    const generation = Number.isInteger(params.generation) ? Number(params.generation) : undefined
    const title = typeof params.title === "string" ? params.title : ""
    const url = typeof params.url === "string" ? params.url : ""
    if (!title || !url || providerTabId !== tab.providerTabId || generation !== tab.generation || title !== tab.title || url !== tab.url) throw browserError("tab_generation_changed")
    return this.referenceGrants.create({
      backend: "iab",
      threadId,
      tabId,
      providerTabId: tab.providerTabId,
      generation: tab.generation,
      title: tab.title,
      url: tab.url,
      access: "control",
    })
  }

  private revokeReferenceGrant(context: BrowserRequestContext, params: Record<string, unknown>): { ok: true; revoked: boolean } {
    if (context.actor !== "user") throw browserError("action_denied")
    const referenceGrantId = String(params.referenceGrantId ?? "").trim()
    const threadId = String(params.threadId ?? context.threadId ?? "").trim().slice(0, 200)
    if (!referenceGrantId || !threadId) throw browserError("invalid_browser_request")
    return { ok: true, revoked: this.referenceGrants.revoke(referenceGrantId, threadId) }
  }

  private unshareTab(tabId: string, context: BrowserRequestContext): BrowserTabDescriptor {
    if (context.actor !== "user") throw browserError("action_denied")
    const tab = this.requireTab(tabId, context)
    this.referenceGrants.invalidateTab(tabId)
    tab.shareable = false
    if (tab.agentViewportOverride) this.restoreAgentViewportOverride(tab, tab.agentViewportOverride)
    revokeSharedLease(tab)
    tab.generation += 1
    tab.inputSequence += 1
    this.hideAgentCursor()
    this.options.emit({ method: "browser:lease-revoked", params: { tabId, generation: tab.generation } })
    return publicTab(tab)
  }

  private claimTab(claimHandle: string, context: BrowserRequestContext, params: Record<string, unknown>): BrowserTabDescriptor {
    if (context.actor !== "agent") throw browserError("action_denied")
    const snapshotKey = claimSnapshotKey(context, claimHandle)
    const snapshot = this.claimSnapshots.get(snapshotKey)
    const tab = snapshot ? this.tabs.get(snapshot.tabId) : undefined
    if (!tab || !snapshot
      || snapshot.providerTabId !== tab.providerTabId
      || snapshot.title !== tab.title
      || snapshot.url !== tab.url
      || snapshot.generation !== tab.generation) {
      this.claimSnapshots.delete(snapshotKey)
      throw browserError("tab_generation_changed")
    }
    const referenceGrantId = typeof params.referenceGrantId === "string" ? params.referenceGrantId : ""
    if (referenceGrantId) {
      if (!context.threadId || !tab || tab.ownerThreadId !== context.threadId) {
        if (tab) this.referenceGrants.invalidateTab(tab.tabId)
        throw browserError("action_denied")
      }
      const grant = this.referenceGrants.consume(referenceGrantId, {
        backend: "iab",
        threadId: context.threadId,
        tabId: tab.tabId,
        providerTabId: tab.providerTabId,
        generation: tab.generation,
        title: tab.title,
        url: tab.url,
        access: "control",
      })
      if (grant.ok === false) {
        if (grant.reason === "expired") throw browserError("reference_grant_expired")
        if (grant.reason === "stale") throw browserError("tab_generation_changed")
        throw browserError("action_denied")
      }
    } else if (!tab || !canAgentClaim(tab, context.browserSessionId, context.browserTurnId)) {
      throw browserError("action_denied")
    }
    this.claimSnapshots.delete(snapshotKey)
    tab.context = context
    tab.agentLease = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: tab.generation }
    void this.setTabSuspended(tab, false)
    this.options.emit({ method: "browser:tab-share-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    return publicTab(tab)
  }

  private clearClaimSnapshots(context: BrowserRequestContext): void {
    const prefix = `${context.browserSessionId}\u0000${context.browserTurnId}\u0000`
    for (const key of this.claimSnapshots.keys()) if (key.startsWith(prefix)) this.claimSnapshots.delete(key)
  }

  private closeTab(tabId: string, context: BrowserRequestContext): { ok: true } {
    const tab = this.requireTab(tabId, context)
    if (tab.mountToken) this.guestMounts.delete(tab.mountToken)
    for (const waiter of tab.mountWaiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(browserError("tab_not_found")) }
    this.referenceGrants.invalidateTab(tabId)
    this.workspaces.close(publicTab(tab), { partition: tab.partition, handoffBrowserSessionId: tab.handoff?.browserSessionId })
    if (tab.ownerThreadId) this.emitWorkspace(this.workspaces.get(tab.ownerThreadId))
    this.closeAuthSessionsForTab(tabId, "cancelled")
    this.clearTabWaiters(tabId)
    for (const [inventoryId, inventory] of this.pageAssetInventories) {
      if (inventory.tabId === tabId) this.pageAssetInventories.delete(inventoryId)
    }
    const contents = tab.webContents
    const browserSession = contents && !contents.isDestroyed() ? contents.session : session.fromPartition(tab.partition)
    tab.webContents = null
    this.tabs.delete(tabId)
    this.disposeOwnedSessionIfUnused(tab.partition, browserSession)
    this.options.emit({ method: "browser:tab-closed", params: { tabId, ownerThreadId: tab.ownerThreadId, profileKind: tab.profileKind } })
    if (contents) closeWebContentsAfterRenderer(contents)
    this.enforceBackgroundLimit()
    return { ok: true }
  }

  private releaseTabs(context: BrowserRequestContext, params: Record<string, unknown>): { ok: true } {
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds.filter((value): value is string => typeof value === "string") : []
    for (const tabId of tabIds) {
      const tab = this.requireTab(tabId, context)
      this.restoreAgentViewportOverride(tab, context)
      tab.context = undefined
      tab.agentLease = undefined
      tab.generation += 1
      tab.inputSequence += 1
    }
    this.enforceBackgroundLimit()
    return { ok: true }
  }

  private clearTabWaiters(tabId: string): void {
    const error = browserError("tab_not_found")
    for (const waiter of this.downloadWaiters.get(tabId) ?? []) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.downloadWaiters.delete(tabId)
    for (const waiter of this.fileChooserWaiters.get(tabId) ?? []) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.fileChooserWaiters.delete(tabId)
    for (const [id, chooser] of this.fileChoosers) if (chooser.tabId === tabId) { clearTimeout(chooser.expiryTimer); this.fileChoosers.delete(id) }
  }

  private handoffTabs(context: BrowserRequestContext, params: Record<string, unknown>): { ok: true } {
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds.filter((value): value is string => typeof value === "string") : []
    for (const tabId of tabIds) {
      const tab = this.requireTab(tabId, context)
      tab.handoff = { browserSessionId: context.browserSessionId, status: "handoff" }
      this.releaseTabs(context, { tabIds: [tabId] })
      this.rememberTab(tab)
    }
    return { ok: true }
  }

  private resumeHandoffTabs(context: BrowserRequestContext): BrowserTabDescriptor[] {
    if (context.actor !== "agent") throw browserError("action_denied")
    const resumed: BrowserTabDescriptor[] = []
    const candidates = [...this.tabs.values()]
      .filter((tab) => tab.handoff?.browserSessionId === context.browserSessionId
        && (tab.handoff.status === "handoff" || tab.handoff.status === "deliverable"))
      .sort((left, right) => Number(right.visible) - Number(left.visible)
        || String(right.lastOpenedAt ?? "").localeCompare(String(left.lastOpenedAt ?? "")))
    for (const tab of candidates) {
      tab.context = context
      tab.agentLease = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: tab.generation }
      if (tab.handoff?.status === "handoff") tab.handoff = undefined
      resumed.push(publicTab(tab))
    }
    return resumed
  }

  private finalizeTabs(context: BrowserRequestContext, params: Record<string, unknown>): { ok: true } {
    const keep = new Map<string, { status: "handoff" | "deliverable"; reason?: string }>()
    for (const value of Array.isArray(params.keep) ? params.keep : []) {
      if (!value || typeof value !== "object") continue
      const item = value as { tabId?: unknown; status?: unknown; reason?: unknown }
      if (typeof item.tabId !== "string" || (item.status !== "handoff" && item.status !== "deliverable")) continue
      keep.set(item.tabId, { status: item.status, ...(typeof item.reason === "string" ? { reason: item.reason.slice(0, 500) } : {}) })
    }
    for (const tab of [...this.tabs.values()]) {
      if (!tab.context || tab.context.browserSessionId !== context.browserSessionId || tab.context.browserTurnId !== context.browserTurnId) continue
      const retained = keep.get(tab.tabId) ?? (tab.handoff?.browserSessionId === context.browserSessionId ? tab.handoff : undefined)
      if (!retained) { this.closeTab(tab.tabId, context); continue }
      tab.handoff = { browserSessionId: context.browserSessionId, ...retained }
      this.releaseTabs(context, { tabIds: [tab.tabId] })
      this.rememberTab(tab)
    }
    for (const tab of [...this.tabs.values()]) {
      if (tab.context?.actor === "agent" || tab.agentLease?.browserSessionId !== context.browserSessionId || tab.agentLease.browserTurnId !== context.browserTurnId) continue
      this.releaseTabs(context, { tabIds: [tab.tabId] })
    }
    return { ok: true }
  }

  private disposeOwnedSessionIfUnused(partition: string, browserSession: Electron.Session): void {
    if (partition === "persist:lume-browser" || [...this.tabs.values()].some((tab) => tab.partition === partition)) return
    const policy = this.sessionPolicies.get(browserSession)
    if (!policy) return
    policy.disposed = true
    browserSession.webRequest.onBeforeRequest(null)
    if (policy.downloadHandler) browserSession.off("will-download", policy.downloadHandler)
    void policy.networkGuard?.close()
    this.ownedSessionPolicies.delete(policy)
    this.sessionPolicies.delete(browserSession)
    void browserSession.clearStorageData().catch(() => undefined)
  }

  private async openExternal(url: string): Promise<{ ok: true }> {
    if (!isAllowedNavigation(url, false)) throw browserError("invalid_url")
    await shell.openExternal(new URL(url).toString())
    return { ok: true }
  }

  private openPopup(token: string, context: BrowserRequestContext): BrowserTabDescriptor {
    if (context.actor !== "user") throw browserError("action_denied")
    const popup = this.popupTokens.get(token)
    this.popupTokens.delete(token)
    if (!popup || popup.expiresAt < Date.now()) throw browserError("confirmation_unavailable")
    const source = this.tabs.get(popup.sourceTabId)
    return this.ensureTab(`browser:${randomUUID()}`, context, {
      url: popup.url,
      ...(source?.ownerThreadId ? { ownerThreadId: source.ownerThreadId } : {}),
      openerTabId: popup.sourceTabId,
    })
  }

  private async confirmBrowserAction(context: BrowserRequestContext, params: Record<string, unknown>): Promise<{ approved: boolean; token?: string }> {
    if (!context.capability?.startsWith("browser-broker-policy-v1:")) throw browserError("action_denied")
    const bindingHash = String(params.bindingHash ?? "")
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(bindingHash)) throw browserError("invalid_browser_request")
    const category = String(params.category ?? "action").replace(/[^a-zA-Z_-]/g, "").slice(0, 32)
    const preview = String(params.preview ?? "执行受保护的浏览器动作").replace(/[\r\n\t]+/g, " ").slice(0, 300)
    const backend = params.backend === "extension" ? "extension" : "iab"
    const approvalMode = category === "history"
      ? backend === "extension" ? this.settings.chromeHistoryApprovalMode : this.settings.iabHistoryApprovalMode
      : category === "browse" ? this.settings.browserApprovalMode : "alwaysAsk"
    if (approvalMode === "disabled") throw browserError("action_denied")
    if (approvalMode === "neverAsk") return this.issuePolicyToken(bindingHash)
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) throw browserError("confirmation_unavailable")
    const result = await dialog.showMessageBox(win, { type: "warning", buttons: ["允许一次", "取消"], defaultId: 1, cancelId: 1, title: "确认浏览器操作", message: preview, detail: `类别：${category}。批准仅对当前标签页的这一次操作有效。` })
    if (result.response !== 0) return { approved: false }
    return this.issuePolicyToken(bindingHash)
  }

  private issuePolicyToken(bindingHash: string): { approved: true; token: string } {
    const token = randomBytes(32).toString("base64url")
    this.policyTokens.set(token, { bindingHash, expiresAt: Date.now() + 30_000 })
    return { approved: true, token }
  }

  private consumeBrowserAction(context: BrowserRequestContext, params: Record<string, unknown>): { ok: true } {
    if (!context.capability?.startsWith("browser-broker-policy-v1:")) throw browserError("action_denied")
    this.consumePolicyToken(String(params.token ?? ""), String(params.bindingHash ?? ""))
    return { ok: true }
  }

  private consumePolicyToken(token: string, bindingHash: string): void {
    const entry = this.policyTokens.get(token)
    this.policyTokens.delete(token)
    if (!entry || entry.expiresAt < Date.now() || entry.bindingHash !== bindingHash) throw browserError("confirmation_unavailable")
  }

  private vaultSummary(): { passwordEntries: number; encrypted: boolean } {
    return this.credentials.passwordSummary()
  }

  private async restoreBrowserExtensions(): Promise<void> {
    const browserSession = session.fromPartition("persist:lume-browser")
    for (const record of this.extensions.records()) {
      if (!record.enabled) continue
      try {
        const inspected = inspectExtensionDirectory(record.path)
        const loaded = await browserSession.loadExtension(inspected.path, { allowFileAccess: false })
        this.extensions.upsert({ ...record, id: loaded.id, name: inspected.name, version: inspected.version, permissions: inspected.permissions })
      } catch {
        this.extensions.upsert({ ...record, enabled: false })
      }
    }
  }

  private async installBrowserExtension(context: BrowserRequestContext): Promise<BrowserExtensionDescriptor | { canceled: true }> {
    if (context.actor !== "user") throw browserError("action_denied")
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) throw browserError("browser_unavailable")
    const selected = await dialog.showOpenDialog(win, { title: "选择解压后的浏览器扩展", properties: ["openDirectory"] })
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true }
    const inspected = inspectExtensionDirectory(selected.filePaths[0])
    const permissionSummary = inspected.permissions.length ? inspected.permissions.join("\n") : "该扩展未声明额外权限"
    const approval = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: ["安装本地扩展", "取消"],
      defaultId: 1,
      cancelId: 1,
      title: `安装 ${inspected.name}？`,
      message: `${inspected.name} ${inspected.version}`,
      detail: `扩展只会加载到 Lume 用户浏览器 Profile。\n\n声明的权限：\n${permissionSummary.slice(0, 4000)}`,
    })
    if (approval.response !== 0) throw browserError("action_denied")
    const loaded = await session.fromPartition("persist:lume-browser").loadExtension(inspected.path, { allowFileAccess: false })
    return this.extensions.upsert({
      id: loaded.id,
      path: inspected.path,
      name: inspected.name,
      version: inspected.version,
      permissions: inspected.permissions,
      enabled: true,
    })
  }

  private removeBrowserExtension(context: BrowserRequestContext, id: string): { removed: boolean } {
    if (context.actor !== "user") throw browserError("action_denied")
    const record = this.extensions.find(id)
    if (!record) return { removed: false }
    session.fromPartition("persist:lume-browser").removeExtension(record.id)
    this.extensions.remove(record.id)
    return { removed: true }
  }

  private async setBrowserExtensionEnabled(context: BrowserRequestContext, id: string, enabled: boolean): Promise<BrowserExtensionDescriptor> {
    if (context.actor !== "user") throw browserError("action_denied")
    const record = this.extensions.find(id)
    if (!record) throw browserError("invalid_browser_request")
    const browserSession = session.fromPartition("persist:lume-browser")
    if (enabled) {
      const inspected = inspectExtensionDirectory(record.path)
      const loaded = await browserSession.loadExtension(inspected.path, { allowFileAccess: false })
      return this.extensions.upsert({ ...record, id: loaded.id, name: inspected.name, version: inspected.version, permissions: inspected.permissions, enabled: true })
    }
    browserSession.removeExtension(record.id)
    return this.extensions.upsert({ ...record, enabled: false })
  }

  private async clearData(context: BrowserRequestContext, params: Record<string, unknown>): Promise<{ ok: true; cleared: string[] }> {
    if (context.actor !== "user") throw browserError("action_denied")
    const categories = Array.isArray(params.categories) ? params.categories.filter((value): value is string => typeof value === "string") : ["siteData", "cache", "downloads"]
    const selected = new Set(categories.filter((value) => ["siteData", "cache", "downloads", "passwords", "history", "permissions"].includes(value)))
    const range = params.timeRange === "hour" || params.timeRange === "day" ? params.timeRange : "all"
    if (range !== "all" && (selected.has("siteData") || selected.has("cache"))) throw browserError("unsupported")
    if (selected.has("passwords")) {
      const win = this.options.getWindow()
      if (!win || win.isDestroyed()) throw browserError("confirmation_unavailable")
      const result = await dialog.showMessageBox(win, { type: "warning", buttons: ["删除保存的密码", "取消"], defaultId: 1, cancelId: 1, title: "再次确认删除密码", message: "此操作只删除 Lume 保存的密码，且无法撤销。" })
      if (result.response !== 0) throw browserError("action_denied")
      this.credentials.clearPasswords()
    }
    const browserSession = session.fromPartition("persist:lume-browser")
    const dataTypes: Electron.ClearDataOptions["dataTypes"] = []
    if (selected.has("siteData")) dataTypes.push("cookies", "fileSystems", "indexedDB", "localStorage", "serviceWorkers", "webSQL")
    if (selected.has("cache")) dataTypes.push("cache")
    if (browserSession && dataTypes.length) await browserSession.clearData({ dataTypes })
    if (selected.has("downloads")) {
      if (range === "all") this.downloadHistory.clear()
      else this.downloadHistory.clearSince(Date.now() - (range === "hour" ? 60 * 60_000 : 24 * 60 * 60_000))
    }
    if (selected.has("history")) this.browsingHistory.clear()
    if (selected.has("permissions")) {
      this.settings = { ...this.settings, siteOverrides: {}, sitePermissionOverrides: {} }
      this.options.persistSettings?.(this.settings)
    }
    return { ok: true, cleared: [...selected] }
  }
}

export function createBrowserRuntime(options: BrowserRuntimeOptions): BrowserRuntime {
  return new BrowserRuntime(options)
}

function publicTab(tab: BrowserTab): BrowserTabDescriptor {
  const {
    webContents: _webContents,
    partition: _partition,
    context: _context,
    inputSequence: _inputSequence,
    agentLease,
    agentViewportOverride: _agentViewportOverride,
    handoff,
    approvedPrivateOrigins: _approvedPrivateOrigins,
    findRequestId: _findRequestId,
    findMatches: _findMatches,
    navigationStack: _navigationStack,
    navigationIndex: _navigationIndex,
    pendingNavigationIndex: _pendingNavigationIndex,
    consoleLogs: _consoleLogs,
    domNodes: _domNodes,
    recentAgentContext: _recentAgentContext,
    agentDispatching: _agentDispatching,
    lastUserActivationAt: _lastUserActivationAt,
    dialogOpen: _dialogOpen,
    dialogInfo: _dialogInfo,
    surfaceBounds: _surfaceBounds,
    pendingUrl: _pendingUrl,
    mountToken: _mountToken,
    mountWaiters: _mountWaiters,
    viewportQueue: _viewportQueue,
    ...result
  } = tab
  return {
    ...result,
    navigationEntries: [..._navigationStack],
    navigationIndex: _navigationIndex,
    agentClaimed: Boolean(agentLease),
    ...(handoff ? { handoffStatus: handoff.status } : {}),
  }
}

function browserContents(tab: BrowserTab): Electron.WebContents {
  const contents = tab.webContents
  if (!contents || contents.isDestroyed()) throw browserError("browser_unavailable")
  return contents
}

function guestMountTokenFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== "about:" || url.pathname !== "blank") return undefined
    const match = /^#lume-browser-mount=([a-f0-9]{48})$/i.exec(url.hash)
    return match?.[1]
  } catch { return undefined }
}

function validateContext(value: BrowserRequestContext): BrowserRequestContext {
  if (!value || (value.actor !== "agent" && value.actor !== "user") || !value.browserSessionId || !value.browserTurnId) throw browserError("invalid_browser_request")
  return value
}

function userContext(): BrowserRequestContext {
  return { browserSessionId: "renderer", browserTurnId: "renderer", actor: "user" }
}

function claimSnapshotKey(context: BrowserRequestContext, tabId: string): string {
  return `${context.browserSessionId}\u0000${context.browserTurnId}\u0000${tabId}`
}

function canContextUseTab(tab: BrowserTab, context: BrowserRequestContext): boolean {
  return context.actor === "user" || (canAgentUse(tab, context.browserSessionId, context.browserTurnId, tab.generation) && (!context.tabId || context.tabId === tab.tabId))
}

function annotationThreadId(tab: BrowserTab, params: Record<string, unknown>): string {
  const value = typeof params.threadId === "string" ? params.threadId.trim() : (tab.ownerThreadId ?? "")
  if (!/^[a-zA-Z0-9._-]{1,200}$/.test(value) || (tab.ownerThreadId && tab.ownerThreadId !== value)) throw browserError("action_denied")
  return value
}

function browserError(code: BrowserErrorCode): Error & { code: BrowserErrorCode } {
  const error = new Error(code) as Error & { code: BrowserErrorCode }
  error.code = code
  return error
}

function closeWebContentsSafely(contents: Electron.WebContents): void {
  if (contents.isDestroyed()) return
  try {
    contents.close()
  } catch {
    // Renderer-owned <webview> guests are destroyed when BrowserWebviewPool
    // removes their DOM node after the corresponding runtime event.
  }
}

function closeWebContentsAfterRenderer(contents: Electron.WebContents): void {
  const timer = setTimeout(() => closeWebContentsSafely(contents), 250)
  timer.unref?.()
}

function stableBrowserErrorCode(error: unknown): BrowserErrorCode {
  const code = (error as { code?: unknown })?.code
  return typeof code === "string" && BROWSER_ERROR_CODES.has(code as BrowserErrorCode) ? code as BrowserErrorCode : "browser_internal_error"
}

const BROWSER_ERROR_CODES = new Set<BrowserErrorCode>([
  "incompatible_protocol", "browser_unavailable", "invalid_browser_request", "invalid_url", "private_origin_confirmation_required", "stale_target", "tab_not_found", "tab_generation_changed", "confirmation_unavailable", "reference_grant_expired", "action_denied", "unsupported", "executed_unknown", "browser_internal_error",
  "strict_locator_violation", "actionability_failed", "dialog_blocking",
])

function safeOrigin(value: string): string | undefined {
  try { return new URL(value).origin } catch { return undefined }
}

function normalizeBrowserMethod(method: string): string {
  return ({ goto: "navigate", dblclick: "doubleClick", selectOption: "select", setChecked: "check" } as Record<string, string>)[method] ?? method
}

export async function listWebMcpTools(tab: BrowserTab): Promise<{ tools: Array<Record<string, unknown>> }> {
  const generation = tab.generation
  const value = await browserContents(tab).executeJavaScript(`(async () => {
    const modelContext = window.__lumeWebMcpModelContext ?? document.modelContext ?? navigator.modelContext;
    if (!modelContext || typeof modelContext.getTools !== "function") return [];
    return (await Promise.resolve(modelContext.getTools())).map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      input_schema: tool.inputSchema == null
        ? null
        : typeof tool.inputSchema === "string"
          ? JSON.parse(tool.inputSchema)
          : tool.inputSchema,
      annotations: tool.annotations,
      origin: tool.origin,
      pageUrl: tool.pageUrl,
    }));
  })()`, true) as unknown
  if (generation !== tab.generation) throw browserError("stale_target")
  if (!Array.isArray(value)) throw browserError("browser_internal_error")
  return { tools: value.slice(0, 100).map(sanitizeWebMcpTool) }
}

export async function invokeWebMcpTool(tab: BrowserTab, params: Record<string, unknown>): Promise<{ result: unknown }> {
  const toolName = String(params.toolName ?? params.tool_name ?? "").trim()
  if (!toolName || toolName.length > 256) throw browserError("invalid_browser_request")
  const encodedInput = JSON.stringify(params.input ?? null)
  if (encodedInput.length > 256_000) throw browserError("invalid_browser_request")
  const timeoutValue = params.timeoutMs ?? params.timeout_ms
  const timeoutMs = timeoutValue === undefined ? 10_000 : boundedNumber(timeoutValue, 1, 30_000)
  const generation = tab.generation
  const script = `(() => {
    const modelContext = window.__lumeWebMcpModelContext ?? document.modelContext ?? navigator.modelContext;
    if (!modelContext || typeof modelContext.getTools !== "function" || typeof modelContext.executeTool !== "function") {
      throw new Error("WebMCP modelContext is unavailable in the current page.");
    }
    return Promise.resolve(modelContext.getTools())
      .then((tools) => {
        const tool = tools.find((candidate) => candidate.name === ${JSON.stringify(toolName)});
        if (!tool) throw new Error(${JSON.stringify(`WebMCP tool not found: ${toolName}`)});
        return modelContext.executeTool(tool, ${JSON.stringify(encodedInput)});
      })
      .then((result) => {
        if (result == null || typeof result !== "string") return result ?? null;
        try { return JSON.parse(result); } catch { return result; }
      });
  })()`
  const value = await browserPromiseTimeout(browserContents(tab).executeJavaScript(script, true), timeoutMs)
  if (generation !== tab.generation) throw browserError("stale_target")
  const encodedResult = JSON.stringify(value)
  if (encodedResult && encodedResult.length > 1_000_000) throw browserError("browser_internal_error")
  return { result: value ?? null }
}

// 处理 guest-preload 经 main.ts 转发的 page-event（lume:browser-page-event 通道）。
//
// 当前仅处理 webmcp_changed（Task 83）：guest-preload qe() 在 shim onToolsChanged 回调中
// ipcRenderer.send('lume:browser-page-event', { type:'webmcp_changed', version:1 })。main.ts
// 监听该通道并调用 BrowserRuntime.handlePageEvent，最终委托到这里。命中后 emit
// browser:webmcp-changed（含 tabId + generation），agent 端可据此知道需要刷新 webmcp:list。
//
// tab 为 undefined（sender 未匹配到任何运行时 tab）时静默忽略——guest 可能在 tab 关闭后
// 仍发出最后一次通知。非 webmcp_changed 类型一并忽略（向前兼容未来新增 page-event 类型）。
export function handleBrowserPageEvent(
  tab: { tabId: string; generation: number } | undefined,
  payload: unknown,
  emit: (event: { method: string; params: Record<string, unknown> }) => void,
): void {
  if (!isRecord(payload) || typeof payload.type !== "string") return
  if (payload.type !== "webmcp_changed") return
  if (!tab) return
  emit({ method: "browser:webmcp-changed", params: { tabId: tab.tabId, generation: tab.generation } })
}

function sanitizeWebMcpTool(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw browserError("browser_internal_error")
  const tool = value as Record<string, unknown>
  const name = webMcpText(tool.name, 256)
  if (!name) throw browserError("browser_internal_error")
  const title = webMcpText(tool.title, 512)
  const description = webMcpText(tool.description, 4_096)
  const origin = webMcpText(tool.origin, 2_048)
  const pageUrl = webMcpText(tool.pageUrl, 8_192)
  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    input_schema: browserJsonValue(tool.input_schema),
    ...(tool.annotations === undefined ? {} : { annotations: browserJsonValue(tool.annotations) }),
    ...(origin ? { origin } : {}),
    ...(pageUrl ? { pageUrl } : {}),
  }
}

function webMcpText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined
}

function browserJsonValue(value: unknown): unknown {
  if (value === undefined) return null
  try { return JSON.parse(JSON.stringify(value)) } catch { return null }
}

function browserCapabilityDocumentation(id: string): string {
  const registered = BROWSER_API_REGISTRY.filter((entry) => entry.capability === id)
  if (registered.length) return registered.map((entry) => entry.description).join("\n")
  const documentation: Record<string, string> = {
    advancedCdp: "Use CDP only for approved inspection in an isolated browser session.",
    pageAssets: "List observed page assets and bundle only explicitly selected items.",
    webmcp: "Prefer page-defined WebMCP tools over DOM or coordinate interaction. Call listTools only to refresh, then invokeTool with the selected tool name and input.",
    visibility: "Show or hide tabs owned by the current browser session.",
    viewport: "Set or reset the responsive viewport for the current browser session.",
  }
  const value = documentation[id]
  if (!value) throw browserError("unsupported")
  return value
}

async function browserPromiseTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(browserError("browser_internal_error")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function splitFrameLocator(locator: BrowserLocator): { frameSelectors: string[]; locator: BrowserLocator } | undefined {
  const frameSelectors: string[] = []
  let index = 0
  while (locator.steps[index]?.kind === "frame") {
    frameSelectors.push((locator.steps[index] as Extract<BrowserLocator["steps"][number], { kind: "frame" }>).selector)
    index += 1
  }
  if (!frameSelectors.length || index >= locator.steps.length || locator.steps.slice(index).some((step) => step.kind === "frame")) return undefined
  return { frameSelectors, locator: { version: 1, steps: locator.steps.slice(index) } }
}

function frameLocatorExceptionCode(details: { exception?: { description?: string }; text?: string }): BrowserErrorCode {
  const message = `${details.exception?.description ?? ""} ${details.text ?? ""}`
  if (message.includes("strict_locator_violation")) return "strict_locator_violation"
  if (message.includes("action_denied")) return "action_denied"
  return "stale_target"
}

function readonlyLocatorExceptionCode(details: { exception?: { description?: string }; text?: string }): BrowserErrorCode {
  const message = `${details.exception?.description ?? ""} ${details.text ?? ""}`
  if (message.includes("strict_locator_violation")) return "strict_locator_violation"
  if (message.includes("stale_target")) return "stale_target"
  return "action_denied"
}

function locatorReadonlyExpression(locator: BrowserLocator, script: string, arg: unknown): string {
  return `(() => { const element = (${browserLocatorScript()})(${JSON.stringify(locator)},"element"); return (${script})(element,${JSON.stringify(arg ?? null)}); })()`
}

function parseLocatorEvaluation(value: string | undefined): { script: string; arg: unknown; timeoutMs: number } {
  try {
    const parsed = JSON.parse(value ?? "") as { script?: unknown; arg?: unknown; timeoutMs?: unknown }
    const script = typeof parsed.script === "string" ? parsed.script : ""
    const timeoutMs = boundedNumber(parsed.timeoutMs ?? 3_000, 1, 10_000)
    if (!script || script.length > 100_000) throw new Error()
    return { script, arg: parsed.arg, timeoutMs }
  } catch {
    throw browserError("invalid_browser_request")
  }
}

function stripUrl(value: string): string {
  try {
    if (value.startsWith("view-source:")) return `view-source:${stripUrl(value.slice("view-source:".length))}`
    const url = new URL(value)
    url.username = ""
    url.password = ""
    return url.toString()
  } catch { return "" }
}

function normalizeNavigableUrl(value: string): string {
  const normalized = stripUrl(value.trim())
  if (!normalized || !isAllowedNavigation(normalized, false)) throw browserError("invalid_url")
  return normalized
}

function isAllowedNavigation(value: string, agent: boolean, settings?: BrowserSettings, approvedPrivateOrigins?: Set<string>): boolean {
  try {
    if (!agent && value.startsWith("view-source:")) return isAllowedNavigation(value.slice("view-source:".length), false, settings, approvedPrivateOrigins)
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const browseDecision = settings?.sitePermissionOverrides?.[url.origin]?.browse
    if (browseDecision === "deny") return false
    if (!agent) return true
    if (!isPrivateHost(url.hostname)) return true
    return browseDecision === "allow" || settings?.siteOverrides[url.origin] === "allow" || approvedPrivateOrigins?.has(url.origin) === true
  } catch { return false }
}

function isPrivateUrl(value: string): boolean { try { return isPrivateHost(new URL(value).hostname) } catch { return false } }

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".local")) return true
  return isIP(host) !== 0 && !isPublicAddress(host)
}

function boundedNumber(value: unknown, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : min
  return Math.max(min, Math.min(max, Math.round(number)))
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }

function normalizePageAssetSource(value: unknown): BrowserPageAsset["sources"][number] | undefined {
  if (!value || typeof value !== "object") return undefined
  const source = value as { kind?: unknown; nodeId?: unknown; property?: unknown }
  if (source.kind !== "attribute" && source.kind !== "computedStyle" && source.kind !== "resource") return undefined
  return {
    kind: source.kind,
    ...(Number.isInteger(source.nodeId) && Number(source.nodeId) > 0 ? { nodeId: Number(source.nodeId) } : {}),
    ...(typeof source.property === "string" && source.property ? { property: source.property.slice(0, 128) } : {}),
  }
}

const BROWSER_VIEWPORT_PRESETS = new Set<BrowserViewportPreset>([
  "desktop",
  "responsive",
  "4k",
  "laptop-l",
  "laptop",
  "surface-pro-7",
  "ipad-air",
  "ipad-mini",
  "surface-duo",
  "iphone-15-pro-max",
  "pixel-8",
  "iphone-15-pro",
  "samsung-galaxy-s24-ultra",
  "iphone-se",
  "phone",
  "tablet",
  "phone-landscape",
  "tablet-landscape",
])

function sanitizeViewportPreset(value: unknown): BrowserViewportPreset | undefined {
  if (value === "laptop-large") return "laptop-l"
  if (value === "galaxy-s24-ultra") return "samsung-galaxy-s24-ultra"
  return typeof value === "string" && BROWSER_VIEWPORT_PRESETS.has(value as BrowserViewportPreset)
    ? value as BrowserViewportPreset
    : undefined
}

function sanitizeViewportDisplayScale(value: unknown): BrowserViewportState["displayScale"] {
  if (value === "fit" || value === undefined) return "fit"
  if (typeof value !== "number" || !Number.isFinite(value)) return "fit"
  return Math.max(0.5, Math.min(2, value))
}

function sanitizeViewportState(value: Record<string, unknown>): BrowserViewportState {
  if (value.enabled === false) return desktopViewportState()
  return {
    enabled: true,
    width: boundedNumber(value.width, 240, 4096),
    height: boundedNumber(value.height, 160, 4096),
    deviceScaleFactor: Math.max(0.5, Math.min(4, Number(value.deviceScaleFactor) || 1)),
    mobile: value.mobile === true,
    touch: value.touch === true,
    preset: sanitizeViewportPreset(value.preset ?? value.presetId) ?? "responsive",
    displayScale: sanitizeViewportDisplayScale(value.displayScale),
  }
}

function desktopViewportState(): BrowserViewportState {
  return {
    enabled: false,
    width: 0,
    height: 0,
    deviceScaleFactor: 1,
    mobile: false,
    touch: false,
    preset: "desktop",
    displayScale: "fit",
  }
}

function pageAssetKind(url: string, hint: string): BrowserPageAsset["kind"] {
  const lower = `${url} ${hint}`.toLowerCase()
  if (/\b(img|image)\b|\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#]|$)/.test(lower)) return "image"
  if (/\bfont\b|\.(?:eot|otf|ttf|woff2?)(?:[?#]|$)/.test(lower)) return "font"
  if (/\b(css|link)\b|\.css(?:[?#]|$)/.test(lower)) return "stylesheet"
  if (/\b(video|media)\b|\.(?:m4v|mov|mp4|webm)(?:[?#]|$)/.test(lower)) return "video"
  if (/\bscript\b|\.(?:js|mjs|cjs)(?:[?#]|$)/.test(lower)) return "script"
  return "other"
}

function pageAssetName(value: string): string {
  try {
    const segment = new URL(value).pathname.split("/").filter(Boolean).at(-1)
    return safeDownloadFilename(segment ? decodeURIComponent(segment) : "asset")
  } catch {
    return "asset"
  }
}

function safePartition(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "browser" }
function sanitizeSiteOverrides(value: Record<string, unknown>): Record<string, "ask" | "allow" | "deny"> {
  const result: Record<string, "ask" | "allow" | "deny"> = {}
  for (const [input, decision] of Object.entries(value).slice(0, 500)) {
    try {
      const url = new URL(input)
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) continue
      if (decision === "ask" || decision === "allow" || decision === "deny") result[url.origin] = decision
    } catch { /* invalid origins remain untrusted */ }
  }
  return result
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeSitePermissionOverrides(value: Record<string, unknown>): Record<string, BrowserSitePermissionOverride> {
  const result: Record<string, BrowserSitePermissionOverride> = {}
  const keys = ["browse", "download", "upload", "cdp", "camera", "microphone"] as const
  for (const [input, raw] of Object.entries(value).slice(0, 500)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    try {
      const url = new URL(input)
      if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) continue
      const entry: BrowserSitePermissionOverride = {}
      for (const key of keys) {
        const decision = (raw as Record<string, unknown>)[key]
        if (decision === "ask" || decision === "allow" || decision === "deny") entry[key] = decision
      }
      if (Object.keys(entry).length > 0) result[url.origin] = entry
    } catch { /* invalid origins remain untrusted */ }
  }
  return result
}

function securityStateForUrl(value: string): NonNullable<BrowserTabDescriptor["securityState"]> {
  try {
    const url = new URL(value.startsWith("view-source:") ? value.slice("view-source:".length) : value)
    if (isPrivateHost(url.hostname)) return "local"
    if (url.protocol === "https:") return "secure"
    if (url.protocol === "http:") return "insecure"
  } catch { /* unknown URL */ }
  return "unknown"
}

function capabilityHash(values: string[]): string { return createHash("sha256").update(values.join("\n")).digest("hex") }
function keyedParameterHash(method: string, params: Record<string, unknown>): string {
  return createHmac("sha256", JOURNAL_HMAC_KEY).update(`${method}:${JSON.stringify(redactParams(params))}`).digest("hex").slice(0, 32)
}
const JOURNAL_HMAC_KEY = randomBytes(32)
const DEBUGGER_OPERATIONS = new WeakMap<Electron.WebContents, Promise<unknown>>()
const DEBUGGER_OPERATION_TIMEOUT_MS = 30_000
function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value === "string" ? "[redacted]" : typeof value === "object" ? "[object]" : value]))
}

async function withDebugger<T>(contents: Electron.WebContents, work: (debuggerRef: Electron.Debugger) => Promise<T>, timeoutMs = DEBUGGER_OPERATION_TIMEOUT_MS): Promise<T> {
  const previous = DEBUGGER_OPERATIONS.get(contents) ?? Promise.resolve()
  const operation = previous.catch(() => undefined).then(async () => {
    const debuggerRef = contents.debugger
    const attached = debuggerRef.isAttached()
    if (!attached) debuggerRef.attach("1.3")
    try {
      return await browserPromiseTimeout(work(debuggerRef), timeoutMs)
    } catch (error) {
      // 必须带 .code —— dispatch catch 的 stableBrowserErrorCode 只认 code，裸 Error 会全部塌缩成 browser_internal_error
      const message = error instanceof Error ? error.message : String(error ?? "")
      if (/Target closed|Session.*not attached|No target|target.*not found/i.test(message)) throw Object.assign(new Error(`tab_not_found: ${message}`), { code: "tab_not_found" })
      if (/Cannot find context|Execution context was destroyed|context.*destroyed|context.*not found/i.test(message)) throw Object.assign(new Error(`stale_target: ${message}`), { code: "stale_target" })
      throw error
    } finally {
      if (!attached && debuggerRef.isAttached()) debuggerRef.detach()
    }
  })
  DEBUGGER_OPERATIONS.set(contents, operation)
  try {
    return await operation
  } finally {
    if (DEBUGGER_OPERATIONS.get(contents) === operation) DEBUGGER_OPERATIONS.delete(contents)
  }
}

class BrowserOperationJournal {
  private entries: JournalEntry[] = []
  private readonly path: string | null
  private readonly encryption?: BrowserRuntimeOptions["journalEncryption"]
  constructor(configDir: () => string, encryption?: BrowserRuntimeOptions["journalEncryption"]) {
    this.encryption = encryption
    if (!encryption?.available || !encryption.encrypt) { this.path = null; return }
    const dir = join(configDir(), "browser")
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, "operations.json")
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as { payload?: string }
      const plaintext = raw.payload && encryption.decrypt ? encryption.decrypt(Buffer.from(raw.payload, "base64")) : "[]"
      this.entries = JSON.parse(plaintext).filter((entry: JournalEntry) => Date.now() - entry.timestamp < 24 * 60 * 60 * 1000)
    } catch { this.entries = [] }
  }
  write(entry: JournalEntry): void {
    if (!this.path || !this.encryption) return
    this.entries = [...this.entries.filter((item) => item.operationId !== entry.operationId), entry].slice(-500)
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, payload: this.encryption.encrypt(JSON.stringify(this.entries)).toString("base64") }), "utf8")
    try { renameSync(temporary, this.path) } catch { try { unlinkSync(temporary) } catch { /* best effort cleanup */ } }
  }
  complete(operationId: string): void {
    if (!this.path || !this.encryption) return
    this.entries = this.entries.filter((entry) => entry.operationId !== operationId)
    writeFileSync(this.path + ".tmp", JSON.stringify({ version: 1, payload: this.encryption.encrypt(JSON.stringify(this.entries)).toString("base64") }), "utf8")
    try { renameSync(this.path + ".tmp", this.path) } catch { try { unlinkSync(this.path + ".tmp") } catch { /* best effort cleanup */ } }
  }
}

const TWEAK_STYLE_KEYS = new Set([
  "textContent",
  "color",
  "backgroundColor",
  "borderColor",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "borderRadius",
  "borderWidth",
  "borderStyle",
  "width",
  "height",
  "display",
  "flexDirection",
  "justifyContent",
  "alignItems",
  "gap",
  "rowGap",
  "columnGap",
  "padding",
  "margin",
])

function sanitizeBrowserAuthRequest(value: Record<string, unknown>): BrowserAuthRequest {
  const tabId = typeof value.tabId === "string" ? value.tabId.slice(0, 200) : ""
  const generation = Number(value.generation)
  const origin = safeOrigin(String(value.origin ?? ""))
  const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt : typeof value.expires_at === "string" ? value.expires_at : ""
  const ids = new Set<string>()
  const fields = (Array.isArray(value.fields) ? value.fields.slice(0, 20) : []).flatMap((raw, index): BrowserAuthFieldRequest[] => {
    if (!isRecord(raw) || !isBrowserLocator(raw.locator)) return []
    validateBrowserLocator(raw.locator)
    const id = typeof raw.id === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(raw.id) ? raw.id : `field-${index + 1}`
    if (ids.has(id)) throw browserError("invalid_browser_request")
    ids.add(id)
    const inputType = String(raw.inputType ?? raw.type ?? "text").toLowerCase()
    const safeInputType: BrowserAuthFieldRequest["inputType"] = (["text", "email", "password", "tel", "number", "url", "search", "otp"] as string[]).includes(inputType) ? inputType as BrowserAuthFieldRequest["inputType"] : "text"
    const frameLocator = isBrowserLocator(raw.frameLocator) ? raw.frameLocator : undefined
    if (frameLocator) validateBrowserLocator(frameLocator)
    return [{
      id,
      label: typeof raw.label === "string" ? raw.label.slice(0, 200) : `Field ${index + 1}`,
      locator: raw.locator,
      inputType: safeInputType,
      ...(typeof raw.autocomplete === "string" ? { autocomplete: raw.autocomplete.slice(0, 200) } : {}),
      required: raw.required === true,
      ...(frameLocator ? { frameLocator } : {}),
    }]
  })
  if (!tabId || !Number.isSafeInteger(generation) || generation < 1 || !origin || !expiresAt) throw browserError("invalid_browser_request")
  const optionIds = new Set<string>()
  const options = (Array.isArray(value.options) ? value.options.slice(0, 10) : []).flatMap((raw): BrowserAuthOption[] => {
    if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.label !== "string" || !Array.isArray(raw.fields)) return []
    const optionFields = raw.fields.filter((id): id is string => typeof id === "string" && ids.has(id))
    // method-only 选项：无字段但带 locator（用户选登录方式 → 后端点按钮），对齐 Codex BrowserAuthOption.selector
    const locator = isBrowserLocator(raw.locator) ? raw.locator : undefined
    if (!optionFields.length && !locator) return []
    const id = raw.id.slice(0, 100)
    if (optionIds.has(id)) throw browserError("invalid_browser_request")
    optionIds.add(id)
    if (locator) {
      validateBrowserLocator(locator)
      const frameLocator = isBrowserLocator(raw.frameLocator) ? raw.frameLocator : undefined
      if (frameLocator) validateBrowserLocator(frameLocator)
      return [{ id, label: raw.label.slice(0, 200), fields: [...new Set(optionFields)], locator, ...(frameLocator ? { frameLocator } : {}) }]
    }
    return [{ id, label: raw.label.slice(0, 200), fields: [...new Set(optionFields)] }]
  })
  if (!fields.length && !options.some((item) => item.locator)) throw browserError("invalid_browser_request")
  let submit: BrowserAuthRequest["submit"]
  if (isRecord(value.submit) && value.submit.kind === "click" && isBrowserLocator(value.submit.locator)) {
    validateBrowserLocator(value.submit.locator)
    const frameLocator = isBrowserLocator(value.submit.frameLocator) ? value.submit.frameLocator : undefined
    if (frameLocator) validateBrowserLocator(frameLocator)
    submit = { kind: "click", locator: value.submit.locator, ...(frameLocator ? { frameLocator } : {}) }
  } else if (isRecord(value.submit) && value.submit.kind === "press_enter") {
    submit = { kind: "press_enter", ...(typeof value.submit.fieldId === "string" && ids.has(value.submit.fieldId) ? { fieldId: value.submit.fieldId } : {}) }
  } else submit = { kind: "none" }
  return { tabId, generation, origin, expiresAt, fields, ...(options.length ? { options } : {}), submit }
}

function combineAuthLocators(frameLocator: BrowserLocator | undefined, locator: BrowserLocator): BrowserLocator {
  if (!frameLocator) return locator
  const frameSteps: BrowserLocator["steps"] = frameLocator.steps.map((step) => {
    if (step.kind === "frame") return step
    if (step.kind === "css" || step.kind === "locator") return { kind: "frame", selector: step.selector }
    throw browserError("invalid_browser_request")
  })
  const combined = { version: 1 as const, steps: [...frameSteps, ...locator.steps] }
  validateBrowserLocator(combined)
  return combined
}

function browserAuthHtml(request: BrowserAuthRequest): string {
  const safe = JSON.stringify({
    origin: request.origin,
    fields: request.fields.map(({ id, label, inputType, autocomplete, required }) => ({ id, label, inputType, autocomplete, required })),
    options: (request.options ?? []).map(({ id, label, fields }) => ({ id, label, fields })),
  }).replaceAll("<", "\\u003c")
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>*{box-sizing:border-box}body{margin:0;background:#151517;color:#f4f4f5;font:13px system-ui,-apple-system,sans-serif}.wrap{padding:22px}.eyebrow{color:#a78bfa;font-size:11px;font-weight:600}.title{font-size:18px;font-weight:650;margin-top:5px}.origin{color:#a1a1aa;font-size:11px;margin:5px 0 18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.field{display:block;margin:11px 0}.label{display:flex;gap:4px;margin-bottom:5px;color:#d4d4d8;font-size:11px}.required{color:#fb7185}input,select{width:100%;height:36px;border:1px solid #3f3f46;border-radius:8px;background:#202024;color:#fafafa;padding:0 10px;outline:none}input:focus,select:focus{border-color:#8b5cf6;box-shadow:0 0 0 2px rgba(139,92,246,.2)}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}button{height:34px;border:0;border-radius:8px;padding:0 14px;font:inherit;cursor:pointer}.cancel{background:#29292e;color:#e4e4e7}.submit{background:#7c3aed;color:white;font-weight:600}.note{margin-top:12px;color:#71717a;font-size:10px;line-height:1.5}</style></head><body><form class="wrap" id="form"><div class="eyebrow">Lume Browser Auth</div><div class="title">在当前页面安全填写</div><div class="origin" id="origin"></div><div id="option"></div><div id="fields"></div><div class="note">凭证只会发送到主进程并直接填写到此标签页，不会进入聊天、Sidecar、日志或审计详情。</div><div class="actions"><button type="button" class="cancel" id="decline">拒绝</button><button type="button" class="cancel" id="cancel">取消</button><button class="submit">填写并继续</button></div></form><script>const state=${safe};document.getElementById('origin').textContent=state.origin;const fields=document.getElementById('fields');const controls=new Map();for(const field of state.fields){const row=document.createElement('label');row.className='field';row.dataset.fieldId=field.id;const label=document.createElement('span');label.className='label';label.textContent=field.label;if(field.required){const mark=document.createElement('span');mark.className='required';mark.textContent='*';label.append(mark)}const input=document.createElement('input');input.type=field.inputType==='otp'?'text':field.inputType;input.autocomplete=field.autocomplete||'off';input.required=field.required;if(field.inputType==='otp')input.inputMode='numeric';row.append(label,input);fields.append(row);controls.set(field.id,{row,input})}let selectedOption;if(state.options.length){const select=document.createElement('select');for(const option of state.options){const item=document.createElement('option');item.value=option.id;item.textContent=option.label;select.append(item)}document.getElementById('option').append(select);const update=()=>{selectedOption=select.value;const enabled=new Set(state.options.find(item=>item.id===selectedOption)?.fields||[]);for(const [id,control] of controls){control.row.hidden=!enabled.has(id);control.input.disabled=!enabled.has(id)}};select.addEventListener('change',update);update()}document.getElementById('decline').addEventListener('click',()=>window.lumeBrowserAuth.decline());document.getElementById('cancel').addEventListener('click',()=>window.lumeBrowserAuth.cancel());document.getElementById('form').addEventListener('submit',event=>{event.preventDefault();const values={};for(const [id,control] of controls)if(!control.input.disabled)values[id]=control.input.value;window.lumeBrowserAuth.submit({selectedOption,values});for(const control of controls.values())control.input.value=''})</script></body></html>`
}

function applyPageTweaksScript(): string {
  return `function(domPath, styles) {
    const element = document.querySelector(domPath);
    if (!(element instanceof HTMLElement)) throw new Error("stale_target");
    const store = globalThis.__lumePageTweakOriginals ||= new Map();
    if (!store.has(domPath)) {
      const originals = {};
      for (const key of Object.keys(styles)) originals[key] = key === "textContent" ? element.textContent || "" : element.style[key] || "";
      store.set(domPath, originals);
    }
    const applied = {};
    for (const [key, value] of Object.entries(styles)) {
      if (key === "textContent") element.textContent = String(value);
      else element.style[key] = String(value);
      applied[key] = String(value);
    }
    return applied;
  }`
}

function resetPageTweaksScript(): string {
  return `function(domPath) {
    const element = document.querySelector(domPath);
    const store = globalThis.__lumePageTweakOriginals;
    const originals = store?.get(domPath);
    if (!(element instanceof HTMLElement) || !originals) return false;
    for (const [key, value] of Object.entries(originals)) {
      if (key === "textContent") element.textContent = String(value);
      else element.style[key] = String(value);
    }
    store.delete(domPath);
    return true;
  }`
}

type BrowserExtensionRecord = BrowserExtensionDescriptor & { path: string }

class BrowserExtensionStore {
  private readonly path: string
  private items: BrowserExtensionRecord[] = []

  constructor(configDir: () => string) {
    const dir = join(configDir(), "browser")
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, "extensions.json")
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"))
      this.items = Array.isArray(parsed) ? parsed.filter(isBrowserExtensionRecord).slice(0, 100) : []
    } catch { this.items = [] }
  }

  records(): BrowserExtensionRecord[] { return this.items.map((item) => ({ ...item, permissions: [...item.permissions] })) }
  list(): BrowserExtensionDescriptor[] { return this.items.map(({ path: _path, ...item }) => ({ ...item, permissions: [...item.permissions] })) }
  find(id: string): BrowserExtensionRecord | undefined { return this.items.find((item) => item.id === id) }

  upsert(record: BrowserExtensionRecord): BrowserExtensionDescriptor {
    this.items = [...this.items.filter((item) => item.id !== record.id && item.path !== record.path), record].slice(-100)
    this.persist()
    const { path: _path, ...descriptor } = record
    return descriptor
  }

  remove(id: string): void {
    this.items = this.items.filter((item) => item.id !== id)
    this.persist()
  }

  private persist(): void {
    const temporaryPath = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(this.items, null, 2), { mode: 0o600 })
    renameSync(temporaryPath, this.path)
  }
}

function inspectExtensionDirectory(inputPath: string): { path: string; name: string; version: string; permissions: string[] } {
  const extensionPath = resolve(inputPath)
  const rootMetadata = lstatSync(extensionPath)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || !samePath(realpathSync(extensionPath), extensionPath)) throw browserError("action_denied")
  const pending = [extensionPath]
  let visited = 0
  while (pending.length) {
    const directory = pending.pop()!
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1
      if (visited > 20_000 || entry.isSymbolicLink()) throw browserError("action_denied")
      const itemPath = join(directory, entry.name)
      const resolvedItem = realpathSync(itemPath)
      if (!isPathInside(extensionPath, resolvedItem)) throw browserError("action_denied")
      if (entry.isDirectory()) pending.push(itemPath)
    }
  }
  const manifestPath = join(extensionPath, "manifest.json")
  const manifestMetadata = lstatSync(manifestPath)
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink() || manifestMetadata.size > 1_000_000) throw browserError("invalid_browser_request")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>
  const manifestVersion = Number(manifest.manifest_version)
  const name = typeof manifest.name === "string" ? manifest.name.trim().slice(0, 160) : ""
  const version = typeof manifest.version === "string" ? manifest.version.trim().slice(0, 80) : ""
  if ((manifestVersion !== 2 && manifestVersion !== 3) || !name || !version) throw browserError("invalid_browser_request")
  const permissions = [...new Set([
    ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
    ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
  ].filter((value): value is string => typeof value === "string").map((value) => value.slice(0, 500)))].slice(0, 500)
  return { path: extensionPath, name, version, permissions }
}

function isBrowserExtensionRecord(value: unknown): value is BrowserExtensionRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.path === "string"
    && typeof value.name === "string"
    && typeof value.version === "string"
    && typeof value.enabled === "boolean"
    && Array.isArray(value.permissions)
    && value.permissions.every((permission) => typeof permission === "string")
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right
}

function isPathInside(root: string, candidate: string): boolean {
  const normalizedRoot = process.platform === "win32" ? root.toLocaleLowerCase() : root
  const normalizedCandidate = process.platform === "win32" ? candidate.toLocaleLowerCase() : candidate
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${process.platform === "win32" ? "\\" : "/"}`)
}

class BrowserHistoryStore {
  private readonly path: string
  private entries: BrowserHistoryEntry[] = []

  constructor(configDir: () => string) {
    const dir = join(configDir(), "browser")
    mkdirSync(dir, { recursive: true })
    this.path = join(dir, "history.json")
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"))
      this.entries = Array.isArray(parsed)
        ? parsed.filter(isBrowserHistoryEntry).slice(-5000)
        : []
    } catch { this.entries = [] }
  }

  record(url: string, title: string): void {
    if (!/^https?:/i.test(url)) return
    const entry: BrowserHistoryEntry = {
      id: randomUUID(),
      url: stripUrl(url),
      title: title.slice(0, 256),
      visitedAt: new Date().toISOString(),
    }
    this.entries = [...this.entries, entry].slice(-5000)
    this.persist()
  }

  updateTitle(url: string, title: string): void {
    let index = -1
    for (let cursor = this.entries.length - 1; cursor >= 0; cursor -= 1) {
      if (this.entries[cursor]?.url === url) {
        index = cursor
        break
      }
    }
    if (index < 0 || this.entries[index]?.title === title) return
    this.entries[index] = { ...this.entries[index]!, title: title.slice(0, 256) }
    this.persist()
  }

  list(query: string, limit: number, from?: string, to?: string): BrowserHistoryEntry[] {
    const normalized = query.trim().toLocaleLowerCase()
    const fromTime = from ? Date.parse(from) : Number.NEGATIVE_INFINITY
    const toTime = to ? Date.parse(to) : Number.POSITIVE_INFINITY
    return [...this.entries]
      .reverse()
      .filter((entry) => {
        const visitedAt = Date.parse(entry.visitedAt)
        return visitedAt >= (Number.isFinite(fromTime) ? fromTime : Number.NEGATIVE_INFINITY)
          && visitedAt <= (Number.isFinite(toTime) ? toTime : Number.POSITIVE_INFINITY)
          && (!normalized || entry.url.toLocaleLowerCase().includes(normalized) || entry.title.toLocaleLowerCase().includes(normalized))
      })
      .slice(0, limit)
  }

  delete(id: string): boolean {
    const next = this.entries.filter((entry) => entry.id !== id)
    if (next.length === this.entries.length) return false
    this.entries = next
    this.persist()
    return true
  }

  clear(): void {
    this.entries = []
    this.persist()
  }

  private persist(): void {
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(this.entries), "utf8")
    try { renameSync(temporary, this.path) } catch { try { unlinkSync(temporary) } catch { /* best effort */ } }
  }
}

function isBrowserHistoryEntry(value: unknown): value is BrowserHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === "string"
    && typeof entry.url === "string"
    && typeof entry.title === "string"
    && typeof entry.visitedAt === "string"
}

function safeAnnotationTheme(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 128 || /[;{}\u0000-\u001f]/.test(value)) return undefined
  return value
}
