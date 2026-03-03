import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import {
  isRelayConnected,
  getAttachedTabs,
  startRelayServer,
  stopRelayServer,
  sendCDPCommand,
  getRelayStatus,
  type RelayStatus
} from "./extension-relay";
import {
  getChromeExtensionInfo,
  installChromeExtension,
  type ChromeExtensionInfo
} from "./chrome-extension-manager";

type BrowserMode = "playwright" | "relay";
type BrowserStartMode = BrowserMode | "auto";
let currentMode: BrowserMode = "playwright";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let activePage: Page | null = null;
const pages = new Map<string, Page>(); // targetId -> Page
let consoleMessages: Array<{ level: string; text: string; ts: number }> = [];

export interface BrowserStatus {
  running: boolean;
  mode: BrowserMode;
  url?: string;
  title?: string;
  tabs?: Array<{ sessionId: string; url?: string; title?: string }>;
  extension?: ChromeExtensionInfo;
  relay?: RelayStatus;
}

export async function getBrowserStatus(): Promise<BrowserStatus> {
  if (currentMode === "relay") {
    const connected = isRelayConnected();
    const tabs = getAttachedTabs();
    return {
      running: connected && tabs.length > 0,
      mode: "relay",
      tabs: tabs.map(t => ({ sessionId: t.sessionId, url: t.url, title: t.title })),
      extension: getChromeExtensionInfo(),
      relay: getRelayStatus()
    };
  }
  if (!browser || !activePage) {
    return { running: false, mode: "playwright" };
  }
  try {
    return {
      running: true,
      mode: "playwright",
      url: activePage.url(),
      title: await activePage.title()
    };
  } catch {
    return { running: false, mode: "playwright" };
  }
}

async function ensurePlaywrightStarted(): Promise<void> {
  if (browser) return;
  browser = await chromium.launch({ headless: false });
  context = await browser.newContext();
  activePage = await context.newPage();
}

export async function startBrowser(mode: BrowserStartMode = "auto"): Promise<BrowserStatus> {
  if (mode === "relay") {
    currentMode = "relay";
    await startRelayServer();
    return getBrowserStatus();
  }
  if (mode === "playwright") {
    currentMode = "playwright";
    await ensurePlaywrightStarted();
    return getBrowserStatus();
  }

  // auto 模式：优先使用 extension relay，若不可用则回退到 Playwright。
  await startRelayServer();
  const relayTabs = getAttachedTabs();
  if (isRelayConnected() && relayTabs.length > 0) {
    currentMode = "relay";
    return getBrowserStatus();
  }

  currentMode = "playwright";
  await ensurePlaywrightStarted();
  return getBrowserStatus();
}

export async function stopBrowser(): Promise<{ ok: true }> {
  if (currentMode === "relay") {
    await stopRelayServer();
  } else if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    context = null;
    activePage = null;
  }
  return { ok: true };
}

export async function navigateTo(url: string): Promise<{ ok: true; url: string; title: string }> {
  if (currentMode === "relay") {
    await sendCDPCommand("Page.navigate", { url });
    await new Promise(r => setTimeout(r, 1000));
    const result = await sendCDPCommand("Runtime.evaluate", {
      expression: "JSON.stringify({ url: location.href, title: document.title })"
    }) as { result?: { value?: string } };
    const info = JSON.parse(result.result?.value || "{}");
    return { ok: true, url: info.url || url, title: info.title || "" };
  }
  if (!activePage) await startBrowser();
  await activePage!.goto(url, { waitUntil: "domcontentloaded" });
  return { ok: true, url: activePage!.url(), title: await activePage!.title() };
}

