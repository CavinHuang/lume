/**
 * 内嵌浏览器(IAB)46 命令协议 —— zod 单源 schema。
 *
 * 来源:
 *   - 命令枚举:`.zcode/analysis/zcode-browser-panel-architecture.md` §46 命令枚举
 *     (navigate/back/forward/reload/getState/snapshot/screenshot/click/fill/type/press/
 *     cuaKeypress/scroll/cuaScroll/domCuaScroll/hover/select/check/drag/cuaDrag/elementInfo/
 *     evaluate/waitFor/getDialog/handleDialog/playwright/playwrightWaitForTimeout/capabilities/
 *     browserVisibilityGet/Set/browserViewportSet/Reset/recordingStart/Status/Cancel/
 *     activateTab/newTab/claimTab/list/listUserTabs/nameSession/finalize/finalizeTabs/
 *     markDeliverable/markHandoff/close/cancelRequest/turnEnded/closeSession)
 *   - 参数形状:`01-browser-guest-manager.source.js` executeInScope 分发 +
 *     `02-execution-engine.source.js` jg(executeBrowserCommandOnView)分发器 / TH(handlePlaywrightAction)
 *   - 设计:`docs/plans/2026-08-30-browser-rewrite-design.md` §2.1
 *
 * 载荷形状:与还原源码一致为平铺形态(method + 顶层参数),命令与归属上下文分离;
 * 请求侧一律 strict,结果侧开放(passthrough,各命令结果键不一)。
 */
import { z } from "zod"

import { BROWSER_RECORDING_MAX_DURATION_MS, BROWSER_VIEWPORT_LIMITS } from "./constants"
import { BROWSER_ERROR_CODES, type BrowserErrorCode, type BrowserErrorSideEffect } from "./errors"

/* ════════════════════════════════════════════════════════════════════
 * 基础标量
 * ════════════════════════════════════════════════════════════════════ */

/** 鼠标键位(CDP Input.dispatchMouseEvent button) */
export const browserMouseButtonSchema = z.enum(["left", "middle", "right"])
export type BrowserMouseButton = z.infer<typeof browserMouseButtonSchema>

/** 键盘修饰键(ControlOrMeta 在 darwin 映射 Meta) */
export const browserModifierSchema = z.enum(["Alt", "Control", "ControlOrMeta", "Meta", "Shift"])
export type BrowserModifier = z.infer<typeof browserModifierSchema>

/** 页面坐标(CSS 像素) */
export const browserPointSchema = z
  .object({ x: z.number().finite(), y: z.number().finite() })
  .strict()
export type BrowserPoint = z.infer<typeof browserPointSchema>

/**
 * 视口尺寸(CM/assertViewportOverride 边界)。
 * 录制 viewport 与 browserViewportSet 共用该约束;超出范围执行器抛
 * "browser viewport is outside the supported free-size range"。
 */
export const browserViewportSchema = z
  .object({
    width: z.number().int().min(BROWSER_VIEWPORT_LIMITS.minWidth).max(BROWSER_VIEWPORT_LIMITS.maxWidth),
    height: z.number().int().min(BROWSER_VIEWPORT_LIMITS.minHeight).max(BROWSER_VIEWPORT_LIMITS.maxHeight),
  })
  .strict()
export type BrowserViewport = z.infer<typeof browserViewportSchema>

/** 可选携带的 tab 定位(缺省解析为当前作用域活动 tab) */
const optionalTabId = z.string().min(1).optional()

/** playwright 系超时(ui/normalizePlaywrightTimeout:缺省 3000ms,非负整数) */
const playwrightTimeoutMs = z.number().int().nonnegative().optional()

/* ════════════════════════════════════════════════════════════════════
 * 归属上下文与结果 meta
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 命令归属上下文(desktop core `BrowserOwnerContext` 的桥接子集)。
 *
 * - ZCode host 后端恒以 `desktop-continuous` 发起;core 合同另含
 *   `web-remote-replayable`(Lume 扩展位),桥接协议出现需要时再放宽。
 * - `windowId`/`remoteSessionId` 为五元组 scope 成分(scopeKey),由桌面端填充,
 *   sidecar 侧可缺省。
 */
export const browserCommandContextSchema = z
  .object({
    requestId: z.string().min(1),
    sessionId: z.string(),
    turnId: z.string().optional(),
    workspaceKey: z.string(),
    browserId: z.string().min(1),
    browserGeneration: z.number().int().nonnegative(),
    clientMode: z.literal("desktop-continuous"),
    windowId: z.number().int().nonnegative().optional(),
    remoteSessionId: z.string().optional(),
  })
  .strict()
