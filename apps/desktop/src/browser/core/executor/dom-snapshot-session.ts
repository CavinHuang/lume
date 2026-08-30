/**
 * Playwright DOM 快照会话 —— 纯 CDP 会话按帧递归抓取 playwright aria 快照并
 * 归一化为 Codex 风格 DOM 快照文本。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       02-execution-engine.source.js [SECTION] PlaywrightDomSnapshotSession (uM)
 *       及其前序小节(预算/abort 原语、快照文本树解析/清洗/渲染/归一化管道)
 *
 * ZCode 原名对照:
 *   Xde → MAIN_FRAME_SNAPSHOT_BUDGET_MS(主帧预算 3000ms)
 *   Yde → IFRAME_EXPANSION_BUDGET_MS(iframe 展开总预算 1000ms)
 *   zg  → PER_IFRAME_BUDGET_MS(单子帧预算 500ms)
 *   Qde → snapshotAbortError(abortError)
 *   vH  → throwIfAborted
 *   Zg  → remainingBudget
 *   ele → runtimeExceptionMessage
 *   tle → parseSnapshotTree
 *   nle → cleanSnapshotLine
 *   kH  → normalizeSnapshotNode
 *   bH  → renderSnapshotTree
 *   rle → normalizeCodexDomSnapshot
 *   ole → iframeRefFromLine
 *   ile → mergeIframeSnapshots
 *   uM  → PlaywrightDomSnapshotSession
 *   _H  → captureCodexDomSnapshot
 *   (Fg/Jde/Wg → getPlaywrightInjectedScriptSource/DOM_SNAPSHOT_WORLD_NAME/
 *     PLAYWRIGHT_INJECTED_GLOBAL_FIELD,见 ./injected-loader)
 *
 * 语义偏差(应为空,除以下已声明项):
 *   - 提取源小节注释提到的 Emulation 视口覆盖(bM/buildViewportMetricsOverride)
 *     不在 uM 类代码内,已随 guest-manager 移植,本会话不含 Emulation 调用。
 *   - s(X,"name") 为压缩器 displayName 元数据,一律去除。
 */
import type { ControlledView } from "../types"
import { DOM_SNAPSHOT_WORLD_NAME, PLAYWRIGHT_INJECTED_GLOBAL_FIELD, getPlaywrightInjectedScriptSource } from "./injected-loader"

/* ── 预算与 abort 原语 ─────────────────────────────────────────────── */

/** ZCode 原名 Xde:主帧快照预算(ms)。 */
const MAIN_FRAME_SNAPSHOT_BUDGET_MS = 3_000
/** ZCode 原名 Yde:iframe 展开总预算(ms)。 */
const IFRAME_EXPANSION_BUDGET_MS = 1_000
/** ZCode 原名 zg:单个子帧(解析/附加/读取)预算(ms)。 */
const PER_IFRAME_BUDGET_MS = 500

/**
 * ZCode 原名 Qde/abortError:DOM 快照中止异常(AbortError)。
 */
function snapshotAbortError(): DOMException {
  return new DOMException("Browser DOM snapshot aborted", "AbortError")
}

/** ZCode 原名 vH/throwIfAborted:信号已中止则抛 AbortError。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw snapshotAbortError()
}

/**
 * ZCode 原名 Zg/remainingBudget:剩余预算夹取(至少 1ms,至多 budgetMs)。
 */
function remainingBudget(deadline: number, budgetMs: number): number {
  return Math.max(1, Math.min(budgetMs, deadline - Date.now()))
}

/** CDP Runtime.evaluate 响应形状(仅取用字段)。 */
interface CdpEvaluateResponse {
  result?: { objectId?: string; subtype?: string; value?: unknown }
  exceptionDetails?: { exception?: { description?: string; value?: unknown }; text?: string }
}

/**
 * ZCode 原名 ele/runtimeExceptionMessage:统一提取 CDP 异常文本;无异常返回
 * undefined,兜底文案 "Playwright DOM snapshot evaluation failed"。
 */
function runtimeExceptionMessage(response: CdpEvaluateResponse): string | undefined {
  const details = response.exceptionDetails
  if (!details) return undefined
  return details.exception?.description
    ?? (details.exception?.value == null ? undefined : String(details.exception.value))
    ?? details.text
    ?? "Playwright DOM snapshot evaluation failed"
}

/* ── 快照文本树解析/清洗/渲染/归一化管道 ───────────────────────────── */

/** 快照文本树节点(缩进层级 + 去缩进行文本)。 */
export interface SnapshotTreeNode {
  children: SnapshotTreeNode[]
  indent: number
  line: string
}