export async function getSnapshot(opts?: { maxChars?: number; selector?: string; interactive?: boolean }): Promise<{ snapshot: string; url: string }> {
  const maxChars = opts?.maxChars ?? 8000;
  const selector = opts?.selector || "body";
  const interactive = opts?.interactive ?? false;
  if (currentMode === "relay") {
    const result = await sendCDPCommand("Runtime.evaluate", {
      expression: `(function(){
        const walk=(el,d=0)=>{if(d>10)return"";const t=el.tagName?.toLowerCase();if(!t||["script","style","noscript","svg"].includes(t))return"";const txt=el.childNodes.length===1&&el.childNodes[0]?.nodeType===3?(el.textContent?.trim().slice(0,100)||""):"";const ch=Array.from(el.children||[]).map(c=>walk(c,d+1)).filter(Boolean).join("");return ch||txt?"<"+t+">"+txt+ch+"</"+t+">":"";};return walk(document.body);
      })()`
    }) as { result?: { value?: string } };
    const snapshot = (result.result?.value || "").slice(0, maxChars);
    const urlRes = await sendCDPCommand("Runtime.evaluate", { expression: "location.href" }) as { result?: { value?: string } };
    return { snapshot, url: urlRes.result?.value || "" };
  }
  if (!activePage) throw new Error("Browser not started");
  const snapshot = await activePage.evaluate(([sel, onlyInteractive]) => {
    const INTERACTIVE = ["a","button","input","select","textarea","[onclick]","[role=button]"];
    const walk = (el: Element, depth = 0): string => {
      if (depth > 10) return "";
      const tag = el.tagName.toLowerCase();
      if (["script","style","noscript","svg","path"].includes(tag)) return "";
      if (onlyInteractive && !INTERACTIVE.some(s => el.matches(s))) {
        return Array.from(el.children).map(c => walk(c, depth + 1)).filter(Boolean).join("");
      }
      const attrs: string[] = [];
      if (el.id) attrs.push(`id="${el.id}"`);
      const text = el.textContent?.trim().slice(0, 80) || "";
      const children = Array.from(el.children).map(c => walk(c, depth + 1)).filter(Boolean).join("");
      return `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>${text && !children ? text : ""}${children}</${tag}>`;
    };
    const root = document.querySelector(sel) || document.body;
    return walk(root);
  }, [selector, interactive] as const);
  return { snapshot: snapshot.slice(0, maxChars), url: activePage.url() };
}

export async function takeScreenshot(opts?: { fullPage?: boolean; element?: string }): Promise<{ path: string }> {
  const path = `/tmp/lume-screenshot-${Date.now()}.png`;
  if (currentMode === "relay") {
    const result = await sendCDPCommand("Page.captureScreenshot", { format: "png" }) as { data?: string };
    await Bun.write(path, Buffer.from(result.data || "", "base64"));
    return { path };
  }
  if (!activePage) throw new Error("Browser not started");
  if (opts?.element) {
    const el = activePage.locator(opts.element);
    await el.screenshot({ path });
  } else {
    await activePage.screenshot({ path, fullPage: opts?.fullPage ?? false });
  }
  return { path };
}

export async function browserClick(selector: string): Promise<{ ok: true }> {
  if (currentMode === "relay") {
    await sendCDPCommand("Runtime.evaluate", {
      expression: `document.querySelector("${selector.replace(/"/g, '\\"')}")?.click()`
    });
    return { ok: true };
  }
  if (!activePage) throw new Error("Browser not started");
  await activePage.click(selector, { timeout: 5000 });
  return { ok: true };
}

export async function browserType(selector: string, text: string): Promise<{ ok: true }> {
  if (currentMode === "relay") {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    await sendCDPCommand("Runtime.evaluate", {
      expression: `(()=>{const el=document.querySelector("${selector.replace(/"/g, '\\"')}");if(el){el.focus();el.value="${escaped}";el.dispatchEvent(new Event("input",{bubbles:true}))}})()`
    });
    return { ok: true };
  }
  if (!activePage) throw new Error("Browser not started");
  await activePage.fill(selector, text, { timeout: 5000 });
  return { ok: true };
}

export async function browserPress(key: string): Promise<{ ok: true }> {
  if (currentMode === "relay") {
    await sendCDPCommand("Input.dispatchKeyEvent", { type: "keyDown", key });
    await sendCDPCommand("Input.dispatchKeyEvent", { type: "keyUp", key });
    return { ok: true };
  }
  if (!activePage) throw new Error("Browser not started");
  await activePage.keyboard.press(key);
  return { ok: true };
}

export async function browserWait(ms: number): Promise<{ ok: true }> {
  await new Promise(r => setTimeout(r, Math.min(ms, 10000)));
  return { ok: true };
}

// === Tabs 管理 ===
export interface TabInfo {
  targetId: string;
  url: string;
  title: string;
  active: boolean;
}

export async function getTabs(): Promise<TabInfo[]> {
  if (currentMode === "relay") {
    return getAttachedTabs().map(t => ({
      targetId: t.targetId || t.sessionId,
      url: t.url || "",
      title: t.title || "",
      active: true
    }));
  }
  if (!context) return [];
  const result: TabInfo[] = [];
  for (const [id, page] of pages) {
    result.push({
      targetId: id,
      url: page.url(),
      title: await page.title().catch(() => ""),
      active: page === activePage
    });
  }
  return result;
}

