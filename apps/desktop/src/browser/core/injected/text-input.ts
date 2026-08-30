/**
 * 虚拟剪贴板文本输入 —— Fj 粘贴页函数(字节恒定)与聚焦目标派发管线。
 *
 * 来源:
 *   - D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *     injected-scripts/runtime-exact/Fj.runtime.js(Fj 页函数完整字节)
 *   - 02-execution-engine.source.js(Zj/Ug/Sde/Wj/zj/Pde/iM/_de/En/Cde/Ide/
 *     Rde/sM/bde/kde,di token 字段)
 *
 * ZCode 原名对照:
 *   Fj  → (粘贴页函数,本文件 PASTE_TEXT_PAGE_SOURCE)   di → INPUT_TARGET_TOKEN_FIELD
 *   Cde → escapeHtml                                   Ide → clipboardItems
 *   Rde → shouldIncludeRichText                        sM  → createInputTargetToken
 *   iM  → cdpRuntimeError(原名 runtimeError)           _de → evaluateTargetKey
 *   En  → sendToTarget(原名 send)                      Wj  → detachAttachedSessions
 *   zj  → tryAttachFrameTarget                         Pde → waitForOopifTarget
 *   kde → OOPIF_ATTACH_BUDGET_MS                       bde → FOCUSED_FRAME_ELEMENT_EXPRESSION
 *   Sde → resolveFocusedInputTarget                    Zj  → assertFocusedInputTarget
 *   Ug  → dispatchTextInput(ZCode 名 pasteTextIntoFocusedTarget)
 *
 * 语义偏差(仅以下已声明项):
 *   - Fj 文本逐字节内嵌(ZCode 以模板字面量对 di 插值,此处等价);与
 *     executor/injecteds/generators.ts 的 pasteTextPageFunction() 输出逐字节
 *     一致(测试保证),集成者二选一去重。
 *   - Fj 内部标识 __zcodeIabInputTargetToken 与隔离世界名
 *     "browser-use-virtual-clipboard" 为 ZCode 页面内协议,保持原名。
 *   - sM/createInputTargetToken 原调 vde()(未在提取源中),以
 *     crypto.randomUUID() 生成等价唯一 token。
 *   - Ide 返回 [{ entries, presentation_style:"unspecified" }](与 Fj 的
 *     item.entries 消费形状一致);executor/dispatcher.ts 的内联副本缺
 *     entries 包装层,属副本缺陷,以本模块为规范实现,集成者去重时替换。
 *
 * dispatchTextInput 管线(Ug):解析聚焦输入目标(Sde,OOPIF 附加会话/隔离
 * 世界)→ 构造剪贴板条目(Ide)→ Runtime.evaluate 包裹 Fj(awaitPromise+
 * returnByValue)→ 结果归一化 → finally 释放全部附加会话(Wj)。
 */
import type { ControlledView } from "../types"

/* ── Fj 页函数(字节恒定) ──────────────────────────────────────────── */

/** ZCode 原名 di:输入目标 token 的元素属性字段名。 */
export const INPUT_TARGET_TOKEN_FIELD = "__zcodeIabInputTargetToken"

/**
 * ZCode 原名 Fj:虚拟剪贴板粘贴页函数(async (options) => {...})。
 * paste 事件 + fallbackPaste 直写 value/setRangeText/execCommand,并校验
 * options.inputTargetToken 未漂移;options 形状见 TextInputPagePayload。
 */
