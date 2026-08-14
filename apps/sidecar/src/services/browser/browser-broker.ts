import { createHash, randomUUID } from "node:crypto"
import {
  BROWSER_PROTOCOL_MAX_SUPPORTED,
  BROWSER_PROTOCOL_MIN_SUPPORTED,
  BROWSER_PROTOCOL_VERSION,
  type BrowserActionRequest,
  type BrowserBackendDescriptor,
  type BrowserLocator,
  type BrowserReferenceCandidate,
  type BrowserReferenceGrantInput,
  type BrowserReferenceGrantResult,
  type BrowserRequestContext,
  type BrowserRuntimeDescriptor,
  type BrowserTabDescriptor,
} from "@lume/shared"
import { BROWSER_API_REGISTRY, browserApiSupportForBackend } from "@lume/shared"
import { classifyBrowserAction } from "./browser-action-policy"
import { resolveAuthorizedBrowserUploadPaths } from "../agent/agent-files-service"

export interface BrowserMainTransport { request(request: BrowserActionRequest): Promise<unknown>; isAvailable?: () => boolean }

export type BrowserThreadContinuity = Pick<BrowserTabDescriptor,
  "tabId" | "url" | "title" | "profileKind" | "visible" | "lifecycle" | "handoffStatus"
>

/** Long-lived sidecar ingress. Identity is derived here; callers cannot set actor. */
export class BrowserBroker {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly pendingReferenceGrants = new Map<string, BrowserReferenceGrantInput & { expiresAt: number }>()
  private readonly claimSnapshots = new Map<string, { backend: "iab" | "extension"; threadId?: string; tabId?: string; providerTabId?: string; title?: string; url?: string; generation?: number }>()
  private generation = 1
  private browserPluginEnabled = false
  private chromePluginEnabled = false
  private extensionBackendEnabled = false
  private extensionConnected = false
  private extensionRuntime?: ExtensionRuntimeDescriptor
  constructor(private readonly main: BrowserMainTransport, private readonly extension?: BrowserMainTransport, private readonly onStateChange?: (state: { browserEnabled: boolean; chromeEnabled: boolean; extensionBackendEnabled: boolean; hostConnected: boolean; generation: number }) => void) {
    this.extensionConnected = extension?.isAvailable?.() === true
  }
  descriptor(backend: "iab" | "extension" = "iab", runtime?: BrowserRuntimeDescriptor): BrowserBackendDescriptor {
    if (backend === "extension" && (!this.extension || !this.extensionBackendEnabled || !this.chromePluginEnabled || !this.extensionConnected)) throw new Error("browser_unavailable")
    const id = backend === "iab" ? "lume-iab" : "lume-extension"
    const browserCapabilities = backend === "iab"
      ? (runtime?.capabilities ?? [{ id: "tabs", description: "In-app tab lifecycle" }, { id: "navigation", description: "Policy-checked navigation" }, { id: "locator-actions", description: "Constrained snapshot and locator actions" }, { id: "screenshot", description: "Screenshot evidence" }, { id: "guardedUpload", description: "Confirmed task-bound file-ref upload" }, { id: "agentDownload", description: "Confirmed quota-bound Agent downloads" }])
        .filter((capability) => !["advancedCdp", "browserAuth", "pageAssets"].includes(capability.id))
      : [{ id: "tabs", description: "Explicit external Chrome tab lifecycle" }, { id: "navigation", description: "Explicit external Chrome navigation" }, { id: "input", description: "Explicit external Chrome click and input control" }, { id: "locator", description: "Strict locator resolution and actionability" }, { id: "screenshot", description: "External Chrome screenshot evidence" }, { id: "visibility", description: "Show or hide the external Chrome window" }, { id: "viewport", description: "Set or reset the external Chrome viewport" }]
    const tabCapabilities = backend === "iab" && Array.isArray(runtime?.capabilities)
      ? [
          ...(runtime.capabilities.some((capability) => capability.id === "advancedCdp") ? [{ id: "cdp", description: "Full CDP for isolated sessions with origin and per-action approval" }] : []),
          ...(runtime.capabilities.some((capability) => capability.id === "browserAuth") ? [{ id: "browserAuth", description: "Collect and submit credentials through an isolated backend-owned window" }] : []),
          ...(runtime.capabilities.some((capability) => capability.id === "pageAssets") ? [{ id: "pageAssets", description: "Inventory and export bounded assets observed in the current page state" }] : []),
          ...(runtime.capabilities.some((capability) => capability.id === "webmcp") ? [{ id: "webmcp", description: "Invoke page-defined WebMCP tools announced by browser notifications" }] : []),
        ]
      : backend === "extension"
        ? this.extensionRuntime?.tabCapabilities ?? []
        : []
    const protocol = backend === "extension" ? this.extensionRuntime : runtime
    const apiSupportOverrides = backend === "extension"
      ? this.extensionRuntime?.apiSupportOverrides ?? browserApiSupportForBackend("extension", new Set())
      : {
          ...(runtime?.apiSupportOverrides ?? browserApiSupportForBackend("iab", new Set())),
          "CdpCapability.readEvents": false,
        }
    return {
      id, browserId: id, backend, type: backend, clientType: backend, name: backend === "iab" ? "Lume 内置浏览器" : "Lume Chrome",
      protocolVersion: protocol?.protocolVersion ?? BROWSER_PROTOCOL_VERSION,
      minSupported: protocol?.minSupported ?? BROWSER_PROTOCOL_MIN_SUPPORTED,
      maxSupported: protocol?.maxSupported ?? BROWSER_PROTOCOL_MAX_SUPPORTED,
      capabilityHash: capabilityHash([
        ...[...browserCapabilities, ...tabCapabilities].map((capability) => capability.id),
        ...Object.entries(apiSupportOverrides).flatMap(([api, supported]) => supported ? [api] : []),
      ]),
      generation: this.generation,
      metadata: backend === "iab"
        ? { networkBoundary: "task-partition-proxy" }
        : { networkBoundary: "external-chrome-best-effort", credentials: "unavailable", agentDownloads: apiSupportOverrides["PlaywrightLocator.downloadMedia"] ? "limited" : "unavailable" },
      capabilities: { browser: browserCapabilities, tab: tabCapabilities },
      apiSupportOverrides,
    }
  }
  setPluginEnabled(enabled: boolean): void { this.setPluginState({ browserEnabled: enabled }) }
  setPluginState(state: Partial<{ browserEnabled: boolean; chromeEnabled: boolean; extensionBackendEnabled: boolean; hostConnected: boolean }>): void {
    const next = {
      browserEnabled: state.browserEnabled ?? this.browserPluginEnabled,
      chromeEnabled: state.chromeEnabled ?? this.chromePluginEnabled,
      extensionBackendEnabled: state.extensionBackendEnabled ?? this.extensionBackendEnabled,
      hostConnected: state.hostConnected ?? this.extensionConnected,
    }
    if (next.browserEnabled === this.browserPluginEnabled && next.chromeEnabled === this.chromePluginEnabled && next.extensionBackendEnabled === this.extensionBackendEnabled && next.hostConnected === this.extensionConnected) return
    const extensionConnectionChanged = next.hostConnected !== this.extensionConnected
    this.browserPluginEnabled = next.browserEnabled
    this.chromePluginEnabled = next.chromeEnabled
    this.extensionBackendEnabled = next.extensionBackendEnabled
    this.extensionConnected = next.hostConnected
    this.extensionRuntime = undefined
    this.generation += 1
    this.queues.clear()
    this.claimSnapshots.clear()
    if (!next.browserEnabled) this.pendingReferenceGrants.clear()
    else if (extensionConnectionChanged) {
      for (const [id, grant] of this.pendingReferenceGrants) if (grant.backend === "extension") this.pendingReferenceGrants.delete(id)
    }
    this.onStateChange?.({ ...next, generation: this.generation })
  }
  setExternalState(state: { chromeEnabled?: boolean; extensionBackendEnabled?: boolean; hostConnected?: boolean }): void { this.setPluginState(state) }
  revoke(): void { this.setPluginEnabled(false) }
  async connectedChromeImportStatus(): Promise<{ available: boolean }> {
    return { available: (await this.connectedChromeRuntime())?.cookieExport === true }
  }
  async exportConnectedChromeCookies(): Promise<unknown[]> {
    const runtime = await this.connectedChromeRuntime()
    if (!runtime?.cookieExport || !this.extension) throw new Error("browser_unavailable")
    const context: BrowserRequestContext = { browserSessionId: "renderer-chrome-import", browserTurnId: randomUUID(), actor: "user", capability: `browser-cookie-import-v1:${this.generation}` }
    const cookies: unknown[] = []
    let cursor = 0
    for (let page = 0; page < 50; page += 1) {
      const result = await this.extension.request({ requestId: randomUUID(), context, method: "cookieExport", params: { cursor } })
      if (!result || typeof result !== "object") throw new Error("invalid_browser_request")
      const payload = result as { cookies?: unknown; nextCursor?: unknown }
      if (!Array.isArray(payload.cookies) || payload.cookies.length > 200) throw new Error("invalid_browser_request")
      cookies.push(...payload.cookies)
      if (payload.nextCursor === null || payload.nextCursor === undefined) return cookies
      if (!Number.isSafeInteger(payload.nextCursor) || Number(payload.nextCursor) <= cursor || Number(payload.nextCursor) > 10_000) throw new Error("invalid_browser_request")
      cursor = Number(payload.nextCursor)
    }
    throw new Error("invalid_browser_request")
  }
  async listReferenceCandidates(threadId: string): Promise<BrowserReferenceCandidate[]> {
    const normalizedThreadId = threadId.trim().slice(0, 200)
    if (!normalizedThreadId || !this.browserPluginEnabled) return []
    const context: BrowserRequestContext = {
      threadId: normalizedThreadId,
      browserSessionId: "renderer-reference-picker",
      browserTurnId: randomUUID(),
      actor: "user",
    }
    const [iabResult, extensionResult] = await Promise.all([
      this.main.request({ requestId: randomUUID(), context, method: "list" }).catch(() => []),
      this.extension && this.extensionBackendEnabled && this.chromePluginEnabled && this.extensionConnected
        ? this.extension.request({ requestId: randomUUID(), context, method: "openTabs" }).catch(() => [])
        : Promise.resolve([]),
    ])
    const iab = referenceCandidateArray(iabResult, "iab", normalizedThreadId)
      .filter((candidate) => candidate.ownerThreadId === normalizedThreadId)
      .sort(compareReferenceCandidates)
    const extension = referenceCandidateArray(extensionResult, "extension")
      .filter((candidate) => Boolean(candidate.lastOpenedAt))
      .sort(compareReferenceCandidates)
      .slice(0, 3)
    return [...iab, ...extension]
  }
  async getThreadAgentContinuity(threadId: string): Promise<BrowserThreadContinuity | undefined> {
    const normalizedThreadId = threadId.trim().slice(0, 200)
    if (!normalizedThreadId || !this.browserPluginEnabled) return undefined
    const context: BrowserRequestContext = {
      threadId: normalizedThreadId,
      browserSessionId: "agent-browser-continuity",
      browserTurnId: randomUUID(),
      actor: "user",
    }
    const result = await this.main.request({ requestId: randomUUID(), context, method: "list" }).catch(() => [])
    return browserUserTabArray(result)
      .flatMap((value) => value && typeof value === "object" ? [value as BrowserTabDescriptor] : [])
      .filter((tab) => tab.ownerThreadId === normalizedThreadId
        && tab.profileKind === "agent"
        && tab.lifecycle !== "crashed"
        && (tab.handoffStatus === "handoff" || tab.handoffStatus === "deliverable")
        && typeof tab.url === "string"
        && tab.url.trim().length > 0)
      .sort((left, right) => Number(right.visible) - Number(left.visible)
        || String(right.lastOpenedAt ?? "").localeCompare(String(left.lastOpenedAt ?? "")))[0]
  }
  async createReferenceGrant(input: BrowserReferenceGrantInput): Promise<BrowserReferenceGrantResult> {
    if (!input || (input.backend !== "iab" && input.backend !== "extension") || input.access !== "control"
      || typeof input.threadId !== "string" || !input.threadId.trim()
      || typeof input.tabId !== "string" || !input.tabId.trim()
      || typeof input.title !== "string" || !input.title.trim()
      || typeof input.url !== "string" || !isReferenceableUrl(input.url, input.backend)
      || input.browserId !== (input.backend === "iab" ? "lume-iab" : "lume-extension")) throw new Error("invalid_browser_request")
    if (!this.browserPluginEnabled) throw new Error("browser_unavailable")
    const transport = input.backend === "extension" ? this.extension : this.main
    if (!transport || (input.backend === "extension" && (!this.extensionBackendEnabled || !this.chromePluginEnabled || !this.extensionConnected))) throw new Error("browser_unavailable")
    const result = await transport.request({
      requestId: randomUUID(),
      context: { threadId: input.threadId, browserSessionId: "renderer-reference-picker", browserTurnId: randomUUID(), actor: "user" },
      method: "referenceGrant:create",
      params: { ...input },
    }) as BrowserReferenceGrantResult
    const expiresAt = Date.parse(result.expiresAt)
    if (!result.referenceGrantId || !Number.isFinite(expiresAt)) throw new Error("browser_internal_error")
    for (const [referenceGrantId, pending] of this.pendingReferenceGrants) {
      if (pending.backend === input.backend && pending.threadId === input.threadId && pending.tabId === input.tabId) {
        this.pendingReferenceGrants.delete(referenceGrantId)
      }
    }
    this.pendingReferenceGrants.set(result.referenceGrantId, { ...input, expiresAt })
    return result
  }
  async revokeReferenceGrant(input: { backend: "iab" | "extension"; threadId: string; referenceGrantId: string }): Promise<{ ok: true; revoked?: boolean }> {
    const pending = this.pendingReferenceGrants.get(input.referenceGrantId)
    if (pending?.threadId === input.threadId && pending.backend === input.backend) this.pendingReferenceGrants.delete(input.referenceGrantId)
    const transport = input.backend === "extension" ? this.extension : this.main
    if (!transport || (input.backend === "extension" && (!this.extensionBackendEnabled || !this.chromePluginEnabled || !this.extensionConnected))) return { ok: true, revoked: false }
    return await transport.request({
      requestId: randomUUID(),
      context: { threadId: input.threadId, browserSessionId: "renderer-reference-picker", browserTurnId: randomUUID(), actor: "user" },
      method: "referenceGrant:revoke",
      params: { threadId: input.threadId, referenceGrantId: input.referenceGrantId },
    }) as { ok: true; revoked?: boolean }
  }
  async dispatch(input: { method: string; params?: Record<string, unknown>; threadId?: string; browserSessionId: string; browserTurnId: string; tabId?: string; backend?: "iab" | "extension"; idempotencyKey?: string }): Promise<unknown> {
    if (!this.browserPluginEnabled) throw new Error("browser_unavailable")
    if (input.method.startsWith("policy:")) throw new Error("action_denied")
    if (input.method === "runtime_list_browsers") return this.listBackendsForContext(input)
    const backend = inferBackend(input.backend, input.params)
    if (input.method === "runtime_ping") {
      if (backend === "iab") return this.descriptor("iab", await this.runtimeDescriptor(input))
      await this.refreshExtensionRuntime(input)
      return this.descriptor("extension")
    }
    if (input.method === "runtime_diagnostics") return { generation: this.generation, backends: this.listBackends() }
    const normalized = normalizeBrowserCommand(input.method, input.params ?? {})
    const tabId = input.tabId ?? (typeof normalized.params.tabId === "string" ? normalized.params.tabId : undefined)
    const transport = backend === "extension" ? this.extension : this.main
    if (!transport || (backend === "extension" && (!this.extensionBackendEnabled || !this.chromePluginEnabled || !this.extensionConnected))) throw new Error("browser_unavailable")
    const context: BrowserRequestContext = { ...(input.threadId ? { threadId: input.threadId } : {}), browserSessionId: input.browserSessionId, browserTurnId: input.browserTurnId, ...(tabId ? { tabId } : {}), actor: "agent", capability: `browser-broker-v1:${this.generation}` }
    const queueKey = `${backend}:${tabId ?? "browser"}`
    const previous = this.queues.get(queueKey) ?? Promise.resolve()
    const execute = async () => {
      const policy = classifyBrowserAction(input.method, input.params, normalized.method)
      if (policy.decision === "deny") throw new Error("action_denied")
      let confirmationToken: string | undefined
      let bindingHash: string | undefined
      if (policy.decision === "confirm") {
        bindingHash = createHash("sha256").update(`${this.generation}:${backend}:${input.method}:${tabId ?? ""}:${policy.category ?? ""}:${stableJson(input.params ?? {})}`).digest("base64url")
        const internalContext: BrowserRequestContext = { ...context, capability: `browser-broker-policy-v1:${this.generation}` }
        const confirmation = await this.main.request({
          requestId: randomUUID(), context: internalContext, method: "policy:confirm",
          params: { method: input.method, tabId, backend, category: policy.category, preview: policy.preview, bindingHash },
        }) as { approved?: boolean; token?: string }
        if (!confirmation.approved || typeof confirmation.token !== "string") throw new Error("confirmation_unavailable")
        confirmationToken = confirmation.token
        if (backend === "extension") {
          await this.main.request({ requestId: randomUUID(), context: internalContext, method: "policy:consume", params: { token: confirmationToken, bindingHash } })
        }
      }
      const authorizedUploadFiles = input.method === "playwright_file_chooser_set_files"
        ? authorizeBrowserUploadFiles(input.threadId, normalized.params.files)
        : undefined
      const params = {
        ...normalized.params,
        ...(normalized.method === "ensure" && input.threadId ? { ownerThreadId: input.threadId } : {}),
        ...(normalized.method === "claim" ? this.referenceGrantForClaim(backend, context, tabId, normalized.params) : {}),
        ...(authorizedUploadFiles ? { files: authorizedUploadFiles.browserDownloadRefs, __authorizedFiles: authorizedUploadFiles.authorizedPaths } : {}),
        ...(confirmationToken ? { __policyRequired: true, __policyConfirmation: confirmationToken, __policyBindingHash: bindingHash } : {}),
      }
      const method = backend === "extension" && input.method === "tab_browser_auth_request"
        ? input.method
        : new Set(["submitForm", "send", "delete", "purchase", "authorize"]).has(input.method) ? "click" : normalized.method
      const request: BrowserActionRequest = { requestId: randomUUID(), context, method, params, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) }
      const result = await transport.request(request)
      if (normalized.method === "openTabs") this.rememberClaimSnapshots(backend, context, result)
      if (normalized.method === "claim" && typeof params.referenceGrantId === "string") this.pendingReferenceGrants.delete(params.referenceGrantId)
      return adaptBrowserResult(input.method, result)
    }
    if (WAIT_COMMANDS.has(input.method)) return execute().catch((error) => { throw new Error(stableBrowserErrorCode(error)) })
    const current = previous.then(execute)
    this.queues.set(queueKey, current.catch(() => undefined))
    return current.catch((error) => { throw new Error(stableBrowserErrorCode(error)) })
  }
  listBackends(): BrowserBackendDescriptor[] { return this.browserPluginEnabled ? [this.descriptor("iab"), ...(this.extension && this.extensionBackendEnabled && this.chromePluginEnabled && this.extensionConnected ? [this.descriptor("extension")] : [])] : [] }
  private async listBackendsForContext(input: { threadId?: string; browserSessionId: string; browserTurnId: string }): Promise<BrowserBackendDescriptor[]> {
    if (!this.browserPluginEnabled) return []
    const runtime = await this.runtimeDescriptor(input)
    if (this.extension && this.extensionBackendEnabled && this.chromePluginEnabled && this.extensionConnected) await this.refreshExtensionRuntime(input)
    return [this.descriptor("iab", runtime), ...(this.extension && this.extensionBackendEnabled && this.chromePluginEnabled && this.extensionConnected ? [this.descriptor("extension")] : [])]
  }
  private async runtimeDescriptor(input: { threadId?: string; browserSessionId: string; browserTurnId: string }): Promise<BrowserRuntimeDescriptor | undefined> {
    try {
      return await this.main.request({
        requestId: randomUUID(),
        context: { ...(input.threadId ? { threadId: input.threadId } : {}), browserSessionId: input.browserSessionId, browserTurnId: input.browserTurnId, actor: "agent", capability: `browser-broker-v1:${this.generation}` },
        method: "handshake",
      }) as BrowserRuntimeDescriptor
    } catch { return undefined }
  }
  private async refreshExtensionRuntime(input: { threadId?: string; browserSessionId: string; browserTurnId: string }): Promise<void> {
    if (!this.extension || !this.extensionBackendEnabled || !this.chromePluginEnabled || !this.extensionConnected) {
      this.extensionRuntime = undefined
      return
    }
    try {
      this.extensionRuntime = sanitizeExtensionRuntimeDescriptor(await this.extension.request({
        requestId: randomUUID(),
        context: { ...(input.threadId ? { threadId: input.threadId } : {}), browserSessionId: input.browserSessionId, browserTurnId: input.browserTurnId, actor: "agent", capability: `browser-broker-v1:${this.generation}` },
        method: "handshake",
      }))
    } catch {
      this.extensionRuntime = undefined
    }
  }

  private async connectedChromeRuntime(): Promise<ExtensionRuntimeDescriptor | undefined> {
    if (!this.extension || !this.extensionBackendEnabled || !this.chromePluginEnabled || !this.extensionConnected) return undefined
    try {
      return sanitizeExtensionRuntimeDescriptor(await this.extension.request({
        requestId: randomUUID(),
        context: { browserSessionId: "renderer-chrome-import", browserTurnId: randomUUID(), actor: "user", capability: `browser-cookie-import-v1:${this.generation}` },
        method: "handshake",
      }))
    } catch { return undefined }
  }

  private rememberClaimSnapshots(backend: "iab" | "extension", context: BrowserRequestContext, value: unknown): void {
    const prefix = claimSnapshotPrefix(backend, context)
    for (const key of this.claimSnapshots.keys()) if (key.startsWith(prefix)) this.claimSnapshots.delete(key)
    for (const item of browserUserTabArray(value)) {
      if (!item || typeof item !== "object") continue
      const descriptor = item as Record<string, unknown>
      const claimHandle = typeof descriptor.id === "string" ? descriptor.id : ""
      if (!claimHandle) continue
      this.claimSnapshots.set(`${prefix}${claimHandle}`, {
        backend,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        ...(typeof descriptor.tabId === "string" ? { tabId: descriptor.tabId } : {}),
        ...(typeof descriptor.providerTabId === "string" ? { providerTabId: descriptor.providerTabId } : {}),
        ...(typeof descriptor.title === "string" ? { title: descriptor.title } : {}),
        ...(typeof descriptor.url === "string" ? { url: descriptor.url } : {}),
        ...(Number.isInteger(descriptor.generation) ? { generation: Number(descriptor.generation) } : {}),
      })
    }
  }

  private referenceGrantForClaim(backend: "iab" | "extension", context: BrowserRequestContext, claimHandle: string | undefined, params: Record<string, unknown>): { referenceGrantId?: string } {
    if (typeof params.referenceGrantId === "string" && params.referenceGrantId) return { referenceGrantId: params.referenceGrantId }
    if (!context.threadId || !claimHandle) return {}
    const snapshot = this.claimSnapshots.get(`${claimSnapshotPrefix(backend, context)}${claimHandle}`)
    if (!snapshot) return {}
    const now = Date.now()
    for (const [referenceGrantId, grant] of this.pendingReferenceGrants) {
      if (grant.expiresAt <= now) {
        this.pendingReferenceGrants.delete(referenceGrantId)
        continue
      }
      const providerMatches = grant.providerTabId
        ? snapshot.providerTabId === grant.providerTabId
        : snapshot.providerTabId === grant.tabId || snapshot.tabId === grant.tabId
      if (grant.backend === backend
        && grant.threadId === context.threadId
        && providerMatches
        && snapshot.title === grant.title
        && snapshot.url === grant.url
        && (grant.generation === undefined || snapshot.generation === undefined || snapshot.generation === grant.generation)) {
        return { referenceGrantId }
      }
    }
    return {}
  }
}

