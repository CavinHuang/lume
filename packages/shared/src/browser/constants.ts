/**
 * 内嵌浏览器(IAB)协议常量 —— ZCode 46 命令协议的 Lume 移植版。
 *
 * 来源:
 *   - `.zcode/analysis/zcode-browser-implementation-guide.md` §1.4 关键常量 / §4.1 IPC 频道
 *   - `.zcode/analysis/zcode-browser-panel-architecture.md` §46 命令枚举
 *   - `docs/plans/2026-08-30-browser-rewrite-design.md` §2.1/§2.2
 *
 * 平台前缀替换(ZCode → Lume):
 *   - 分区 `persist:zcode-embedded-browser` → `persist:lume-browser`
 *   - 恢复协议 `zcode-browser-restore://pending` → `lume-browser-restore://pending`
 *   - 频道前缀 `zcode:browser-view-*` → `lume:browser-view-*`;
 *     `zcode:embedded-browser-javascript-dialog` → `lume:embedded-browser-javascript-dialog`
 */

/**
 * 浏览器命令协议版本(新协议新起点;Lume 旧 v9 常量随旧实现删除)。
 * 传输层 MAC 桥的 `incompatible_protocol` 闸以本值为起点。
 */
export const BROWSER_PROTOCOL_VERSION = 1

/** 兼容的最低协议版本 */
export const BROWSER_PROTOCOL_VERSION_MIN = 1

/** 兼容的最高协议版本 */
export const BROWSER_PROTOCOL_VERSION_MAX = 1

/**
 * 浏览器会话 webview 分区(la)。
 * 全部 tab 的 cookies/localStorage 等会话数据都隔离在该持久分区内。
 */
export const BROWSER_PARTITION = "persist:lume-browser"

/**
 * 挂起恢复停靠协议 URL(WH/installBrowserRestoreBootstrapProtocol)。
 * renderer 重建 webview 时先挂载该地址(主进程延迟数秒返回空 HTML),
 * attach 成功后立即移除,避免空白页闪烁。
 */
export const BROWSER_RESTORE_URL = "lume-browser-restore://pending"

/**
 * fr —— 视口自由尺寸边界(共享模块常量,assertViewportOverride 校验依据)。
 * 录制 viewport/viewportSet 命令都必须落在 [320,3840]×[320,2160] 的整数范围内。
 */
export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  minHeight: 320,
  maxWidth: 3840,
  maxHeight: 2160,
} as const

/** OH —— 自然视口缺省值(无 guest/读取失败时的回退) */
export const BROWSER_DEFAULT_NATURAL_VIEWPORT = { width: 800, height: 600 } as const

/** DH —— 录制视口缺省值(新 tab 的 viewportOverride 同源) */
export const BROWSER_RECORDING_DEFAULT_VIEWPORT = { width: 1280, height: 720 } as const

/** 录制缺省帧率 */
export const BROWSER_RECORDING_DEFAULT_FPS = 25

/** 录制缺省最长时长(runRecording 超时 abort 依据) */
export const BROWSER_RECORDING_DEFAULT_MAX_DURATION_MS = 60_000

/** 录制最长时长上限(zod 校验;guide §1.4 "上限 90s") */
export const BROWSER_RECORDING_MAX_DURATION_MS = 90_000

/** 录制缺省起播沉降时间(settleMs,动作序列执行前等待) */
export const BROWSER_RECORDING_DEFAULT_SETTLE_MS = 300

/**
 * 主进程 ↔ renderer 事件/invoke 频道名表(guide §4.1)。
 *
 * - `main→renderer` 事件(需 webContents.send):ready/operation/visibility/viewport-changed/
 *   screenshot-surface-prepare/screenshot-surface-ready(send 型)/screenshot-surface-release/
 *   close-tab/suspend/restore
 * - `renderer→main` invoke:attach-guest/detach-guest/close-tab-from-renderer/report-residency/
 *   suspend-ready/ensure-resident/restore-tabs/update-viewport
 * - guest preload → 主进程 sendSync:embedded-browser-javascript-dialog
 *   (ZCode 原名无 browser-view 中缀,前缀替换后为 `lume:embedded-browser-javascript-dialog`)
 */
export const BROWSER_VIEW_IPC_CHANNELS = {
  /** m→r:请 renderer 建 webview 壳 {tabId,browserId,browserGeneration,…} */
  ready: "lume:browser-view-ready",
  /** m→r:agent 操作前/后通知(5s 操作态;activateTab/newTab/viewport 系/visibilitySet 附 resetsResizeBaseline) */
  operation: "lume:browser-view-operation",
  /** m→r:agent 侧显隐浏览器面板 */
  visibility: "lume:browser-view-visibility",
  /** m→r:agent 设置/重置视口 */
  viewportChanged: "lume:browser-view-viewport-changed",
  /** m→r:截图摆位开始(屏外定影请求) */
  screenshotSurfacePrepare: "lume:browser-view-screenshot-surface-prepare",
  /** r→m:摆位就绪回执(唯一 send 型 r→m,{...request,surfaceScale,viewport}) */
  screenshotSurfaceReady: "lume:browser-view-screenshot-surface-ready",
  /** m→r:摆位结束,恢复布局 */
  screenshotSurfaceRelease: "lume:browser-view-screenshot-surface-release",
  /** m→r:main 主导关闭 tab */
  closeTab: "lume:browser-view-close-tab",
  /** m→r:main 主导挂起(卸载 webview 渲染空壳) */
  suspend: "lume:browser-view-suspend",
  /** m→r:main 主导恢复(重建 webview 挂 BROWSER_RESTORE_URL) */
  restore: "lume:browser-view-restore",
  /** r→m invoke:webview attach 载荷 {tabId,webContentsId,active,residencyGeneration,…} */
  attachGuest: "lume:browser-view-attach-guest",
  /** r→m invoke:CDP 断开确认后才放行重建 */
  detachGuest: "lume:browser-view-detach-guest",
  /** r→m invoke:renderer 侧关闭请求(main 权威裁决) */
  closeTabFromRenderer: "lume:browser-view-close-tab-from-renderer",
  /** r→m invoke:驻留状态上报 {selected,visible,loading,restoreUrl,title,faviconUrl,…} */
  reportResidency: "lume:browser-view-report-residency",
  /** r→m invoke:空壳挂载完成 ack {tabId,generation} */
  suspendReady: "lume:browser-view-suspend-ready",
  /** r→m invoke:请求把某 tab 恢复为常驻 */
  ensureResident: "lume:browser-view-ensure-resident",
  /** r→m invoke:窗口重建后拉取可恢复 tab 列表 */
  restoreTabs: "lume:browser-view-restore-tabs",
  /** r→m invoke:responsive 画布同步 {tabId,viewport|null} */
  updateViewport: "lume:browser-view-update-viewport",
  /** g→m sendSync:guest preload 劫持的 alert/confirm 对话框桥 {type,message}→{handled,value} */
  embeddedBrowserJavaScriptDialog: "lume:embedded-browser-javascript-dialog",
} as const

/** 频道名类型(供 ipc 层以字面量类型收窄) */
export type BrowserViewIpcChannel =
  (typeof BROWSER_VIEW_IPC_CHANNELS)[keyof typeof BROWSER_VIEW_IPC_CHANNELS]