const PASTE_TEXT_PAGE_SOURCE = `async (options) => {
  const asElement = (candidate) => {
    if (candidate == null || typeof candidate !== "object" || !("ownerDocument" in candidate))
      return null;
    const view = candidate.ownerDocument?.defaultView ?? null;
    return view != null && candidate instanceof view.Element ? candidate : null;
  };
  const elementWindow = (element) => element.ownerDocument.defaultView ?? window;
  const deepestActiveElement = (root) => {
    const active = root.activeElement;
    if (active == null) return null;
    const view = elementWindow(active);
    if (active instanceof view.HTMLElement && active.shadowRoot != null)
      return deepestActiveElement(active.shadowRoot) ?? active;
    if (active instanceof view.HTMLIFrameElement || active instanceof view.HTMLFrameElement) {
      try {
        const frameDocument = active.contentDocument ?? active.contentWindow?.document ?? null;
        if (frameDocument != null) return deepestActiveElement(frameDocument) ?? active;
      } catch {
        return active;
      }
    }
    return active;
  };
  const textForMime = (items, mimeType) =>
    items.flatMap((item) => item.entries).find((entry) => entry.mime_type === mimeType)?.text ?? "";
  const fallbackPaste = (target, html, text, replaceInputValue) => {
    const element = asElement(target);
    if (element == null) return;
    const view = elementWindow(element);
    if (element instanceof view.HTMLTextAreaElement || element instanceof view.HTMLInputElement) {
      if (element.disabled || element.readOnly || text.length === 0) return;
      const setValue = (value) => {
        const prototype = Object.getPrototypeOf(element);
        const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        const ownSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
        if (prototypeSetter != null && ownSetter !== prototypeSetter) prototypeSetter.call(element, value);
        else element.value = value;
      };
      if (element.selectionStart == null || element.selectionEnd == null) {
        setValue(replaceInputValue ? text : element.value + text);
      } else {
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        try {
          element.setRangeText(text, start, end, "end");
        } catch {
          setValue(replaceInputValue ? text : element.value + text);
        }
      }
      element.dispatchEvent(new view.InputEvent("input", { bubbles: true }));
      return;
    }
    if (
      element instanceof view.HTMLElement &&
      (element.isContentEditable || element.closest("[contenteditable=true]"))
    ) {
      element.focus();
      if (html.length > 0) {
        element.ownerDocument.execCommand("insertHTML", false, html);
        return;
      }
      if (text.length > 0) element.ownerDocument.execCommand("insertText", false, text);
    }
  };

  const target = deepestActiveElement(document) ?? document.body;
  if (options.inputTargetToken != null) {
    const element = asElement(target);
    if ((element ?? null)?.${INPUT_TARGET_TOKEN_FIELD}!== options.inputTargetToken)
      throw new Error("Active element is no longer the expected input target");
  }
  if (options.clipboardItems.length === 0)
    throw new Error("Browser Use virtual clipboard has no data to paste");
  const targetElement = asElement(target);
  const view = targetElement == null ? window : elementWindow(targetElement);
  const plainText = textForMime(options.clipboardItems, "text/plain");
  const richText = options.richTextFallback === true
    ? textForMime(options.clipboardItems, "text/html")
    : "";
  if (typeof view.DataTransfer !== "function" || typeof view.ClipboardEvent !== "function") {
    fallbackPaste(target, richText, plainText, options.replaceInputValue === true);
    return {};
  }
  const dataTransfer = new view.DataTransfer();
  for (const item of options.clipboardItems)
    for (const entry of item.entries)
      if (typeof entry.text === "string") dataTransfer.setData(entry.mime_type, entry.text);
  const pasteEvent = new view.ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: dataTransfer,
    composed: true,
  });
  if (target.dispatchEvent(pasteEvent))
    fallbackPaste(target, richText, plainText, options.replaceInputValue === true);
  return {};
}`

/**
 * ZCode 原名 Fj 的装配出口(与内嵌 PASTE_TEXT_PAGE_SOURCE 同一字节串)。
 * 与 executor/injecteds/generators.ts 的同名函数输出逐字节一致(测试保证)。
 */
export function pasteTextPageFunction(): string {
  return PASTE_TEXT_PAGE_SOURCE
}

/* ── 剪贴板条目构造 ────────────────────────────────────────────────── */

/** 单 mime 文本条目(ZCode 原名 Ide 的 entries 项形状)。 */
export interface BrowserClipboardEntry {
  mime_type: string
  text: string
}

/** 剪贴板条目组(Fj 按 item.entries 消费;ZCode 原名 Ide 的项形状)。 */
export interface BrowserClipboardItem {
  entries: BrowserClipboardEntry[]
  presentation_style: string
}

/** ZCode 原名 Cde/escapeHtml:HTML 转义 + 各类换行转 <br>(富文本粘贴)。 */
export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("\r\n", "<br>")
    .replaceAll(/[\r\n\u2028\u2029]/gu, "<br>")
}

/**
 * ZCode 原名 Ide/clipboardItems:text/plain 必带,includeRichText 时追加
 * text/html(经 escapeHtml);统一包一层 { entries, presentation_style }。
 */