export function createBrowserBroker(main: BrowserMainTransport, extension?: BrowserMainTransport, onStateChange?: ConstructorParameters<typeof BrowserBroker>[2]): BrowserBroker { return new BrowserBroker(main, extension, onStateChange) }

function referenceCandidateArray(value: unknown, backend: "iab" | "extension", threadId?: string): BrowserReferenceCandidate[] {
  const values = browserUserTabArray(value)
  return values.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const descriptor = item as Record<string, unknown>
    if (backend === "iab" && descriptor.profileKind !== "user") return []
    const tabId = typeof descriptor.tabId === "string" ? descriptor.tabId : typeof descriptor.id === "string" ? descriptor.id : ""
    const url = typeof descriptor.url === "string" ? descriptor.url.trim() : ""
    if (!tabId || !isReferenceableUrl(url, backend)) return []
    const lastOpenedAt = referenceTimestamp(descriptor.lastOpenedAt ?? descriptor.lastOpened ?? descriptor.lastAccessed)
    const ownerThreadId = typeof descriptor.ownerThreadId === "string" ? descriptor.ownerThreadId : undefined
    if (backend === "iab" && threadId && ownerThreadId !== threadId) return []
    let fallbackTitle = url
    try { fallbackTitle = new URL(url).hostname || url } catch { /* validated above */ }
    return [{
      backend,
      browserId: backend === "iab" ? "lume-iab" : "lume-extension",
      tabId,
      ...(typeof descriptor.providerTabId === "string" ? { providerTabId: descriptor.providerTabId } : {}),
      title: typeof descriptor.title === "string" && descriptor.title.trim() ? descriptor.title.trim().slice(0, 512) : fallbackTitle,
      url,
      ...(Number.isInteger(descriptor.generation) && Number(descriptor.generation) > 0 ? { generation: Number(descriptor.generation) } : {}),
      ...(lastOpenedAt ? { lastOpenedAt } : {}),
      ...(ownerThreadId ? { ownerThreadId } : {}),
    } satisfies BrowserReferenceCandidate]
  })
}