export type BrowserCommandContext = z.infer<typeof browserCommandContextSchema>

/**
 * 结果 meta(withMeta 统一附加;逐字段对照 core/types.ts `BrowserResultMeta`)。
 */
export const browserResultMetaSchema = z
  .object({
    browserUse: z.literal(true),
    backendType: z.literal("iab"),
    browserId: z.string(),
    browserGeneration: z.number().int(),
    openTabIds: z.array(z.string()),
    tabId: z.string().optional(),
    currentUrl: z.string().optional(),
    lifecycle: z.enum(["active", "closed", "deliverable", "handoff"]).optional(),
  })
  .strict()
export type BrowserResultMeta = z.infer<typeof browserResultMetaSchema>

/** 稳定错误负载(线上形态) */
export const browserErrorPayloadSchema = z
  .object({
    code: z.enum(BROWSER_ERROR_CODES),
    message: z.string(),
    sideEffect: z.enum(["none", "uncertain"]).optional(),
  })
  .strict()
export type BrowserErrorPayloadSchema = z.infer<typeof browserErrorPayloadSchema>

/* ════════════════════════════════════════════════════════════════════
 * playwright 动作(TH/handlePlaywrightAction + 01 管理器分支)
 * ════════════════════════════════════════════════════════════════════ */

/**
 * playwright.evaluate 表达式形态。
 * - `"expression"`:页面内求值 `(arg) => (expression)`;
 * - `"function"`:`(expression)(arg)`。
 */
export const browserExpressionKindSchema = z.enum(["expression", "function"])
export type BrowserExpressionKind = z.infer<typeof browserExpressionKindSchema>

/** 导航/加载等待态;`networkidle` 执行器显式拒绝(execution_error) */
export const browserLoadStateSchema = z.enum(["commit", "domcontentloaded", "load", "networkidle"])
export type BrowserLoadState = z.infer<typeof browserLoadStateSchema>

/** locator.waitFor 期待态(waitForState) */
export const browserLocatorWaitStateSchema = z.enum(["visible", "hidden", "attached", "detached"])
export type BrowserLocatorWaitState = z.infer<typeof browserLocatorWaitStateSchema>

/**
 * locator 操作集(IabPlaywrightLocatorSession.execute/perform 全量)。
 * 副作用操作(click/dblclick/downloadMedia/fill/press/selectOption/setChecked)按
 * `_M`(isSideEffecting)白名单,取消时标 sideEffect:"uncertain"。
 */
export const browserLocatorOperationSchema = z.enum([
  "click",
  "dblclick",
  "fill",
  "press",
  "selectOption",
  "setChecked",
  "downloadMedia",
  "evaluate",
  "count",
  "allTextContents",
  "isVisible",
  "isEnabled",
  "waitFor",
  "textContent",
  "innerText",
  "getAttribute",
])
export type BrowserLocatorOperation = z.infer<typeof browserLocatorOperationSchema>

/** playwright.locator 单动作参数(帧链用 " >> " 编码在 selector 内,无独立 frame 字段) */
export const browserLocatorActionSchema = z
  .object({
    name: z.literal("locator"),
    /** 同源 Playwright selector 引擎(仅允许从快照事实构建:css/text/xpath/role) */
    selector: z.string().min(1),
    operation: browserLocatorOperationSchema,
    timeoutMs: playwrightTimeoutMs,
    /** 跳过 actionability 探测(click/dblclick/fill…) */
    force: z.boolean().optional(),
    button: browserMouseButtonSchema.optional(),
    modifiers: z.array(browserModifierSchema).optional(),
    /** fill 文本 / press 键名("Control+a" 形式,+ 拆解) */
    value: z.string().optional(),
    /** fill:false 为追加而非替换 */
    replace: z.boolean().optional(),
    /** setChecked 目标态 */
    checked: z.boolean().optional(),
    /** selectOption 目标值(value 优先,匹配不到再按 text) */
    selections: z.array(z.string()).optional(),
    /** getAttribute 目标属性名 */
    attribute: z.string().optional(),
    /** waitFor 期待态(缺省 visible) */
    state: browserLocatorWaitStateSchema.optional(),
    /** evaluate 表达式(元素为 this,arg 注入) */
    expression: z.string().optional(),
    expressionKind: browserExpressionKindSchema.optional(),
    arg: z.unknown().optional(),
  })
  .strict()