export function clipboardItems(text: string, includeRichText: boolean): BrowserClipboardItem[] {
  const entries: BrowserClipboardEntry[] = [{ mime_type: "text/plain", text }]
  if (includeRichText) entries.push({ mime_type: "text/html", text: escapeHtml(text) })
  return [{ entries, presentation_style: "unspecified" }]
}

/** ZCode 原名 Rde/shouldIncludeRichText:Google Sheets 不投递富文本。 */
export function shouldIncludeRichText(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.host !== "docs.google.com" || parsed.pathname.split("/").filter(Boolean)[0] !== "spreadsheets"
  } catch {
    return true
  }
}

/**
 * ZCode 原名 sM/createInputTargetToken(内部调 vde)。
 * PortingGap:vde 未在提取源中,以 crypto.randomUUID() 生成等价唯一 token。
 */
export function createInputTargetToken(): string {
  return crypto.randomUUID()
}

/* ── 隔离世界/帧链求值通道(Sde 管线) ─────────────────────────────── */

/** 隔离世界/帧链求值目标(sessionId 或隔离世界 contextId)。 */
export interface TextInputEvaluateTarget {
  sessionId?: string
  contextId?: number
}

/** CDP Runtime.evaluate 响应形状(仅取用字段)。 */
interface CdpEvaluateResponse {
  result?: { objectId?: string; subtype?: string; value?: unknown }
  exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string }
}

/** ZCode 原名 kde:OOPIF 目标等待预算(ms)。 */
const OOPIF_ATTACH_BUDGET_MS = 1_000

/**
 * ZCode 原名 bde:沿 activeElement iframe/shadow 递归下行取聚焦帧元素的表达式
 * (返回 HTMLElement/HTMLIFrameElement/HTMLFrameElement 或 null)。
 */
const FOCUSED_FRAME_ELEMENT_EXPRESSION = `(() => {
  const focusedFrameElementInRoot = (root) => {
    const active = root.activeElement;
    if (active == null) return null;
    const activeWindow = active.ownerDocument.defaultView ?? window;
    if (
      active instanceof activeWindow.HTMLElement &&
      active.shadowRoot != null
    )
      return focusedFrameElementInRoot(active.shadowRoot);
    if (
      active instanceof activeWindow.HTMLIFrameElement ||
      active instanceof activeWindow.HTMLFrameElement
    ) {
      try {
        const frameDocument =
          active.contentDocument ?? active.contentWindow?.document ?? null;
        if (frameDocument != null)
          return focusedFrameElementInRoot(frameDocument);
      } catch {}
      return active;
    }
    return null;
  };
  return focusedFrameElementInRoot(document);
})()`

/**
 * ZCode 原名 iM/runtimeError:提取 CDP 响应的异常文本;无异常返回 undefined。
 * 兜底文案沿用 ZCode 的虚拟剪贴板语境。
 */
export function cdpRuntimeError(response: CdpEvaluateResponse): string | undefined {
  const details = response.exceptionDetails
  if (details) {
    return details.exception?.description
      ?? (details.exception?.value == null ? undefined : String(details.exception.value))
      ?? details.text
      ?? "Browser Use virtual clipboard evaluation failed"
  }
  return undefined
}

/** ZCode 原名 _de/targetKey:求值目标的去重键。 */
export function evaluateTargetKey(target: TextInputEvaluateTarget): string {
  return `${target.sessionId ?? "root"}:${target.contextId ?? "default"}`
}

/** ZCode 原名 En/send:按目标 sessionId 发送 CDP 命令。 */
export async function sendToTarget(view: ControlledView, target: TextInputEvaluateTarget, method: string, params?: Record<string, unknown>): Promise<unknown> {
  return view.cdp.send(method, params, target.sessionId)
}

/** ZCode 原名 Wj/detachAttachedSessions:allSettled 释放全部附加会话。 */
export async function detachAttachedSessions(view: ControlledView, sessionIds: string[]): Promise<void> {
  await Promise.allSettled(sessionIds.map((sessionId) => view.cdp.send("Target.detachFromTarget", { sessionId })))
}

/** ZCode 原名 zj/tryAttachFrameTarget:flatten 附加帧目标,失败静默。 */
export async function tryAttachFrameTarget(view: ControlledView, targetId: string): Promise<string | undefined> {
  return ((await view.cdp.send("Target.attachToTarget", { flatten: true, targetId }).catch(() => {})) as { sessionId?: string } | undefined)?.sessionId
}