function browserUserTabArray(value: unknown): unknown[] {
  return Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { tabs?: unknown }).tabs)
      ? (value as { tabs: unknown[] }).tabs
      : []
}

function claimSnapshotPrefix(backend: "iab" | "extension", context: BrowserRequestContext): string {
  return `${backend}\u0000${context.browserSessionId}\u0000${context.browserTurnId}\u0000`
}

function isReferenceableUrl(value: string, backend: "iab" | "extension"): boolean {
  try {
    const protocol = new URL(value).protocol.toLowerCase()
    return backend === "extension" ? protocol === "http:" || protocol === "https:" : protocol === "http:" || protocol === "https:" || protocol === "file:"
  } catch { return false }
}

function referenceTimestamp(value: unknown): string | undefined {
  const date = typeof value === "number" ? new Date(value) : typeof value === "string" && value.trim() ? new Date(value) : undefined
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function compareReferenceCandidates(left: BrowserReferenceCandidate, right: BrowserReferenceCandidate): number {
  return String(right.lastOpenedAt ?? "").localeCompare(String(left.lastOpenedAt ?? "")) || left.title.localeCompare(right.title)
}

function capabilityHash(ids: string[]): string { return createHash("sha256").update(ids.join("\n")).digest("hex") }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
function stableBrowserErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : ""
  return new Set(["browser_unavailable", "invalid_browser_request", "invalid_url", "private_origin_confirmation_required", "stale_target", "tab_not_found", "tab_generation_changed", "confirmation_unavailable", "reference_grant_expired", "action_denied", "strict_locator_violation", "actionability_failed", "dialog_blocking", "unsupported", "executed_unknown"]).has(value) ? value : "browser_internal_error"
}

