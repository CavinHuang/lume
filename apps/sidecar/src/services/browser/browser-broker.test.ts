import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BrowserBroker } from "./browser-broker";

test("extension backend is absent until browser/chrome plugins, setting, and live host agree", async () => {
  const calls: unknown[] = [];
  const broker = new BrowserBroker({ request: async (request) => { calls.push(request); return { backend: "iab" }; } }, { isAvailable: () => false, request: async () => ({ backend: "extension" }) });
  assert.deepEqual(broker.listBackends(), []);
  broker.setPluginState({ browserEnabled: true, chromeEnabled: true, extensionBackendEnabled: true, hostConnected: false });
  assert.equal(broker.listBackends().some((backend) => backend.backend === "extension"), false);
  await assert.rejects(() => broker.dispatch({ method: "list", browserSessionId: "s", browserTurnId: "t", backend: "extension" }), /browser_unavailable/);
  broker.setExternalState({ hostConnected: true });
  const extension = broker.listBackends().find((backend) => backend.backend === "extension");
  assert.ok(extension);
  assert.deepEqual(extension.capabilities.tab, []);
  assert.equal(extension.apiSupportOverrides["BrowserUser.history"], false);
  assert.equal((await broker.dispatch({ method: "list", browserSessionId: "s", browserTurnId: "t", backend: "extension" }) as { backend: string }).backend, "extension");
  assert.equal(calls.length, 0);
});

test("broker obtains and binds one-time confirmation for consequential actions", async () => {
  const calls: any[] = [];
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request);
    if (request.method === "policy:confirm") return { approved: true, token: "confirmation-token" };
    return { ok: true };
  } });
  broker.setPluginState({ browserEnabled: true });
  await broker.dispatch({ method: "submitForm", params: { tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "button" }] }, semanticIntent: "提交表单" }, tabId: "tab-1", browserSessionId: "s", browserTurnId: "t" });
  assert.equal(calls[0].method, "policy:confirm");
  assert.equal(calls[1].method, "click");
  assert.equal(calls[1].params.__policyRequired, true);
  assert.equal(calls[1].params.__policyConfirmation, "confirmation-token");
  await broker.dispatch({ method: "submitForm", params: { tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "button.other" }] }, semanticIntent: "提交表单" }, tabId: "tab-1", browserSessionId: "s", browserTurnId: "t" });
  assert.notEqual(calls[0].params.bindingHash, calls[2].params.bindingHash);
  await assert.rejects(() => broker.dispatch({ method: "click", params: { semanticIntent: "Pay now" }, browserSessionId: "s", browserTurnId: "t" }), /action_denied/);
});

