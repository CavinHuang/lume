import { createHash, randomUUID } from "node:crypto"
import type { BrowserActionRequest, BrowserBackendDescriptor, BrowserRequestContext, BrowserRuntimeDescriptor } from "@lume/shared"
import { classifyBrowserAction } from "./browser-action-policy"

export interface BrowserMainTransport { request(request: BrowserActionRequest): Promise<unknown>; isAvailable?: () => boolean }

/** Long-lived sidecar ingress. Identity is derived here; callers cannot set actor. */
export class BrowserBroker {
  private readonly queues = new Map<string, Promise<unknown>>()
  private generation = 1
  private browserPluginEnabled = false
  private chromePluginEnabled = false
  private extensionBackendEnabled = false
  private extensionConnected = false
  constructor(private readonly main: BrowserMainTransport, private readonly extension?: BrowserMainTransport, private readonly onStateChange?: (state: { browserEnabled: boolean; chromeEnabled: boolean; extensionBackendEnabled: boolean; hostConnected: boolean; generation: number }) => void) {
    this.extensionConnected = extension?.isAvailable?.() === true
  }
  descriptor(backend: "iab" | "extension" = "iab", runtime?: BrowserRuntimeDescriptor): BrowserBackendDescriptor {
    if (backend === "extension" && (!this.extension || !this.extensionBackendEnabled || !this.chromePluginEnabled || !this.extensionConnected)) throw new Error("browser_unavailable")
    const id = backend === "iab" ? "lume-iab" : "lume-extension"
    const browserCapabilities = backend === "iab"
      ? [{ id: "tabs", description: "In-app tab lifecycle" }, { id: "navigation", description: "Policy-checked navigation" }, { id: "locator-actions", description: "Constrained snapshot and locator actions" }, { id: "screenshot", description: "Screenshot evidence" }, { id: "guardedUpload", description: "Confirmed task-bound file-ref upload" }, { id: "agentDownload", description: "Confirmed quota-bound Agent downloads" }]
      : [{ id: "tabs", description: "Explicit external Chrome tab lifecycle" }, { id: "navigation", description: "Explicit external Chrome navigation" }, { id: "input", description: "Explicit external Chrome click and input control" }, { id: "locator", description: "Strict locator resolution and actionability" }, { id: "screenshot", description: "External Chrome screenshot evidence" }, { id: "visibility", description: "Show or hide the external Chrome window" }, { id: "viewport", description: "Set or reset the external Chrome viewport" }]
    const tabCapabilities = backend === "iab" && Array.isArray(runtime?.capabilities) && runtime.capabilities.some((capability) => capability.id === "advancedCdp")
      ? [{ id: "cdp", description: "Method-allowlisted CDP for isolated advanced sessions" }]
      : backend === "extension"
        ? [{ id: "botDetection", description: "Report bot-detection blockers without page secrets" }]
        : []
    return {
      id, browserId: id, backend, type: backend, clientType: backend, name: backend === "iab" ? "Lume 内置浏览器" : "Lume Chrome",
      protocolVersion: 5, minSupported: 5, maxSupported: 5,
      capabilityHash: capabilityHash([...browserCapabilities, ...tabCapabilities].map((capability) => capability.id)),
      generation: this.generation,
      metadata: backend === "iab" ? { networkBoundary: "task-partition-proxy" } : { networkBoundary: "external-chrome-best-effort", credentials: "unavailable", agentDownloads: "unavailable" },
      capabilities: { browser: browserCapabilities, tab: tabCapabilities },
      apiSupportOverrides: backend === "extension" ? EXTENSION_API_SUPPORT : IAB_API_SUPPORT,
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
    this.browserPluginEnabled = next.browserEnabled
    this.chromePluginEnabled = next.chromeEnabled
    this.extensionBackendEnabled = next.extensionBackendEnabled
    this.extensionConnected = next.hostConnected
    this.generation += 1
    this.queues.clear()
    this.onStateChange?.({ ...next, generation: this.generation })
  }
  setExternalState(state: { chromeEnabled?: boolean; extensionBackendEnabled?: boolean; hostConnected?: boolean }): void { this.setPluginState(state) }
  revoke(): void { this.setPluginEnabled(false) }
  async dispatch(input: { method: string; params?: Record<string, unknown>; threadId?: string; browserSessionId: string; browserTurnId: string; tabId?: string; backend?: "iab" | "extension"; idempotencyKey?: string }): Promise<unknown> {
    if (!this.browserPluginEnabled) throw new Error("browser_unavailable")
    if (input.method.startsWith("policy:")) throw new Error("action_denied")
    if (input.method === "runtime_list_browsers") return this.listBackendsForContext(input)
    const backend = inferBackend(input.backend, input.params)
    if (input.method === "runtime_ping") return backend === "iab" ? this.descriptor("iab", await this.runtimeDescriptor(input)) : this.descriptor(backend)
    if (input.method === "runtime_diagnostics") return { generation: this.generation, backends: this.listBackends() }
    const normalized = normalizeBrowserCommand(input.method, input.params ?? {})
    const tabId = input.tabId ?? (typeof normalized.params.tabId === "string" ? normalized.params.tabId : undefined)
    const transport = backend === "extension" ? this.extension : this.main
    if (!transport || (backend === "extension" && (!this.extensionBackendEnabled || !this.chromePluginEnabled || !this.extensionConnected))) throw new Error("browser_unavailable")
    const context: BrowserRequestContext = { ...(input.threadId ? { threadId: input.threadId } : {}), browserSessionId: input.browserSessionId, browserTurnId: input.browserTurnId, ...(tabId ? { tabId } : {}), actor: "agent", capability: `browser-broker-v1:${this.generation}` }
    const queueKey = `${backend}:${tabId ?? "browser"}`
    const previous = this.queues.get(queueKey) ?? Promise.resolve()
    const current = previous.then(async () => {
      const policy = classifyBrowserAction(input.method, input.params)
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
      const params = { ...normalized.params, ...(confirmationToken ? { __policyRequired: true, __policyConfirmation: confirmationToken, __policyBindingHash: bindingHash } : {}) }
      const method = new Set(["submitForm", "send", "delete", "purchase", "authorize"]).has(input.method) ? "click" : normalized.method
      const request: BrowserActionRequest = { requestId: randomUUID(), context, method, params, ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) }
      return adaptBrowserResult(input.method, await transport.request(request))
    })
    this.queues.set(queueKey, current.catch(() => undefined))
    return current.catch((error) => { throw new Error(stableBrowserErrorCode(error)) })
  }
  listBackends(): BrowserBackendDescriptor[] { return this.browserPluginEnabled ? [this.descriptor("iab"), ...(this.extension && this.extensionBackendEnabled && this.chromePluginEnabled && this.extensionConnected ? [this.descriptor("extension")] : [])] : [] }
  private async listBackendsForContext(input: { threadId?: string; browserSessionId: string; browserTurnId: string }): Promise<BrowserBackendDescriptor[]> {
    if (!this.browserPluginEnabled) return []
    const runtime = await this.runtimeDescriptor(input)
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
}

export function createBrowserBroker(main: BrowserMainTransport, extension?: BrowserMainTransport, onStateChange?: ConstructorParameters<typeof BrowserBroker>[2]): BrowserBroker { return new BrowserBroker(main, extension, onStateChange) }

function capabilityHash(ids: string[]): string { return createHash("sha256").update(ids.join("\n")).digest("hex") }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
function stableBrowserErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : ""
  return new Set(["browser_unavailable", "invalid_browser_request", "invalid_url", "private_origin_confirmation_required", "stale_target", "tab_not_found", "tab_generation_changed", "confirmation_unavailable", "action_denied", "strict_locator_violation", "actionability_failed", "dialog_blocking", "unsupported", "executed_unknown"]).has(value) ? value : "browser_internal_error"
}