function inferBackend(explicit: "iab" | "extension" | undefined, params: Record<string, unknown> | undefined): "iab" | "extension" {
  if (explicit === "extension") return "extension"
  const requested = String(params?.browserId ?? params?.browser_id ?? params?.clientType ?? "").toLowerCase()
  return requested === "extension" || requested === "chrome-extension" || requested === "lume-extension" ? "extension" : "iab"
}

function normalizeBrowserCommand(method: string, input: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const params = { ...input }
  if (typeof params.tabId !== "string" && typeof input.tab_id === "string") params.tabId = input.tab_id
  if (typeof params.referenceGrantId !== "string" && typeof input.reference_grant_id === "string") params.referenceGrantId = input.reference_grant_id
  delete params.browserId
  delete params.browser_id
  const locator = browserClientSelectorToLocator(input.selector)
  if (locator) params.locator = locator
  const options = input.options && typeof input.options === "object" && !Array.isArray(input.options) ? input.options as Record<string, unknown> : {}
  switch (method) {
    case "name_session": case "browser_name_session": return { method: "nameSession", params }
    case "browser_user_open_tabs": return { method: "openTabs", params }
    case "browser_user_claim_tab": return { method: "claim", params }
    case "browser_user_history": return {
      method: "history:list",
      params: {
        ...params,
        query: input.query ?? options.text,
        limit: input.limit ?? options.maxResults,
        from: normalizeBrowserHistoryTime(input.from ?? options.startTime),
        to: normalizeBrowserHistoryTime(input.to ?? options.endTime),
      },
    }
    case "browser_visibility_get": return { method: "browser:visibility:get", params }
    case "browser_visibility_set": return { method: "browser:visibility:set", params }
    case "browser_viewport_set": return { method: "browser:viewport:set", params: { ...params, ...options, width: input.width ?? options.width, height: input.height ?? options.height } }
    case "browser_viewport_reset": return { method: "browser:viewport:reset", params }
    case "create_tab": return { method: "ensure", params: { ...params, ...options, url: options.url ?? params.url } }
    case "get_tab": return { method: "get", params }
    case "selected_tab": return { method: "selected", params }
    case "list_tabs": case "get_session_tabs": return { method: "list", params }
    case "release_tabs": return { method: "release", params }
    case "handoff_tabs": return { method: "handoff", params }
    case "resume_handoff_tabs": return { method: "resumeHandoff", params }
    case "finalize_tabs": return {
      method: "finalize",
      params: {
        ...params,
        keep: Array.isArray(input.keep)
          ? input.keep.flatMap((value) => {
              if (!value || typeof value !== "object") return []
              const item = value as Record<string, unknown>
              const tabId = typeof item.tab_id === "string" ? item.tab_id : typeof item.tabId === "string" ? item.tabId : ""
              return tabId && (item.status === "handoff" || item.status === "deliverable") ? [{ tabId, status: item.status }] : []
            })
          : undefined,
      },
    }
    case "mark_tab": return { method: "mark", params: { ...params, status: input.status } }
    case "close_tab": return { method: "close", params }
    case "navigate_tab_url": return { method: "navigate", params }
    case "navigate_tab_back": return { method: "back", params }
    case "navigate_tab_forward": return { method: "forward", params }
    case "navigate_tab_reload": return { method: "reload", params }
    case "tab_url": return { method: "url", params }
    case "tab_title": return { method: "title", params }
    case "tab_screenshot": return { method: "screenshot", params: { ...params, ...options, fullPage: options.fullPage === true || params.fullPage === true } }
    case "tab_content": return { method: "content", params: { ...params, format: input.content_type === "html" ? "html" : "text" } }
    case "tab_content_export": return { method: "content:export", params }
    case "tab_content_export_gsuite": return { method: "content:exportGsuite", params: { ...params, format: input.format ?? input.type ?? options.format } }
    case "tab_browser_auth_request": return {
      method: "browserAuth:request",
      params: input.options && typeof input.options === "object" && !Array.isArray(input.options)
        ? normalizeBrowserAuthParams(params, options)
        : params,
    }
    case "tabs_content": return { method: "tabs:content", params: { ...params, ...options, contentType: input.content_type ?? options.contentType, timeoutMs: input.timeout_ms ?? options.timeoutMs } }
    case "tab_clipboard_read": return { method: "clipboard:read", params }
    case "tab_clipboard_read_text": return { method: "clipboard:readText", params }
    case "tab_clipboard_write": return { method: "clipboard:write", params }
    case "tab_clipboard_write_text": return { method: "clipboard:writeText", params }
    case "playwright_dom_snapshot": return { method: "snapshot", params }
    case "playwright_element_info": return { method: "elementInfo", params: { ...params, ...options } }
    case "playwright_element_screenshot": return { method: "elementScreenshot", params: { ...params, ...options } }
    case "playwright_evaluate": return { method: "evaluate:readonly", params: { ...params, timeoutMs: input.timeoutMs ?? input.timeout_ms ?? options.timeoutMs } }
    case "playwright_wait_for_download": return { method: "wait:download", params: { ...params, timeoutMs: input.timeout_ms ?? options.timeoutMs } }
    case "playwright_download_path": return { method: "download:path", params: { ...params, downloadId: input.download_id ?? input.downloadId, timeoutMs: input.timeout_ms ?? input.timeoutMs ?? options.timeoutMs } }
    case "playwright_wait_for_file_chooser": return { method: "wait:filechooser", params: { ...params, timeoutMs: input.timeout_ms ?? options.timeoutMs } }
    case "playwright_file_chooser_set_files": return {
      method: "filechooser:setFiles",
      params: {
        ...params,
        fileChooserId: input.file_chooser_id ?? input.chooserId,
        files: Array.isArray(input.files) ? input.files : typeof input.files === "string" ? [input.files] : [],
      },
    }
    case "tab_page_assets_list": return { method: "pageAssets:list", params }
    case "tab_page_assets_bundle": return {
      method: "pageAssets:bundle",
      params: {
        ...params,
        ...options,
        inventoryId: input.inventory_id ?? input.inventoryId ?? options.inventoryId,
        assetIds: input.asset_ids ?? input.assetIds ?? options.assetIds,
      },
    }
    case "webmcp_list_tools": return { method: "webmcp:list", params }
    case "webmcp_invoke_tool": return {
      method: "webmcp:invoke",
      params: { ...params, toolName: input.tool_name ?? input.toolName, timeoutMs: input.timeout_ms ?? input.timeoutMs },
    }
    case "tab_dev_logs": return { method: "dev:logs", params }
    case "dom_cua_get_visible_dom": return { method: "dom:visible", params }
    case "dom_cua_click": return { method: "dom:click", params: { ...params, nodeId: input.node_id } }
    case "dom_cua_double_click": return { method: "dom:doubleClick", params: { ...params, nodeId: input.node_id } }
    case "dom_cua_scroll": return { method: "dom:scroll", params: { ...params, nodeId: input.node_id, scrollX: input.scroll_x ?? input.x, scrollY: input.scroll_y ?? input.y } }
    case "dom_cua_type": return { method: "dom:type", params }
    case "dom_cua_keypress": return { method: "dom:keypress", params }
    case "dom_cua_download_media": return { method: "downloadMedia", params: { ...params, nodeId: input.node_id } }
    case "playwright_locator_click": return { method: "click", params }
    case "playwright_locator_dblclick": return { method: "doubleClick", params }
    case "playwright_locator_hover": return { method: "hover", params }
    case "playwright_locator_fill": return { method: "fill", params: { ...params, text: input.text ?? input.value } }
    case "playwright_locator_type": return { method: "type", params: { ...params, text: input.text ?? input.value } }
    case "playwright_locator_press": return { method: "press", params: { ...params, key: input.key ?? input.value } }
    case "playwright_locator_select_option": return { method: "select", params: { ...params, value: normalizeSelections(input.selections ?? input.value) } }
    case "playwright_locator_set_checked": return { method: input.checked === false ? "uncheck" : "check", params }
    case "playwright_locator_check": return { method: "check", params }
    case "playwright_locator_uncheck": return { method: "uncheck", params }
    case "playwright_locator_scroll": return { method: "scroll", params }
    case "playwright_locator_get_attribute": return { method: "locator:getAttribute", params: { ...params, name: input.name ?? input.attribute_name } }
    case "playwright_locator_inner_text": return { method: "locator:innerText", params }
    case "playwright_locator_text_content": return { method: "locator:textContent", params }
    case "playwright_locator_input_value": return { method: "locator:inputValue", params }
    case "playwright_locator_is_visible": return { method: "locator:isVisible", params }
    case "playwright_locator_is_enabled": return { method: "locator:isEnabled", params }
    case "playwright_locator_is_checked": return { method: "locator:isChecked", params }
    case "playwright_locator_count": return { method: "locator:count", params }
    case "playwright_locator_all_text_contents": return { method: "locator:allTextContents", params }
    case "playwright_locator_read_all": return { method: "locator:readAll", params }
    case "playwright_locator_wait_for": return { method: "locator:waitFor", params }
    case "playwright_locator_evaluate": return { method: "locator:evaluate", params: { ...params, timeoutMs: input.timeoutMs ?? input.timeout_ms ?? options.timeoutMs } }
    case "playwright_locator_download_media": return { method: "downloadMedia", params }
    case "playwright_wait_for_url": return { method: "wait:url", params: { ...params, timeoutMs: options.timeoutMs ?? params.timeoutMs ?? params.timeout_ms } }
    case "playwright_wait_for_load_state": return { method: "wait:load", params }
    case "playwright_wait_for_timeout": return { method: "wait:timeout", params }
    case "cua_click": return { method: "click", params }
    case "cua_double_click": return { method: "doubleClick", params }
    case "cua_move": return { method: "hover", params }
    case "cua_scroll": return { method: "scroll", params: { ...params, deltaX: input.scrollX, deltaY: input.scrollY } }
    case "cua_drag": {
      const path = Array.isArray(input.path) ? input.path.filter((point): point is Record<string, unknown> => Boolean(point) && typeof point === "object" && !Array.isArray(point)) : []
      const start = path[0] ?? {}
      const end = path[path.length - 1] ?? {}
      return { method: "drag", params: { ...params, x: start.x, y: start.y, toX: end.x, toY: end.y } }
    }
    case "cua_type": return { method: "typeActive", params }
    case "cua_keypress": return { method: "pressActive", params }
    case "cua_download_media": return { method: "downloadMedia", params }
    case "tab_get_js_dialog": case "tab_js_dialog_get": return { method: "dialog:get", params }
    case "tab_handle_js_dialog": case "tab_js_dialog_handle": return {
      method: "dialog:handle",
      params: {
        ...params,
        accept: input.action === "accept",
        dialogId: input.dialog_id ?? input.dialogId,
        promptText: input.prompt_text ?? input.promptText,
      },
    }
    case "tab_cdp_call": case "tab_cdp_send": return { method: "cdp", params: { ...params, method: input.method, params: input.params } }
    default: return { method, params }
  }
}