/**
 * ZCode 原名 tle/parseSnapshotTree:按前导空格缩进把快照文本解析为森林;
 * 空行跳过,栈回退到缩进 <= 栈顶的祖先。
 */
export function parseSnapshotTree(source: string): SnapshotTreeNode[] {
  const root: SnapshotTreeNode = { children: [], indent: -1, line: "" }
  const stack: SnapshotTreeNode[] = [root]
  for (const rawLine of source.split("\n")) {
    if (rawLine.trim() === "") continue
    const indent = rawLine.match(/^ */)?.[0].length ?? 0
    const node: SnapshotTreeNode = { children: [], indent, line: rawLine.slice(indent) }
    while (stack.length > 1 && indent <= (stack.at(-1)?.indent ?? -1)) stack.pop()
    stack.at(-1)?.children.push(node)
    stack.push(node)
  }
  return root.children
}

/**
 * ZCode 原名 nle/cleanSnapshotLine:剥离 " [ref=…]" 与 " [cursor=…]" 标注。
 */
export function cleanSnapshotLine(line: string): string {
  return line.replace(/ \[ref=[^\]]+\]/g, "").replace(/ \[cursor=[^\]]+\]/g, "")
}

/**
 * ZCode 原名 kH/normalizeSnapshotNode:递归归一化 —— `- img` 行整支丢弃;
 * `- generic`/`- listitem`/`- group` 行以子节点顶替(自身不输出);其余保留。
 */
export function normalizeSnapshotNode(node: SnapshotTreeNode): SnapshotTreeNode[] {
  const children = node.children.flatMap(normalizeSnapshotNode)
  const cleaned = cleanSnapshotLine(node.line)
  if (/^- img(?: \[[^\]]+\])*:?$/u.test(cleaned)) return []
  if (/^- (?:generic|listitem|group)(?: \[[^\]]+\])*:?$/u.test(cleaned)) return children
  return [{ children, indent: node.indent, line: cleaned }]
}

/**
 * ZCode 原名 bH/renderSnapshotTree:树 → 两空格缩进文本(拼接串);子树拼接
 * 结果为空串时不追加(与原 `i && r.push(i)` 一致)。
 */
export function renderSnapshotTree(nodes: SnapshotTreeNode[], depth = 0): string {
  const lines: string[] = []
  const indent = "  ".repeat(depth)
  for (const node of nodes) {
    lines.push(indent + node.line)
    const childBlock = renderSnapshotTree(node.children, depth + 1)
    if (childBlock) lines.push(childBlock)
  }
  return lines.join("\n")
}

/**
 * ZCode 原名 rle/normalizeCodexDomSnapshot:归一化管道入口 —— 非树形文本
 * (无 "- " 行)原样返回;否则解析 → 逐节点归一化 → 渲染。
 */
export function normalizeCodexDomSnapshot(snapshot: string): string {
  if (!snapshot.startsWith("- ") && !snapshot.includes("\n- ") && !snapshot.includes("\n  - ")) return snapshot
  return renderSnapshotTree(parseSnapshotTree(snapshot).flatMap(normalizeSnapshotNode))
}

/**
 * ZCode 原名 ole/iframeRefFromLine:从 "- iframe [ref=…]" 行提取 ref;
 * 非 iframe 行返回 undefined。
 */
export function iframeRefFromLine(line: string): string | undefined {
  if (line.trimStart().startsWith("- iframe")) return line.match(/\[ref=([^\]]+)\]/)?.[1]
  return undefined
}

/**
 * ZCode 原名 ile/mergeIframeSnapshots:把子帧快照内联到父快照 —— 命中 ref
 * 的行先补齐 ":" 结尾,再把子快照按行缩进(行首空白 + 两空格)追加其后。
 */
export function mergeIframeSnapshots(snapshot: string, childrenByRef: Map<string, string | undefined>): string {
  const lines: string[] = []
  for (const line of snapshot.split("\n")) {
    const ref = iframeRefFromLine(line)
    const child = ref ? childrenByRef.get(ref) : undefined
    if (!child) {
      lines.push(line)
      continue
    }
    const indent = line.match(/^ */)?.[0] ?? ""
    lines.push(line.endsWith(":") ? line : `${line}:`)
    lines.push(...child.split("\n").map((childLine) => `${indent}  ${childLine}`))
  }
  return lines.join("\n")
}

/* ── PlaywrightDomSnapshotSession (uM) ─────────────────────────────── */

