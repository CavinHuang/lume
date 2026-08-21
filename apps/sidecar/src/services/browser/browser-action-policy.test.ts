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
  assert.equal(classifyBrowserAction("click", { semanticIntent: "Pay now" }).decision, "deny")
  assert.equal(classifyBrowserAction("click", { description: "完成 CAPTCHA" }).decision, "deny")
})