function authorizeBrowserUploadFiles(threadId: string | undefined, value: unknown): { browserDownloadRefs: string[]; authorizedPaths: string[] } | undefined {
  if (!Array.isArray(value)) return undefined
  const files = value.filter((item): item is string => typeof item === "string").slice(0, 20)
  const browserDownloadRefs = files.filter((item) => /^browser-download:[a-f0-9-]{36}$/i.test(item))
  const unresolved = files.filter((item) => !browserDownloadRefs.includes(item))
  if (!unresolved.length) return { browserDownloadRefs, authorizedPaths: [] }
  if (!threadId) throw new Error("action_denied")
  try {
    return { browserDownloadRefs, authorizedPaths: resolveAuthorizedBrowserUploadPaths(threadId, unresolved) }
  } catch {
    throw new Error("action_denied")
  }
}

const WAIT_COMMANDS = new Set(["playwright_wait_for_download", "playwright_wait_for_file_chooser"])

function browserClientSelectorToLocator(value: unknown): BrowserLocator | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>
    const ast = candidate.ast && typeof candidate.ast === "object" ? candidate.ast : candidate
    if ((ast as Record<string, unknown>).version === 1 && Array.isArray((ast as Record<string, unknown>).steps)) return ast as BrowserLocator
  }
  if (typeof value !== "string" || !value.trim() || value.length > 4096) return undefined
  const frameParts = value.split(/\s*>>\s*internal:control=enter-frame\s*>>\s*/g)
  const steps: BrowserLocator["steps"] = []
  for (const frameSelector of frameParts.slice(0, -1)) {
    if (!frameSelector.trim() || frameSelector.startsWith("internal:")) return undefined
    steps.push({ kind: "frame", selector: frameSelector.trim() })
  }
  for (const rawPart of frameParts.at(-1)!.split(/\s*>>\s*/g)) {
    const part = rawPart.trim()
    if (!part) continue
    const role = /^internal:role=([^\[]+)(?:\[name=("(?:[^"\\]|\\.)*")(s|i)\])?$/.exec(part)
    if (role) {
      const name = role[2] ? decodeSelectorString(role[2]) : undefined
      steps.push({ kind: "role", role: role[1]!, ...(name !== undefined ? { name, exact: role[3] === "s" } : {}) })
      continue
    }
    const text = /^internal:(text|label)=("(?:[^"\\]|\\.)*")(s|i)$/.exec(part)
    if (text) {
      const content = decodeSelectorString(text[2]!)
      steps.push(text[1] === "label"
        ? { kind: "label", text: content, exact: text[3] === "s" }
        : { kind: "text", text: content, exact: text[3] === "s" })
      continue
    }
    const attribute = /^internal:attr=\[placeholder=("(?:[^"\\]|\\.)*")(s|i)\]$/.exec(part)
    if (attribute) {
      steps.push({ kind: "placeholder", text: decodeSelectorString(attribute[1]!), exact: attribute[2] === "s" })
      continue
    }
    const testId = /^internal:testid=\[data-testid=("(?:[^"\\]|\\.)*")s\]$/.exec(part)
    if (testId) {
      steps.push({ kind: "testId", testId: decodeSelectorString(testId[1]!) })
      continue
    }
    const nth = /^nth=(-?\d+)$/.exec(part)
    if (nth) {
      const index = Number(nth[1])
      if (index === -1) steps.push({ kind: "last" })
      else if (index >= 0 && index <= 10_000) steps.push({ kind: "nth", index })
      else return undefined
      continue
    }
    if (part.startsWith("internal:")) return undefined
    steps.push({ kind: "css", selector: part })
  }
  return steps.length ? { version: 1, steps } : undefined
}

