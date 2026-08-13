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
          apiSupportOverrides: {},
        }];
      }
      if (method === "create_tab") return { id: "tab-1" };
      if (method === "tab_title") return { title: "百度一下" };
      if (method === "tab_url") return { url: "https://www.baidu.com/" };
      if (method === "playwright_dom_snapshot") return { dom_snapshot: "search page" };
      if (method === "playwright_locator_count") return { count: 1 };
      return {};
    },
  },
};

const { setupLumeBrowserRuntime } = await import("./browser-client.mjs");

test("adapts Broker result envelopes to the canonical BrowserClient API", async () => {
  const globals = {};
  await setupLumeBrowserRuntime({ globals });
  const browser = await globals.agent.browsers.getDefault();
  const tab = await browser.tabs.new();

  assert.equal(tab.id, "tab-1");
  assert.equal(await tab.title(), "百度一下");
  assert.equal(await tab.url(), "https://www.baidu.com/");
  assert.equal(await tab.playwright.domSnapshot(), "search page");
  assert.equal(await tab.playwright.getByRole("textbox").count(), 1);
  assert.deepEqual(calls.map((call) => call.method), [
    "runtime_list_browsers",
    "create_tab",
    "tab_title",
    "tab_url",
    "playwright_dom_snapshot",
    "playwright_locator_count",
  ]);
});
