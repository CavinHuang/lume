import assert from "node:assert/strict";
import test from "node:test";

const calls = [];
const images = [];
const descriptors = [
  {
    id: "lume-iab",
    name: "Lume 内置浏览器",
    type: "iab",
    protocolVersion: 8,
    minSupported: 5,
    maxSupported: 8,
    generation: 1,
    capabilities: {
      browser: [{ id: "visibility", description: "visibility" }],
      tab: [{ id: "pageAssets", description: "page assets" }],
    },
    apiSupportOverrides: { "BrowserUser.history": true, "Tabs.content": true, "PlaywrightFileChooser.setFiles": true },
  },
  {
    id: "lume-extension",
    name: "Chrome",
    type: "extension",
    protocolVersion: 5,
    minSupported: 5,
    maxSupported: 5,
    generation: 1,
    capabilities: { browser: [], tab: [] },
    apiSupportOverrides: {},
  },
];
globalThis.nodeRepl = {
  async emitImage(bytes, mimeType) {
    images.push({ bytes: Buffer.from(bytes), mimeType });
  },
  browser: {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "runtime_list_browsers") return descriptors;
      if (method === "runtime_ping") return String(params.clientType).includes("extension") ? descriptors[1] : descriptors[0];
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
      if (method === "tabs_content") return [{ url: "https://example.com/", title: "Example", content: "ok" }];
      if (method === "browser_visibility_get") return { visible: false };
      if (method === "tab_page_assets_bundle") return { assetId: "asset-1" };
      if (method === "playwright_wait_for_download") return { download_id: "download-1", filename: "report.pdf" };
      if (method === "playwright_download_path") return { path: "C:\\downloads\\report.pdf" };
      if (method === "playwright_wait_for_file_chooser") return { file_chooser_id: "chooser-1", is_multiple: true };
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
  assert.equal(images.at(-1)?.mimeType, "image/png");
  assert.equal(images.at(-1)?.bytes.toString("utf8"), "png");
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

test("uses canonical backend selection and request shapes", async () => {
  calls.length = 0;
  images.length = 0;
  const globals = {};
  await setupLumeBrowserRuntime({ globals });

  assert.equal((await globals.agent.browsers.get("lume-extension")).browserId, "lume-extension");
  assert.equal((await globals.agent.browsers.getForUrl("https://example.com/")).browserId, "lume-extension");
  assert.equal((await globals.agent.browsers.getForUrl("http://localhost:3000/")).browserId, "lume-iab");

  const browser = await globals.agent.browsers.get("lume-iab");
  const tab = await browser.tabs.new({ url: "https://example.com/" });
  await tab.screenshot({ fullPage: true });
  await browser.tabs.content({ urls: ["https://example.com/"], contentType: "html", timeoutMs: 30_000 });
  await tab.playwright.waitForURL("**/done", { timeoutMs: 250 });
  const visibility = await browser.capabilities.get("visibility");
  assert.equal(await visibility.get(), false);
  const pageAssets = await tab.capabilities.get("pageAssets");
  await pageAssets.bundle({ inventoryId: "inventory-1", assetIds: ["asset-1"] });
  const download = await tab.playwright.waitForEvent("download");
  assert.equal(await download.path(), "C:\\downloads\\report.pdf");
  const fileChooser = await tab.playwright.waitForEvent("filechooser");
  assert.equal(fileChooser.isMultiple(), true);
  await fileChooser.setFiles(["browser-download:00000000-0000-0000-0000-000000000001"]);

  assert.deepEqual(calls.find((call) => call.method === "create_tab")?.params.options, { url: "https://example.com/" });
  assert.deepEqual(calls.find((call) => call.method === "tab_screenshot")?.params.options, { fullPage: true });
  assert.deepEqual(calls.find((call) => call.method === "tabs_content")?.params.options, {
    urls: ["https://example.com/"], contentType: "html", timeoutMs: 30_000,
  });
  assert.deepEqual(calls.find((call) => call.method === "playwright_wait_for_url")?.params.options, { timeoutMs: 250 });
  assert.deepEqual(calls.find((call) => call.method === "tab_page_assets_bundle")?.params.options, {
    inventoryId: "inventory-1", assetIds: ["asset-1"],
  });
  const downloadPath = calls.find((call) => call.method === "playwright_download_path")?.params;
  assert.equal(downloadPath.downloadId, "download-1");
  assert.equal(downloadPath.tabId, "tab-1");
  assert.equal(calls.find((call) => call.method === "playwright_file_chooser_set_files")?.params.chooserId, "chooser-1");
});