function normalizeBrowserAuthParams(params: Record<string, unknown>, options: Record<string, unknown>): Record<string, unknown> {
  const fields = Array.isArray(options.fields) ? options.fields.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    const field = value as Record<string, unknown>
    return { ...field, locator: browserClientSelectorToLocator(field.locator ?? field.selector) }
  }) : options.fields
  const authOptions = Array.isArray(options.options) ? options.options.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    const option = value as Record<string, unknown>
    return {
      ...option,
      fields: option.fields ?? option.field_ids ?? [],
      locator: browserClientSelectorToLocator(option.locator ?? option.selector),
    }
  }) : options.options
  let submit = options.submit
  if (submit && typeof submit === "object" && !Array.isArray(submit)) {
    const value = submit as Record<string, unknown>
    submit = {
      ...value,
      kind: value.kind ?? value.action,
      locator: browserClientSelectorToLocator(value.locator ?? value.selector),
      fieldId: value.fieldId ?? value.field_id,
    }
  }
  return { ...params, ...options, fields, options: authOptions, submit }
}

function normalizeBrowserHistoryTime(value: unknown): unknown {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : value
}

function decodeSelectorString(value: string): string {
  try { return String(JSON.parse(value)).slice(0, 4096) } catch { return "" }
}

function normalizeSelections(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value]
  return values.flatMap((item) => {
    if (typeof item === "string") return [item]
    if (!item || typeof item !== "object") return []
    const selection = item as { value?: unknown; label?: unknown; index?: unknown }
    if (typeof selection.value === "string") return [selection.value]
    if (typeof selection.label === "string") return [selection.label]
    if (typeof selection.index === "number") return [String(selection.index)]
    return []
  }).slice(0, 100)
}

