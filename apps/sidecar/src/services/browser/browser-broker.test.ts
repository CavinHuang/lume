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
  assert.deepEqual(descriptors.map((descriptor) => [descriptor.type, descriptor.protocolVersion]), [["iab", 6], ["extension", 5]])
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