test("canonical BrowserClient commands select and normalize the requested backend", async () => {
  const mainCalls: any[] = []
  const extensionCalls: any[] = []
  const broker = new BrowserBroker(
    { request: async (request) => { mainCalls.push(request); return request.method === "handshake" ? { capabilities: [{ id: "advancedCdp" }] } : request.method === "screenshot" ? "cG5n" : request.method === "elementScreenshot" ? { data: "ZWxlbWVudA==" } : { ok: true } } },
    { isAvailable: () => true, request: async (request) => {
      extensionCalls.push(request)
      if (request.method === "handshake") return {
        protocolVersion: 5,
        minSupported: 5,
        maxSupported: 5,
        capabilities: { browser: [], tab: [{ id: "pageAssets" }, { id: "cdp" }, { id: "webmcp" }, { id: "unknown-capability" }] },
        apiSupportOverrides: { "BrowserUser.history": true, "CUAAPI.downloadMedia": true, "DomCUAAPI.downloadMedia": true, "PlaywrightAPI.evaluate": true, "PlaywrightLocator.evaluate": true, "PlaywrightLocator.downloadMedia": true, "Tab.content": true },
      }
      return { tabId: "chrome-tab:1" }
    } },
  )
  broker.setPluginState({ browserEnabled: true, chromeEnabled: true, extensionBackendEnabled: true, hostConnected: true })

  const descriptors = await broker.dispatch({ method: "runtime_list_browsers", browserSessionId: "s", browserTurnId: "t" }) as any[]
  assert.deepEqual(descriptors.map((descriptor) => [descriptor.type, descriptor.protocolVersion]), [["iab", 7], ["extension", 5]])
  assert.deepEqual(descriptors[0].capabilities.tab.map((capability: { id: string }) => capability.id), ["cdp"])
  assert.deepEqual(descriptors[1].capabilities.tab.map((capability: { id: string }) => capability.id), ["pageAssets", "cdp", "webmcp"])
  assert.equal(descriptors[1].apiSupportOverrides["BrowserUser.history"], true)
  assert.equal(descriptors[1].apiSupportOverrides["PlaywrightAPI.evaluate"], true)
  assert.equal(descriptors[1].apiSupportOverrides["PlaywrightLocator.evaluate"], true)
  assert.equal(descriptors[1].apiSupportOverrides["CUAAPI.downloadMedia"], true)
  assert.equal(descriptors[1].apiSupportOverrides["Tab.content"], true)
  assert.equal(descriptors[1].metadata.agentDownloads, "limited")

  await broker.dispatch({ method: "create_tab", params: { browserId: "lume-extension", options: { url: "https://example.com" } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(extensionCalls.at(-1).method, "ensure")
  assert.equal(extensionCalls.at(-1).params.url, "https://example.com")

  await broker.dispatch({ method: "playwright_locator_click", params: { browserId: "lume-iab", tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "button" }] } }, browserSessionId: "s", browserTurnId: "t" })
  const actionCalls = mainCalls.filter((request) => request.method !== "handshake")
  assert.equal(actionCalls[0].method, "click")
  assert.equal(actionCalls[0].context.tabId, "tab-1")

  await broker.dispatch({ method: "playwright_locator_inner_text", params: { browserId: "lume-iab", tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "output" }] } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(mainCalls.filter((request) => request.method !== "handshake")[1].method, "locator:innerText")

  await broker.dispatch({ method: "playwright_locator_evaluate", params: { browserId: "lume-iab", tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "output" }] }, expression: "(element) => element.textContent", options: { timeoutMs: 321 } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(mainCalls.filter((request) => request.method !== "handshake")[2].method, "locator:evaluate")
  assert.equal(mainCalls.filter((request) => request.method !== "handshake")[2].params.timeoutMs, 321)

  await broker.dispatch({ method: "playwright_locator_click", params: { browserId: "lume-iab", tabId: "tab-1", selector: "iframe#preview >> internal:control=enter-frame >> internal:role=button[name=\"Save\"s]" }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(mainCalls.filter((request) => request.method !== "handshake")[3].params.locator.steps, [
    { kind: "frame", selector: "iframe#preview" },
    { kind: "role", role: "button", name: "Save", exact: true },
  ])

  await broker.dispatch({ method: "cua_keypress", params: { browserId: "lume-iab", tabId: "tab-1", key: "Enter" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(mainCalls.filter((request) => request.method !== "handshake")[4].method, "pressActive")

  const screenshot = await broker.dispatch({ method: "tab_screenshot", params: { browserId: "lume-iab", tabId: "tab-1" }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(screenshot, { data: "cG5n" })

  const elementScreenshot = await broker.dispatch({ method: "playwright_element_screenshot", params: { browserId: "lume-iab", tabId: "tab-1", options: { x: 10, y: 20 } }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(elementScreenshot, { dataBase64: "ZWxlbWVudA==" })
});

test("reference candidates stay in the current IAB task and include only the three latest Chrome tabs", async () => {
  const broker = new BrowserBroker(
    { request: async (request) => request.method === "list" ? [
      { tabId: "iab-current", providerTabId: "provider-current", ownerThreadId: "thread-1", profileKind: "user", backend: "iab", generation: 2, title: "Current", url: "http://localhost:3000/", lastOpenedAt: "2026-08-01T10:00:00.000Z" },
      { tabId: "iab-other", providerTabId: "provider-other", ownerThreadId: "thread-2", profileKind: "user", backend: "iab", generation: 1, title: "Other", url: "http://localhost:4000/", lastOpenedAt: "2026-08-01T11:00:00.000Z" },
      { tabId: "iab-agent", ownerThreadId: "thread-1", profileKind: "agent", backend: "iab", generation: 1, title: "Agent", url: "http://localhost:5000/" },
    ] : {} },
    { isAvailable: () => true, request: async (request) => request.method === "openTabs" ? [
      { id: "chrome-1", title: "One", url: "https://one.example/", lastAccessed: Date.parse("2026-08-01T10:00:00.000Z") },
      { id: "chrome-2", title: "Two", url: "https://two.example/", lastAccessed: Date.parse("2026-08-01T12:00:00.000Z") },
      { id: "chrome-3", title: "Three", url: "https://three.example/", lastAccessed: Date.parse("2026-08-01T11:00:00.000Z") },
      { id: "chrome-4", title: "Four", url: "https://four.example/", lastAccessed: Date.parse("2026-08-01T09:00:00.000Z") },
      { id: "chrome-internal", title: "Extensions", url: "chrome://extensions/", lastAccessed: Date.parse("2026-08-01T13:00:00.000Z") },
    ] : {} },
  )
  broker.setPluginState({ browserEnabled: true, chromeEnabled: true, extensionBackendEnabled: true, hostConnected: true })

  const candidates = await broker.listReferenceCandidates("thread-1")
  assert.deepEqual(candidates.map((candidate) => candidate.tabId), ["iab-current", "chrome-2", "chrome-3", "chrome-1"])
  assert.equal(candidates[0]?.browserId, "lume-iab")
  assert.equal(candidates[1]?.browserId, "lume-extension")
});

test("reference grant RPCs use user context and the selected backend", async () => {
  const mainCalls: any[] = []
  const extensionCalls: any[] = []
  const broker = new BrowserBroker(
    { request: async (request) => { mainCalls.push(request); return { referenceGrantId: "iab-grant", expiresAt: "2026-08-01T01:00:00.000Z" } } },
    { isAvailable: () => true, request: async (request) => { extensionCalls.push(request); return request.method === "referenceGrant:revoke" ? { ok: true, revoked: true } : { referenceGrantId: "chrome-grant", expiresAt: "2026-08-01T01:00:00.000Z" } } },
  )
  broker.setPluginState({ browserEnabled: true, chromeEnabled: true, extensionBackendEnabled: true, hostConnected: true })

  const grant = await broker.createReferenceGrant({ backend: "extension", browserId: "lume-extension", threadId: "thread-1", tabId: "chrome-1", title: "Chrome", url: "https://example.com/", access: "control" })
  assert.equal(grant.referenceGrantId, "chrome-grant")
  assert.equal(extensionCalls[0].method, "referenceGrant:create")
  assert.equal(extensionCalls[0].context.actor, "user")
  await broker.revokeReferenceGrant({ backend: "extension", threadId: "thread-1", referenceGrantId: "chrome-grant" })
  assert.equal(extensionCalls[1].method, "referenceGrant:revoke")
  assert.equal(mainCalls.length, 0)
});

test("claiming uses a fresh openTabs handle and injects only an exact task-bound reference grant", async () => {
  const calls: any[] = []
  let currentTitle = "Changed"
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request)
    if (request.method === "referenceGrant:create") return { referenceGrantId: "grant-1", expiresAt: "2099-01-01T00:00:00.000Z" }
    if (request.method === "openTabs") return [{ id: "claim-handle", providerTabId: "provider-1", title: currentTitle, url: "https://example.com/", generation: 3 }]
    if (request.method === "claim") return { tabId: "controlled-tab", title: currentTitle, url: "https://example.com/" }
    return {}
  } })
  broker.setPluginState({ browserEnabled: true })
  await broker.createReferenceGrant({
    backend: "iab",
    browserId: "lume-iab",
    threadId: "thread-1",
    tabId: "persistent-tab",
    providerTabId: "provider-1",
    generation: 3,
    title: "Example",
    url: "https://example.com/",
    access: "control",
  })

  await broker.dispatch({ method: "browser_user_open_tabs", params: { browser_id: "lume-iab" }, threadId: "thread-1", browserSessionId: "session-1", browserTurnId: "turn-1" })
  await broker.dispatch({ method: "browser_user_claim_tab", params: { browser_id: "lume-iab", tab_id: "claim-handle" }, threadId: "thread-1", browserSessionId: "session-1", browserTurnId: "turn-1" })
  assert.equal(calls.at(-1).params.referenceGrantId, undefined)

  currentTitle = "Example"
  await broker.dispatch({ method: "browser_user_open_tabs", params: { browser_id: "lume-iab" }, threadId: "thread-1", browserSessionId: "session-1", browserTurnId: "turn-1" })
  await broker.dispatch({ method: "browser_user_claim_tab", params: { browser_id: "lume-iab", tab_id: "claim-handle" }, threadId: "thread-1", browserSessionId: "session-1", browserTurnId: "turn-1" })
  assert.equal(calls.at(-1).params.tabId, "claim-handle")
  assert.equal(calls.at(-1).params.referenceGrantId, "grant-1")
});

test("broker exposes runtime-declared APIs and normalizes protected browser-use commands", async () => {
  const calls: any[] = []
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request)
    if (request.method === "handshake") return {
      protocolVersion: 6,
      minSupported: 5,
      maxSupported: 6,
      capabilities: [{ id: "history", description: "history" }, { id: "pageAssets", description: "assets" }, { id: "webmcp", description: "tools" }],
      apiSupportOverrides: { "BrowserUser.history": true },
    }
    if (request.method === "policy:confirm") return { approved: true, token: "token" }
    if (request.method === "history:list") return [{ url: "https://example.com/", title: "Example", visitedAt: "2026-07-30T00:00:00.000Z" }]
    return {}
  } })
  broker.setPluginState({ browserEnabled: true })

  const [descriptor] = await broker.dispatch({ method: "runtime_list_browsers", browserSessionId: "s", browserTurnId: "t" }) as any[]
  assert.equal(descriptor.apiSupportOverrides["BrowserUser.history"], true)
  assert.deepEqual(descriptor.capabilities.browser.map((capability: { id: string }) => capability.id), ["history"])
  assert.deepEqual(descriptor.capabilities.tab.map((capability: { id: string }) => capability.id), ["pageAssets", "webmcp"])

  const result = await broker.dispatch({ method: "browser_user_history", params: { queries: ["example"] }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "history:list")
  assert.deepEqual(result, { items: [{ url: "https://example.com/", title: "Example", dateVisited: "2026-07-30T00:00:00.000Z" }] })

  await broker.dispatch({ method: "tab_page_assets_list", params: { tabId: "tab-1" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-1).method, "pageAssets:list")

  await broker.dispatch({ method: "tab_content", params: { tabId: "tab-1", content_type: "html" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-1).method, "content")
  assert.equal(calls.at(-1).params.format, "html")

  await broker.dispatch({ method: "tab_page_assets_bundle", params: { tabId: "tab-1", inventory_id: "inventory-1", kinds: ["image"] }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "pageAssets:bundle")
  assert.equal(calls.at(-1).params.inventoryId, "inventory-1")

  await broker.dispatch({ method: "webmcp_list_tools", params: { tabId: "tab-1" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-1).method, "webmcp:list")

  await broker.dispatch({ method: "webmcp_invoke_tool", params: { tabId: "tab-1", tool_name: "search", input: { query: "Lume" } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "webmcp:invoke")
  assert.equal(calls.at(-1).params.toolName, "search")
  assert.equal(calls.at(-1).params.__policyRequired, true)
})

test("event waits do not block the action that produces the event", async () => {
  const calls: string[] = []
  let resolveDownload!: (value: unknown) => void
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request.method)
    if (request.method === "wait:download") return new Promise((resolve) => { resolveDownload = resolve })
    return {}
  } })
  broker.setPluginState({ browserEnabled: true })

  const waiting = broker.dispatch({ method: "playwright_wait_for_download", params: { tabId: "tab-1" }, browserSessionId: "s", browserTurnId: "t" })
  await Promise.resolve()
  await broker.dispatch({ method: "playwright_locator_click", params: { tabId: "tab-1", selector: "a.download" }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(calls, ["wait:download", "click"])
  resolveDownload({ download_id: "download-1" })
  assert.deepEqual(await waiting, { download_id: "download-1" })
})

test("broker normalizes media downloads and confirmed file chooser uploads", async () => {
  const calls: any[] = []
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request)
    if (request.method === "policy:confirm") return { approved: true, token: "upload-token" }
    return {}
  } })
  broker.setPluginState({ browserEnabled: true })

  await broker.dispatch({
    method: "dom_cua_download_media",
    params: { tabId: "tab-1", node_id: "4:1:node" },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-1).method, "downloadMedia")
  assert.equal(calls.at(-1).params.nodeId, "4:1:node")

  await broker.dispatch({
    method: "playwright_locator_download_media",
    params: { tabId: "tab-1", selector: "img.hero" },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-1).method, "downloadMedia")
  assert.deepEqual(calls.at(-1).params.locator.steps, [{ kind: "css", selector: "img.hero" }])

  await broker.dispatch({
    method: "playwright_file_chooser_set_files",
    params: { tabId: "tab-1", file_chooser_id: "chooser-1", files: "browser-download:00000000-0000-0000-0000-000000000001" },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "filechooser:setFiles")
  assert.deepEqual(calls.at(-1).params.files, ["browser-download:00000000-0000-0000-0000-000000000001"])
  assert.equal(calls.at(-1).params.__policyRequired, true)
  await assert.rejects(() => broker.dispatch({
    method: "playwright_file_chooser_set_files",
    params: { tabId: "tab-1", file_chooser_id: "chooser-1", files: "C:\\outside-task.txt" },
    browserSessionId: "s",
    browserTurnId: "t",
  }), /action_denied/)

  await broker.dispatch({
    method: "tab_cdp_call",
    params: { tabId: "tab-1", method: "Runtime.evaluate", params: { expression: "1 + 1" } },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "cdp")
  assert.equal(calls.at(-1).params.method, "Runtime.evaluate")
  assert.equal(calls.at(-1).params.__policyRequired, true)
})