type ExtensionRuntimeDescriptor = {
  protocolVersion: number
  minSupported: number
  maxSupported: number
  tabCapabilities: BrowserBackendDescriptor["capabilities"]["tab"]
  apiSupportOverrides: Record<string, boolean>
  cookieExport: boolean
}

const EXTENSION_TAB_CAPABILITIES = {
  pageAssets: { id: "pageAssets", description: "Inventory and export bounded assets from the current Chrome tab" },
  cdp: { id: "cdp", description: "Read-only CDP with per-action approval and buffered events" },
  botDetection: { id: "botDetection", description: "Report bot-detection blockers without page secrets" },
  webmcp: { id: "webmcp", description: "Invoke page-defined WebMCP tools announced by browser notifications" },
} as const

function sanitizeExtensionRuntimeDescriptor(value: unknown): ExtensionRuntimeDescriptor | undefined {
  if (!value || typeof value !== "object") return undefined
  const descriptor = value as Record<string, unknown>
  const protocolVersion = safeProtocolVersion(descriptor.protocolVersion)
  const minSupported = safeProtocolVersion(descriptor.minSupported)
  const maxSupported = safeProtocolVersion(descriptor.maxSupported)
  if (!protocolVersion || !minSupported || !maxSupported || maxSupported < BROWSER_PROTOCOL_MIN_SUPPORTED || minSupported > BROWSER_PROTOCOL_MAX_SUPPORTED) return undefined
  const capabilities = descriptor.capabilities && typeof descriptor.capabilities === "object" ? descriptor.capabilities as Record<string, unknown> : {}
  const declaredTabCapabilities = new Set(Array.isArray(capabilities.tab)
    ? capabilities.tab.flatMap((capability) => capability && typeof capability === "object" && typeof (capability as { id?: unknown }).id === "string" ? [(capability as { id: string }).id] : [])
    : [])
  const declaredBrowserCapabilities = new Set(Array.isArray(capabilities.browser)
    ? capabilities.browser.flatMap((capability) => capability && typeof capability === "object" && typeof (capability as { id?: unknown }).id === "string" ? [(capability as { id: string }).id] : [])
    : [])
  const declaredApiSupport = descriptor.apiSupportOverrides && typeof descriptor.apiSupportOverrides === "object"
    ? descriptor.apiSupportOverrides as Record<string, unknown>
    : {}
  return {
    protocolVersion,
    minSupported,
    maxSupported,
    tabCapabilities: Object.values(EXTENSION_TAB_CAPABILITIES).filter((capability) => declaredTabCapabilities.has(capability.id)),
    apiSupportOverrides: browserApiSupportForBackend(
      "extension",
      new Set(BROWSER_API_REGISTRY.filter((entry) => entry.backends.includes("extension")).map((entry) => entry.runtimeMethod)),
      declaredApiSupport,
    ),
    cookieExport: declaredBrowserCapabilities.has("cookieExport"),
  }
}

