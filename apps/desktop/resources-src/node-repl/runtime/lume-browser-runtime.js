// Lume 浏览器运行时高层 API —— 镜像 OpenAI Codex browser-client.mjs
//
// 把 worker 沙箱里的低层 nodeRepl.browser.request(method, params) 封装成
// agent.browsers / browser / tab 链式 API，让 agent 代码写法对齐 Codex：
//   const iab = await agent.browsers.get("iab");
//   const tab = await iab.tabs.new();
//   await tab.goto(url);
//   await tab.playwright.getByRole("button", { name: "Login" }).click();
//   await tab.screenshot();  // 自动 emitImage，模型直接看到页面
//
// 每个 method 一对一映射到 Lume broker 已有的 method 名（见 browser-broker.ts
// normalizeBrowserCommand）。本文件不引入任何新后端能力，纯封装。
//
// 通过 worker.js 调 createLumeBrowserRuntime(trustedNodeRepl) 注入沙箱。

// ---- selector 编码（对齐 browserClientSelectorToLocator 解析格式）----

function encodeSelectorString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}
function roleSelector(role, opts = {}) {
  if (opts.name === undefined) return `internal:role=${role}`
  const flag = opts.exact ? "s" : "i"
  return `internal:role=${role}[name="${encodeSelectorString(opts.name)}"${flag}]`
}
function textSelector(text, opts = {}, kind = "text") {
  const flag = opts.exact ? "s" : "i"
  return `internal:${kind}="${encodeSelectorString(text)}"${flag}`
}
function placeholderSelector(text, opts = {}) {
  const flag = opts.exact ? "s" : "i"
  return `internal:attr=[placeholder="${encodeSelectorString(text)}"${flag}]`
}
function testIdSelector(testId) {
  return `internal:testid=[data-testid="${encodeSelectorString(testId)}"s]`
}

function asTabArray(result) {
  if (Array.isArray(result)) return result
  if (result && Array.isArray(result.tabs)) return result.tabs
  return []
}
function asTabId(result, fallback) {
  if (typeof result === "string") return result
  if (result && typeof result === "object") {
    return result.tabId ?? result.id ?? result.tab_id ?? (Array.isArray(result.tabs) && result.tabs[0]?.tabId) ?? fallback
  }
  return fallback
}

// ---- 运行时工厂 ----