/** ZCode 原名 Pde/waitForOopifTarget:轮询目标列表直至 OOPIF 可附加。 */
export async function waitForOopifTarget(view: ControlledView, targetId: string): Promise<string | undefined> {
  const deadline = Date.now() + OOPIF_ATTACH_BUDGET_MS
  for (;;) {
    if (((await view.cdp.send("Target.getTargets").catch(() => {})) as { targetInfos?: Array<{ targetId?: string; type?: string }> } | undefined)?.targetInfos?.some((info) => info.targetId === targetId && info.type === "iframe")) {
      const sessionId = await tryAttachFrameTarget(view, targetId)
      if (sessionId) return sessionId
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return undefined
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)))
  }
}

/**
 * ZCode 原名 Sde/resolveFocusedInputTarget:沿 activeElement iframe/shadow
 * 递归下行解析聚焦输入目标;OOPIF 走 createIsolatedWorld("browser-use-virtual-
 * clipboard"),兜底 waitForOopifTarget 轮询;失败路径释放全部附加会话。
 */
export async function resolveFocusedInputTarget(view: ControlledView, initialTarget?: TextInputEvaluateTarget): Promise<{ attachedSessionIds: string[]; target: TextInputEvaluateTarget }> {
  let target = initialTarget ?? {}
  const attachedSessionIds: string[] = []
  const visited = new Set<string>()
  try {
    for (;;) {
      const key = evaluateTargetKey(target)
      if (visited.has(key)) throw new Error("Browser Use encountered a focused frame cycle")
      visited.add(key)
      const probe = await sendToTarget(view, target, "Runtime.evaluate", {
        ...(target.contextId == null ? {} : { contextId: target.contextId }),
        expression: FOCUSED_FRAME_ELEMENT_EXPRESSION,
        returnByValue: false,
      }) as CdpEvaluateResponse
      if (cdpRuntimeError(probe)) throw new Error("Browser Use could not inspect the focused frame")
      const objectId = probe.result?.objectId
      if (!objectId) return { attachedSessionIds, target }
      let frameId: string | undefined
      try {
        frameId = ((await sendToTarget(view, target, "DOM.describeNode", { objectId })) as { node?: { frameId?: string } })?.node?.frameId
      } finally {
        await sendToTarget(view, target, "Runtime.releaseObject", { objectId }).catch(() => {})
      }
      if (!frameId) return { attachedSessionIds, target }
      const sessionId = await tryAttachFrameTarget(view, frameId)
      if (sessionId) {
        attachedSessionIds.push(sessionId)
        target = { sessionId }
        await Promise.all([sendToTarget(view, target, "Page.enable"), sendToTarget(view, target, "Runtime.enable"), sendToTarget(view, target, "DOM.enable")])
        continue
      }
      const isolatedWorld = await sendToTarget(view, target, "Page.createIsolatedWorld", {
        frameId,
        grantUniveralAccess: false,
        worldName: "browser-use-virtual-clipboard",
      }).catch(() => {}) as { executionContextId?: number } | undefined
      if (isolatedWorld?.executionContextId) {
        target = { ...target, contextId: isolatedWorld.executionContextId }
        continue
      }
      const oopifSessionId = await waitForOopifTarget(view, frameId)
      if (!oopifSessionId) throw new Error(`Browser Use could not resolve an input target for frame ${frameId}`)
      attachedSessionIds.push(oopifSessionId)
      target = { sessionId: oopifSessionId }
      await Promise.all([sendToTarget(view, target, "Page.enable"), sendToTarget(view, target, "Runtime.enable"), sendToTarget(view, target, "DOM.enable")])
    }
  } catch (error) {
    await detachAttachedSessions(view, attachedSessionIds)
    throw error
  }
}

/* ── 校验与派发 ────────────────────────────────────────────────────── */

/**
 * ZCode 原名 Zj/assertFocusedInputTarget:粘贴前校验聚焦元素
 * __zcodeIabInputTargetToken 未漂移(deepestActiveElement 深度解析)。
 */
