import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, nativeImage, screen, session, shell, type IpcMainEvent } from "electron"
import {
  BROWSER_PROTOCOL_MAX_SUPPORTED,
  BROWSER_PROTOCOL_MIN_SUPPORTED,
  BROWSER_PROTOCOL_VERSION,
  DEFAULT_BROWSER_SETTINGS,
  type BrowserActionRequest,
  type BrowserErrorCode,
  type BrowserExtensionDescriptor,
  type BrowserHistoryEntry,
  type BrowserLocator,
  type BrowserRequestContext,
  type BrowserRuntimeDescriptor,
  type BrowserSettings,
  type BrowserSitePermissionOverride,
  type BrowserTabDescriptor,
  type BrowserViewportState,
} from "../../../packages/shared/src/types/browser-runtime"
import {
  selectBrowserPartition,
  shouldInstallAdvancedCdpPolicy,
  shouldInstallAgentSessionPolicy,
} from "./browser-runtime-policy"
import { browserLocatorScript, isBrowserLocator, validateBrowserLocator, type BrowserLocatorQuery, type ResolvedBrowserTarget } from "./browser-locator"
import { createCursorUpdateScript } from "./browser-cursor"
import { canAgentClaim, canAgentUse, revokeSharedLease } from "./browser-sharing-policy"
import { BrowserNetworkGuard } from "./browser-network-guard"
import { BrowserAuditLog } from "./browser-audit"
import { AGENT_DOWNLOAD_LIMITS, AgentDownloadQuota, BrowserDownloadHistory, completeDownload, prepareDownload, removePartialDownload, safeDownloadFilename } from "./browser-downloads"
import { BrowserCredentialVault } from "./browser-credentials"

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
  overlayPreloadPath?: string
}