export function createLumeBrowserRuntime(nodeRepl) {
  const req = (method, params = {}) => nodeRepl.browser.request(method, params)

  const base64ToBytes = (b64) => {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    return bytes
  }

  // tab_screenshot / elementScreenshot 拿到 base64 后自动 emitImage，
  // 让模型无需手动 nodeRepl.emitImage 即可看到页面（对齐 Codex displayImage→emitImage）
  async function emitScreenshotImage(result) {
    const data = result?.data ?? result?.dataBase64
    if (typeof data === "string" && data.length > 0) {
      try {
        await nodeRepl.emitImage(base64ToBytes(data), "image/png")
      } catch {
        // emitImage 失败不应阻断截图返回值
      }
    }
    return result
  }

  function makeLocator(tabId, selector) {
    const base = { tabId, selector }
    const withOpts = (opts) => ({ ...base, ...(opts || {}) })
    return {
      click: (opts) => req("playwright_locator_click", withOpts(opts)),
      dblclick: (opts) => req("playwright_locator_dblclick", withOpts(opts)),
      hover: () => req("playwright_locator_hover", base),
      fill: (text, opts) => req("playwright_locator_fill", { ...base, text: text ?? opts?.value, ...(opts || {}) }),
      type: (text, opts) => req("playwright_locator_type", { ...base, text: text ?? opts?.value, ...(opts || {}) }),
      press: (key, opts) => req("playwright_locator_press", { ...base, key, ...(opts || {}) }),
      check: () => req("playwright_locator_check", base),
      uncheck: () => req("playwright_locator_uncheck", base),
      setChecked: (checked, opts) => req("playwright_locator_set_checked", { ...base, checked: checked !== false, ...(opts || {}) }),
      selectOption: (value, opts) => req("playwright_locator_select_option", { ...base, selections: value, ...(opts || {}) }),
      scroll: (opts) => req("playwright_locator_scroll", withOpts(opts)),
      getAttribute: (name, opts) => req("playwright_locator_get_attribute", { ...base, name, ...(opts || {}) }),
      innerText: (opts) => req("playwright_locator_inner_text", withOpts(opts)),
      textContent: (opts) => req("playwright_locator_text_content", withOpts(opts)),
      textContents: () => req("playwright_locator_all_text_contents", base),
      inputValue: (opts) => req("playwright_locator_input_value", withOpts(opts)),
      count: () => req("playwright_locator_count", base),
      isVisible: () => req("playwright_locator_is_visible", base),
      isEnabled: () => req("playwright_locator_is_enabled", base),
      isChecked: () => req("playwright_locator_is_checked", base),
      evaluate: (fn, arg, opts) => req("playwright_locator_evaluate", { ...base, fn: String(fn), arg, ...(opts || {}) }),
      waitFor: (opts) => req("playwright_locator_wait_for", { ...base, ...(opts || {}) }),
      readAll: () => req("playwright_locator_read_all", base),
      downloadMedia: (opts) => req("playwright_locator_download_media", { ...base, ...(opts || {}) }),
    }
  }

  function makePlaywright(tabId) {
    return {
      locator: (selector) => makeLocator(tabId, selector),
      getByRole: (role, opts) => makeLocator(tabId, roleSelector(role, opts)),
      getByText: (text, opts) => makeLocator(tabId, textSelector(text, opts, "text")),
      getByLabel: (text, opts) => makeLocator(tabId, textSelector(text, opts, "label")),
      getByPlaceholder: (text, opts) => makeLocator(tabId, placeholderSelector(text, opts)),
      getByTestId: (testId) => makeLocator(tabId, testIdSelector(testId)),
      domSnapshot: (opts) => req("playwright_dom_snapshot", { tabId, ...(opts || {}) }),
      elementInfo: (opts) => req("playwright_element_info", { tabId, ...(opts || {}) }),
      elementScreenshot: async (opts) => emitScreenshotImage(await req("playwright_element_screenshot", { tabId, ...(opts || {}) })),
      evaluate: (fn, arg, opts) => req("playwright_evaluate", { tabId, fn: String(fn), arg, ...(opts || {}) }),
      waitForDownload: (opts) => req("playwright_wait_for_download", { tabId, ...(opts || {}) }),
      downloadPath: (opts) => req("playwright_download_path", { tabId, ...(opts || {}) }),
      waitForFileChooser: (opts) => req("playwright_wait_for_file_chooser", { tabId, ...(opts || {}) }),
      fileChooserSetFiles: (opts) => req("playwright_file_chooser_set_files", { tabId, ...(opts || {}) }),
      // wait 系：Lume locator 不内置 auto-wait，显式 wait 让 navigate/操作后页面就绪
      waitForLoadState: (opts) => req("playwright_wait_for_load_state", { tabId, ...(opts || {}) }),
      waitForURL: (url, opts) => req("playwright_wait_for_url", { tabId, url, ...(opts || {}) }),
      waitForTimeout: (ms) => req("playwright_wait_for_timeout", { tabId, timeoutMs: ms }),
    }
  }

  function makeCua(tabId) {
    return {
      click: (opts) => req("cua_click", { tabId, ...(opts || {}) }),
      doubleClick: (opts) => req("cua_double_click", { tabId, ...(opts || {}) }),
      type: (opts) => req("cua_type", { tabId, ...(opts || {}) }),
      keypress: (opts) => req("cua_keypress", { tabId, ...(opts || {}) }),
      scroll: (opts) => req("cua_scroll", { tabId, ...(opts || {}) }),
      move: (opts) => req("cua_move", { tabId, ...(opts || {}) }),
      drag: (opts) => req("cua_drag", { tabId, ...(opts || {}) }),
      downloadMedia: (opts) => req("cua_download_media", { tabId, ...(opts || {}) }),
    }
  }

  function makeDomCua(tabId) {
    return {
      click: (opts) => req("dom_cua_click", { tabId, ...(opts || {}) }),
      doubleClick: (opts) => req("dom_cua_double_click", { tabId, ...(opts || {}) }),
      type: (opts) => req("dom_cua_type", { tabId, ...(opts || {}) }),
      keypress: (opts) => req("dom_cua_keypress", { tabId, ...(opts || {}) }),
      scroll: (opts) => req("dom_cua_scroll", { tabId, ...(opts || {}) }),
      getVisibleDom: () => req("dom_cua_get_visible_dom", { tabId }),
      downloadMedia: (opts) => req("dom_cua_download_media", { tabId, ...(opts || {}) }),
    }
  }

  function makeTabCapability(tabId) {
    return async (cap) => {
      switch (cap) {
        case "cdp":
          return { send: (method, params) => req("tab_cdp_send", { tabId, method, params }) }
        case "webmcp":
          return {
            listTools: () => req("webmcp_list_tools", { tabId }),
            invokeTool: (opts) => req("webmcp_invoke_tool", { tabId, ...(opts || {}) }),
          }
        case "pageAssets":
          return {
            list: () => req("tab_page_assets_list", { tabId }),
            bundle: (opts) => req("tab_page_assets_bundle", { tabId, ...(opts || {}) }),
          }
        case "browserAuth":
          return { request: (r) => req("tab_browser_auth_request", { tabId, ...(r || {}) }) }
        case "dev":
          return { logs: () => req("tab_dev_logs", { tabId }) }
        default:
          throw new Error(`unsupported tab capability: ${cap}`)
      }
    }
  }

  function makeTab(tabId, browserId) {
    return {
      id: tabId,
      browserId,
      goto: (url) => req("navigate_tab_url", { tabId, url }),
      back: () => req("navigate_tab_back", { tabId }),
      forward: () => req("navigate_tab_forward", { tabId }),
      reload: () => req("navigate_tab_reload", { tabId }),
      close: () => req("close_tab", { tabId }),
      url: async () => (await req("get_tab", { tabId }))?.url,
      title: async () => (await req("get_tab", { tabId }))?.title,
      content: (opts) => req("tab_content", { tabId, ...(opts || {}) }),
      screenshot: async (opts) => emitScreenshotImage(await req("tab_screenshot", { tabId, ...(opts || {}) })),
      markDeliverable: () => req("mark_tab", { tabId, status: "deliverable" }),
      markHandoff: () => req("mark_tab", { tabId, status: "handoff" }),
      // JS dialog（alert/confirm/prompt）处理：遇弹窗先 getJsDialog 再 handleJsDialog，否则操作被阻塞
      getJsDialog: () => req("tab_get_js_dialog", { tabId }),
      handleJsDialog: (opts) => req("tab_handle_js_dialog", { tabId, ...(opts || {}) }),
      exportContent: (opts) => req("tab_content_export", { tabId, ...(opts || {}) }),
      clipboard: {
        read: () => req("tab_clipboard_read", { tabId }),
        readText: () => req("tab_clipboard_read_text", { tabId }),
        write: (opts) => req("tab_clipboard_write", { tabId, ...(opts || {}) }),
        writeText: (text) => req("tab_clipboard_write_text", { tabId, text }),
      },
      dev: { logs: () => req("tab_dev_logs", { tabId }) },
      playwright: makePlaywright(tabId),
      cua: makeCua(tabId),
      dom_cua: makeDomCua(tabId),
      capabilities: {
        get: makeTabCapability(tabId),
        list: async () => ["cdp", "webmcp", "pageAssets", "browserAuth", "dev"],
      },
    }
  }

  function makeBrowser(browserId, type = "iab", name = "Lume Browser") {
    return {
      browserId,
      type,
      name,
      user: {
        openTabs: async () => asTabArray(await req("browser_user_open_tabs", { browserId })),
        claimTab: (tab) =>
          req("browser_user_claim_tab", {
            browserId,
            providerTabId: tab?.providerTabId ?? tab?.id ?? tab,
            title: tab?.title,
            url: tab?.url,
          }),
        history: (opts) => req("browser_user_history", { browserId, ...(opts || {}) }),
      },
      tabs: {
        list: async () => asTabArray(await req("list_tabs", { browserId })),
        get: (tabId) => makeTab(tabId, browserId),
        new: async (opts) => makeTab(asTabId(await req("create_tab", { browserId, ...(opts || {}) }), opts?.tabId), browserId),
        selected: async () => {
          const r = await req("selected_tab", { browserId })
          const tabId = asTabId(r)
          return tabId ? makeTab(tabId, browserId) : undefined
        },
        finalize: (opts) => req("finalize_tabs", { browserId, ...(opts || {}) }),
        release: (opts) => req("release_tabs", { browserId, ...(opts || {}) }),
        resumeHandoff: (opts) => req("resume_handoff_tabs", { browserId, ...(opts || {}) }),
        content: (opts) => req("tabs_content", { browserId, ...(opts || {}) }),
      },
      capabilities: {
        list: async () => [
          { id: "visibility", description: "Show or hide the browser" },
          { id: "viewport", description: "Set the viewport size" },
        ],
        get: async (cap) => {
          switch (cap) {
            case "visibility":
              return {
                get: () => req("browser_visibility_get", { browserId }),
                set: (visible) => req("browser_visibility_set", { browserId, visible }),
              }
            case "viewport":
              return {
                set: (opts) => req("browser_viewport_set", { browserId, ...(opts || {}) }),
                reset: () => req("browser_viewport_reset", { browserId }),
              }
            default:
              throw new Error(`unsupported browser capability: ${cap}`)
          }
        },
      },
      nameSession: (name) => req("browser_name_session", { browserId, name }),
      documentation: async () => LUME_BROWSER_DOC,
    }
  }

  const browsersApi = {
    list: async () => [
      {
        id: "iab",
        type: "iab",
        name: "Lume Browser",
        family: "iab",
        capabilities: {
          browser: [{ id: "visibility", description: "Show or hide the browser" }, { id: "viewport", description: "Set the viewport size" }],
          tab: [{ id: "cdp", description: "Raw CDP access" }, { id: "webmcp", description: "Page-defined MCP tools" }],
        },
      },
    ],
    get: async (id) => {
      const normalized = String(id || "").toLowerCase()
      if (normalized === "extension" || normalized === "chrome") {
        return makeBrowser("extension", "extension", "Chrome")
      }
      return makeBrowser("iab", "iab", "Lume Browser")
    },
    getDefault: async () => makeBrowser("iab", "iab", "Lume Browser"),
    getForUrl: async () => makeBrowser("iab", "iab", "Lume Browser"),
  }

  const documentationApi = {
    get: async (name) => {
      if (name === "browser" || name === "control-chrome" || name === "iab" || name === "bootstrap") return LUME_BROWSER_DOC
      return `Unknown documentation topic: ${name}`
    },
  }

  async function setupBrowserRuntime() {
    return { browsers: browsersApi, documentation: documentationApi }
  }

  return { setupBrowserRuntime, makeBrowser, makeTab }
}