export async function assertFocusedInputTarget(view: ControlledView, target: TextInputEvaluateTarget, token: string): Promise<void> {
  const response = await sendToTarget(view, target, "Runtime.evaluate", {
    ...(target.contextId == null ? {} : { contextId: target.contextId }),
    expression: `(() => {
      const deepestActiveElement = (root) => {
        const active = root.activeElement;
        if (active == null) return null;
        const view = active.ownerDocument.defaultView ?? window;
        if (active instanceof view.HTMLElement && active.shadowRoot != null)
          return deepestActiveElement(active.shadowRoot) ?? active;
        return active;
      };
      return deepestActiveElement(document)?.${INPUT_TARGET_TOKEN_FIELD} === ${JSON.stringify(token)};
    })()`,
    returnByValue: true,
  }) as CdpEvaluateResponse
  const runtimeError = cdpRuntimeError(response)
  if (runtimeError) throw new Error(`Browser Use could not verify the focused input target: ${runtimeError}`)
  if (response.result?.value !== true) throw new Error("Active element is no longer the expected input target")
}

/** dispatchTextInput 的选项(ZCode 原名 Ug 的第二参形状 + 剪贴板条目直传)。 */
export interface TextInputDispatchOptions {
  /** 粘贴前聚焦元素 token 校验值(缺省不投递,Fj 跳过校验) */
  inputTargetToken?: string
  /** 预构建剪贴板条目;缺省按 text + 富文本启发式经 clipboardItems 构造 */
  clipboardItems?: BrowserClipboardItem[]
  /** 覆盖 payload.richTextFallback 与 text/html 条目构造;缺省按 URL 启发式 */
  richTextFallback?: boolean
  /** true 时替换输入值而非追加(Fj fallbackPaste 语义) */
  replaceInputValue?: boolean
  /** 已解析的求值目标(Sde.initialTarget;OOPIF sessionId/隔离世界 contextId) */
  initialTarget?: TextInputEvaluateTarget
}

/** Fj 页函数 payload(options 形状,逐字段与 ZCode Ug 构造一致)。 */
interface TextInputPagePayload {
  clipboardItems: BrowserClipboardItem[]
  inputTargetToken?: string
  replaceInputValue: boolean
  richTextFallback: boolean
}

/**
 * ZCode 原名 Ug/pasteTextIntoFocusedTarget(dispatchTextInput 为语义化对外名):
 * 解析聚焦输入目标 → 构造剪贴板条目(clipboardItems 直传优先)→ Runtime.evaluate
 * 包裹 Fj(awaitPromise+returnByValue)→ 异常/结果归一化 → finally 释放全部
 * 附加会话。
 */
export async function dispatchTextInput(view: ControlledView, text: string, options: TextInputDispatchOptions = {}): Promise<void> {
  const resolved = await resolveFocusedInputTarget(view, options.initialTarget)
  try {
    const includeRichText = options.richTextFallback ?? shouldIncludeRichText(view.webContents.getURL())
    const payload: TextInputPagePayload = {
      clipboardItems: options.clipboardItems ?? clipboardItems(text, includeRichText),
      ...(options.inputTargetToken == null ? {} : { inputTargetToken: options.inputTargetToken }),
      replaceInputValue: options.replaceInputValue === true,
      richTextFallback: includeRichText,
    }
    const response = await sendToTarget(view, resolved.target, "Runtime.evaluate", {
      ...(resolved.target.contextId == null ? {} : { contextId: resolved.target.contextId }),
      expression: `(async () => {
        try {
          const pageFunction = ${pasteTextPageFunction()};
          const data = await pageFunction(${JSON.stringify(payload)});
          return { ok: true, data };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }) as CdpEvaluateResponse
    const runtimeError = cdpRuntimeError(response)
    if (runtimeError) throw new Error(`Browser Use encountered an error interacting with this webpage's clipboard: ${runtimeError}`)
    const result = response.result?.value
    if (!result || typeof result !== "object" || !("ok" in result)) {
      throw new Error("Browser Use encountered an error interacting with this webpage's clipboard: type returned an invalid result")
    }
    if ((result as { ok?: unknown }).ok !== true) {
      const failure = "error" in result && typeof (result as { error?: unknown }).error === "string"
        ? (result as { error: string }).error
        : "type failed"
      throw new Error(`Browser Use encountered an error interacting with this webpage's clipboard: ${failure}`)
    }
  } finally {
    await detachAttachedSessions(view, resolved.attachedSessionIds)
  }
}