/** CDP 会话求值目标(sessionId / 帧 id / 隔离世界 executionContextId)。 */
interface SnapshotTarget {
  sessionId?: string
  frameId?: string
  contextId?: number
}

/** 注入 runtime incrementalAriaSnapshot 返回的单帧快照(shape 校验后)。 */
interface FrameDomSnapshot {
  full: string
  iframeDepths: Record<string, number>
  iframeRefs: string[]
}

/**
 * ZCode 原名 uM/PlaywrightDomSnapshotSession:纯 CDP 会话(Page/Runtime/
 * DOM.enable + getFrameTree),按帧在隔离世界(DOM_SNAPSHOT_WORLD_NAME)执行
 * injected.playwright.incrementalAriaSnapshot(root,{mode:"ai"});对 aria 可见
 * 且非 aria-hidden 的 iframe 经 Target.attachToTarget 递归展开并内联合并,
 * finally 释放全部自附加会话。
 */
export class PlaywrightDomSnapshotSession {
  private readonly cdp: ControlledView["cdp"]
  private readonly signal?: AbortSignal
  private readonly attachedSessionIds = new Set<string>()
  private readonly frameContexts = new Map<string, SnapshotTarget>()

  constructor(cdp: ControlledView["cdp"], signal?: AbortSignal) {
    this.cdp = cdp
    this.signal = signal
  }

  /**
   * ZCode 原名 capture:使能 Page/Runtime/DOM → 主帧快照(3000ms)→ iframe
   * 展开(总预算 1000ms)→ 归一化;finally 释放自附加会话;主帧缺失抛错。
   */
  async capture(): Promise<string> {
    throwIfAborted(this.signal)
    await this.send({}, "Page.enable")
    await this.send({}, "Runtime.enable")
    await this.send({}, "DOM.enable")
    const frameTree = await this.send({}, "Page.getFrameTree") as { frameTree?: { frame?: { id?: string } } }
    const mainFrameId = frameTree.frameTree?.frame?.id
    if (!mainFrameId) throw new Error("Page.getFrameTree returned no main frame id")
    try {
      const rootSnapshot = await this.readFrameSnapshot({ frameId: mainFrameId }, MAIN_FRAME_SNAPSHOT_BUDGET_MS)
      if (!rootSnapshot) return ""
      const iframeDeadline = Date.now() + IFRAME_EXPANSION_BUDGET_MS
      const expanded = await this.expandIframes(rootSnapshot, { frameId: mainFrameId }, iframeDeadline)
      return normalizeCodexDomSnapshot(expanded)
    } finally {
      await this.detachOwnedSessions()
    }
  }

  /** ZCode 原名 send:每次发送前检查 abort,按目标 sessionId 转发 CDP 命令。 */
  private async send(target: SnapshotTarget, method: string, params?: Record<string, unknown>): Promise<unknown> {
    throwIfAborted(this.signal)
    return this.cdp.send(method, params, target.sessionId)
  }

  /** ZCode 原名 contextKey:会话+帧 的上下文缓存键。 */
  private contextKey(target: Pick<SnapshotTarget, "sessionId">, frameId?: string): string {
    return `${target.sessionId ?? "root"}:${frameId}`
  }

  /**
   * ZCode 原名 ensureContext:按帧创建(或复用缓存)隔离世界执行上下文,
   * 首次创建后立刻注入 playwright runtime。
   */
  private async ensureContext(target: SnapshotTarget, budgetMs: number): Promise<SnapshotTarget> {
    const key = this.contextKey(target, target.frameId)
    const cached = this.frameContexts.get(key)
    if (cached) return cached
    const world = await this.send(target, "Page.createIsolatedWorld", {
      frameId: target.frameId,
      grantUniveralAccess: false,
      worldName: DOM_SNAPSHOT_WORLD_NAME,
    }) as { executionContextId?: number }
    if (!world.executionContextId) throw new Error(`Unable to create Playwright isolated world for frame ${target.frameId}`)
    const context: SnapshotTarget = { ...target, contextId: world.executionContextId }
    await this.ensureInjected(context, budgetMs)
    this.frameContexts.set(key, context)
    return context
  }

