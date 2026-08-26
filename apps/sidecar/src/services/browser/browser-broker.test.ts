import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BrowserBroker } from "./browser-broker";
import { BrowserRpcError } from "../../rpc/browser-rpc-sequence";

test("per-tab queue slot is reclaimed after settle (#615)", async () => {
  const broker = new BrowserBroker({ request: async () => ({ ok: true }) });
  broker.setPluginState({ browserEnabled: true });
  const queues = (broker as unknown as { queues: Map<string, Promise<unknown>> }).queues;

  await broker.dispatch({ method: "list", params: { tabId: "tab-reclaim" }, browserSessionId: "s", browserTurnId: "t" });
  // settle 后 finally 微任务回收槽位;让出一个宏任务确保已执行
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal([...queues.keys()].some((key) => key.includes("tab-reclaim")), false);
});

test("serial chain keeps working across slot reclamation (#615)", async () => {
  const broker = new BrowserBroker({ request: async () => ({ ok: true }) });
  broker.setPluginState({ browserEnabled: true });
  const queues = (broker as unknown as { queues: Map<string, Promise<unknown>> }).queues;

  // 连发三个同 tab 请求:回收逻辑不得打断串行语义,全部按序完成
  const results = await Promise.all([
    broker.dispatch({ method: "list", params: { tabId: "tab-chain" }, browserSessionId: "s", browserTurnId: "t" }),
    broker.dispatch({ method: "list", params: { tabId: "tab-chain" }, browserSessionId: "s", browserTurnId: "t" }),
    broker.dispatch({ method: "list", params: { tabId: "tab-chain" }, browserSessionId: "s", browserTurnId: "t" }),
  ]);
  assert.equal(results.length, 3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal([...queues.keys()].some((key) => key.includes("tab-chain")), false);
});

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

test("broker preserves a structured Desktop browser error code", async () => {
  const broker = new BrowserBroker({
    request: async () => { throw new BrowserRpcError("actionability_failed", "browser request failed"); },
  });
  broker.setPluginState({ browserEnabled: true });

  await assert.rejects(
    () => broker.dispatch({ method: "playwright_locator_fill", params: { tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "#kw" }] }, value: "agent loop" }, browserSessionId: "s", browserTurnId: "t" }),
    /actionability_failed/,
  );
});

test("connected Chrome cookie export is capability-gated, user-only, and paged", async () => {
  const calls: any[] = []
  const broker = new BrowserBroker(
    { request: async () => ({}) },
    { isAvailable: () => true, request: async (request) => {
      calls.push(request)
      if (request.method === "handshake") return { protocolVersion: 5, minSupported: 5, maxSupported: 5, capabilities: { browser: [{ id: "cookieExport" }], tab: [] }, apiSupportOverrides: {} }
      if (request.method === "cookieExport" && request.params?.cursor === 0) return { cookies: [{ name: "a" }], nextCursor: 1 }
      if (request.method === "cookieExport" && request.params?.cursor === 1) return { cookies: [{ name: "b" }], nextCursor: null }
      throw new Error("unexpected request")
    } },
  )
  broker.setPluginState({ browserEnabled: true, chromeEnabled: true, extensionBackendEnabled: true, hostConnected: true })
  assert.deepEqual(await broker.connectedChromeImportStatus(), { available: true })
  assert.deepEqual(await broker.exportConnectedChromeCookies(), [{ name: "a" }, { name: "b" }])
  assert.equal(calls.filter((call) => call.method === "cookieExport").every((call) => call.context.actor === "user"), true)
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

test("user rejection surfaces user_declined while transport anomalies stay confirmation_unavailable (#606)", async () => {
  let confirmResponse: Record<string, unknown> = { approved: false };
  const broker = new BrowserBroker({ request: async () => confirmResponse });
  broker.setPluginState({ browserEnabled: true });
  const dispatch = () => broker.dispatch({ method: "submitForm", params: { tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "button" }] }, semanticIntent: "提交表单" }, tabId: "tab-1", browserSessionId: "s", browserTurnId: "t" });

  // 用户明确拒绝 → user_declined(非通道故障)
  await assert.rejects(dispatch, /user_declined/);

  // 缺 token/响应缺失 → confirmation_unavailable(通道异常语义保留)
  confirmResponse = { approved: true };
  await assert.rejects(dispatch, /confirmation_unavailable/);
  confirmResponse = {};
  await assert.rejects(dispatch, /confirmation_unavailable/);
  // 有 token 但缺 approved 字段的畸形响应:不视为用户拒绝(#606 review 钉态)
  confirmResponse = { token: "t" };
  await assert.rejects(dispatch, /confirmation_unavailable/);
});