export async function openTab(url: string): Promise<TabInfo> {
  if (currentMode === "relay") {
    const created = await sendCDPCommand("Target.createTarget", { url }) as { targetId?: string };
    await new Promise(r => setTimeout(r, 300));
    const tabs = getAttachedTabs();
    const tab = created?.targetId
      ? tabs.find((item) => item.targetId === created.targetId)
      : tabs[tabs.length - 1];
    return { targetId: tab?.targetId || tab?.sessionId || created?.targetId || "", url: tab?.url || url, title: tab?.title || "", active: true };
  }
  if (!context) await startBrowser();
  const page = await context!.newPage();
  const id = `tab-${Date.now()}`;
  pages.set(id, page);
  activePage = page;
  if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
  return { targetId: id, url: page.url(), title: await page.title(), active: true };
}

export async function focusTab(targetId: string): Promise<{ ok: true }> {
  if (currentMode === "relay") {
    await sendCDPCommand("Target.activateTarget", { targetId });
    return { ok: true };
  }
  const page = pages.get(targetId);
  if (!page) throw new Error(`Tab not found: ${targetId}`);
  activePage = page;
  await page.bringToFront();
  return { ok: true };
}

export async function closeTab(targetId: string): Promise<{ ok: true }> {
  if (currentMode === "relay") {
    await sendCDPCommand("Target.closeTarget", { targetId });
    return { ok: true };
  }
  const page = pages.get(targetId);
  if (page) {
    await page.close();
    pages.delete(targetId);
    if (activePage === page) activePage = [...pages.values()][0] || null;
  }
  return { ok: true };
}

// === Console 日志 ===
export async function getConsoleMessages(level?: string): Promise<{ messages: typeof consoleMessages }> {
  const filtered = level ? consoleMessages.filter(m => m.level === level) : consoleMessages;
  return { messages: filtered.slice(-100) };
}

// === 交互操作 ===
export async function browserHover(selector: string): Promise<{ ok: true }> {
  if (currentMode === "relay") {
    await sendCDPCommand("Runtime.evaluate", {
      expression: `document.querySelector("${selector.replace(/"/g, '\\"')}")?.dispatchEvent(new MouseEvent("mouseover",{bubbles:true}))`
    });
    return { ok: true };
  }
  if (!activePage) throw new Error("Browser not started");
  await activePage.hover(selector, { timeout: 5000 });
  return { ok: true };
}

export async function browserSelect(selector: string, values: string[]): Promise<{ ok: true }> {
  if (currentMode === "relay") {
    const valStr = JSON.stringify(values);
    await sendCDPCommand("Runtime.evaluate", {
      expression: `(()=>{const s=document.querySelector("${selector.replace(/"/g, '\\"')}");if(s){${valStr}.forEach(v=>{for(let o of s.options)if(o.value===v)o.selected=true});s.dispatchEvent(new Event("change",{bubbles:true}))}})()`
    });
    return { ok: true };
  }
  if (!activePage) throw new Error("Browser not started");
  await activePage.selectOption(selector, values, { timeout: 5000 });
  return { ok: true };
}

export async function browserDrag(startSelector: string, endSelector: string): Promise<{ ok: true }> {
  if (!activePage) throw new Error("Browser not started");
  await activePage.dragAndDrop(startSelector, endSelector, { timeout: 5000 });
  return { ok: true };
}

export async function browserEvaluate(fn: string): Promise<{ result: unknown }> {
  const source = fn.trim();
  const expression = (
    (source.startsWith("() =>") || source.startsWith("async () =>") || source.startsWith("function"))
    && !source.endsWith(")()")
  )
    ? `(${source})()`
    : source;

  if (currentMode === "relay") {
    const res = await sendCDPCommand("Runtime.evaluate", { expression, returnByValue: true }) as { result?: { value?: unknown } };
    return { result: res.result?.value };
  }
  if (!activePage) throw new Error("Browser not started");
  const result = await activePage.evaluate(expression);
  return { result };
}

// === PDF 导出 ===
export async function browserPdf(opts?: { path?: string }): Promise<{ path: string }> {
  if (!activePage) throw new Error("Browser not started");
  const path = opts?.path || `/tmp/lume-pdf-${Date.now()}.pdf`;
  await activePage.pdf({ path });
  return { path };
}

