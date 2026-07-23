import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app, BrowserWindow, WebContentsView, dialog, session, shell } from "electron"
import {
  BROWSER_PROTOCOL_MAX_SUPPORTED,
  BROWSER_PROTOCOL_MIN_SUPPORTED,
  BROWSER_PROTOCOL_VERSION,
  DEFAULT_BROWSER_SETTINGS,
  type BrowserActionRequest,
  type BrowserErrorCode,
  type BrowserRequestContext,
  type BrowserRuntimeDescriptor,
  type BrowserSettings,
  type BrowserTabDescriptor,
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
  authorizeCredentialUse?: () => Promise<boolean>
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

const MUTATING_METHODS = new Set(["navigate", "back", "forward", "reload", "click", "doubleClick", "hover", "fill", "type", "typeActive", "press", "pressActive", "select", "check", "uncheck", "scroll", "drag", "browserAuth", "contactFill", "dialog:handle", "upload"])
const CDP_ALLOWLIST = new Set(["DOMSnapshot.captureSnapshot", "DOM.getDocument", "DOM.querySelector", "DOM.getBoxModel", "Accessibility.getFullAXTree", "CSS.getComputedStyleForNode", "Page.captureScreenshot", "Page.navigate", "Input.dispatchMouseEvent", "Input.insertText", "Input.dispatchKeyEvent"])

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
  private readonly credentials: BrowserCredentialVault
  private agentPluginEnabled = false
  private cursorOverlay: BrowserWindow | null = null
  private cursorState: { x: number; y: number; pulse: boolean } | null = null
  private readonly popupTokens = new Map<string, { sourceTabId: string; url: string; expiresAt: number }>()
  private readonly policyTokens = new Map<string, { bindingHash: string; expiresAt: number }>()
  private readonly downloadRefs = new Map<string, { path: string; browserSessionId: string; browserTurnId: string }>()
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
    this.credentials = new BrowserCredentialVault(options.configDir, options.credentialStorage)
    app.on("login", this.loginHandler)
    app.on("certificate-error", this.certificateErrorHandler)
    app.on("select-client-certificate", this.clientCertificateHandler)
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
    ]
    if (this.settings.advancedCdpEnabled) capabilities.push({ id: "advancedCdp", description: "Use the isolated, method-allowlisted CDP session." })
    if (this.options.credentialStorage.isEncryptionAvailable() && this.options.authorizeCredentialUse) capabilities.push({ id: "browserAuth", description: "Fill a saved credential in the current IAB origin after fresh system verification without returning its value." })
    return {
      id: "lume-iab",
      backend: "iab",
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      minSupported: BROWSER_PROTOCOL_MIN_SUPPORTED,
      maxSupported: BROWSER_PROTOCOL_MAX_SUPPORTED,
      capabilityHash: capabilityHash(capabilities.map((item) => item.id)),
      generation: this.backendGeneration,
      capabilities,
    }
  }

  getSettings(): BrowserSettings { return { ...this.settings } }

  updateSettings(input: Partial<BrowserSettings>): BrowserSettings {
    const previous = JSON.stringify(this.settings)
    const advancedCdpWasEnabled = this.settings.advancedCdpEnabled
    this.settings = {
      ...this.settings,
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
    if (context.actor === "agent" && (!this.agentPluginEnabled || !this.options.isAgentPluginEnabled?.())) {
      throw browserError("browser_unavailable")
    }
    if (method === "handshake") return this.descriptor()
    if (method === "list") return [...this.tabs.values()].map(publicTab)
    if (method === "openTabs") return [...this.tabs.values()].filter((tab) => tab.partition === "persist:lume-browser").map((tab) => ({ id: tab.tabId, tabId: tab.tabId, url: tab.url, title: tab.title }))
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
    if (method === "clear-data") return this.clearData(context, params)

    const tab = this.requireTab(String(params.tabId ?? context.tabId ?? ""), context)
    if (tab.dialogOpen && method !== "dialog:handle" && method !== "dialog:get") throw browserError("dialog_blocking")
    if ((method === "browserAuth" || method === "contactFill" || method === "upload") && params.__policyRequired !== true) throw browserError("confirmation_unavailable")
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
    if (method === "dialog:get") return tab.dialogInfo
    if (method.startsWith("locator:")) return this.queryLocator(tab, method.slice("locator:".length), params)
    if (method === "wait:url") return this.waitForUrl(tab, String(params.url ?? ""), boundedNumber(params.timeoutMs ?? (params.options as Record<string, unknown> | undefined)?.timeoutMs, 0, 30_000) || 10_000)
    if (method === "wait:load") return this.waitForLoad(tab, boundedNumber(params.timeoutMs, 0, 30_000) || 10_000)
    if (method === "wait:timeout") { await delay(boundedNumber(params.timeoutMs, 0, 30_000)); return undefined }
    if (method === "browserAuth:list") return this.credentials.listPasswords().filter((entry) => entry.origin === safeOrigin(tab.url))
    if (method === "screenshot") return this.screenshot(tab, params)
    if (method === "screenshot:save") return this.saveScreenshot(tab, params)
    if (method === "find") return { requestId: tab.view.webContents.findInPage(String(params.text ?? "").slice(0, 500), { forward: params.forward !== false, findNext: params.findNext === true }) }
    if (method === "find:stop") { tab.view.webContents.stopFindInPage(params.action === "activate" ? "activateSelection" : "clearSelection"); return { ok: true } }
    if (method === "zoom:get") return { factor: tab.view.webContents.getZoomFactor() }
    if (method === "zoom:set") { const factor = Math.max(0.25, Math.min(5, Number(params.factor) || 1)); tab.view.webContents.setZoomFactor(factor); return { factor } }
    if (method === "emulate") return this.emulateDevice(tab, String(params.preset ?? "desktop"))
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
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    this.tabs.clear()
    this.downloadRefs.clear()
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
      backend: "iab",
      generation: 1,
      url: "",
      title: "浏览器",
      visible: false,
      surface: null,
      view,
      partition,
      ...(agentOwned ? { context, agentLease: { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: 1 } } : {}),
      inputSequence: 0,
    }
    this.tabs.set(tabId, tab)
    this.installPolicies(tab, isAgent || advancedCdp, advancedCdp)
    win.contentView.addChildView(view)
    view.setVisible(false)
    const initialUrl = typeof params.url === "string" && params.url.trim() ? params.url : undefined
    if (initialUrl) void this.navigate(tab, initialUrl, context)
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
      tab.url = stripUrl(url)
      tab.generation += 1
      tab.inputSequence += 1
      if (tab.context?.actor === "agent") tab.agentLease = { browserSessionId: tab.context.browserSessionId, browserTurnId: tab.context.browserTurnId, generation: tab.generation }
      else tab.agentLease = undefined
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("did-navigate-in-page", (_event, url) => {
      tab.url = stripUrl(url)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("before-input-event", () => {
      if (!tab.agentDispatching) tab.inputSequence += 1
    })
    wc.on("before-mouse-event", () => {
      if (!tab.agentDispatching) tab.inputSequence += 1
    })
    wc.on("page-title-updated", (_event, title) => {
      tab.title = title.slice(0, 256)
      this.options.emit({ method: "browser:tab-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    })
    wc.on("render-process-gone", () => {
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
      })
    } catch { /* debugger capability remains unavailable for this tab */ }
  }

  private ensureSessionPolicy(browserSession: Electron.Session, partition: string, agent: boolean): void {
    if (this.sessionPolicies.has(browserSession)) return
    const policy: SessionPolicy = { session: browserSession, partition, agent, disposed: false }
    this.sessionPolicies.set(browserSession, policy)
    this.ownedSessionPolicies.add(policy)
    browserSession.setPermissionRequestHandler((contents, permission, callback) => {
      const origin = safeOrigin(contents.getURL())
      const override = origin ? this.settings.siteOverrides[origin] : undefined
      if (policy.agent || override === "deny" || (!override && this.settings.sitePermissionDefault === "deny")) {
        callback(false)
        return
      }
      if (override === "allow") {
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
        message: `${origin ?? "此网站"} 请求使用${permission}权限。`,
      }).then((result) => callback(result.response === 0)).catch(() => callback(false))
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
    if (context.actor === "agent") tab.recentAgentContext = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, expiresAt: Date.now() + 30_000 }
    if (method === "navigate") return this.navigate(tab, String(params.url ?? ""), context, params.__policyRequired === true)
    if (method === "back") return tab.view.webContents.goBack()
    if (method === "forward") return tab.view.webContents.goForward()
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
    if (method === "typeActive") { await this.applyTextToActive(tab, String(params.text ?? "")); return { ok: true } }
    if (method === "pressActive") { await this.dispatchKey(tab, String(params.key ?? "Enter")); return { ok: true } }
    if (["click", "doubleClick", "hover", "scroll", "drag", "fill", "type", "press", "select", "check", "uncheck"].includes(method)) {
      if (context.actor === "agent" && !context.capability) throw browserError("action_denied")
      const generation = tab.generation
      const inputSequence = tab.inputSequence
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
    const credentialId = String(params.credentialId ?? "")
    const exists = this.credentials.listPasswords().some((entry) => entry.id === credentialId && entry.origin === origin)
    if (!exists || !this.options.authorizeCredentialUse || !await this.options.authorizeCredentialUse()) throw browserError("action_denied")
    const secret = this.credentials.passwordForOrigin(credentialId, origin)
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

  private async dispatchMouse(tab: BrowserTab, method: string, params: Record<string, unknown>): Promise<void> {
    const x = boundedNumber(params.x, 0, 100_000)
    const y = boundedNumber(params.y, 0, 100_000)
    this.showAgentCursor(tab, x, y, method === "click" || method === "doubleClick")
    await withDebugger(tab.view.webContents, (debuggerRef) => debuggerRef.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }))
    if (method === "hover") return
    const clickCount = method === "doubleClick" ? 2 : 1
    const activated = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const element = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
      if (!(element instanceof HTMLElement)) return false;
      element.focus({ preventScroll: true });
      for (let index = 0; index < ${clickCount}; index += 1) HTMLElement.prototype.click.call(element);
      if (${clickCount} === 2) {
        const event = document.createEvent("MouseEvent");
        event.initMouseEvent("dblclick", true, true, window, 2, 0, 0, ${JSON.stringify(x)}, ${JSON.stringify(y)}, false, false, false, false, 0, null);
        element.dispatchEvent(event);
      }
      return true;
    })()` }], true)
    if (!activated) throw browserError("stale_target")
  }

  private async dispatchKey(tab: BrowserTab, key: string, modifiers: string[] = []): Promise<void> {
    await withDebugger(tab.view.webContents, async (debuggerRef) => {
      const modifier = modifiers.includes("CTRL") ? 2 : modifiers.includes("META") ? 4 : 0
      await debuggerRef.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key, modifiers: modifier })
      await debuggerRef.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key, modifiers: modifier })
    })
  }

  private async applyText(tab: BrowserTab, target: ResolvedBrowserTarget, text: string, replace: boolean): Promise<void> {
    const applied = await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
      const pointed = document.elementFromPoint(${JSON.stringify(target.x)}, ${JSON.stringify(target.y)});
      const active = document.activeElement;
      const element = pointed instanceof HTMLElement && pointed.tagName.toLowerCase() === ${JSON.stringify(target.tagName)}
        ? pointed
        : active instanceof HTMLElement && active.tagName.toLowerCase() === ${JSON.stringify(target.tagName)} ? active : null;
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (${JSON.stringify(target.x)} < rect.left || ${JSON.stringify(target.x)} > rect.right || ${JSON.stringify(target.y)} < rect.top || ${JSON.stringify(target.y)} > rect.bottom) return false;
      element.focus({ preventScroll: true });
      if (document.activeElement !== element && !element.contains(document.activeElement)) return false;
      if (element instanceof HTMLInputElement) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (!descriptor?.set) return false;
        descriptor.set.call(element, ${replace ? JSON.stringify(text) : `element.value + ${JSON.stringify(text)}`});
      } else if (element instanceof HTMLTextAreaElement) {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
        if (!descriptor?.set) return false;
        descriptor.set.call(element, ${replace ? JSON.stringify(text) : `element.value + ${JSON.stringify(text)}`});
      } else if (element.isContentEditable) {
        element.textContent = ${replace ? JSON.stringify(text) : `element.textContent + ${JSON.stringify(text)}`};
      } else return false;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()` }], true)
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
    const allowed = new Set<BrowserLocatorQuery>(["count", "allTextContents", "readAll", "getAttribute", "innerText", "textContent", "inputValue", "isVisible", "isEnabled", "isChecked"])
    if (!allowed.has(operation as BrowserLocatorQuery)) {
      if (operation === "waitFor") return this.waitForLocator(tab, params)
      throw browserError("unsupported")
    }
    if (operation === "getAttribute" && (typeof params.name !== "string" || params.name.length > 256)) throw browserError("invalid_browser_request")
    return this.executeLocatorQuery(tab, params, operation as BrowserLocatorQuery, typeof params.name === "string" ? params.name : undefined)
  }

  private async executeLocatorQuery(tab: BrowserTab, params: Record<string, unknown>, operation: BrowserLocatorQuery, argument?: string): Promise<unknown> {
    if (!isBrowserLocator(params.locator)) throw browserError("invalid_browser_request")
    try {
      validateBrowserLocator(params.locator)
      return await tab.view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: `(${browserLocatorScript()})(${JSON.stringify(params.locator)},${JSON.stringify(operation)},${JSON.stringify(argument)})` }], true)
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      const code = ["stale_target", "strict_locator_violation", "action_denied"].find((value) => message.includes(value)) ?? "stale_target"
      throw browserError(code as BrowserErrorCode)
    }
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

  private async emulateDevice(tab: BrowserTab, preset: string): Promise<{ preset: string }> {
    const devices: Record<string, { width: number; height: number; deviceScaleFactor: number; mobile: boolean; touch: boolean }> = {
      desktop: { width: 0, height: 0, deviceScaleFactor: 1, mobile: false, touch: false },
      phone: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, touch: true },
      tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true },
      "phone-landscape": { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, touch: true },
      "tablet-landscape": { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true, touch: true },
    }
    const device = devices[preset]
    if (!device) throw browserError("invalid_browser_request")
    await withDebugger(tab.view.webContents, async (debuggerRef) => {
      if (preset === "desktop") await debuggerRef.sendCommand("Emulation.clearDeviceMetricsOverride")
      else await debuggerRef.sendCommand("Emulation.setDeviceMetricsOverride", { ...device, screenWidth: device.width, screenHeight: device.height })
      await debuggerRef.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1 })
    })
    tab.view.webContents.reload()
    return { preset }
  }

  private async cdp(tab: BrowserTab, params: Record<string, unknown>): Promise<unknown> {
    if (!this.settings.advancedCdpEnabled || !shouldInstallAdvancedCdpPolicy(tab.partition)) throw browserError("action_denied")
    const method = String(params.method ?? "")
    if (!CDP_ALLOWLIST.has(method)) throw browserError("action_denied")
    const commandParams = params.params && typeof params.params === "object" ? params.params : {}
    if (Buffer.byteLength(JSON.stringify(commandParams)) > 64 * 1024) throw browserError("invalid_browser_request")
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
    tab.view.setVisible(tab.visible)
    return publicTab(tab)
  }

  private setVisible(tabId: string, visible: boolean): BrowserTabDescriptor {
    const tab = this.requireTab(tabId, userContext())
    tab.visible = visible
    tab.view.setVisible(visible)
    if (!visible) this.hideAgentCursor()
    return publicTab(tab)
  }

  private focus(tabId: string): BrowserTabDescriptor {
    const tab = this.requireTab(tabId, userContext())
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
    if (!tab || !canAgentClaim(tab, context.browserSessionId, context.browserTurnId)) throw browserError("action_denied")
    tab.agentLease = { browserSessionId: context.browserSessionId, browserTurnId: context.browserTurnId, generation: tab.generation }
    this.options.emit({ method: "browser:tab-share-changed", params: publicTab(tab) as unknown as Record<string, unknown> })
    return publicTab(tab)
  }

  private closeTab(tabId: string, context: BrowserRequestContext): { ok: true } {
    const tab = this.requireTab(tabId, context)
    const win = this.options.getWindow()
    if (win && !win.isDestroyed()) win.contentView.removeChildView(tab.view)
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    this.tabs.delete(tabId)
    this.disposeOwnedSessionIfUnused(tab.partition, tab.view.webContents.session)
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
    return { ok: true }
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
    return this.ensureTab(randomUUID(), context, { url: popup.url })
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

  private async clearData(context: BrowserRequestContext, params: Record<string, unknown>): Promise<{ ok: true; cleared: string[] }> {
    if (context.actor !== "user") throw browserError("action_denied")
    const categories = Array.isArray(params.categories) ? params.categories.filter((value): value is string => typeof value === "string") : ["siteData", "cache", "downloads"]
    const selected = new Set(categories.filter((value) => ["siteData", "cache", "downloads", "passwords"].includes(value)))
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
    return { ok: true, cleared: [...selected] }
  }
}