function inferBackend(explicit: "iab" | "extension" | undefined, params: Record<string, unknown> | undefined): "iab" | "extension" {
  if (explicit === "extension") return "extension"
  const requested = String(params?.browserId ?? params?.clientType ?? "").toLowerCase()
  return requested === "extension" || requested === "chrome-extension" || requested === "lume-extension" ? "extension" : "iab"
}

function normalizeBrowserCommand(method: string, input: Record<string, unknown>): { method: string; params: Record<string, unknown> } {
  const params = { ...input }
  delete params.browserId
  const options = input.options && typeof input.options === "object" && !Array.isArray(input.options) ? input.options as Record<string, unknown> : {}
  switch (method) {
    case "browser_user_open_tabs": return { method: "openTabs", params }
    case "browser_user_claim_tab": return { method: "claim", params }
    case "create_tab": return { method: "ensure", params: { ...params, ...options, url: options.url } }
    case "get_tab": return { method: "get", params }
    case "selected_tab": return { method: "selected", params }
    case "list_tabs": case "get_session_tabs": return { method: "list", params }
    case "release_tabs": return { method: "release", params }
    case "handoff_tabs": return { method: "handoff", params }
    case "resume_handoff_tabs": return { method: "resumeHandoff", params }
    case "finalize_tabs": return { method: "finalize", params }
    case "close_tab": return { method: "close", params }
    case "navigate_tab_url": return { method: "navigate", params }
    case "navigate_tab_back": return { method: "back", params }
    case "navigate_tab_forward": return { method: "forward", params }
    case "navigate_tab_reload": return { method: "reload", params }
    case "tab_url": return { method: "url", params }
    case "tab_title": return { method: "title", params }
    case "tab_screenshot": return { method: "screenshot", params: { ...params, fullPage: options.fullPage === true } }
    case "playwright_dom_snapshot": return { method: "snapshot", params }
    case "playwright_locator_click": return { method: "click", params }
    case "playwright_locator_dblclick": return { method: "doubleClick", params }
    case "playwright_locator_hover": return { method: "hover", params }
    case "playwright_locator_fill": return { method: "fill", params: { ...params, text: input.text ?? input.value } }
    case "playwright_locator_type": return { method: "type", params }
    case "playwright_locator_press": return { method: "press", params }
    case "playwright_locator_select_option": return { method: "select", params: { ...params, value: input.value } }
    case "playwright_locator_set_checked": return { method: input.checked === false ? "uncheck" : "check", params }
    case "playwright_locator_check": return { method: "check", params }
    case "playwright_locator_uncheck": return { method: "uncheck", params }
    case "playwright_locator_scroll": return { method: "scroll", params }
    case "playwright_locator_get_attribute": return { method: "locator:getAttribute", params }
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
    case "playwright_wait_for_url": return { method: "wait:url", params: { ...params, timeoutMs: options.timeoutMs } }
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
    case "tab_js_dialog_get": return { method: "dialog:get", params }
    case "tab_js_dialog_handle": return { method: "dialog:handle", params }
    case "tab_cdp_call": case "tab_cdp_send": return { method: "cdp", params: { ...params, method: input.method, params: input.params } }
    default: return { method, params }
  }
}