function safeProtocolVersion(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

function adaptBrowserResult(originalMethod: string, result: unknown): unknown {
  if (originalMethod === "tab_screenshot" && typeof result === "string") return { data: result }
  if (originalMethod === "playwright_element_screenshot" && result && typeof result === "object" && typeof (result as { data?: unknown }).data === "string") return { dataBase64: (result as { data: string }).data }
  if (originalMethod === "playwright_dom_snapshot") return { dom_snapshot: typeof result === "string" ? result : JSON.stringify(result) }
  if (originalMethod === "browser_user_open_tabs") return { tabs: browserUserTabArray(result) }
  if (originalMethod === "browser_user_history") {
    const entries = Array.isArray(result) ? result : []
    return {
      items: entries.flatMap((entry) => entry && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string"
        ? [{
            url: (entry as { url: string }).url,
            ...(typeof (entry as { title?: unknown }).title === "string" ? { title: (entry as { title: string }).title } : {}),
            dateVisited: String((entry as { visitedAt?: unknown }).visitedAt ?? ""),
          }]
        : []),
    }
  }
  if (originalMethod === "tab_get_js_dialog" || originalMethod === "tab_js_dialog_get") {
    const dialog = result && typeof result === "object" ? result as Record<string, unknown> : undefined
    return {
      dialog: dialog && typeof dialog.id === "string" && typeof dialog.type === "string"
        ? { id: dialog.id, type: dialog.type }
        : null,
    }
  }
  if (originalMethod === "create_tab") return { id: descriptorId(result) }
  if (originalMethod === "get_tab" || originalMethod === "browser_user_claim_tab") return descriptorResult(result)
  if (originalMethod === "selected_tab") return descriptorId(result) ? { id: descriptorId(result) } : {}
  if (originalMethod === "list_tabs" || originalMethod === "get_session_tabs") return { tabs: (Array.isArray(result) ? result : []).map(descriptorResult) }
  if (originalMethod === "tab_url") return { url: typeof result === "string" ? result : undefined }
  if (originalMethod === "tab_title") return { title: typeof result === "string" ? result : undefined }
  if (originalMethod === "playwright_locator_count") return { count: typeof result === "number" ? result : 0 }
  if (originalMethod === "playwright_locator_all_text_contents") return { values: Array.isArray(result) ? result : [] }
  if (originalMethod === "playwright_locator_read_all") return { values: Array.isArray(result) ? result : [] }
  if (originalMethod === "playwright_locator_get_attribute"
    || originalMethod === "playwright_locator_inner_text"
    || originalMethod === "playwright_locator_text_content"
    || originalMethod === "playwright_locator_input_value"
    || originalMethod === "playwright_locator_is_visible"
    || originalMethod === "playwright_locator_is_enabled"
    || originalMethod === "playwright_locator_is_checked") return { value: result ?? null }
  return result
}

function descriptorId(value: unknown): string {
  if (!value || typeof value !== "object") return ""
  const descriptor = value as { id?: unknown; tabId?: unknown }
  return typeof descriptor.id === "string" ? descriptor.id : typeof descriptor.tabId === "string" ? descriptor.tabId : ""
}

function descriptorResult(value: unknown): { id: string; title?: string; url?: string } {
  if (!value || typeof value !== "object") return { id: "" }
  const descriptor = value as { id?: unknown; tabId?: unknown; title?: unknown; url?: unknown }
  return {
    id: descriptorId(value),
    ...(typeof descriptor.title === "string" && descriptor.title ? { title: descriptor.title } : {}),
    ...(typeof descriptor.url === "string" && descriptor.url ? { url: descriptor.url } : {}),
  }
}
