import { strict as assert } from "node:assert"
import { test } from "node:test"
import { classifyBrowserAction } from "./browser-action-policy"

test("browser policy allows ordinary controls and confirms consequential intent", () => {
  assert.deepEqual(classifyBrowserAction("click", { label: "展开详情" }), { decision: "allow" })
  assert.equal(classifyBrowserAction("click", { semanticIntent: "发布文章" }).decision, "confirm")
  assert.equal(classifyBrowserAction("playwright_locator_click", { semanticIntent: "发布文章" }).decision, "confirm")
  assert.equal(classifyBrowserAction("cua_click", { semanticIntent: "删除记录" }).category, "delete")
  assert.equal(classifyBrowserAction("send").category, "send")
  assert.equal(classifyBrowserAction("upload").category, "file")
  assert.equal(classifyBrowserAction("browser_user_history").category, "history")
  assert.equal(classifyBrowserAction("tab_clipboard_read_text").category, "clipboard")
  assert.deepEqual(classifyBrowserAction("webmcp_invoke_tool"), {
    decision: "confirm",
    category: "authorize",
    preview: "webmcp_invoke_tool: 执行受保护的浏览器动作",
  })
  assert.equal(classifyBrowserAction("playwright_file_chooser_set_files").category, "file")
  assert.equal(classifyBrowserAction("tab_page_assets_bundle").category, "file")
  assert.equal(classifyBrowserAction("tab_cdp_call").category, "authorize")
  assert.deepEqual(classifyBrowserAction("browser_run_script"), {
    decision: "confirm",
    category: "authorize",
    preview: "在当前 Agent 任务标签页执行 JavaScript",
  })
})

test("browser policy hands payment and CAPTCHA back to the user", () => {
  assert.equal(classifyBrowserAction("purchase").decision, "deny")
  assert.equal(classifyBrowserAction("contactFill").decision, "confirm")
  assert.deepEqual(classifyBrowserAction("browser_fill_secret", {}, "secretFill"), { decision: "confirm", category: "credential", preview: "browser_fill_secret: 执行受保护的浏览器动作" })
  assert.equal(classifyBrowserAction("navigate_tab_url", { url: "http://127.0.0.1:3000" }).decision, "confirm")
  assert.deepEqual(classifyBrowserAction("navigate_tab_url", { url: "https://example.com" }), { decision: "confirm", category: "browse", preview: "打开网站：https://example.com" })
  // #602 十视角 review:内置 open 工具以 {options:{url}} 嵌套形制派发 create_tab，门必须打中主路径
  assert.equal(classifyBrowserAction("create_tab", { options: { url: "https://example.com" } }).decision, "confirm")
  assert.equal(classifyBrowserAction("ensure", { options: { url: "https://example.com" } }).decision, "confirm")
  const privateNested = classifyBrowserAction("create_tab", { options: { url: "http://169.254.169.254/latest/meta-data" } })
  assert.equal(privateNested.decision, "confirm")
  assert.equal(privateNested.category, "authorize")
  // 无 url 的建 tab 不入导航门
  assert.equal(classifyBrowserAction("create_tab", {}).decision, "allow")
  assert.deepEqual(classifyBrowserAction("navigate", { url: "file:///tmp/preview.html" }), {
    decision: "confirm",
    category: "authorize",
    preview: "打开本地或私有地址：未知地址",
  })
  // #649 review P1-3:双键冲突时取序与 broker normalize(options.url ?? params.url)一致,
  // 门评估的 URL 必须等于实际导航的 URL,否则弹窗确认 A 实际导航 B(同意失真)
  const dualKey = classifyBrowserAction("create_tab", { url: "https://confirmed.example.com", options: { url: "http://169.254.169.254/latest/meta-data" } })
  assert.equal(dualKey.decision, "confirm")
  assert.equal(dualKey.category, "authorize")
  assert.equal(dualKey.preview, "打开本地或私有地址：http://169.254.169.254")
  assert.equal(classifyBrowserAction("click", { semanticIntent: "Pay now" }).decision, "deny")
  assert.equal(classifyBrowserAction("click", { description: "完成 CAPTCHA" }).decision, "deny")
})

test("browser policy confirms batch background navigation (#649 review P1-4)", () => {
  // tabs:content 批量后台导航同属导航面,零确认静默浏览违背 alwaysAsk 出厂承诺
  const batch = classifyBrowserAction("tabs_content", { urls: ["https://a.example.com", "https://b.example.com", "https://c.example.com", "https://d.example.com"] })
  assert.equal(batch.decision, "confirm")
  assert.equal(batch.category, "browse")
  assert.match(batch.preview ?? "", /批量打开网站（共 4 个）：/)
  // 私网混入 → authorize 档
  const privateBatch = classifyBrowserAction("tabs_content", { urls: ["https://a.example.com", "http://127.0.0.1:9222/json"] })
  assert.equal(privateBatch.decision, "confirm")
  assert.equal(privateBatch.category, "authorize")
  assert.match(privateBatch.preview ?? "", /批量读取本地或私有地址（共 2 个）/)
  // 无 urls 不设门(该请求本身会被 desktop 以 invalid_browser_request 拒绝)
  assert.equal(classifyBrowserAction("tabs_content", {}).decision, "allow")
})

test("browser policy returns user_action_required for captcha and MFA gates", () => {
  assert.equal(classifyBrowserAction("captcha").errorCode, "user_action_required")
  assert.equal(classifyBrowserAction("click", { description: "完成 CAPTCHA" }).errorCode, "user_action_required")
  assert.equal(classifyBrowserAction("fill", { semanticIntent: "textbox Enter OTP code" }).errorCode, "user_action_required")
  assert.equal(classifyBrowserAction("fill", { semanticIntent: "textbox 两步验证 security key" }).category, "mfa")
  // 普通 deny（支付）不带 errorCode，保持 action_denied
  assert.equal(classifyBrowserAction("click", { semanticIntent: "Pay now" }).errorCode, undefined)
})

test("download status polling is a read-only query and never asks for confirmation", () => {
  // 下载本身的审批在 Electron will-download 处；轮询 download:path 只读状态，弹确认框会打断轮询链路
  assert.equal(classifyBrowserAction("playwright_download_path", { tabId: "tab-1", download_id: "download-1" }, "download:path").decision, "allow")
})