  /**
   * ZCode 原名 ensureInjected:探测全局注入字段,缺失时以官方
   * injectedScriptSource 构造 InjectedScript 实例挂到 globalThis。
   */
  private async ensureInjected(target: SnapshotTarget, budgetMs: number): Promise<void> {
    const probe = await this.evaluate(target, `Boolean(globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD})`, {
      returnByValue: true,
      timeoutMs: budgetMs,
    })
    if (probe.value === true) return
    const injectedOptions = {
      browserName: "chromium",
      customEngines: [] as unknown[],
      isUnderTest: false,
      sdkLanguage: "javascript",
      stableRafCount: 1,
      testIdAttributeName: "data-testid",
    }
    const bootstrap = `(() => {
      const module = {};
      ${getPlaywrightInjectedScriptSource()}
      globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD} = new (module.exports.InjectedScript())(
        globalThis,
        ${JSON.stringify(injectedOptions)}
      );
      return true;
    })()`
    const initialized = await this.evaluate(target, bootstrap, { returnByValue: true, timeoutMs: budgetMs })
    if (initialized.value !== true) throw new Error("Unable to initialize Playwright injected runtime")
  }

  /**
   * ZCode 原名 evaluate:目标上下文内 Runtime.evaluate(awaitPromise,超时
   * budget);异常文本经 runtimeExceptionMessage 抛出;返回 RemoteObject。
   */
  private async evaluate(target: SnapshotTarget, expression: string, options: { returnByValue: boolean; timeoutMs: number }): Promise<{ objectId?: string; subtype?: string; value?: unknown }> {
    const response = await this.send(target, "Runtime.evaluate", {
      awaitPromise: true,
      contextId: target.contextId,
      expression,
      returnByValue: options.returnByValue,
      timeout: options.timeoutMs,
    }) as CdpEvaluateResponse
    const failure = runtimeExceptionMessage(response)
    if (failure) throw new Error(failure)
    return response.result ?? {}
  }