const IAB_API_SUPPORT = {
  "Browser.nameSession": false,
  "BrowserUser.history": false,
  "Tabs.content": false,
  "Tabs.finalize": true,
  "Tab.content": false,
  "Tab.markDeliverable": true,
  "Tab.markHandoff": true,
  "Tab.clipboard": false,
  "TabClipboardAPI.read": false,
  "TabClipboardAPI.readText": false,
  "TabClipboardAPI.write": false,
  "TabClipboardAPI.writeText": false,
  "DomCUAAPI.click": false,
  "DomCUAAPI.double_click": false,
  "DomCUAAPI.downloadMedia": false,
  "DomCUAAPI.get_visible_dom": false,
  "DomCUAAPI.keypress": false,
  "DomCUAAPI.scroll": false,
  "DomCUAAPI.type": false,
  "PlaywrightAPI.elementInfo": false,
  "PlaywrightAPI.elementScreenshot": false,
  "PlaywrightAPI.evaluate": false,
  "PlaywrightAPI.frameLocator": false,
  "PlaywrightAPI.waitForEvent": false,
  "PlaywrightLocator.downloadMedia": false,
  "TabDevAPI.logs": false,
} as const

const EXTENSION_API_SUPPORT = {
  "BrowserUser.history": false,
  "Tabs.content": false,
  "Tab.content": false,
  "Tab.clipboard": false,
  "TabClipboardAPI.read": false,
  "TabClipboardAPI.readText": false,
  "TabClipboardAPI.write": false,
  "TabClipboardAPI.writeText": false,
  "CUAAPI.downloadMedia": false,
  "DomCUAAPI.downloadMedia": false,
  "PlaywrightAPI.evaluate": false,
  "PlaywrightAPI.waitForEvent": false,
  "PlaywrightDownload.path": false,
  "PlaywrightFileChooser.setFiles": false,
  "PlaywrightLocator.downloadMedia": false,
} as const

function adaptBrowserResult(originalMethod: string, result: unknown): unknown {
  if (originalMethod === "tab_screenshot" && typeof result === "string") return { dataBase64: result }
  return result
}
