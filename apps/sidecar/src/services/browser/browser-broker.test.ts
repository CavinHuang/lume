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
  assert.equal(broker.listBackends().some((backend) => backend.backend === "extension"), true);
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
    { request: async (request) => { mainCalls.push(request); return request.method === "handshake" ? { capabilities: [{ id: "advancedCdp" }] } : request.method === "screenshot" ? "cG5n" : { ok: true } } },
    { isAvailable: () => true, request: async (request) => { extensionCalls.push(request); return { tabId: "chrome-tab:1" } } },
  )
  broker.setPluginState({ browserEnabled: true, chromeEnabled: true, extensionBackendEnabled: true, hostConnected: true })

  const descriptors = await broker.dispatch({ method: "runtime_list_browsers", browserSessionId: "s", browserTurnId: "t" }) as any[]
  assert.deepEqual(descriptors.map((descriptor) => [descriptor.type, descriptor.protocolVersion]), [["iab", 5], ["extension", 5]])
  assert.deepEqual(descriptors[0].capabilities.tab.map((capability: { id: string }) => capability.id), ["cdp"])

  await broker.dispatch({ method: "create_tab", params: { browserId: "lume-extension", options: { url: "https://example.com" } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(extensionCalls[0].method, "ensure")
  assert.equal(extensionCalls[0].params.url, "https://example.com")

  await broker.dispatch({ method: "playwright_locator_click", params: { browserId: "lume-iab", tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "button" }] } }, browserSessionId: "s", browserTurnId: "t" })
  const actionCalls = mainCalls.filter((request) => request.method !== "handshake")
  assert.equal(actionCalls[0].method, "click")
  assert.equal(actionCalls[0].context.tabId, "tab-1")

  await broker.dispatch({ method: "playwright_locator_inner_text", params: { browserId: "lume-iab", tabId: "tab-1", locator: { version: 1, steps: [{ kind: "css", selector: "output" }] } }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(mainCalls.filter((request) => request.method !== "handshake")[1].method, "locator:innerText")

  await broker.dispatch({ method: "cua_keypress", params: { browserId: "lume-iab", tabId: "tab-1", key: "Enter" }, browserSessionId: "s", browserTurnId: "t" })
  assert.equal(mainCalls.filter((request) => request.method !== "handshake")[2].method, "pressActive")

  const screenshot = await broker.dispatch({ method: "tab_screenshot", params: { browserId: "lume-iab", tabId: "tab-1" }, browserSessionId: "s", browserTurnId: "t" })
  assert.deepEqual(screenshot, { dataBase64: "cG5n" })
});