// === 文件上传 ===
export async function browserUpload(selector: string, paths: string[]): Promise<{ ok: true }> {
  if (!activePage) throw new Error("Browser not started");
  const input = activePage.locator(selector);
  await input.setInputFiles(paths);
  return { ok: true };
}

// === Dialog 处理 ===
let pendingDialog: { type: string; message: string } | null = null;

export function setupDialogHandler() {
  if (!activePage) return;
  activePage.on("dialog", async (dialog) => {
    pendingDialog = { type: dialog.type(), message: dialog.message() };
  });
}

export async function browserDialog(accept: boolean, promptText?: string): Promise<{ ok: true; dialog?: typeof pendingDialog }> {
  if (!activePage) throw new Error("Browser not started");
  const dialog = pendingDialog;
  pendingDialog = null;
  // 下次 dialog 会自动处理
  activePage.once("dialog", async (d) => {
    if (accept) await d.accept(promptText);
    else await d.dismiss();
  });
  return { ok: true, dialog };
}

// === 窗口大小 ===
export async function browserResize(width: number, height: number): Promise<{ ok: true }> {
  if (!activePage) throw new Error("Browser not started");
  await activePage.setViewportSize({ width, height });
  return { ok: true };
}

// === Fill 批量填充 ===
export async function browserFill(fields: Array<{ selector: string; value: string }>): Promise<{ ok: true }> {
  if (!activePage) throw new Error("Browser not started");
  for (const f of fields) {
    await activePage.fill(f.selector, f.value, { timeout: 5000 });
  }
  return { ok: true };
}

// === Profiles ===
export async function getProfiles(): Promise<{ profiles: string[] }> {
  return { profiles: ["playwright", "relay"] };
}

export async function getBrowserExtensionInfo(): Promise<ChromeExtensionInfo> {
  return getChromeExtensionInfo();
}

export async function installBrowserExtension(): Promise<{ path: string }> {
  return installChromeExtension();
}

export async function getBrowserRelayStatus(): Promise<RelayStatus> {
  return getRelayStatus();
}

// === Act 统一入口 ===
export type ActRequest = {
  kind: "click" | "type" | "press" | "hover" | "drag" | "select" | "fill" | "resize" | "wait" | "evaluate" | "close";
  selector?: string;
  text?: string;
  key?: string;
  values?: string[];
  startSelector?: string;
  endSelector?: string;
  width?: number;
  height?: number;
  timeMs?: number;
  fn?: string;
  fields?: Array<{ selector: string; value: string }>;
};

export async function browserAct(request: ActRequest): Promise<{ ok: true; result?: unknown }> {
  if (!activePage) throw new Error("Browser not started");

  switch (request.kind) {
    case "click":
      if (!request.selector) throw new Error("selector required");
      await activePage.click(request.selector, { timeout: 5000 });
      break;
    case "type":
      if (!request.selector || !request.text) throw new Error("selector and text required");
      await activePage.type(request.selector, request.text, { timeout: 5000 });
      break;
    case "press":
      if (!request.key) throw new Error("key required");
      await activePage.keyboard.press(request.key);
      break;
    case "hover":
      if (!request.selector) throw new Error("selector required");
      await activePage.hover(request.selector, { timeout: 5000 });
      break;
    case "drag":
      if (!request.startSelector || !request.endSelector) throw new Error("startSelector and endSelector required");
      await activePage.dragAndDrop(request.startSelector, request.endSelector, { timeout: 5000 });
      break;
    case "select":
      if (!request.selector || !request.values) throw new Error("selector and values required");
      await activePage.selectOption(request.selector, request.values, { timeout: 5000 });
      break;
    case "fill":
      if (!request.fields) throw new Error("fields required");
      for (const f of request.fields) {
        await activePage.fill(f.selector, f.value, { timeout: 5000 });
      }
      break;
    case "resize":
      if (!request.width || !request.height) throw new Error("width and height required");
      await activePage.setViewportSize({ width: request.width, height: request.height });
      break;
    case "wait":
      await new Promise(r => setTimeout(r, Math.min(request.timeMs || 1000, 10000)));
      break;
    case "evaluate":
      if (!request.fn) throw new Error("fn required");
      const result = await activePage.evaluate(request.fn);
      return { ok: true, result };
    case "close":
      await activePage.close();
      activePage = null;
      break;
    default:
      throw new Error(`Unknown act kind: ${(request as ActRequest).kind}`);
  }
  return { ok: true };
}