export function createBrowserRuntime(options: BrowserRuntimeOptions): BrowserRuntime {
  return new BrowserRuntime(options)
}

function publicTab(tab: BrowserTab): BrowserTabDescriptor {
  const { view: _view, partition: _partition, context: _context, inputSequence: _inputSequence, agentLease, handoff: _handoff, approvedPrivateOrigins: _approvedPrivateOrigins, ...result } = tab
  return { ...result, agentClaimed: Boolean(agentLease) }
}

function validateContext(value: BrowserRequestContext): BrowserRequestContext {
  if (!value || (value.actor !== "agent" && value.actor !== "user") || !value.browserSessionId || !value.browserTurnId) throw browserError("invalid_browser_request")
  return value
}

function userContext(): BrowserRequestContext {
  return { browserSessionId: "renderer", browserTurnId: "renderer", actor: "user" }
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

function stripUrl(value: string): string {
  try { const url = new URL(value); url.username = ""; url.password = ""; return url.toString() } catch { return "" }
}

function isAllowedNavigation(value: string, agent: boolean, settings?: BrowserSettings, approvedPrivateOrigins?: Set<string>): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (!agent) return true
    if (!isPrivateHost(url.hostname)) return true
    return settings?.siteOverrides[url.origin] === "allow" || approvedPrivateOrigins?.has(url.origin) === true
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
