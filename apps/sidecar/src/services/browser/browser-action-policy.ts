import { browserApiPolicyForRuntimeMethod } from "@lume/shared"

export type BrowserActionPolicyDecision = {
  decision: "allow" | "confirm" | "deny"
  category?: "browse" | "submit" | "send" | "delete" | "purchase" | "authorize" | "file" | "clipboard" | "credential" | "history" | "payment" | "captcha"
  preview?: string
}

const EXPLICIT_CONFIRM = new Map<string, BrowserActionPolicyDecision["category"]>([
  ["submitForm", "submit"], ["send", "send"], ["delete", "delete"], ["authorize", "authorize"],
  ["upload", "file"], ["download", "file"], ["contactFill", "credential"],
  ["tab_page_assets_bundle", "file"],
  ["webmcp_invoke_tool", "authorize"],
  ["browser_run_script", "authorize"],
  ["tab_cdp_call", "authorize"], ["tab_cdp_send", "authorize"],
])

export function classifyBrowserAction(method: string, params: Record<string, unknown> = {}, runtimeMethod = canonicalActionMethod(method)): BrowserActionPolicyDecision {
  const actionMethod = canonicalActionMethod(method)
  if (method === "purchase") return { decision: "deny", category: "payment", preview: "支付或购买必须由用户完成" }
  if (method === "captcha") return { decision: "deny", category: "captcha", preview: "CAPTCHA 必须由用户完成" }
  if ((method === "navigate" || method === "goto" || method === "navigate_tab_url") && isPrivateBrowserUrl(params.url)) {
    return { decision: "confirm", category: "authorize", preview: `打开本地或私有地址：${safeOrigin(params.url) ?? "未知地址"}` }
  }
  if (method === "navigate" || method === "goto" || method === "navigate_tab_url") {
    return { decision: "confirm", category: "browse", preview: `打开网站：${safeOrigin(params.url) ?? "未知地址"}` }
  }
  const explicit = EXPLICIT_CONFIRM.get(method)
  if (explicit) return { decision: "confirm", category: explicit, preview: preview(method, params) }
  const registeredPolicy = browserApiPolicyForRuntimeMethod(runtimeMethod)
  if (registeredPolicy !== "none") {
    const category: BrowserActionPolicyDecision["category"] = registeredPolicy === "credentials"
      ? "credential"
      : registeredPolicy === "upload" || registeredPolicy === "download"
        ? "file"
        : registeredPolicy === "cdp"
          ? "authorize"
          : registeredPolicy
    return { decision: "confirm", category, preview: preview(method, params) }
  }
  const intent = [params.semanticIntent, params.intent, params.description, params.label].filter((value): value is string => typeof value === "string").join(" ").slice(0, 512)
  if (/captcha|验证码|人机验证/i.test(intent)) return { decision: "deny", category: "captcha", preview: "CAPTCHA 必须由用户完成" }
  if (/payment|pay now|付款|支付|转账|银行卡/i.test(intent)) return { decision: "deny", category: "payment", preview: "支付确认必须由用户完成" }
  if (!new Set(["click", "doubleClick", "press", "select", "check", "uncheck", "fill", "type"]).has(actionMethod)) return { decision: "allow" }
  const categories: Array<[RegExp, BrowserActionPolicyDecision["category"]]> = [
    [/(submit|confirm|publish|提交|确认|发布)/i, "submit"],
    [/(send|发送|回复)/i, "send"],
    [/(delete|remove|erase|删除|移除)/i, "delete"],
    [/(purchase|buy|order|购买|下单)/i, "purchase"],
    [/(authorize|approve|grant|授权|批准)/i, "authorize"],
  ]
  for (const [pattern, category] of categories) if (pattern.test(intent)) return { decision: "confirm", category, preview: preview(method, params) }
  return { decision: "allow" }
}

function canonicalActionMethod(method: string): string {
  const aliases: Record<string, string> = {
    browser_user_history: "history:list",
    tab_clipboard_read: "clipboard:read", tab_clipboard_read_text: "clipboard:readText",
    tab_clipboard_write: "clipboard:write", tab_clipboard_write_text: "clipboard:writeText",
    playwright_file_chooser_set_files: "filechooser:setFiles",
    playwright_locator_click: "click", playwright_locator_dblclick: "doubleClick", playwright_locator_press: "press",
    playwright_locator_select_option: "select", playwright_locator_set_checked: "check", playwright_locator_check: "check",
    playwright_locator_uncheck: "uncheck", playwright_locator_fill: "fill", playwright_locator_type: "type",
    cua_click: "click", cua_double_click: "doubleClick", cua_keypress: "press", cua_type: "type",
    dom_cua_click: "click", dom_cua_double_click: "doubleClick", dom_cua_keypress: "press", dom_cua_type: "type",
  }
  return aliases[method] ?? method
}

function isPrivateBrowserUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) return true
    const octets = host.split(".").map(Number)
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
    const first = octets[0]!
    const second = octets[1]!
    return first === 10 || first === 127 || (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
  } catch { return false }
}

function safeOrigin(value: unknown): string | undefined { try { return typeof value === "string" ? new URL(value).origin : undefined } catch { return undefined } }

function preview(method: string, params: Record<string, unknown>): string {
  if (method === "browser_run_script") return "在当前 Agent 任务标签页执行 JavaScript"
  const intent = [params.semanticIntent, params.intent, params.description, params.label].find((value): value is string => typeof value === "string" && Boolean(value.trim()))
  return `${method}: ${(intent ?? "执行受保护的浏览器动作").replace(/[\r\n\t]+/g, " ").slice(0, 240)}`
}