test("Agent scripts require confirmation and stay bound to the selected tab", async () => {
  const calls: any[] = []
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request)
    if (request.method === "policy:confirm") return { approved: true, token: "script-token" }
    return { status: "completed", value: { title: "Example" } }
  } })
  broker.setPluginState({ browserEnabled: true })

  const result = await broker.dispatch({
    method: "browser_run_script",
    params: { tabId: "tab-1", script: "return document.title", arg: null, timeout_ms: 1_000 },
    tabId: "tab-1",
    threadId: "thread-1",
    browserSessionId: "s",
    browserTurnId: "t",
  })

  assert.deepEqual(result, { status: "completed", value: { title: "Example" } })
  assert.equal(calls[0].method, "policy:confirm")
  assert.equal(calls[1].method, "agentScript:evaluate")
  assert.equal(calls[1].context.tabId, "tab-1")
  assert.equal(calls[1].params.__policyRequired, true)
  assert.equal(calls[1].params.__policyConfirmation, "script-token")
})

test("agent-created in-app tabs are bound to the owning thread workspace", async () => {
  const calls: any[] = [];
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request);
    return { tabId: "tab-1" };
  } });
  broker.setPluginState({ browserEnabled: true });

  await broker.dispatch({
    method: "create_tab",
    params: { options: {} },
    threadId: "thread-1",
    browserSessionId: "thread-1",
    browserTurnId: "run-1",
  });

  assert.equal(calls.at(-1).method, "ensure");
  assert.equal(calls.at(-1).params.ownerThreadId, "thread-1");
});