export type BrowserLocatorAction = z.infer<typeof browserLocatorActionSchema>

/**
 * playwright 动作判别联合(TH 按 t.name 分发的全量 + 01 管理器处理的下载/上传分支)。
 *
 * - domSnapshot:aria 快照(无参数);
 * - elementInfo/elementScreenshot:基于坐标(x,y);
 * - evaluate:页面求值;
 * - waitForURL/waitForLoadState:导航态等待(waitUntil/state 缺省 load);
 * - locator:选择器操作(上表 16 种);
 * - downloadPath / waitForEvent(download):下载落地(管理器处理);
 * - fileChooserSetFiles / waitForEvent(filechooser):iab 明确拒绝
 *   capability_unsupported "File uploads are not supported by iab" ——
 *   保留在联合内使管理器(而非 zod 解析)产出该稳定错误。
 */
export const browserPlaywrightActionSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("domSnapshot") }).strict(),
  z
    .object({
      name: z.literal("elementInfo"),
      x: z.number().finite(),
      y: z.number().finite(),
      /** elementsFromPoint 过滤时可放行非可交互元素 */
      includeNonInteractable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({ name: z.literal("elementScreenshot"), x: z.number().finite(), y: z.number().finite() })
    .strict(),
  z
    .object({
      name: z.literal("evaluate"),
      expression: z.string().min(1),
      expressionKind: browserExpressionKindSchema.optional(),
      arg: z.unknown().optional(),
      timeoutMs: playwrightTimeoutMs,
    })
    .strict(),
  z
    .object({
      name: z.literal("waitForURL"),
      /** glob 形态 URL 匹配 */
      url: z.string().min(1),
      waitUntil: browserLoadStateSchema.optional(),
      timeoutMs: playwrightTimeoutMs,
    })
    .strict(),
  z
    .object({ name: z.literal("waitForLoadState"), state: browserLoadStateSchema.optional(), timeoutMs: playwrightTimeoutMs })
    .strict(),
  browserLocatorActionSchema,
  z
    .object({ name: z.literal("downloadPath"), downloadId: z.string().min(1), timeoutMs: playwrightTimeoutMs })
    .strict(),
  z
    .object({
      name: z.literal("waitForEvent"),
      event: z.enum(["download", "filechooser"]),
      timeoutMs: playwrightTimeoutMs,
    })
    .strict(),
  z
    .object({ name: z.literal("fileChooserSetFiles"), paths: z.array(z.string().min(1)).min(1) })
    .strict(),
])
export type BrowserPlaywrightAction = z.infer<typeof browserPlaywrightActionSchema>

/* ════════════════════════════════════════════════════════════════════
 * 录制(runRecording options + 数据化动作 DSL)
 * ════════════════════════════════════════════════════════════════════ */

/** 录制动作的执行后等待(所有动作共享) */
function optionalDelayMs() {
  return z.number().int().nonnegative().optional()
}

/**
 * 录制动作 DSL(数据化,executeRecordingAction 分支全量)。
 * 所有动作共享可选 `delayAfterMs`(执行后等待)。纯数据描述,不含可执行代码。
 */
export const browserRecordingActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), durationMs: z.number().int().nonnegative(), delayAfterMs: optionalDelayMs() }).strict(),
  z
    .object({
      type: z.literal("click"),
      /** 有 selector 走 locator(click/dblclick),否则必须给 (x,y) 坐标点击 */
      selector: z.string().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      doubleClick: z.boolean().optional(),
      button: browserMouseButtonSchema.optional(),
      delayAfterMs: optionalDelayMs(),
    })
    .strict(),
  z
    .object({ type: z.literal("type"), selector: z.string().min(1), text: z.string(), delayAfterMs: optionalDelayMs() })
    .strict(),
  z
    .object({
      type: z.literal("hover"),
      selector: z.string().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      durationMs: z.number().int().nonnegative().optional(),
      delayAfterMs: optionalDelayMs(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      x: z.number().finite(),
      y: z.number().finite(),
      durationMs: z.number().int().nonnegative().optional(),
      delayAfterMs: optionalDelayMs(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scroll"),
      deltaX: z.number().finite().optional(),
      deltaY: z.number().finite(),
      durationMs: z.number().int().nonnegative().optional(),
      delayAfterMs: optionalDelayMs(),
    })
    .strict(),
  z
    .object({
      type: z.literal("scrollTo"),
      selector: z.string().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      durationMs: z.number().int().nonnegative().optional(),
      delayAfterMs: optionalDelayMs(),
    })
    .strict(),
  z
    .object({
      type: z.literal("wheel"),
      deltaX: z.number().finite().optional(),
      deltaY: z.number().finite(),
      times: z.number().int().positive().optional(),
      intervalMs: z.number().int().nonnegative().optional(),
      delayAfterMs: optionalDelayMs(),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      path: z.array(browserPointSchema).min(2),
      durationMs: z.number().int().nonnegative().optional(),
      delayAfterMs: optionalDelayMs(),
    })
    .strict(),
  z
    .object({
      type: z.literal("waitFor"),
      selector: z.string().min(1),
      state: browserLocatorWaitStateSchema.optional(),
      timeoutMs: z.number().int().nonnegative().optional(),
      delayAfterMs: optionalDelayMs(),
    })
    .strict(),
])
export type BrowserRecordingAction = z.infer<typeof browserRecordingActionSchema>

