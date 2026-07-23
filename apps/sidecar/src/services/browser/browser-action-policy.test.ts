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
})

test("browser policy hands payment and CAPTCHA back to the user", () => {
  assert.equal(classifyBrowserAction("purchase").decision, "deny")
  assert.equal(classifyBrowserAction("contactFill").decision, "confirm")
  assert.equal(classifyBrowserAction("navigate_tab_url", { url: "http://127.0.0.1:3000" }).decision, "confirm")
  assert.equal(classifyBrowserAction("navigate_tab_url", { url: "https://example.com" }).decision, "allow")
  assert.equal(classifyBrowserAction("click", { semanticIntent: "Pay now" }).decision, "deny")
  assert.equal(classifyBrowserAction("click", { description: "完成 CAPTCHA" }).decision, "deny")
})