  /**
   * ZCode 原名 readFrameSnapshot:注入 runtime 抓取当前帧 aria 快照
   * (mode:"ai"),过滤 aria-hidden/不可见的 iframe ref;结果形状不符抛错。
   */
  private async readFrameSnapshot(target: SnapshotTarget, budgetMs: number): Promise<FrameDomSnapshot> {
    const context = await this.ensureContext(target, budgetMs)
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD};
      const root = document.body || document.documentElement;
      if (!root) return { full: "", iframeDepths: {}, iframeRefs: [] };
      const snapshot = injected.incrementalAriaSnapshot(root, { mode: "ai" });
      const iframeRefs = snapshot.iframeRefs.filter((ref) => {
        if (!(ref in snapshot.iframeDepths)) return false;
        try {
          const [frame] = injected.querySelectorAll(injected.parseSelector("aria-ref=" + ref), root);
          return frame != null &&
            frame.getAttribute("aria-hidden") !== "true" &&
            injected.elementState(frame, "visible").matches === true;
        } catch {
          return false;
        }
      });
      return { ...snapshot, iframeRefs };
    })()`
    const value = (await this.evaluate(context, expression, { returnByValue: true, timeoutMs: budgetMs })).value
    const snapshot = value as FrameDomSnapshot | undefined
    if (!snapshot || typeof snapshot.full !== "string" || !Array.isArray(snapshot.iframeRefs)
      || !snapshot.iframeDepths || typeof snapshot.iframeDepths !== "object") {
      throw new Error("Playwright injected runtime returned an invalid DOM snapshot")
    }
    return snapshot
  }

  /**
   * ZCode 原名 frameIdForRef:按 aria-ref 解析 iframe 元素(DOM.describeNode)
   * 所属 frameId;RemoteObject 用毕释放(releaseObject 失败静默)。
   */
  private async frameIdForRef(target: SnapshotTarget, ref: string, budgetMs: number): Promise<string | undefined> {
    const context = await this.ensureContext(target, budgetMs)
    const expression = `(() => {
      const injected = globalThis.${PLAYWRIGHT_INJECTED_GLOBAL_FIELD};
      const root = document.body || document.documentElement;
      if (!root) return null;
      const [frame] = injected.querySelectorAll(
        injected.parseSelector(${JSON.stringify(`aria-ref=${ref}`)}),
        root
      );
      return frame || null;
    })()`
    const handle = await this.evaluate(context, expression, { returnByValue: false, timeoutMs: budgetMs })
    if (!handle.objectId || handle.subtype === "null") return undefined
    try {
      const described = await this.send(target, "DOM.describeNode", { objectId: handle.objectId }) as { node?: { frameId?: string } }
      return described.node?.frameId
    } finally {
      await this.send(target, "Runtime.releaseObject", { objectId: handle.objectId }).catch(() => {})
    }
  }

  /**
   * ZCode 原名 attachFrameTarget:附加帧目标(flatten);已附加且上下文已建
   * 时复用;使能三域后返回目标;失败静默返回 undefined。
   */
  private async attachFrameTarget(frameId: string): Promise<SnapshotTarget | undefined> {
    const owned = [...this.attachedSessionIds].find((sessionId) => this.frameContexts.has(this.contextKey({ sessionId }, frameId)))
    if (owned) return { sessionId: owned }
    try {
      const attached = await this.send({}, "Target.attachToTarget", { flatten: true, targetId: frameId }) as { sessionId?: string }
      if (!attached.sessionId) return undefined
      this.attachedSessionIds.add(attached.sessionId)
      const target: SnapshotTarget = { sessionId: attached.sessionId }
      await this.send(target, "Page.enable")
      await this.send(target, "Runtime.enable")
      await this.send(target, "DOM.enable")
      return target
    } catch {
      return undefined
    }
  }

  /**
   * ZCode 原名 childTarget:解析子帧执行上下文 —— 先复用当前会话(同会话
   * 隔离世界),失败再跨会话附加帧目标重试。
   */
  private async childTarget(target: SnapshotTarget, frameId: string, budgetMs: number): Promise<SnapshotTarget | undefined> {
    const sameSession: SnapshotTarget = { ...target, frameId }
    try {
      return await this.ensureContext(sameSession, budgetMs)
    } catch {
      const attached = await this.attachFrameTarget(frameId)
      if (!attached) return undefined
      const crossSession: SnapshotTarget = { ...attached, frameId }
      try {
        return await this.ensureContext(crossSession, budgetMs)
      } catch {
        return undefined
      }
    }
  }

  /**
   * ZCode 原名 readChildSnapshot:单子帧展开 —— ref→frameId→子上下文→帧
   * 快照,每步受剩余预算约束;期间 Target.getTargets 触发一次目标刷新重试;
   * 成功后递归展开其自身 iframe。
   */
  private async readChildSnapshot(target: SnapshotTarget, ref: string, deadline: number): Promise<string | undefined> {
    if (Date.now() >= deadline) return undefined
    let frameId = await this.frameIdForRef(target, ref, remainingBudget(deadline, PER_IFRAME_BUDGET_MS)).catch(() => undefined)
    if (!frameId || Date.now() >= deadline) return undefined
    let child = await this.childTarget(target, frameId, remainingBudget(deadline, PER_IFRAME_BUDGET_MS))
    if (!child && Date.now() < deadline) {
      await this.send(target, "Target.getTargets").catch(() => {})
      frameId = await this.frameIdForRef(target, ref, remainingBudget(deadline, PER_IFRAME_BUDGET_MS)).catch(() => undefined)
      if (frameId) child = await this.childTarget(target, frameId, remainingBudget(deadline, PER_IFRAME_BUDGET_MS))
    }
    if (!child || Date.now() >= deadline) return undefined
    const snapshot = await this.readFrameSnapshot(child, remainingBudget(deadline, PER_IFRAME_BUDGET_MS)).catch(() => undefined)
    if (!snapshot) return undefined
    return this.expandIframes(snapshot, child, deadline)
  }

  /**
   * ZCode 原名 expandIframes:对快照内可见 iframe ref 并行递归抓取子快照,
   * 按 ref 内联合并;无 ref 或超出总预算时返回原文。
   */
  private async expandIframes(snapshot: FrameDomSnapshot, target: SnapshotTarget, deadline: number): Promise<string> {
    const refs = snapshot.iframeRefs.filter((ref) => ref in snapshot.iframeDepths)
    if (refs.length === 0 || Date.now() >= deadline) return snapshot.full
    const childrenByRef = new Map<string, string | undefined>(await Promise.all(refs.map(async (ref) => [ref, await this.readChildSnapshot(target, ref, deadline)] as const)))
    return mergeIframeSnapshots(snapshot.full, childrenByRef)
  }

  /** ZCode 原名 detachOwnedSessions:allSettled 释放全部自附加会话并清空。 */
  private async detachOwnedSessions(): Promise<void> {
    await Promise.allSettled([...this.attachedSessionIds].map((sessionId) => this.cdp.send("Target.detachFromTarget", { sessionId })))
    this.attachedSessionIds.clear()
  }
}

/**
 * ZCode 原名 _H/captureCodexDomSnapshot:一次性入口 —— 建会话 → capture。
 */
export async function captureCodexDomSnapshot(view: ControlledView, signal?: AbortSignal): Promise<string> {
  return new PlaywrightDomSnapshotSession(view.cdp, signal).capture()
}