/** recordingStart options(runRecording 解构 + zod 上限) */
export const browserRecordingOptionsSchema = z
  .object({
    viewport: browserViewportSchema.optional(),
    fps: z.number().int().positive().optional(),
    /** 缺省 60000,上限 90000(guide §1.4) */
    maxDurationMs: z.number().int().positive().max(BROWSER_RECORDING_MAX_DURATION_MS).optional(),
    settleMs: z.number().int().nonnegative().optional(),
    /** 缺省 true(false 时不注入光标 overlay) */
    showCursor: z.boolean().optional(),
    actions: z.array(browserRecordingActionSchema).optional(),
  })
  .strict()
export type BrowserRecordingOptions = z.infer<typeof browserRecordingOptionsSchema>

/** 录制任务快照(snapshotRecording) */
export const browserRecordingSnapshotSchema = z.looseObject({
  id: z.string(),
  status: z.enum(["running", "completed", "cancelled", "failed"]),
  phase: z.enum(["preparing", "capturing", "finalizing", "completed", "cancelled", "failed"]),
  progress: z.number(),
  startedAt: z.number(),
  updatedAt: z.number(),
  artifact: z
    .looseObject({
      path: z.string(),
      mimeType: z.string(),
      width: z.number(),
      height: z.number(),
      fps: z.number(),
      durationMs: z.number(),
      frameCount: z.number(),
    })
    .optional(),
  error: z.string().optional(),
})
export type BrowserRecordingSnapshot = z.infer<typeof browserRecordingSnapshotSchema>

/* ════════════════════════════════════════════════════════════════════
 * 46 命令面
 * ════════════════════════════════════════════════════════════════════ */

/** 截图 clip 区域(Page.captureScreenshot clip,scale 恒 1 由执行器注入) */
const screenshotClip = z
  .object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() })
  .strict()

/**
 * 命令 schema 判别联合。
 *
 * 形状按还原源码逐条对照;仅一个例外(枚举内成员、执行器无路由):
 * - `waitFor`:与 locator.waitFor 同构 {selector, state?, timeoutMs?};执行器无路由。
 * `fill` 此前同为无路由例外,ZCode 执行器 jg 无该分支;Lume 执行器已按 locator
 * fill 语义补齐 case(fill = 聚焦目标 + replaceInputValue 替换粘贴),与 type
 * 同构 {ref?, text}。
 */
