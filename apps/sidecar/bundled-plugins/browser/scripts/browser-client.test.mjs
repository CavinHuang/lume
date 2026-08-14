import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
globalThis.nodeRepl = {
  browser: {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "runtime_list_browsers") {
        return [{
          id: "lume-iab",
          name: "Lume 内置浏览器",
          type: "iab",
          protocolVersion: 8,
          minSupported: 8,
          maxSupported: 8,
          generation: 1,
          capabilities: { browser: [], tab: [] },
          apiSupportOverrides: { "BrowserUser.history": true },
        }];
      }
      if (method === "create_tab") return { id: "tab-1" };
      if (method === "tab_title") return { title: "百度一下" };
      if (method === "tab_url") return { url: "https://www.baidu.com/" };
      if (method === "playwright_dom_snapshot") return { dom_snapshot: "search page" };
      if (method === "playwright_locator_count") return { count: 1 };
      if (method === "tab_screenshot") return { data: "cG5n" };
      if (method === "browser_user_history") {
        return { items: [{ url: "https://example.com/", title: "Example", dateVisited: "2026-08-13T00:00:00.000Z" }] };
      }
      if (method === "tab_js_dialog_get") return { dialog: { id: "dialog-1", type: "confirm" } };
      if (method === "tab_js_dialog_handle") return {};
      return {};
    },
  },
};

const { setupLumeBrowserRuntime } = await import("./browser-client.mjs");

test("adapts Broker result envelopes to the canonical BrowserClient API", async () => {
  const globals = {};
  await setupLumeBrowserRuntime({ globals });
  const browser = await globals.agent.browsers.getDefault();
  const tab = await browser.tabs.new({ sessionKind: "agent-task" });

  assert.equal(tab.id, "tab-1");
  assert.equal(calls.find((call) => call.method === "create_tab").params.options.sessionKind, "agent-task");
  assert.equal(await tab.title(), "百度一下");
  assert.equal(await tab.url(), "https://www.baidu.com/");
  assert.equal(await tab.playwright.domSnapshot(), "search page");
  assert.equal(await tab.playwright.getByRole("textbox").count(), 1);
  assert.equal(Buffer.from(await tab.screenshot()).toString("utf8"), "png");
  assert.deepEqual(await browser.user.history({ queries: ["example"] }), [{
    url: "https://example.com/",
    title: "Example",
    dateVisited: "2026-08-13T00:00:00.000Z",
  }]);
  const dialog = await tab.getJsDialog();
  await dialog.accept();
  const dialogHandle = calls.find((call) => call.method === "tab_js_dialog_handle");
  assert.equal(dialogHandle.params.dialogId, "dialog-1");
  assert.equal(dialogHandle.params.action, "accept");
  assert.deepEqual(calls.map((call) => call.method), [
    "runtime_list_browsers",
    "create_tab",
    "tab_title",
    "tab_url",
    "playwright_dom_snapshot",
    "playwright_locator_count",
    "tab_screenshot",
    "browser_user_history",
    "tab_js_dialog_get",
    "tab_js_dialog_handle",
  ]);
});