type BrowserTab = BrowserTabDescriptor & {
  view: WebContentsView
  partition: string
  context?: BrowserRequestContext
  inputSequence: number
  agentDispatching?: boolean
  dialogOpen?: boolean
  dialogInfo?: { type: "alert" | "beforeunload" | "confirm" | "prompt"; message?: string; defaultValue?: string }
  recentAgentContext?: { browserSessionId: string; browserTurnId: string; expiresAt: number }
  agentLease?: { browserSessionId: string; browserTurnId: string; generation: number }
  handoff?: { browserSessionId: string; status: "handoff" | "deliverable"; reason?: string }
  approvedPrivateOrigins?: Set<string>
  findRequestId?: number
  findMatches?: { activeMatchOrdinal: number; matches: number }
  navigationStack: string[]
  navigationIndex: number
  pendingNavigationIndex?: number
  consoleLogs: Array<{ level: "debug" | "info" | "log" | "warn" | "error"; message: string; timestamp: string; url?: string }>
  domNodes?: Map<string, { generation: number; x: number; y: number }>
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

type BrowserReviewOverlayResult =
  | { status: "submit"; body: string }
  | { status: "submit"; styles: Record<string, string> }
  | { status: "cancel" }

type BrowserReviewOverlay = {
  window: BrowserWindow
  tabId: string
  generation: number
  kind: "annotation" | "tweaks"
  domPath?: string
  body: string
  styles: Record<string, string>
  settled: boolean
  resolve: (result: BrowserReviewOverlayResult) => void
}

const MUTATING_METHODS = new Set(["navigate", "back", "forward", "reload", "click", "doubleClick", "hover", "fill", "type", "typeActive", "press", "pressActive", "select", "check", "uncheck", "scroll", "drag", "browserAuth", "contactFill", "dialog:handle", "upload", "filechooser:setFiles", "downloadMedia", "pageAssets:bundle", "webmcp:invoke"])
const BROWSER_API_SUPPORT = {
  "Browser.nameSession": true,
  "BrowserUser.history": true,
  "Tabs.content": true,
  "Tabs.finalize": true,
  "Tab.content": true,
  "Tab.markDeliverable": true,
  "Tab.markHandoff": true,
  "Tab.clipboard": true,
  "TabClipboardAPI.read": true,
  "TabClipboardAPI.readText": true,
  "TabClipboardAPI.write": true,
  "TabClipboardAPI.writeText": true,
  "CUAAPI.downloadMedia": true,
  "DomCUAAPI.click": true,
  "DomCUAAPI.double_click": true,
  "DomCUAAPI.downloadMedia": true,
  "DomCUAAPI.get_visible_dom": true,
  "DomCUAAPI.keypress": true,
  "DomCUAAPI.scroll": true,
  "DomCUAAPI.type": true,
  "PlaywrightAPI.elementInfo": true,
  "PlaywrightAPI.elementScreenshot": true,
  "PlaywrightAPI.evaluate": true,
  "PlaywrightAPI.frameLocator": true,
  "PlaywrightAPI.waitForEvent": true,
  "PlaywrightDownload.path": true,
  "PlaywrightFileChooser.setFiles": true,
  "PlaywrightLocator.downloadMedia": true,
  "TabDevAPI.logs": true,
} as const

export class BrowserRuntime {
  private readonly tabs = new Map<string, BrowserTab>()
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
  private agentPluginEnabled = false
  private cursorOverlay: BrowserWindow | null = null
  private cursorState: { x: number; y: number; pulse: boolean } | null = null
  private readonly popupTokens = new Map<string, { sourceTabId: string; url: string; expiresAt: number }>()
  private readonly policyTokens = new Map<string, { bindingHash: string; expiresAt: number }>()
  private readonly downloadRefs = new Map<string, { path: string; browserSessionId: string; browserTurnId: string }>()
  private readonly sessionNames = new Map<string, string>()
  private readonly claimSnapshots = new Map<string, { providerTabId?: string; title: string; url: string; generation: number }>()
  private readonly downloadWaiters = new Map<string, BrowserDownloadWaiter[]>()
  private readonly downloadResults = new Map<string, { browserSessionId: string; browserTurnId: string; state: "pending" | "completed" | "failed"; fileRef?: string; waiters: Array<(value: string | null) => void> }>()
  private readonly fileChooserWaiters = new Map<string, BrowserFileChooserWaiter[]>()
  private readonly fileChoosers = new Map<string, { tabId: string; backendNodeId: number; isMultiple: boolean; browserSessionId: string; browserTurnId: string; generation: number }>()
  private readonly pageAssetInventories = new Map<string, BrowserPageAssetInventory>()
  private readonly reviewOverlays = new Map<number, BrowserReviewOverlay>()
  private readonly browserOverlayMessageHandler = (event: IpcMainEvent, payload: unknown): void => {
    const overlay = this.reviewOverlays.get(event.sender.id)
    if (!overlay || overlay.window.isDestroyed()) return
    this.handleBrowserOverlayMessage(overlay, payload)
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
    this.journal = new BrowserOperationJournal(options.configDir, options.journalEncryption)
    this.audit = new BrowserAuditLog(options.configDir)
    this.downloadHistory = new BrowserDownloadHistory(options.configDir)
    this.browsingHistory = new BrowserHistoryStore(options.configDir)
    this.extensions = new BrowserExtensionStore(options.configDir)
    this.credentials = new BrowserCredentialVault(options.configDir, options.credentialStorage)
    void this.restoreBrowserExtensions()
    app.on("login", this.loginHandler)
    app.on("certificate-error", this.certificateErrorHandler)
    app.on("select-client-certificate", this.clientCertificateHandler)
    ipcMain.on("lume:browser-overlay", this.browserOverlayMessageHandler)
  }

  descriptor(): BrowserRuntimeDescriptor {
    const capabilities = [
      { id: "tabs", description: "Create, close, switch and inspect in-app tabs." },
      { id: "navigation", description: "Navigate and control ordinary HTTP(S) pages." },
      { id: "locator-actions", description: "Use the constrained snapshot and locator input facade." },
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
    if (this.options.credentialStorage.isEncryptionAvailable()) capabilities.push({ id: "browserAuth", description: "Fill a saved credential in the current IAB origin without returning its value." })
    return {
      id: "lume-iab",
      backend: "iab",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      minSupported: BROWSER_PROTOCOL_MIN_SUPPORTED,
      maxSupported: BROWSER_PROTOCOL_MAX_SUPPORTED,
      capabilityHash: capabilityHash(capabilities.map((item) => item.id)),
      generation: this.backendGeneration,
      capabilities,
      apiSupportOverrides: BROWSER_API_SUPPORT,
    }
  }

  getSettings(): BrowserSettings { return { ...this.settings } }

  updateSettings(input: Partial<BrowserSettings>): BrowserSettings {
    const previous = JSON.stringify(this.settings)
    const advancedCdpWasEnabled = this.settings.advancedCdpEnabled
    this.settings = {
      ...this.settings,
      schemaVersion: 2,
      ...(typeof input.browserEnabled === "boolean" ? { browserEnabled: input.browserEnabled } : {}),
      ...(typeof input.browserUseEnabled === "boolean" ? { browserUseEnabled: input.browserUseEnabled } : {}),
      ...(typeof input.agentCursorVisible === "boolean" ? { agentCursorVisible: input.agentCursorVisible } : {}),
      ...(input.linkOpenTarget === "lume" || input.linkOpenTarget === "system" ? { linkOpenTarget: input.linkOpenTarget } : {}),
      ...(input.localUrlTarget === "lume" || input.localUrlTarget === "system" ? { localUrlTarget: input.localUrlTarget } : {}),
      ...(typeof input.advancedCdpEnabled === "boolean" ? { advancedCdpEnabled: input.advancedCdpEnabled } : {}),
      ...(typeof input.extensionBackendEnabled === "boolean" ? { extensionBackendEnabled: input.extensionBackendEnabled } : {}),
      ...(input.annotationScreenshots === "off" || input.annotationScreenshots === "ask" || input.annotationScreenshots === "always" ? { annotationScreenshots: input.annotationScreenshots } : {}),
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
        const browserSession = tab.view.webContents.session
        if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view)
        if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
        this.tabs.delete(tabId)
        this.disposeOwnedSessionIfUnused(tab.partition, browserSession)
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
    if (method === "openTabs") {
      const tabs = [...this.tabs.values()]
        .filter((tab) => tab.partition === "persist:lume-browser")
        .sort((left, right) => String(right.lastOpenedAt ?? "").localeCompare(String(left.lastOpenedAt ?? "")))
      if (context.actor === "agent") {
        for (const tab of tabs) {
          this.claimSnapshots.set(claimSnapshotKey(context, tab.tabId), {
            providerTabId: tab.providerTabId,
            title: tab.title,
            url: tab.url,
            generation: tab.generation,
          })
        }
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
    if (method === "ensure") return this.ensureTab(String(params.tabId ?? randomUUID()), context, params)
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
    if (method === "claim") return this.claimTab(String(params.tabId ?? context.tabId ?? ""), context)
    if (method === "close") return this.closeTab(String(params.tabId ?? context.tabId ?? ""), context)
    if (method === "bounds") return this.updateBounds(String(params.tabId ?? context.tabId ?? ""), params)
    if (method === "visible") return this.setVisible(String(params.tabId ?? context.tabId ?? ""), params.visible === true)
    if (method === "move-owner") {
      if (context.actor !== "user") throw browserError("action_denied")
      const tab = this.requireTab(String(params.tabId ?? context.tabId ?? ""), context)
      tab.ownerThreadId = typeof params.ownerThreadId === "string" ? params.ownerThreadId.slice(0, 200) : undefined
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
        tab.view.setVisible(tab.visible)
      }
      return {}
    }
    if (method === "browser:viewport:set" || method === "browser:viewport:reset") {
      for (const tab of this.tabs.values()) {
        if (!canContextUseTab(tab, context)) continue
        if (method === "browser:viewport:set") await this.setViewport(tab, params)
        else await this.resetViewport(tab)
      }
      return {}
    }

    const tab = this.requireTab(String(params.tabId ?? context.tabId ?? ""), context)
    if (tab.dialogOpen && method !== "dialog:handle" && method !== "dialog:get") throw browserError("dialog_blocking")
    if ((method === "browserAuth" || method === "contactFill" || method === "upload" || method === "filechooser:setFiles" || method === "pageAssets:bundle" || method === "cdp" || method === "clipboard:read" || method === "clipboard:readText" || method === "clipboard:write" || method === "clipboard:writeText") && params.__policyRequired !== true) throw browserError("confirmation_unavailable")
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
    if (method === "snapshot") return this.snapshot(tab)
    if (method === "wait:download") return this.waitForDownload(tab, context, boundedNumber(params.timeoutMs ?? params.timeout_ms, 1, 30_000) || 10_000)
    if (method === "download:path") return this.downloadPath(context, String(params.downloadId ?? params.download_id ?? ""), boundedNumber(params.timeoutMs ?? params.timeout_ms, 1, 30_000) || 10_000)
    if (method === "wait:filechooser") return this.waitForFileChooser(tab, context, boundedNumber(params.timeoutMs ?? params.timeout_ms, 1, 30_000) || 10_000)
    if (method === "pageAssets:list") return this.listPageAssets(tab, context)
    if (method === "webmcp:list") return listWebMcpTools(tab)
    if (method === "webmcp:invoke") return invokeWebMcpTool(tab, params)
    if (method === "content") return this.pageContent(tab, params)
    if (method === "scroll:get") {
      const position = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `({ x: scrollX, y: scrollY })` }], true) as { x?: unknown; y?: unknown }
      return { x: Math.max(0, finiteNumber(position.x)), y: Math.max(0, finiteNumber(position.y)) }
    }
    if (method === "scroll:set") {
      const x = boundedNumber(params.x, 0, 10_000_000)
      const y = boundedNumber(params.y, 0, 10_000_000)
      await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `scrollTo(${JSON.stringify(x)}, ${JSON.stringify(y)}); ({ x: scrollX, y: scrollY })` }], true)
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
    if (method === "stop") { tab.view.webContents.stop(); return publicTab(tab) }
    if (method === "hardReload") {
      tab.view.webContents.reloadIgnoringCache()
      return publicTab(tab)
    }
    if (method === "dialog:get") return tab.dialogInfo
    if (method.startsWith("locator:")) return this.queryLocator(tab, method.slice("locator:".length), params)
    if (method === "wait:url") return this.waitForUrl(tab, String(params.url ?? ""), boundedNumber(params.timeoutMs ?? (params.options as Record<string, unknown> | undefined)?.timeoutMs, 0, 30_000) || 10_000)
    if (method === "wait:load") return this.waitForLoad(tab, boundedNumber(params.timeoutMs, 0, 30_000) || 10_000)
    if (method === "wait:timeout") { await delay(boundedNumber(params.timeoutMs, 0, 30_000)); return undefined }
    if (method === "browserAuth:list") return this.credentials.listPasswords().filter((entry) => entry.origin === safeOrigin(tab.url))
    if (method === "screenshot") return this.screenshot(tab, params)
    if (method === "screenshot:save") return this.saveScreenshot(tab, params)
    if (method === "find") {
      tab.findRequestId = tab.view.webContents.findInPage(String(params.text ?? "").slice(0, 500), { forward: params.forward !== false, findNext: params.findNext === true })
      return { requestId: tab.findRequestId, ...(tab.findMatches ?? { activeMatchOrdinal: 0, matches: 0 }) }
    }
    if (method === "find:stop") {
      tab.view.webContents.stopFindInPage(params.action === "activate" ? "activateSelection" : "clearSelection")
      tab.findRequestId = undefined
      tab.findMatches = undefined
      return { ok: true }
    }
    if (method === "zoom:get") return { factor: tab.view.webContents.getZoomFactor() }
    if (method === "zoom:set") { const factor = Math.max(0.25, Math.min(5, Number(params.factor) || 1)); tab.view.webContents.setZoomFactor(factor); return { factor } }
    if (method === "emulate") return this.emulateDevice(tab, String(params.preset ?? "desktop"), params)
    if (method === "viewport:set") return this.setViewport(tab, params)
    if (method === "viewport:reset") return this.resetViewport(tab)
    if (method === "screenshot:clipboard") return this.copyScreenshot(tab, params)
    if (method === "print") return this.printPage(tab)
    if (method === "devtools") {
      if (context.actor !== "user") throw browserError("action_denied")
      tab.view.webContents.openDevTools({ mode: "detach", activate: true })
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
    if (method === "annotation:start" || method === "tweaks:start") {
      if (context.actor !== "user") throw browserError("action_denied")
      return this.selectPageAnchor(tab, method === "tweaks:start" ? "element" : String(params.mode ?? "element"))
    }
    if (method === "overlay:compose") return this.composeReviewOverlay(tab, params, context)
    if (method === "annotation:stop") {
      if (context.actor !== "user") throw browserError("action_denied")
      await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: "globalThis.__lumeCancelPageSelection?.()" }], true)
      return { ok: true }
    }
    if (method === "tweaks:apply") return this.applyPageTweaks(tab, params, context)
    if (method === "tweaks:reset") return this.resetPageTweaks(tab, params, context)
    if (method === "cdp") return this.cdp(tab, params)
    if (method === "url") return tab.url
    if (method === "title") return tab.title
    throw browserError("unsupported")
  }

  destroy(): void {
    this.hideAgentCursor()
    if (this.cursorOverlay && !this.cursorOverlay.isDestroyed()) this.cursorOverlay.close()
    this.cursorOverlay = null
    app.off("login", this.loginHandler)
    app.off("certificate-error", this.certificateErrorHandler)
    app.off("select-client-certificate", this.clientCertificateHandler)
    ipcMain.off("lume:browser-overlay", this.browserOverlayMessageHandler)
    for (const overlay of this.reviewOverlays.values()) {
      if (!overlay.window.isDestroyed()) overlay.window.close()
      if (!overlay.settled) overlay.resolve({ status: "cancel" })
    }
    this.reviewOverlays.clear()
    for (const tab of this.tabs.values()) {
      this.clearTabWaiters(tab.tabId)
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    this.downloadRefs.clear()
    this.pageAssetInventories.clear()
    for (const policy of this.ownedSessionPolicies) {
      policy.disposed = true
      policy.session.webRequest.onBeforeRequest(null)
      if (policy.downloadHandler) policy.session.off("will-download", policy.downloadHandler)
      void policy.networkGuard?.close()
    }
    this.ownedSessionPolicies.clear()
    this.backendGeneration += 1
  }

  private ensureTab(tabId: string, context: BrowserRequestContext, params: Record<string, unknown>): BrowserTabDescriptor {
    const existing = this.tabs.get(tabId)
    if (existing) {
      if (context.actor === "agent") {
        if (!existing.agentLease && existing.shareable && existing.partition === "persist:lume-browser") {
          existing.agentLease = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: existing.generation }
        }
        if (!existing.agentLease || existing.agentLease.browserSessionId !== context.browserSessionId || existing.agentLease.browserTurnId !== context.browserTurnId) throw browserError("action_denied")
      }
      return publicTab(existing)
    }
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) throw browserError("browser_unavailable")
    const partition = selectBrowserPartition(context, params)
    const isAgent = shouldInstallAgentSessionPolicy(partition)
    const advancedCdp = shouldInstallAdvancedCdpPolicy(partition)
    const agentOwned = context.actor === "agent"
    if (advancedCdp && !this.settings.advancedCdpEnabled) throw browserError("action_denied")
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition },
    })
    const tab: BrowserTab = {
      tabId,
      providerTabId: randomUUID(),
      ...(typeof params.ownerThreadId === "string" ? { ownerThreadId: params.ownerThreadId.slice(0, 200) } : {}),
      ...(typeof params.openerTabId === "string" ? { openerTabId: params.openerTabId.slice(0, 200) } : {}),
      profileKind: advancedCdp ? "advanced-cdp" : agentOwned ? "agent" : "user",
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
      view,
      partition,
      ...(agentOwned ? { context, agentLease: { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: 1 } } : {}),
      inputSequence: 0,
      navigationStack: Array.isArray(params.navigationEntries)
        ? params.navigationEntries.filter((value): value is string => typeof value === "string" && /^https?:/i.test(value)).map(stripUrl).filter(Boolean).slice(-200)
        : [],
      navigationIndex: Number.isInteger(params.navigationIndex) ? boundedNumber(params.navigationIndex, 0, 199) : -1,
      consoleLogs: [],
    }
    this.tabs.set(tabId, tab)
    this.installPolicies(tab, isAgent || advancedCdp, advancedCdp)
    win.contentView.addChildView(view)
    view.setVisible(false)
    const initialUrl = typeof params.url === "string" && params.url.trim() ? params.url : undefined
    if (initialUrl) void this.navigate(tab, initialUrl, context)
    this.enforceBackgroundLimit()
    return publicTab(tab)
  }

  private installPolicies(tab: BrowserTab, agent: boolean, advancedCdp: boolean): void {
    const wc = tab.view.webContents
    this.ensureSessionPolicy(wc.session, tab.partition, agent || advancedCdp)
    wc.setWindowOpenHandler(({ url }) => {
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
    wc.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url, agent, this.settings, tab.approvedPrivateOrigins)) event.preventDefault()
    })
    wc.on("did-navigate", (_event, url) => {
      this.hideAgentCursor()
      this.closeReviewOverlaysForTab(tab.tabId)
      tab.url = stripUrl(url)
      tab.securityState = securityStateForUrl(tab.url)
      tab.isLoading = wc.isLoading()
      tab.lifecycle = tab.visible ? "active" : "background"
      tab.lastOpenedAt = new Date().toISOString()
      if (tab.pendingNavigationIndex !== undefined) {
        tab.navigationIndex = tab.pendingNavigationIndex
        tab.pendingNavigationIndex = undefined
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
      else tab.agentLease = undefined
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("did-navigate-in-page", (_event, url) => {
      this.closeReviewOverlaysForTab(tab.tabId)
      tab.url = stripUrl(url)
      tab.securityState = securityStateForUrl(tab.url)
      tab.lastOpenedAt = new Date().toISOString()
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("did-start-loading", () => {
      tab.isLoading = true
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("did-stop-loading", () => {
      tab.isLoading = false
      tab.canGoBack = tab.navigationIndex > 0
      tab.canGoForward = tab.navigationIndex >= 0 && tab.navigationIndex < tab.navigationStack.length - 1
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      tab.isLoading = false
      this.options.emit({ method: "browser:tab-error", params: { tabId: tab.tabId, code: "load_failed", errorCode, errorDescription: errorDescription.slice(0, 300), url: stripUrl(validatedURL), recoverable: true } })
    })
    wc.on("page-favicon-updated", (_event, favicons) => {
      const faviconUrl = favicons.find((value) => /^https?:|^data:image\//i.test(value))
      tab.faviconUrl = faviconUrl?.slice(0, 4096)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
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
    wc.on("before-input-event", () => {
      if (!tab.agentDispatching) tab.inputSequence += 1
    })
    wc.on("before-mouse-event", () => {
      if (!tab.agentDispatching) tab.inputSequence += 1
    })
    wc.on("page-title-updated", (_event, title) => {
      tab.title = title.slice(0, 256)
      if (tab.url) this.browsingHistory.updateTitle(tab.url, tab.title)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("console-message", (_event, details) => {
      const detail = details as unknown as { level?: unknown; message?: unknown; sourceId?: unknown }
      const level: BrowserTab["consoleLogs"][number]["level"] = detail.level === "debug" || detail.level === "info" || detail.level === "warn" || detail.level === "error"
        ? detail.level
        : "log"
      tab.consoleLogs = [...tab.consoleLogs, {
        level,
        message: String(detail.message ?? "").slice(0, 20_000),
        timestamp: new Date().toISOString(),
        ...(typeof detail.sourceId === "string" && /^https?:/i.test(detail.sourceId) ? { url: stripUrl(detail.sourceId) } : {}),
      }].slice(-500)
    })
    wc.on("render-process-gone", () => {
      tab.lifecycle = "crashed"
      tab.isLoading = false
      tab.generation += 1
      tab.inputSequence += 1
      if (tab.context?.actor === "agent") {
        tab.agentLease = { browserSessionId: tab.context.browserSessionId, browserTurnId: tab.context.browserTurnId, generation: tab.generation }
      }
      this.options.emit({ method: "browser:tab-error", params: { tabId: tab.tabId, code: "browser_internal_error", recoverable: true } })
    })
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach("1.3")
      void wc.debugger.sendCommand("Page.enable")
      wc.debugger.on("message", (_event, method, params) => {
        if (method === "Page.javascriptDialogOpening") {
          tab.dialogOpen = true
          const detail = params as Record<string, unknown>
          const type = String(detail.type ?? "alert")
          tab.dialogInfo = {
            type: (["alert", "beforeunload", "confirm", "prompt"].includes(type) ? type : "alert") as NonNullable<BrowserTab["dialogInfo"]>["type"],
            ...(typeof detail.message === "string" ? { message: detail.message.slice(0, 10_000) } : {}),
            ...(typeof detail.defaultPrompt === "string" ? { defaultValue: detail.defaultPrompt.slice(0, 10_000) } : {}),
          }
          this.options.emit({ method: "browser:dialog", params: { tabId: tab.tabId, generation: tab.generation, type: String((params as Record<string, unknown>).type ?? "alert") } })
        }
        if (method === "Page.javascriptDialogClosed") { tab.dialogOpen = false; tab.dialogInfo = undefined }
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
          this.fileChoosers.set(fileChooserId, {
            tabId: tab.tabId,
            backendNodeId,
            isMultiple,
            browserSessionId: waiter.browserSessionId,
            browserTurnId: waiter.browserTurnId,
            generation: tab.generation,
          })
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
      const legacyOverride = origin ? this.settings.siteOverrides[origin] : undefined
      const requestedMediaTypes = (details as { mediaTypes?: unknown } | undefined)?.mediaTypes
      const mediaTypes = Array.isArray(requestedMediaTypes) ? requestedMediaTypes : []
      const permissionKey = permission === "media"
        ? mediaTypes.includes("video") ? "camera" : mediaTypes.includes("audio") ? "microphone" : undefined
        : undefined
      const override = origin && permissionKey ? this.settings.sitePermissionOverrides?.[origin]?.[permissionKey] : legacyOverride
      if (policy.agent || override === "deny" || (!override && this.settings.sitePermissionDefault === "deny")) {
        callback(false)
        return
      }
      if (override === "allow") {
        const tab = this.tabForContents(contents)
        if (tab && permissionKey) {
          tab.mediaState = {
            ...(tab.mediaState ?? { audible: false, camera: false, microphone: false }),
            [permissionKey]: true,
          }
          this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
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
          const tab = this.tabForContents(contents)
          if (tab) {
            tab.mediaState = {
              ...(tab.mediaState ?? { audible: false, camera: false, microphone: false }),
              [permissionKey]: true,
            }
            this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
          }
        }
        callback(allowed)
      }).catch(() => callback(false))
    })
    const downloadHandler = (_event: Electron.Event, item: Electron.DownloadItem, webContents: Electron.WebContents): void => {
      if (policy.disposed) { item.cancel(); return }
      const tab = [...this.tabs.values()].find((candidate) => candidate.view.webContents === webContents)
      item.pause()
      void this.handleDownload(policy, tab, item).catch(() => item.cancel())
    }
    policy.downloadHandler = downloadHandler
    browserSession.on("will-download", downloadHandler)
    browserSession.webRequest.onBeforeRequest({ urls: ["*://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
      const claimedGlobalTab = [...this.tabs.values()].find((tab) => tab.view.webContents.id === details.webContentsId && Boolean(tab.agentLease))
      const guarded = policy.agent || Boolean(claimedGlobalTab)
      callback({ cancel: policy.disposed || (guarded && !isAllowedNavigation(details.url, true, this.settings, claimedGlobalTab?.approvedPrivateOrigins)) })
    })
    if (!agent) return
    const guard = new BrowserNetworkGuard({ allowPrivateOrigin: (origin) => this.settings.siteOverrides[origin] === "allow" || [...this.tabs.values()].some((tab) => tab.view.webContents.session === browserSession && tab.approvedPrivateOrigins?.has(origin)) })
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
      if (result.response !== 0 || policy.disposed || !tab || (generation !== undefined && tab.generation !== generation)) { item.cancel(); return }
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
    item.on("updated", () => {
      if (agent && quotaId && !this.downloadQuota.update(sessionId, quotaId, item.getReceivedBytes())) {
        quotaExceeded = true
        item.cancel()
      }
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
      this.options.emit({ method: "browser:download", params: { tabId: tab?.tabId, state, filename: prepared.filename, ...(agent && completed ? { fileRef: `browser-download:${prepared.id}` } : {}) } })
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

  private tabForContents(contents: Electron.WebContents): BrowserTab | undefined {
    return [...this.tabs.values()].find((tab) => tab.view.webContents === contents)
  }

  private async dispatchAction(tab: BrowserTab, method: string, params: Record<string, unknown>, context: BrowserRequestContext): Promise<unknown> {
    if (tab.lifecycle === "suspended") void this.setTabSuspended(tab, false)
    if (context.actor === "agent") tab.recentAgentContext = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, expiresAt: Date.now() + 30_000 }
    if (method === "navigate") return this.navigate(tab, String(params.url ?? ""), context, params.__policyRequired === true)
    if (method === "back") {
      if (tab.navigationIndex <= 0) return undefined
      tab.pendingNavigationIndex = tab.navigationIndex - 1
      if (tab.view.webContents.canGoBack()) return tab.view.webContents.goBack()
      return tab.view.webContents.loadURL(tab.navigationStack[tab.pendingNavigationIndex]!)
    }
    if (method === "forward") {
      if (tab.navigationIndex < 0 || tab.navigationIndex >= tab.navigationStack.length - 1) return undefined
      tab.pendingNavigationIndex = tab.navigationIndex + 1
      if (tab.view.webContents.canGoForward()) return tab.view.webContents.goForward()
      return tab.view.webContents.loadURL(tab.navigationStack[tab.pendingNavigationIndex]!)
    }
    if (method === "reload") return tab.view.webContents.reload()
    if (method === "dialog:handle") {
      await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Page.handleJavaScriptDialog", { accept: params.accept === true, ...(typeof params.promptText === "string" ? { promptText: params.promptText.slice(0, 10_000) } : {}) }))
      tab.dialogOpen = false
      tab.dialogInfo = undefined
      return { ok: true }
    }
    if (method === "browserAuth") return this.fillSavedPassword(tab, params)
    if (method === "contactFill") return this.fillSavedContact(tab, params)
    if (method === "upload") return this.uploadFileRefs(tab, params, context)
    if (method === "filechooser:setFiles") return this.setFileChooserFiles(tab, params, context)
    if (method === "downloadMedia") return this.downloadMedia(tab, params, context)
    if (method === "pageAssets:bundle") return this.bundlePageAssets(tab, params, context)
    if (method === "webmcp:invoke") return invokeWebMcpTool(tab, params)
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
        tab.inputSequence += 1
        tab.agentDispatching = true
        try {
          const argument = method === "fill" || method === "type"
            ? String(params.text ?? "")
            : method === "press"
              ? String(params.key ?? "Enter")
              : method === "select"
                ? JSON.stringify(Array.isArray(params.value) ? params.value : [String(params.value ?? "")])
                : undefined
          await this.executeFrameLocatorQuery(tab, params.locator, method as BrowserLocatorQuery, argument)
        } finally {
          tab.agentDispatching = false
        }
        return { ok: true, inputSequence: tab.inputSequence }
      }
      const target = await this.resolveTarget(tab, params)
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
    const policy = this.sessionPolicies.get(tab.view.webContents.session)
    if (policy?.networkReady) {
      try { await policy.networkReady } catch { throw browserError("browser_unavailable") }
    }
    await tab.view.webContents.loadURL(new URL(url).toString())
    return publicTab(tab)
  }

  private async fillSavedPassword(tab: BrowserTab, params: Record<string, unknown>): Promise<{ status: "submitted" }> {
    const origin = safeOrigin(tab.url)
    if (!origin) throw browserError("action_denied")
    const secret = this.credentials.passwordForOrigin(String(params.credentialId ?? ""), origin)
    if (!secret) throw browserError("action_denied")
    await this.fillSecret(tab, params, secret)
    return { status: "submitted" }
  }

  private async fillSavedContact(tab: BrowserTab, params: Record<string, unknown>): Promise<{ status: "submitted" }> {
    const value = this.credentials.contactValue(String(params.contactId ?? ""), String(params.field ?? ""))
    if (!value) throw browserError("action_denied")
    await this.fillSecret(tab, params, value)
    return { status: "submitted" }
  }

  private async fillSecret(tab: BrowserTab, params: Record<string, unknown>, value: string): Promise<void> {
    const generation = tab.generation
    const inputSequence = tab.inputSequence
    const target = await this.resolveTarget(tab, params)
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
    const target = await this.resolveTarget(tab, params)
    if (target.tagName.toLowerCase() !== "input" || tab.generation !== generation || tab.inputSequence !== inputSequence) throw browserError("stale_target")
    await withDebugger(tab.view.webContents, async (debuggerRef) => {
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

  private async waitForFileChooser(tab: BrowserTab, context: BrowserRequestContext, timeoutMs: number): Promise<{ file_chooser_id: string; is_multiple: boolean }> {
    if (context.actor !== "agent") throw browserError("action_denied")
    await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }))
    return new Promise((resolve, reject) => {
      const waiter: BrowserFileChooserWaiter = {
        browserSessionId: context.browserSessionId,
        browserTurnId: context.browserTurnId,
        resolve,
        reject,
        timer: setTimeout(() => {
          const current = this.fileChooserWaiters.get(tab.tabId) ?? []
          this.fileChooserWaiters.set(tab.tabId, current.filter((item) => item !== waiter))
          void withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })).catch(() => undefined)
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
      await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("DOM.setFileInputFiles", { files, backendNodeId: chooser.backendNodeId }))
      return {}
    } finally {
      this.fileChoosers.delete(chooserId)
      await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false })).catch(() => undefined)
    }
  }

  private async downloadMedia(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<Record<string, never>> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const nodeId = typeof params.nodeId === "string" ? params.nodeId : typeof params.node_id === "string" ? params.node_id : ""
    const node = nodeId ? tab.domNodes?.get(nodeId) : undefined
    if (nodeId && (!node || node.generation !== tab.generation)) throw browserError("stale_target")
    const target = node
      ? { x: node.x, y: node.y }
      : await this.resolveTarget(tab, params)
    const generation = tab.generation
    const mediaUrl = await withDebugger(tab.view.webContents, async (debuggerRef) => {
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
    tab.view.webContents.downloadURL(mediaUrl)
    return {}
  }

  private async listPageAssets(tab: BrowserTab, context: BrowserRequestContext): Promise<Record<string, unknown>> {
    if (context.actor !== "agent") throw browserError("action_denied")
    const generation = tab.generation
    const observed = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
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
        const response = await tab.view.webContents.session.fetch(asset.url, { redirect: "follow", signal: controller.signal })
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
      const clicked = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
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
    await withDebugger(tab.view.webContents, async (debuggerRef) => {
      await debuggerRef.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
      if (method === "hover") return
    })
  }

  private async dispatchKey(tab: BrowserTab, key: string, modifiers: string[] = []): Promise<void> {
    await withDebugger(tab.view.webContents, async (debuggerRef) => {
      const modifier = modifiers.includes("CTRL") ? 2 : modifiers.includes("META") ? 4 : 0
      await debuggerRef.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers: modifier })
      await debuggerRef.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers: modifier })
    })
  }

  private async applyText(tab: BrowserTab, target: ResolvedBrowserTarget, text: string, replace: boolean): Promise<void> {
    const applied = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
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
    const applied = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
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
    const pressed = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
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
    const timeoutMs = boundedNumber(params.timeoutMs ?? params.timeout_ms, 1, 10_000) || 3_000
    const argument = JSON.stringify({ script, arg: params.arg ?? null, timeoutMs })
    if (splitFrameLocator(locator)) return this.executeFrameLocatorQuery(tab, locator, "evaluate", argument)
    const generation = tab.generation
    const result = await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Runtime.evaluate", {
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
      return await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(${browserLocatorScript()})(${JSON.stringify(params.locator)},${JSON.stringify(operation)},${JSON.stringify(argument)})` }], true)
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      const code = ["stale_target", "strict_locator_violation", "action_denied"].find((value) => message.includes(value)) ?? "stale_target"
      throw browserError(code as BrowserErrorCode)
    }
  }

  private async executeFrameLocatorQuery(tab: BrowserTab, locator: BrowserLocator, operation: BrowserLocatorQuery, argument?: string): Promise<unknown> {
    const parts = splitFrameLocator(locator)
    if (!parts) throw browserError("invalid_browser_request")
    const evaluation = operation === "evaluate" ? parseLocatorEvaluation(argument) : undefined
    const generation = tab.generation
    return withDebugger(tab.view.webContents, async (debuggerRef) => {
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
      const evaluated = await debuggerRef.sendCommand("Runtime.evaluate", {
        contextId: isolated.executionContextId,
        expression: evaluation
          ? locatorReadonlyExpression(parts.locator, evaluation.script, evaluation.arg)
          : `(${browserLocatorScript()})(${JSON.stringify(parts.locator)},${JSON.stringify(operation)},${JSON.stringify(argument)})`,
        returnByValue: true,
        awaitPromise: true,
        ...(evaluation ? { throwOnSideEffect: true, timeout: evaluation.timeoutMs } : {}),
      }) as { result?: { value?: unknown }; exceptionDetails?: { exception?: { description?: string }; text?: string } }
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
    while (tab.view.webContents.isLoading()) {
      if (Date.now() >= deadline) throw browserError("actionability_failed")
      await delay(50)
    }
  }

  private async resolveTarget(tab: BrowserTab, params: Record<string, unknown>): Promise<ResolvedBrowserTarget> {
    if (params.locator === undefined) return { x: boundedNumber(params.x, 0, 100_000), y: boundedNumber(params.y, 0, 100_000), width: 1, height: 1, tagName: "", editable: true, enabled: true }
    if (!isBrowserLocator(params.locator)) throw browserError("invalid_browser_request")
    try {
      validateBrowserLocator(params.locator)
      if (splitFrameLocator(params.locator)) return await this.executeFrameLocatorQuery(tab, params.locator, "target") as ResolvedBrowserTarget
      return await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(${browserLocatorScript()})(${JSON.stringify(params.locator)})` }], true) as ResolvedBrowserTarget
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      const code = ["stale_target", "strict_locator_violation", "action_denied"].find((value) => message.includes(value)) ?? "stale_target"
      throw browserError(code as BrowserErrorCode)
    }
  }

  private async dispatchScroll(tab: BrowserTab, target: ResolvedBrowserTarget, params: Record<string, unknown>): Promise<void> {
    await this.dispatchMouse(tab, "hover", target)
    await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: target.x, y: target.y, deltaX: boundedNumber(params.deltaX, -10000, 10000), deltaY: boundedNumber(params.deltaY ?? params.y, -10000, 10000),
    }))
  }

  private async dispatchDrag(tab: BrowserTab, target: ResolvedBrowserTarget, params: Record<string, unknown>): Promise<void> {
    const endX = boundedNumber(params.toX ?? params.x2, 0, 100_000)
    const endY = boundedNumber(params.toY ?? params.y2, 0, 100_000)
    await this.showAgentCursor(tab, target.x, target.y, false)
    await withDebugger(tab.view.webContents, async (debuggerRef) => {
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
    const viewBounds = tab.view.getBounds()
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
    await tab.view.webContents.executeJavaScript(`(values => { const select = document.activeElement; if (!(select instanceof HTMLSelectElement)) throw new Error("action_denied"); for (const option of Array.from(select.options)) option.selected = values.includes(option.value); select.dispatchEvent(new Event("input", { bubbles: true })); select.dispatchEvent(new Event("change", { bubbles: true })); })(${JSON.stringify(values)})`, true)
  }

  private async applyChecked(tab: BrowserTab, params: Record<string, unknown>, checked: boolean): Promise<void> {
    if (!params.locator) return
    await tab.view.webContents.executeJavaScript(`(locator => { const el = document.activeElement; if (!(el instanceof HTMLInputElement) || !["checkbox", "radio"].includes(el.type)) throw new Error("action_denied"); if (el.checked !== ${checked}) el.click(); })(${JSON.stringify(params.locator)})`, true)
  }

  private async snapshot(tab: BrowserTab): Promise<unknown> {
    return withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("DOMSnapshot.captureSnapshot", { computedStyles: [] }))
  }

  private async screenshot(tab: BrowserTab, params: Record<string, unknown>): Promise<string> {
    if (params.fullPage === true) {
      const result = await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })) as { data?: string }
      if (typeof result.data === "string") return result.data
    }
    try {
      const image = await tab.view.webContents.capturePage()
      return image.toPNG().toString("base64")
    } catch {
      const result = await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })) as { data?: string }
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
    writeFileSync(selected.filePath, Buffer.from(data, "base64"))
    return { saved: true }
  }

  private async copyScreenshot(tab: BrowserTab, params: Record<string, unknown>): Promise<{ copied: true }> {
    const data = await this.screenshot(tab, params)
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(data, "base64")))
    return { copied: true }
  }

  private async printPage(tab: BrowserTab): Promise<{ printed: boolean }> {
    if (tab.context?.actor === "agent") throw browserError("action_denied")
    return { printed: await new Promise<boolean>((resolve) => {
      tab.view.webContents.print({}, (success) => resolve(success))
    }) }
  }

  private async pageContent(tab: BrowserTab, params: Record<string, unknown>): Promise<{ url: string; title: string; text: string; html?: string }> {
    const includeHtml = params.format === "html"
    const result = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
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
    const nodes = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
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
    return tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
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
    await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
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
      await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `document.getElementById("__lume_element_probe")?.remove()` }], true).catch(() => undefined)
    }
  }

  private async evaluateReadonly(tab: BrowserTab, params: Record<string, unknown>): Promise<unknown> {
    const script = String(params.script ?? params.expression ?? "")
    if (!script || script.length > 100_000) throw browserError("invalid_browser_request")
    const expression = `(${script})(${JSON.stringify(params.arg ?? null)})`
    const result = await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      throwOnSideEffect: true,
      timeout: boundedNumber(params.timeoutMs ?? params.timeout_ms, 1, 10_000) || 3_000,
    })) as { result?: { value?: unknown }; exceptionDetails?: unknown }
    if (result.exceptionDetails) throw browserError("action_denied")
    return result.result?.value
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

  private async selectPageAnchor(tab: BrowserTab, requestedMode: string): Promise<{
    anchor: {
      kind: "element" | "text" | "region"
      url: string
      generation: number
      framePath: string[]
      domPath?: string
      textQuote?: { exact: string; prefix?: string; suffix?: string }
      rect: { x: number; y: number; width: number; height: number }
    }
    originalStyles: Record<string, string>
  }> {
    const mode = requestedMode === "text" || requestedMode === "region" ? requestedMode : "element"
    const generation = tab.generation
    const selected = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
      code: `(${pageSelectionScript()})(${JSON.stringify(mode)})`,
    }], true) as {
      kind?: unknown
      domPath?: unknown
      textQuote?: unknown
      rect?: unknown
      originalStyles?: unknown
    }
    if (generation !== tab.generation) throw browserError("stale_target")
    const rect = isRecord(selected.rect) ? {
      x: finiteNumber(selected.rect.x),
      y: finiteNumber(selected.rect.y),
      width: Math.max(0, finiteNumber(selected.rect.width)),
      height: Math.max(0, finiteNumber(selected.rect.height)),
    } : { x: 0, y: 0, width: 0, height: 0 }
    const textQuote = isRecord(selected.textQuote) && typeof selected.textQuote.exact === "string"
      ? {
          exact: selected.textQuote.exact.slice(0, 32_000),
          ...(typeof selected.textQuote.prefix === "string" ? { prefix: selected.textQuote.prefix.slice(0, 1000) } : {}),
          ...(typeof selected.textQuote.suffix === "string" ? { suffix: selected.textQuote.suffix.slice(0, 1000) } : {}),
        }
      : undefined
    const originalStyles = isRecord(selected.originalStyles)
      ? Object.fromEntries(Object.entries(selected.originalStyles).filter(([key, value]) => TWEAK_STYLE_KEYS.has(key) && typeof value === "string").map(([key, value]) => [key, String(value).slice(0, 4096)]))
      : {}
    return {
      anchor: {
        kind: selected.kind === "text" || selected.kind === "region" ? selected.kind : "element",
        url: tab.url,
        generation,
        framePath: [],
        ...(typeof selected.domPath === "string" ? { domPath: selected.domPath.slice(0, 8192) } : {}),
        ...(textQuote ? { textQuote } : {}),
        rect,
      },
      originalStyles,
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
    const applied = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
      code: `(${applyPageTweaksScript()})(${JSON.stringify(domPath)}, ${JSON.stringify(styles)})`,
    }], true) as unknown
    if (!isRecord(applied)) throw browserError("stale_target")
    return { applied: Object.fromEntries(Object.entries(applied).filter((entry): entry is [string, string] => typeof entry[1] === "string")) }
  }

  private async resetPageTweaks(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<{ ok: true }> {
    if (context.actor !== "user") throw browserError("action_denied")
    const domPath = String(params.domPath ?? "").slice(0, 8192)
    if (!domPath) throw browserError("invalid_browser_request")
    await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{
      code: `(${resetPageTweaksScript()})(${JSON.stringify(domPath)})`,
    }], true)
    return { ok: true }
  }

  private composeReviewOverlay(tab: BrowserTab, params: Record<string, unknown>, context: BrowserRequestContext): Promise<BrowserReviewOverlayResult> {
    if (context.actor !== "user" || !this.options.overlayPreloadPath) throw browserError("unsupported")
    const kind = params.kind === "tweaks" ? "tweaks" : "annotation"
    const anchor = isRecord(params.anchor) ? params.anchor : undefined
    const rectValue = anchor && isRecord(anchor.rect) ? anchor.rect : undefined
    if (!anchor
      || anchor.url !== tab.url
      || anchor.generation !== tab.generation
      || !rectValue) throw browserError("stale_target")
    const parent = this.options.getWindow()
    if (!parent || parent.isDestroyed()) throw browserError("browser_unavailable")
    for (const overlay of this.reviewOverlays.values()) {
      if (overlay.tabId === tab.tabId && !overlay.window.isDestroyed()) overlay.window.close()
    }
    const initialBody = typeof params.body === "string" ? params.body.slice(0, 32_000) : ""
    const initialStyles = sanitizeTweakStyles(params.styles)
    const width = kind === "annotation" ? 390 : 520
    const height = kind === "annotation" ? 230 : 570
    const parentBounds = parent.getContentBounds()
    const viewBounds = tab.view.getBounds()
    const zoomFactor = tab.view.webContents.getZoomFactor()
    const desiredX = parentBounds.x + viewBounds.x + Math.round(finiteNumber(rectValue.x) * zoomFactor)
    const desiredY = parentBounds.y + viewBounds.y + Math.round((finiteNumber(rectValue.y) + finiteNumber(rectValue.height)) * zoomFactor) + 8
    const display = screen.getDisplayNearestPoint({ x: desiredX, y: desiredY })
    const x = Math.max(display.workArea.x, Math.min(desiredX, display.workArea.x + display.workArea.width - width))
    const y = Math.max(display.workArea.y, Math.min(desiredY, display.workArea.y + display.workArea.height - height))
    const overlayWindow = new BrowserWindow({
      parent,
      frame: false,
      show: false,
      skipTaskbar: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      width,
      height,
      x,
      y,
      backgroundColor: "#111113",
      webPreferences: {
        preload: this.options.overlayPreloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: false,
      },
    })
    overlayWindow.setMenuBarVisibility(false)
    overlayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    return new Promise((resolveOverlay) => {
      const overlay: BrowserReviewOverlay = {
        window: overlayWindow,
        tabId: tab.tabId,
        generation: tab.generation,
        kind,
        ...(typeof anchor.domPath === "string" ? { domPath: anchor.domPath.slice(0, 8192) } : {}),
        body: initialBody,
        styles: initialStyles,
        settled: false,
        resolve: resolveOverlay,
      }
      this.reviewOverlays.set(overlayWindow.webContents.id, overlay)
      const overlayWebContentsId = overlayWindow.webContents.id
      overlayWindow.once("closed", () => {
        this.reviewOverlays.delete(overlayWebContentsId)
        if (!overlay.settled) {
          overlay.settled = true
          overlay.resolve({ status: "cancel" })
        }
      })
      overlayWindow.once("ready-to-show", () => overlayWindow.show())
      void overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(browserReviewOverlayHtml(kind, initialBody, initialStyles))}`)
        .catch(() => overlayWindow.close())
    })
  }

  private closeReviewOverlaysForTab(tabId: string): void {
    for (const overlay of this.reviewOverlays.values()) {
      if (overlay.tabId === tabId && !overlay.window.isDestroyed()) overlay.window.close()
    }
  }

  private handleBrowserOverlayMessage(overlay: BrowserReviewOverlay, payload: unknown): void {
    if (!isRecord(payload) || overlay.settled) return
    const tab = this.tabs.get(overlay.tabId)
    if (!tab || tab.generation !== overlay.generation) {
      overlay.window.close()
      return
    }
    if (payload.type === "draft" && overlay.kind === "annotation" && typeof payload.body === "string") {
      overlay.body = payload.body.slice(0, 32_000)
      return
    }
    if ((payload.type === "preview" || payload.type === "submit") && overlay.kind === "tweaks") {
      overlay.styles = sanitizeTweakStyles(payload.styles)
      if (payload.type === "preview" && overlay.domPath && Object.keys(overlay.styles).length) {
        void this.applyPageTweaks(tab, { domPath: overlay.domPath, styles: overlay.styles }, userContext()).catch(() => undefined)
        return
      }
    }
    if (payload.type === "reset" && overlay.kind === "tweaks" && overlay.domPath) {
      overlay.styles = {}
      void this.resetPageTweaks(tab, { domPath: overlay.domPath }, userContext()).catch(() => undefined)
      return
    }
    if (payload.type === "cancel") {
      overlay.window.close()
      return
    }
    if (payload.type !== "submit") return
    if (overlay.kind === "annotation") {
      const body = typeof payload.body === "string" ? payload.body.trim().slice(0, 32_000) : overlay.body.trim()
      if (!body) return
      overlay.settled = true
      overlay.resolve({ status: "submit", body })
    } else {
      if (!Object.keys(overlay.styles).length) return
      overlay.settled = true
      overlay.resolve({ status: "submit", styles: overlay.styles })
    }
    overlay.window.close()
  }

  private async emulateDevice(tab: BrowserTab, preset: string, params: Record<string, unknown> = {}): Promise<{ preset: string; viewport: BrowserViewportState }> {
    const devices: Record<string, { width: number; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean }> = {
      desktop: { width: 0, height: 0, deviceScaleFactor: 1, mobile: false, touch: false },
      phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
      tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
      "phone-landscape": { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, touch: true },
      "tablet-landscape": { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true, touch: true },
    }
    const device = preset === "custom"
      ? {
          width: boundedNumber(params.width, 200, 4000),
          height: boundedNumber(params.height, 200, 4000),
          deviceScaleFactor: Math.max(0.5, Math.min(4, Number(params.deviceScaleFactor) || 1)),
          mobile: params.mobile === true,
          touch: params.touch === true,
        }
      : devices[preset]
    if (!device) throw browserError("invalid_browser_request")
    const viewport: BrowserViewportState = {
      enabled: preset !== "desktop",
      width: device.width,
      height: device.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.mobile,
      touch: device.touch,
    }
    await withDebugger(tab.view.webContents, async (debuggerRef) => {
      if (preset === "desktop") await debuggerRef.sendCommand("Emulation.clearDeviceMetricsOverride")
      else await debuggerRef.sendCommand("Emulation.setDeviceMetricsOverride", { ...device, screenWidth: device.width, screenHeight: device.height })
      await debuggerRef.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1 })
    })
    tab.viewport = viewport
    this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    return { preset, viewport }
  }

  private setViewport(tab: BrowserTab, params: Record<string, unknown>): Promise<{ viewport: BrowserViewportState }> {
    return this.emulateDevice(tab, "custom", params).then(({ viewport }) => ({ viewport }))
  }

  private resetViewport(tab: BrowserTab): Promise<{ viewport: BrowserViewportState }> {
    return this.emulateDevice(tab, "desktop").then(({ viewport }) => ({ viewport }))
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
    const result = await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand(method, commandParams))
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
    tab.view.setBounds(bounds)
    tab.surface = params.surface === "main" || params.surface === "right-panel" ? params.surface : null
    tab.visible = params.visible !== false
    tab.lifecycle = tab.visible ? "active" : "background"
    if (tab.visible) tab.lastOpenedAt = new Date().toISOString()
    tab.view.setVisible(tab.visible)
    if (tab.visible) void this.setTabSuspended(tab, false)
    this.enforceBackgroundLimit()
    return publicTab(tab)
  }

  private setVisible(tabId: string, visible: boolean): BrowserTabDescriptor {
    const tab = this.requireTab(tabId, userContext())
    tab.visible = visible
    tab.lifecycle = visible ? "active" : tab.lifecycle === "crashed" ? "crashed" : "background"
    if (visible) tab.lastOpenedAt = new Date().toISOString()
    tab.view.setVisible(visible)
    if (visible) void this.setTabSuspended(tab, false)
    if (!visible) this.hideAgentCursor()
    this.enforceBackgroundLimit()
    return publicTab(tab)
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
    if (tab.view.webContents.isDestroyed() || tab.lifecycle === "crashed") return
    if (suspended && tab.lifecycle === "suspended") return
    if (!suspended && tab.lifecycle !== "suspended") return
    tab.lifecycle = suspended ? "suspended" : tab.visible ? "active" : "background"
    tab.view.webContents.setBackgroundThrottling(suspended || !tab.visible)
    try {
      await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Page.setWebLifecycleState", { state: suspended ? "frozen" : "active" }))
    } catch { /* Chromium may reject lifecycle control for a tab that is still loading. */ }
    this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
  }

  private focus(tabId: string): BrowserTabDescriptor {
    const tab = this.requireTab(tabId, userContext())
    tab.lastOpenedAt = new Date().toISOString()
    tab.lifecycle = "active"
    void this.setTabSuspended(tab, false)
    tab.view.webContents.focus()
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

  private unshareTab(tabId: string, context: BrowserRequestContext): BrowserTabDescriptor {
    if (context.actor !== "user") throw browserError("action_denied")
    const tab = this.requireTab(tabId, context)
    tab.shareable = false
    revokeSharedLease(tab)
    tab.generation += 1
    tab.inputSequence += 1
    this.hideAgentCursor()
    this.options.emit({ method: "browser:lease-revoked", params: { tabId, generation: tab.generation } })
    return publicTab(tab)
  }

  private claimTab(tabId: string, context: BrowserRequestContext): BrowserTabDescriptor {
    if (context.actor !== "agent") throw browserError("action_denied")
    const tab = this.tabs.get(tabId)
    const snapshotKey = claimSnapshotKey(context, tabId)
    const snapshot = this.claimSnapshots.get(snapshotKey)
    if (!tab || !snapshot
      || snapshot.providerTabId !== tab.providerTabId
      || snapshot.title !== tab.title
      || snapshot.url !== tab.url
      || snapshot.generation !== tab.generation) {
      this.claimSnapshots.delete(snapshotKey)
      throw browserError("tab_generation_changed")
    }
    if (!tab || !canAgentClaim(tab, context.browserSessionId, context.browserTurnId)) throw browserError("action_denied")
    this.claimSnapshots.delete(snapshotKey)
    tab.agentLease = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: tab.generation }
    void this.setTabSuspended(tab, false)
    this.options.emit({ method: "browser:tab-share-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    return publicTab(tab)
  }

  private closeTab(tabId: string, context: BrowserRequestContext): { ok: true } {
    const tab = this.requireTab(tabId, context)
    this.closeReviewOverlaysForTab(tabId)
    this.clearTabWaiters(tabId)
    for (const [inventoryId, inventory] of this.pageAssetInventories) {
      if (inventory.tabId === tabId) this.pageAssetInventories.delete(inventoryId)
    }
    const win = this.options.getWindow()
    if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(tabId)
    this.disposeOwnedSessionIfUnused(tab.partition, tab.view.webContents.session)
    this.enforceBackgroundLimit()
    return { ok: true }
  }

  private releaseTabs(context: BrowserRequestContext, params: Record<string, unknown>): { ok: true } {
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds.filter((value): value is string => typeof value === "string") : []
    for (const tabId of tabIds) {
      const tab = this.requireTab(tabId, context)
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
    for (const [id, chooser] of this.fileChoosers) if (chooser.tabId === tabId) this.fileChoosers.delete(id)
  }

  private handoffTabs(context: BrowserRequestContext, params: Record<string, unknown>): { ok: true } {
    const tabIds = Array.isArray(params.tabIds) ? params.tabIds.filter((value): value is string => typeof value === "string") : []
    for (const tabId of tabIds) {
      const tab = this.requireTab(tabId, context)
      tab.handoff = { browserSessionId: context.browserSessionId, status: "handoff" }
      this.releaseTabs(context, { tabIds: [tabId] })
    }
    return { ok: true }
  }

  private resumeHandoffTabs(context: BrowserRequestContext): BrowserTabDescriptor[] {
    if (context.actor !== "agent") throw browserError("action_denied")
    const resumed: BrowserTabDescriptor[] = []
    for (const tab of this.tabs.values()) {
      if (tab.handoff?.browserSessionId !== context.browserSessionId || tab.handoff.status !== "handoff") continue
      tab.context = context
      tab.agentLease = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: tab.generation }
      tab.handoff = undefined
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
      const retained = keep.get(tab.tabId)
      if (!retained) { this.closeTab(tab.tabId, context); continue }
      tab.handoff = { browserSessionId: context.browserSessionId, ...retained }
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
    const win = this.options.getWindow()
    if (!win || win.isDestroyed()) throw browserError("confirmation_unavailable")
    const category = String(params.category ?? "action").replace(/[^a-zA-Z_-]/g, "").slice(0, 32)
    const preview = String(params.preview ?? "执行受保护的浏览器动作").replace(/[\r\n\t]+/g, " ").slice(0, 300)
    const result = await dialog.showMessageBox(win, { type: "warning", buttons: ["允许一次", "取消"], defaultId: 1, cancelId: 1, title: "确认浏览器操作", message: preview, detail: `类别：${category}。批准仅对当前标签页的这一次操作有效。` })
    if (result.response !== 0) return { approved: false }
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
    const browserSession = this.tabs.values().next().value?.view.webContents.session ?? session.fromPartition("persist:lume-browser")
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
    view: _view,
    partition: _partition,
    context: _context,
    inputSequence: _inputSequence,
    agentLease,
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
    dialogOpen: _dialogOpen,
    dialogInfo: _dialogInfo,
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

function browserError(code: BrowserErrorCode): Error & { code: BrowserErrorCode } {
  const error = new Error(code) as Error & { code: BrowserErrorCode }
  error.code = code
  return error
}

function stableBrowserErrorCode(error: unknown): BrowserErrorCode {
  const code = (error as { code?: unknown })?.code
  return typeof code === "string" && BROWSER_ERROR_CODES.has(code as BrowserErrorCode) ? code as BrowserErrorCode : "browser_internal_error"
}

const BROWSER_ERROR_CODES = new Set<BrowserErrorCode>([
  "incompatible_protocol", "browser_unavailable", "invalid_browser_request", "invalid_url", "private_origin_confirmation_required", "stale_target", "tab_not_found", "tab_generation_changed", "confirmation_unavailable", "action_denied", "unsupported", "executed_unknown", "browser_internal_error",
  "strict_locator_violation", "actionability_failed", "dialog_blocking",
])

function safeOrigin(value: string): string | undefined {
  try { return new URL(value).origin } catch { return undefined }
}

function normalizeBrowserMethod(method: string): string {
  return ({ goto: "navigate", dblclick: "doubleClick", selectOption: "select", setChecked: "check" } as Record<string, string>)[method] ?? method
}

async function listWebMcpTools(tab: BrowserTab): Promise<{ tools: Array<Record<string, unknown>> }> {
  const generation = tab.generation
  const value = await tab.view.webContents.executeJavaScript(`(async () => {
    const modelContext = document.modelContext ?? navigator.modelContext;
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

async function invokeWebMcpTool(tab: BrowserTab, params: Record<string, unknown>): Promise<{ result: unknown }> {
  const toolName = String(params.toolName ?? params.tool_name ?? "").trim()
  if (!toolName || toolName.length > 256) throw browserError("invalid_browser_request")
  const encodedInput = JSON.stringify(params.input ?? null)
  if (encodedInput.length > 256_000) throw browserError("invalid_browser_request")
  const timeoutValue = params.timeoutMs ?? params.timeout_ms
  const timeoutMs = timeoutValue === undefined ? 10_000 : boundedNumber(timeoutValue, 1, 30_000)
  const generation = tab.generation
  const script = `(() => {
    const modelContext = document.modelContext ?? navigator.modelContext;
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
  const value = await browserPromiseTimeout(tab.view.webContents.executeJavaScript(script, true), timeoutMs)
  if (generation !== tab.generation) throw browserError("stale_target")
  const encodedResult = JSON.stringify(value)
  if (encodedResult && encodedResult.length > 1_000_000) throw browserError("browser_internal_error")
  return { result: value ?? null }
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
  const documentation: Record<string, string> = {
    advancedCdp: "Use CDP only for approved inspection in an isolated browser session.",
    browserAuth: "Request saved credentials without returning sensitive values to the Agent.",
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
    const timeoutMs = boundedNumber(parsed.timeoutMs, 1, 10_000) || 3_000
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
  if (host === "localhost" || host.endsWith(".local") || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true
  const octets = host.split(".").map(Number)
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  return octets[0] === 10 || octets[0] === 127 || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
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
function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, typeof value === "string" ? "[redacted]" : typeof value === "object" ? "[object]" : value]))
}

async function withDebugger<T>(contents: Electron.WebContents, work: (debuggerRef: Electron.Debugger) => Promise<T>): Promise<T> {
  const debuggerRef = contents.debugger
  const attached = debuggerRef.isAttached()
  if (!attached) debuggerRef.attach("1.3")
  try { return await work(debuggerRef) } finally { if (!attached && debuggerRef.isAttached()) debuggerRef.detach() }
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
  "padding",
  "margin",
])

function sanitizeTweakStyles(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => TWEAK_STYLE_KEYS.has(key) && typeof item === "string")
    .map(([key, item]) => [key, String(item).slice(0, 4096)]))
}

function browserReviewOverlayHtml(kind: "annotation" | "tweaks", initialBody: string, initialStyles: Record<string, string>): string {
  const tweakFields = [
    ["textContent", "文本"], ["color", "前景色"], ["backgroundColor", "背景色"], ["borderColor", "边框色"],
    ["fontFamily", "字体"], ["fontSize", "字号"], ["fontWeight", "字重"], ["borderRadius", "圆角"],
    ["borderWidth", "边框宽度"], ["borderStyle", "边框样式"], ["width", "宽度"], ["height", "高度"],
    ["display", "Display"], ["flexDirection", "Flex 方向"], ["justifyContent", "主轴分布"], ["alignItems", "交叉轴"],
    ["gap", "Gap"], ["padding", "Padding"], ["margin", "Margin"],
  ]
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
  :root{color-scheme:light dark;font:12px system-ui,-apple-system,"Segoe UI",sans-serif}
  *{box-sizing:border-box}html,body{height:100%;margin:0;overflow:hidden;background:#151517;color:#f4f4f5}
  body{display:flex;flex-direction:column;border:1px solid #3f3f46;border-radius:10px}
  header{height:38px;display:flex;align-items:center;padding:0 12px;border-bottom:1px solid #343438;font-weight:600;-webkit-app-region:drag}
  main{min-height:0;flex:1;padding:10px;overflow:auto}
  textarea,input{width:100%;border:1px solid #3f3f46;border-radius:6px;background:#202024;color:#fafafa;padding:7px;outline:none}
  textarea{height:112px;resize:none;line-height:1.45}textarea:focus,input:focus{border-color:#5b8cff}
  footer{display:flex;justify-content:flex-end;gap:7px;padding:9px 10px;border-top:1px solid #343438}
  button{border:1px solid #45454b;border-radius:6px;background:#252529;color:#fafafa;padding:6px 11px;cursor:pointer;-webkit-app-region:no-drag}
  button.primary{background:#2563eb;border-color:#2563eb}button:hover{filter:brightness(1.1)}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.field{display:grid;gap:3px;color:#a1a1aa;font-size:10px}
  @media(prefers-color-scheme:light){html,body{background:#fff;color:#18181b}body{border-color:#d4d4d8}header,footer{border-color:#e4e4e7}textarea,input{background:#fafafa;color:#18181b;border-color:#d4d4d8}button{background:#f4f4f5;color:#18181b;border-color:#d4d4d8}}
</style></head><body>
<header>${kind === "annotation" ? "添加网页批注" : "Design Tweaks"}</header>
<main>${kind === "annotation"
    ? '<textarea id="body" maxlength="32000" placeholder="写下要让 Agent 处理的网页审阅意见…"></textarea>'
    : '<div id="fields" class="grid"></div>'}</main>
<footer>${kind === "tweaks" ? '<button id="reset">全部重置</button>' : ""}<button id="cancel">取消</button><button id="submit" class="primary">${kind === "annotation" ? "添加到聊天" : "添加到聊天"}</button></footer>
<script>
  const bridge = globalThis.lumeBrowserOverlay;
  const kind = ${JSON.stringify(kind)};
  const initialBody = ${JSON.stringify(initialBody)};
  const initialStyles = ${JSON.stringify(initialStyles)};
  const fields = ${JSON.stringify(tweakFields)};
  const readStyles = () => Object.fromEntries(Array.from(document.querySelectorAll("[data-style-key]")).flatMap(input => input.value ? [[input.dataset.styleKey, input.value]] : []));
  if (kind === "annotation") {
    const body = document.getElementById("body");
    body.value = initialBody;
    body.focus();
    body.addEventListener("input", () => bridge.emit({ type: "draft", body: body.value }));
  } else {
    const root = document.getElementById("fields");
    for (const [key, label] of fields) {
      const wrapper = document.createElement("label"); wrapper.className = "field"; wrapper.textContent = label;
      const input = document.createElement("input"); input.dataset.styleKey = key; input.value = initialStyles[key] || "";
      input.addEventListener("input", () => bridge.emit({ type: "preview", styles: readStyles() }));
      wrapper.append(input); root.append(wrapper);
    }
    root.querySelector("input")?.focus();
    document.getElementById("reset").addEventListener("click", () => {
      for (const input of root.querySelectorAll("input")) input.value = "";
      bridge.emit({ type: "reset" });
    });
  }
  document.getElementById("cancel").addEventListener("click", () => bridge.emit({ type: "cancel" }));
  document.getElementById("submit").addEventListener("click", () => bridge.emit(kind === "annotation"
    ? { type: "submit", body: document.getElementById("body").value }
    : { type: "submit", styles: readStyles() }));
  addEventListener("keydown", event => { if (event.key === "Escape") bridge.emit({ type: "cancel" }); if ((event.ctrlKey || event.metaKey) && event.key === "Enter") document.getElementById("submit").click(); });
</script></body></html>`
}

function pageSelectionScript(): string {
  return `function(mode) {
    return new Promise((resolve, reject) => {
      globalThis.__lumeCancelPageSelection?.();
      const cleanupTasks = [];
      const on = (target, type, handler, options) => {
        target.addEventListener(type, handler, options);
        cleanupTasks.push(() => target.removeEventListener(type, handler, options));
      };
      const overlay = document.createElement("div");
      overlay.setAttribute("data-lume-browser-selection", "");
      Object.assign(overlay.style, {
        position: "fixed", zIndex: "2147483647", pointerEvents: "none",
        border: "2px solid #2f7cf6", background: "rgba(47,124,246,.12)",
        borderRadius: "3px", boxSizing: "border-box", display: "none"
      });
      document.documentElement.appendChild(overlay);
      const hint = document.createElement("div");
      hint.textContent = mode === "text" ? "选择文本后松开鼠标 · Esc 取消" : mode === "region" ? "拖动选择区域 · Esc 取消" : "点击选择元素 · Esc 取消";
      Object.assign(hint.style, {
        position: "fixed", left: "50%", top: "12px", transform: "translateX(-50%)",
        zIndex: "2147483647", padding: "7px 10px", borderRadius: "8px",
        color: "#fff", background: "rgba(20,20,22,.92)", font: "12px system-ui",
        boxShadow: "0 6px 20px rgba(0,0,0,.24)", pointerEvents: "none"
      });
      document.documentElement.appendChild(hint);
      const cleanup = () => {
        cleanupTasks.splice(0).forEach((task) => task());
        overlay.remove();
        hint.remove();
        delete globalThis.__lumeCancelPageSelection;
      };
      globalThis.__lumeCancelPageSelection = () => {
        cleanup();
        reject(new Error("selection_cancelled"));
      };
      const pathFor = (element) => {
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && parts.length < 32) {
          const tag = current.tagName.toLowerCase();
          if (tag === "html") { parts.unshift("html"); break; }
          const parent = current.parentElement;
          if (!parent) break;
          const siblings = Array.from(parent.children).filter((item) => item.tagName === current.tagName);
          const suffix = siblings.length > 1 ? ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")" : "";
          parts.unshift(tag + suffix);
          current = parent;
        }
        return parts.join(" > ");
      };
      const stylesFor = (element) => {
        const style = getComputedStyle(element);
        return {
          textContent: element.textContent || "",
          color: style.color, backgroundColor: style.backgroundColor, borderColor: style.borderColor,
          fontFamily: style.fontFamily, fontSize: style.fontSize, fontWeight: style.fontWeight,
          borderRadius: style.borderRadius, borderWidth: style.borderWidth, borderStyle: style.borderStyle,
          width: style.width, height: style.height, display: style.display, flexDirection: style.flexDirection,
          justifyContent: style.justifyContent, alignItems: style.alignItems, gap: style.gap,
          padding: style.padding, margin: style.margin
        };
      };
      const finish = (kind, rect, element, textQuote) => {
        const result = {
          kind,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          domPath: element ? pathFor(element) : undefined,
          textQuote,
          originalStyles: element ? stylesFor(element) : {}
        };
        cleanup();
        resolve(result);
      };
      on(window, "keydown", (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        globalThis.__lumeCancelPageSelection?.();
      }, true);
      if (mode === "element") {
        on(document, "mousemove", (event) => {
          const element = document.elementFromPoint(event.clientX, event.clientY);
          if (!(element instanceof Element) || element === overlay || element === hint) return;
          const rect = element.getBoundingClientRect();
          Object.assign(overlay.style, { display: "block", left: rect.x + "px", top: rect.y + "px", width: rect.width + "px", height: rect.height + "px" });
        }, true);
        on(document, "click", (event) => {
          const element = document.elementFromPoint(event.clientX, event.clientY);
          if (!(element instanceof Element) || element === overlay || element === hint) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          finish("element", element.getBoundingClientRect(), element);
        }, true);
        return;
      }
      if (mode === "text") {
        on(document, "mouseup", () => {
          const selection = getSelection();
          if (!selection || selection.isCollapsed || !selection.rangeCount) return;
          const range = selection.getRangeAt(0);
          const rect = range.getBoundingClientRect();
          const element = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
          const exact = selection.toString().slice(0, 32000);
          if (!element || !exact) return;
          const source = element.textContent || "";
          const index = source.indexOf(exact);
          finish("text", rect, element, {
            exact,
            prefix: index >= 0 ? source.slice(Math.max(0, index - 1000), index) : undefined,
            suffix: index >= 0 ? source.slice(index + exact.length, index + exact.length + 1000) : undefined
          });
        }, true);
        return;
      }
      overlay.style.pointerEvents = "auto";
      overlay.style.display = "block";
      overlay.style.inset = "0";
      overlay.style.border = "0";
      overlay.style.background = "rgba(47,124,246,.04)";
      let start = null;
      on(overlay, "mousedown", (event) => {
        start = { x: event.clientX, y: event.clientY };
        event.preventDefault();
      }, true);
      on(window, "mousemove", (event) => {
        if (!start) return;
        const x = Math.min(start.x, event.clientX);
        const y = Math.min(start.y, event.clientY);
        Object.assign(overlay.style, {
          inset: "auto", left: x + "px", top: y + "px",
          width: Math.abs(event.clientX - start.x) + "px", height: Math.abs(event.clientY - start.y) + "px",
          border: "2px solid #2f7cf6", background: "rgba(47,124,246,.12)"
        });
      }, true);
      on(window, "mouseup", (event) => {
        if (!start) return;
        const rect = {
          x: Math.min(start.x, event.clientX), y: Math.min(start.y, event.clientY),
          width: Math.abs(event.clientX - start.x), height: Math.abs(event.clientY - start.y)
        };
        if (rect.width < 4 || rect.height < 4) return;
        finish("region", rect);
      }, true);
    });
  }`
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