export const browserCommandSchema = z.discriminatedUnion("method", [
  /* ── 导航 ── */
  z.object({ method: z.literal("navigate"), tabId: optionalTabId, url: z.string().min(1) }).strict(),
  z.object({ method: z.literal("back"), tabId: optionalTabId }).strict(),
  z.object({ method: z.literal("forward"), tabId: optionalTabId }).strict(),
  z.object({ method: z.literal("reload"), tabId: optionalTabId }).strict(),
  z.object({ method: z.literal("getState"), tabId: optionalTabId }).strict(),
  /* ── 观察 ── */
  z
    .object({
      method: z.literal("snapshot"),
      tabId: optionalTabId,
      /** 可交互元素上限(缺省 200) */
      maxElements: z.number().int().positive().optional(),
      /** 是否包含隐藏元素(缺省 false) */
      includeHidden: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("screenshot"),
      tabId: optionalTabId,
      fullPage: z.boolean().optional(),
      clip: screenshotClip.optional(),
    })
    .strict(),
  z
    .object({ method: z.literal("elementInfo"), tabId: optionalTabId, x: z.number().finite(), y: z.number().finite() })
    .strict(),
  z.object({ method: z.literal("evaluate"), tabId: optionalTabId, expression: z.string().min(1) }).strict(),
  /* ── 交互 ── */
  z
    .object({
      method: z.literal("click"),
      tabId: optionalTabId,
      ref: z.string().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      button: browserMouseButtonSchema.optional(),
      doubleClick: z.boolean().optional(),
      modifiers: z.array(browserModifierSchema).optional(),
    })
    .strict(),
  z
    .object({ method: z.literal("fill"), tabId: optionalTabId, ref: z.string().optional(), text: z.string() })
    .strict(),
  z
    .object({ method: z.literal("type"), tabId: optionalTabId, ref: z.string().optional(), text: z.string() })
    .strict(),
  z
    .object({
      method: z.literal("press"),
      tabId: optionalTabId,
      ref: z.string().optional(),
      key: z.string().min(1),
      modifiers: z.array(browserModifierSchema).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("scroll"),
      tabId: optionalTabId,
      /** 有 ref 先解析元素中心;否则 (x,y) 为滚动增量(deltaX/deltaY) */
      ref: z.string().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("hover"),
      tabId: optionalTabId,
      ref: z.string().optional(),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      modifiers: z.array(browserModifierSchema).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("select"),
      tabId: optionalTabId,
      ref: z.string().min(1),
      values: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      method: z.literal("check"),
      tabId: optionalTabId,
      ref: z.string().min(1),
      checked: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("drag"),
      tabId: optionalTabId,
      fromRef: z.string().optional(),
      from: browserPointSchema.optional(),
      toRef: z.string().optional(),
      to: browserPointSchema.optional(),
      modifiers: z.array(browserModifierSchema).optional(),
    })
    .strict(),
  /* ── CUA(CDP Input 坐标路径) ── */
  z.object({ method: z.literal("cuaKeypress"), tabId: optionalTabId, keys: z.array(z.string().min(1)).min(1) }).strict(),
  z
    .object({
      method: z.literal("cuaScroll"),
      tabId: optionalTabId,
      x: z.number().finite(),
      y: z.number().finite(),
      scrollX: z.number().finite(),
      scrollY: z.number().finite(),
      modifiers: z.array(browserModifierSchema).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("domCuaScroll"),
      tabId: optionalTabId,
      /** 快照 ref(node_id);缺省滚动视口中心 */
      nodeId: z.string().optional(),
      scrollX: z.number().finite(),
      scrollY: z.number().finite(),
    })
    .strict(),
  z
    .object({
      method: z.literal("cuaDrag"),
      tabId: optionalTabId,
      path: z.array(browserPointSchema).min(2),
      modifiers: z.array(browserModifierSchema).optional(),
    })
    .strict(),
  /* ── Playwright ── */
  z.object({ method: z.literal("playwright"), tabId: optionalTabId, action: browserPlaywrightActionSchema }).strict(),
  z
    .object({ method: z.literal("playwrightWaitForTimeout"), tabId: optionalTabId, timeoutMs: z.number().int().nonnegative() })
    .strict(),
  z
    .object({
      method: z.literal("waitFor"),
      tabId: optionalTabId,
      selector: z.string().min(1),
      state: browserLocatorWaitStateSchema.optional(),
      timeoutMs: playwrightTimeoutMs,
    })
    .strict(),
  /* ── 对话框 ── */
  z.object({ method: z.literal("getDialog"), tabId: optionalTabId }).strict(),
  z
    .object({
      method: z.literal("handleDialog"),
      tabId: optionalTabId,
      accept: z.boolean(),
      promptText: z.string().optional(),
    })
    .strict(),
  /* ── 可见性 / 视口 ── */
  z.object({ method: z.literal("browserVisibilityGet") }).strict(),
  z.object({ method: z.literal("browserVisibilitySet"), visible: z.boolean() }).strict(),
  z
    .object({
      method: z.literal("browserViewportSet"),
      tabId: optionalTabId,
      width: browserViewportSchema.shape.width,
      height: browserViewportSchema.shape.height,
    })
    .strict(),
  z.object({ method: z.literal("browserViewportReset"), tabId: optionalTabId }).strict(),
  /* ── 录制 ── */
  z
    .object({ method: z.literal("recordingStart"), tabId: optionalTabId, options: browserRecordingOptionsSchema.optional() })
    .strict(),
  z.object({ method: z.literal("recordingStatus"), recordingId: z.string().min(1), tabId: optionalTabId }).strict(),
  z.object({ method: z.literal("recordingCancel"), recordingId: z.string().min(1), tabId: optionalTabId }).strict(),
  /* ── tab 生命周期 ── */
  z.object({ method: z.literal("newTab") }).strict(),
  z.object({ method: z.literal("activateTab"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("claimTab"), tabId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("list") }).strict(),
  z.object({ method: z.literal("listUserTabs") }).strict(),
  z.object({ method: z.literal("nameSession"), name: z.string() }).strict(),
  z
    .object({
      method: z.literal("finalize"),
      tabId: optionalTabId,
      /** false 表示回退 active(true/缺省 → deliverable) */
      deliverable: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("finalizeTabs"),
      keep: z
        .array(
          z
            .object({ tabId: z.string().min(1), status: z.enum(["deliverable", "handoff"]) })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z.object({ method: z.literal("markDeliverable"), tabId: optionalTabId }).strict(),
  z.object({ method: z.literal("markHandoff"), tabId: optionalTabId }).strict(),
  z.object({ method: z.literal("close"), tabId: optionalTabId }).strict(),
  /* ── 控制 ── */
  z.object({ method: z.literal("capabilities") }).strict(),
  z.object({ method: z.literal("cancelRequest"), requestId: z.string().min(1) }).strict(),
  z.object({ method: z.literal("turnEnded"), turnId: z.string().optional() }).strict(),
  z.object({ method: z.literal("closeSession") }).strict(),
])
export type BrowserCommand = z.infer<typeof browserCommandSchema>

/** 46 命令 method 全集(枚举顺序同判别联合) */
export const BROWSER_COMMAND_METHODS = browserCommandSchema.options.map((option) => option.shape.method.value)
export type BrowserCommandMethod = (typeof BROWSER_COMMAND_METHODS)[number]

/* ════════════════════════════════════════════════════════════════════
 * 请求 / 结果信封
 * ════════════════════════════════════════════════════════════════════ */

/** 桥接请求(sidecar → desktop main):归属上下文 + 命令 */
export const browserExecuteRequestSchema = z
  .object({ context: browserCommandContextSchema, command: browserCommandSchema })
  .strict()
export type BrowserExecuteRequest = z.infer<typeof browserExecuteRequestSchema>

/**
 * 命令结果信封(开放键:state/tabs/userTabs/value/image/snapshot/tab/dialog/recording 等
 * 随命令各异,此处只收敛公共骨架;严格结果形状由 desktop core 各 withMeta 调用点定义)。
 */
export const browserCommandResultSchema = z.looseObject({
  ok: z.boolean(),
  elapsedMs: z.number().optional(),
  error: browserErrorPayloadSchema.optional(),
  meta: browserResultMetaSchema.optional(),
})
export type BrowserCommandResult = z.infer<typeof browserCommandResultSchema>

/** tab 摘要(summary):url/title/viewport 恒在,active/lifecycle 按需出现 */
export const browserTabSummarySchema = z.looseObject({
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  viewport: browserViewportSchema,
  active: z.boolean().optional(),
  lifecycle: z.enum(["active", "closed", "deliverable", "handoff"]).optional(),
})
export type BrowserTabSummary = z.infer<typeof browserTabSummarySchema>

/** 用户 tab 条目(userTabInfo) */
export const browserUserTabInfoSchema = z.looseObject({
  id: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
})
export type BrowserUserTabInfo = z.infer<typeof browserUserTabInfoSchema>

/** 还原工具:解析失败时取出首个 issue 的可读路径(日志用) */
export function firstBrowserParseIssuePath(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue ? issue.path.map((segment) => String(segment)).join(".") || "(root)" : "(unknown)"
}

/** 类型收窄助手:任意 code 是否稳定协议错误码 */
export function isBrowserProtocolErrorCode(code: string): code is BrowserErrorCode {
  return (BROWSER_ERROR_CODES as readonly string[]).includes(code)
}

/** 类型收窄助手:sideEffect 标注(与 errors.ts 字面量对齐) */
export function isBrowserErrorSideEffect(value: unknown): value is BrowserErrorSideEffect {
  return value === "none" || value === "uncertain"
}