test("canonical BrowserClient commands select and normalize the requested backend", async () => {
  const mainCalls: any[] = []
  const extensionCalls: any[] = []
  const broker = new BrowserBroker(
    { request: async (request) => { mainCalls.push(request); return request.method === "handshake" ? { capabilities: [{ id: "advancedCdp" }] } : request.method === "policy:confirm" ? { approved: true, token: "token" } : request.method === "screenshot" ? "cG5n" : request.method === "elementScreenshot" ? { data: "ZWxlbWVudA==" } : { ok: true } } },
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
  assert.deepEqual(descriptors.map((descriptor) => [descriptor.type, descriptor.protocolVersion]), [["iab", 8], ["extension", 5]])
  assert.deepEqual(descriptors[0].capabilities.tab.map((capability: { id: string }) => capability.id), ["cdp"])
  assert.deepEqual(descriptors[1].capabilities.tab.map((capability: { id: string }) => capability.id), ["pageAssets", "cdp"])
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
  // #602:create_tab 带 url 会先插 policy:confirm/policy:consume 确认轮询，动作索引须将其滤除
  const isPolicyChatter = (request: { method: string }) =>
    request.method === "handshake" || request.method === "policy:confirm" || request.method === "policy:consume"
  const actionCall = (index: number) => mainCalls.filter((request) => !isPolicyChatter(request))[index]
  const actionCalls = mainCalls.filter((request) => !isPolicyChatter(request))
  assert.equal(actionCalls[0].method, "click")
  assert.equal(actionCalls[0].context.tabId, "tab-1")

  await broker.dispatch({ method: "playwright_locator_inner_text", params: { browserId: "lume-iab", tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "output" }] } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(actionCall(1).method, "locator:innerText")

  await broker.dispatch({ method: "browser_snapshot", params: { browserId: "lume-iab", tabId: "tab-1", interactive_only: true, limit: 200 }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(actionCall(2).method, "semanticSnapshot")
  assert.equal(actionCall(2).params.interactiveOnly, true)

  await broker.dispatch({ method: "playwright_locator_evaluate", params: { browserId: "lume-iab", tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "output" }] }, expression: "(element) => element.textContent", options: { timeoutMs: 321 } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(actionCall(3).method, "locator:evaluate")
  assert.equal(actionCall(3).params.timeoutMs, 321)

  await broker.dispatch({ method: "playwright_locator_click", params: { browserId: "lume-iab", tabId: "tab-1", selector: "iframe#preview >> internal:control=enter-frame >> internal:role=button[name=\"Save\"s]" }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(actionCall(4).params.locator.steps, [
    { kind: "frame", selector: "iframe#preview" },
    { kind: "role", role: "button", name: "Save", exact: true },
  ])

  await broker.dispatch({ method: "cua_keypress", params: { browserId: "lume-iab", tabId: "tab-1", key: "Enter" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(actionCall(5).method, "pressActive")

  const screenshot = await broker.dispatch({ method: "tab_screenshot", params: { browserId: "lume-iab", tabId: "tab-1" }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(screenshot, { data: "cG5n" })

  const elementScreenshot = await broker.dispatch({ method: "playwright_element_screenshot", params: { browserId: "lume-iab", tabId: "tab-1", options: { x: 10, y: 20 } }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(elementScreenshot, { dataBase64: "ZWxlbWVudA==" })

  await broker.dispatch({ method: "mark_tab", params: { browserId: "lume-iab", tab_id: "tab-1", status: "handoff" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(mainCalls.at(-1).method, "mark")
  assert.equal(mainCalls.at(-1).params.status, "handoff")

  await broker.dispatch({ method: "finalize_tabs", params: { browserId: "lume-iab", keep: [{ tab_id: "tab-1", status: "deliverable" }] }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(mainCalls.at(-1).params.keep, [{ tabId: "tab-1", status: "deliverable" }])

  const authOptions = {
    generation: 3,
    origin: "https://example.com",
    expiresAt: "2099-01-01T00:00:00.000Z",
    fields: [{ id: "username", selector: "#username" }],
  }
  await broker.dispatch({
    method: "tab_browser_auth_request",
    params: { browserId: "lume-extension", tabId: "chrome-tab:1", options: authOptions },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(extensionCalls.at(-1).method, "tab_browser_auth_request")
  assert.deepEqual(extensionCalls.at(-1).params.options, authOptions)

  mainCalls.length = 0
  const dialogBroker = new BrowserBroker({ request: async (request) => {
    mainCalls.push(request)
    if (request.method === "policy:confirm") return { approved: true, token: "content-export-token" }
    return request.method === "dialog:get" ? { id: "dialog-1", type: "prompt" } : {}
  } })
  dialogBroker.setPluginState({ browserEnabled: true })
  assert.deepEqual(
    await dialogBroker.dispatch({ method: "tab_get_js_dialog", params: { browserId: "lume-iab", tab_id: "tab-1" }, browserSessionId: "s", browserTurnId: "t" }),
    { dialog: { id: "dialog-1", type: "prompt" } },
  )
  await dialogBroker.dispatch({ method: "tab_handle_js_dialog", params: { browserId: "lume-iab", tab_id: "tab-1", dialog_id: "dialog-1", action: "accept", prompt_text: "Lume" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(mainCalls.at(-1).method, "dialog:handle")
  assert.deepEqual({ accept: mainCalls.at(-1).params.accept, dialogId: mainCalls.at(-1).params.dialogId, promptText: mainCalls.at(-1).params.promptText }, { accept: true, dialogId: "dialog-1", promptText: "Lume" })

  await dialogBroker.dispatch({ method: "tab_content_export", params: { browserId: "lume-iab", tab_id: "tab-1" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(mainCalls.at(-2).method, "policy:confirm")
  assert.equal(mainCalls.at(-1).method, "content:export")
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

test("browser continuity selects the visible resumable Agent tab owned by the task", async () => {
  const broker = new BrowserBroker({ request: async (request) => request.method === "list" ? [
    { tabId: "hidden-agent", ownerThreadId: "thread-1", profileKind: "agent", backend: "iab", generation: 1, title: "Old", url: "https://old.example/", visible: false, lifecycle: "background", handoffStatus: "handoff", lastOpenedAt: "2026-08-01T12:00:00.000Z" },
    { tabId: "visible-agent", ownerThreadId: "thread-1", profileKind: "agent", backend: "iab", generation: 1, title: "Current", url: "https://current.example/", visible: true, lifecycle: "active", handoffStatus: "deliverable", lastOpenedAt: "2026-08-01T11:00:00.000Z" },
    { tabId: "other-agent", ownerThreadId: "thread-2", profileKind: "agent", backend: "iab", generation: 1, title: "Other", url: "https://other.example/", visible: true, lifecycle: "active", handoffStatus: "deliverable" },
    { tabId: "user-tab", ownerThreadId: "thread-1", profileKind: "user", backend: "iab", generation: 1, title: "User", url: "https://user.example/", visible: true, lifecycle: "active", handoffStatus: "deliverable" },
  ] : {} })
  broker.setPluginState({ browserEnabled: true })

  assert.deepEqual(await broker.getThreadAgentContinuity("thread-1"), {
    tabId: "visible-agent",
    ownerThreadId: "thread-1",
    profileKind: "agent",
    backend: "iab",
    generation: 1,
    title: "Current",
    url: "https://current.example/",
    visible: true,
    lifecycle: "active",
    handoffStatus: "deliverable",
    lastOpenedAt: "2026-08-01T11:00:00.000Z",
  })
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
  assert.deepEqual(descriptor.capabilities.tab.map((capability: { id: string }) => capability.id), ["pageAssets"])
  assert.equal(descriptor.apiSupportOverrides["CdpCapability.readEvents"], false)

  const result = await broker.dispatch({
    method: "browser_user_history",
    params: {
      options: {
        text: "example",
        maxResults: 25,
        startTime: Date.parse("2026-07-01T00:00:00.000Z"),
        endTime: Date.parse("2026-08-01T00:00:00.000Z"),
      },
    },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "history:list")
  assert.deepEqual(
    { query: calls.at(-1).params.query, limit: calls.at(-1).params.limit, from: calls.at(-1).params.from, to: calls.at(-1).params.to },
    { query: "example", limit: 25, from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
  )
  assert.deepEqual(result, { items: [{ url: "https://example.com/", title: "Example", dateVisited: "2026-07-30T00:00:00.000Z" }] })

  await broker.dispatch({ method: "tab_page_assets_list", params: { tabId: "tab-1" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-1).method, "pageAssets:list")

  await broker.dispatch({ method: "tab_content", params: { tabId: "tab-1", content_type: "html" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-1).method, "content")
  assert.equal(calls.at(-1).params.format, "html")

  await broker.dispatch({
    method: "tab_browser_auth_request",
    params: {
      tabId: "tab-1",
      options: {
        generation: 2,
        origin: "https://example.com",
        expiresAt: "2099-01-01T00:00:00.000Z",
        fields: [],
        options: [{
          id: "google",
          label: "Google",
          field_ids: [],
          selector: { ast: { version: 1, steps: [{ kind: "role", role: "button", name: "Google" }] } },
        }],
      },
    },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-1).method, "browserAuth:request")
  assert.equal(calls.at(-1).params.generation, 2)
  assert.deepEqual(calls.at(-1).params.options, [{
    id: "google",
    label: "Google",
    field_ids: [],
    selector: { ast: { version: 1, steps: [{ kind: "role", role: "button", name: "Google" }] } },
    fields: [],
    locator: { version: 1, steps: [{ kind: "role", role: "button", name: "Google" }] },
  }])

  await broker.dispatch({ method: "tabs_content", params: { options: { urls: ["https://example.com/"], contentType: "html", timeoutMs: 30_000 } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-1).method, "tabs:content")
  assert.deepEqual(
    { contentType: calls.at(-1).params.contentType, timeoutMs: calls.at(-1).params.timeoutMs },
    { contentType: "html", timeoutMs: 30_000 },
  )

  await broker.dispatch({ method: "tab_page_assets_bundle", params: { tabId: "tab-1", options: { inventoryId: "inventory-1", assetIds: ["asset-1"] } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "pageAssets:bundle")
  assert.equal(calls.at(-1).params.inventoryId, "inventory-1")
  assert.deepEqual(calls.at(-1).params.assetIds, ["asset-1"])

  await broker.dispatch({ method: "dom_cua_scroll", params: { tabId: "tab-1", node_id: "node-1", x: 10, y: 20 }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(calls.at(-1).method, "dom:scroll")
  assert.deepEqual(
    { nodeId: calls.at(-1).params.nodeId, scrollX: calls.at(-1).params.scrollX, scrollY: calls.at(-1).params.scrollY },
    { nodeId: "node-1", scrollX: 10, scrollY: 20 },
  )

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

test("broker preserves canonical download handles and their originating tab", async () => {
  const calls: any[] = []
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request)
    if (request.method === "policy:confirm") return { approved: true, token: "download-token" }
    return { path: "C:\\downloads\\report.pdf" }
  } })
  broker.setPluginState({ browserEnabled: true })

  await broker.dispatch({
    method: "playwright_download_path",
    params: { tabId: "tab-1", downloadId: "download-1", options: { timeoutMs: 5_000 } },
    browserSessionId: "s",
    browserTurnId: "t",
  })

  assert.equal(calls.at(-1).method, "download:path")
  assert.deepEqual(
    { tabId: calls.at(-1).params.tabId, downloadId: calls.at(-1).params.downloadId, timeoutMs: calls.at(-1).params.timeoutMs },
    { tabId: "tab-1", downloadId: "download-1", timeoutMs: 5_000 },
  )
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

test("broker strips caller-supplied reserved params before injecting its own", async () => {
  const calls: any[] = []
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request)
    if (request.method === "policy:confirm") return { approved: true, token: "reserved-token" }
    return {}
  } })
  broker.setPluginState({ browserEnabled: true })

  // canonical 方法名绕过 upload 授权函数（其精确匹配 playwright_file_chooser_set_files），
  // 注入的 __authorizedFiles 不得透传到 Desktop
  await broker.dispatch({
    method: "filechooser:setFiles",
    params: { tabId: "tab-1", fileChooserId: "chooser-1", __authorizedFiles: ["C:\\outside-task.txt"] },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "filechooser:setFiles")
  assert.equal(calls.at(-1).params.__authorizedFiles, undefined)
  assert.equal(calls.at(-1).params.__policyRequired, true)

  await broker.dispatch({
    method: "tab_url",
    params: { tabId: "tab-1", __policyRequired: true, __policyConfirmation: "forged", __policyBindingHash: "forged", __authorizedFiles: ["C:\\outside-task.txt"] },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-1).method, "url")
  for (const key of Object.keys(calls.at(-1).params)) {
    assert.equal(key.startsWith("__"), false, `reserved key leaked: ${key}`)
  }

  // 正常 upload 链路的授权注入不受影响：browser-download refs 保留，授权路径照常携带
  await broker.dispatch({
    method: "playwright_file_chooser_set_files",
    params: { tabId: "tab-1", file_chooser_id: "chooser-1", files: ["browser-download:00000000-0000-0000-0000-000000000001"] },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  assert.equal(calls.at(-1).params.__policyRequired, true)
  assert.deepEqual(calls.at(-1).params.files, ["browser-download:00000000-0000-0000-0000-000000000001"])
  assert.deepEqual(calls.at(-1).params.__authorizedFiles, [])
})

test("broker confirms secret filling while never accepting a secret value", async () => {
  const calls: any[] = []
  const broker = new BrowserBroker({ request: async (request) => {
    calls.push(request)
    if (request.method === "policy:confirm") return { approved: true, token: "credential-token" }
    if (request.method === "secrets:list") return [{ id: "secret-1", origin: "https://example.test", username: "alice" }]
    return { status: "submitted" }
  } })
  broker.setPluginState({ browserEnabled: true })

  const listed = await broker.dispatch({
    method: "browser_list_secrets",
    params: { tabId: "tab-1" },
    browserSessionId: "s",
    browserTurnId: "t",
  })
  await broker.dispatch({
    method: "browser_fill_secret",
    params: { tabId: "tab-1", secret_id: "secret-1", semanticRef: "e1", semanticSnapshotId: "snap-1" },
    browserSessionId: "s",
    browserTurnId: "t",
  })

  assert.deepEqual(listed, [{ id: "secret-1", origin: "https://example.test", username: "alice" }])
  assert.equal(calls.at(-2).method, "policy:confirm")
  assert.equal(calls.at(-1).method, "secretFill")
  assert.equal(calls.at(-1).params.secretId, "secret-1")
  assert.equal(JSON.stringify(calls).includes("password-value"), false)
})

test("iab descriptor keeps internal WebMCP out of public capabilities", () => {
  const broker = new BrowserBroker({ request: async () => ({}) })
  broker.setPluginState({ browserEnabled: true })
  const runtime = { capabilities: [
    { id: "tabs", description: "Tabs" },
    { id: "navigation", description: "Navigation" },
    { id: "webmcp", description: "WebMCP tools" },
    { id: "advancedCdp", description: "Advanced CDP" },
  ] }
  const descriptor = broker.descriptor("iab", runtime as any)
  const browserCapabilityIds = descriptor.capabilities.browser.map((c: { id: string }) => c.id)
  assert.ok(!browserCapabilityIds.includes("webmcp"), "WebMCP should not be advertised as a browser capability")
  assert.ok(!browserCapabilityIds.includes("advancedCdp"), "advancedCdp 仍应被剥离")
  const tabCapabilityIds = descriptor.capabilities.tab.map((c: { id: string }) => c.id)
  assert.ok(!tabCapabilityIds.includes("webmcp"), "WebMCP should not be advertised as a tab capability")
})

test("iab descriptor default (no runtime) still excludes webmcp from browser capabilities", () => {
  // 默认 iab capability 列表（runtime 缺省）本就不含 webmcp；此用例锁定缺省不变性。
  const broker = new BrowserBroker({ request: async () => ({}) })
  broker.setPluginState({ browserEnabled: true })
  const descriptor = broker.descriptor("iab")
  const browserCapabilityIds = descriptor.capabilities.browser.map((c: { id: string }) => c.id)
  assert.ok(!browserCapabilityIds.includes("webmcp"), "缺省 iab browser capabilities 不应凭空出现 webmcp")
})