// agent.browsers.get(...).documentation() 与 agent.documentation.get("browser") 的返回内容
const LUME_BROWSER_DOC = `# Lume Browser

Control the in-app browser via the agent.browsers API (mirrors the Codex browser-client surface).

## Bootstrap (once per node_repl session)
if (globalThis.agent == null) globalThis.agent = await setupBrowserRuntime();

## Select a browser
globalThis.iab = await agent.browsers.get("iab");        // in-app browser
nodeRepl.write(await iab.documentation());               // read once, reuse binding

## Tabs
const tab = await iab.tabs.new();                        // new tab
await tab.goto("https://example.com");
await tab.back(); await tab.forward(); await tab.reload();
const url = await tab.url(); const title = await tab.title();
await tab.close();

## Read the page
const dom = await tab.playwright.domSnapshot();          // accessibility/DOM snapshot (text)
const shot = await tab.screenshot();                     // screenshot auto-emitted to the model as an image

## Interact (Playwright locators)
await tab.playwright.getByRole("button", { name: "Sign in" }).click();
await tab.playwright.getByLabel("Email").fill("user@example.com");
await tab.playwright.locator("#password").fill(secret);
await tab.playwright.getByRole("checkbox").check();
await tab.playwright.getByText("Continue").click();

Locator methods: click, dblclick, fill, type, press, check, uncheck, hover, scroll,
selectOption, getAttribute, innerText, textContents, inputValue, count, isVisible,
isEnabled, isChecked, evaluate, waitFor, readAll.

## Wait for page readiness (IMPORTANT: Lume locators do NOT auto-wait)
await tab.goto(url); await tab.playwright.waitForLoadState();   // always after navigation
await tab.playwright.waitForURL("**/dashboard");                // wait for a route
await tab.playwright.getByRole("button", { name: "Continue" }).waitFor();  // wait for element
await tab.playwright.waitForTimeout(500);                       // fixed delay, last resort

## JavaScript dialogs (alert/confirm/prompt block all page actions)
const dialog = await tab.getJsDialog();
if (dialog) await tab.handleJsDialog({ accept: true, promptText: "" });

## Frames (chain selector with the frame separator)
await tab.playwright.locator("iframe#main >> internal:control=enter-frame >> button#go").click();

## Coordinate-based interaction (CUA)
await tab.cua.click({ x: 100, y: 200 });
await tab.cua.type({ text: "hello" });
await tab.cua.scroll({ deltaY: 300 });

## Capabilities
const cdp = await tab.capabilities.get("cdp");           // raw CDP: cdp.send(method, params)
const webmcp = await tab.capabilities.get("webmcp");     // page-defined tools
const vis = await iab.capabilities.get("visibility");    // vis.set(true/false)

## Claim a user-opened tab
const tabs = await iab.user.openTabs();
const claimed = await iab.user.claimTab(tabs.find(t => t.url === targetUrl));

Only node_repl js controls the browser. References and screenshots from the user are
context; verify the live page before acting on annotations.
`
