/**
 * 内嵌浏览器 JS 对话框控制器 —— webview guest 的原生替代对话框与自动化直通。
 *
 * 来源:D:\workspace\projects\ai-projects\lume\.zcode\analysis\extracted\
 *       06-ipc-and-wiring.source.js(JS 对话框控制器段 @1058728-1062358)
 *
 * ZCode 原名对照:
 *   eh  → EmbeddedBrowserJavaScriptDialogController(类名保留)
 *   nfe → DEFAULT_AUTOMATION_GRACE_MS(自动化后原生直通宽限,3e3 ms)
 *   rfe → GUEST_PARTITION_PREFIX(guest 分区前缀)
 *   ofe → parseEmbeddedBrowserDialogRequest
 *   ife → resolveEmbeddedBrowserDialogSource
 *   sfe → resolveEmbeddedBrowserDialogButtons
 *
 * 语义偏差(仅以下已声明项):
 *   - 平台:ZCode guest 分区前缀 "browser:" 按 PORTING.md 分区常量表替换为
 *     persist:lume-browser(与 ipc.ts BROWSER_GUEST_PARTITION 一致)。
 *   - webContents.fromId / BrowserWindow.fromId 由构造注入(测试/装配用),
 *     ZCode 为模块级静态调用。
 *   - onDialogOpening/onDialogClosed 为集成锚点(guest-manager 的
 *     Page.javascriptDialogOpening/Closed 跟踪回调),把 CDP 侧观测到的
 *     对话框开关并入 openDialogGuestIds;ZCode 原类仅经 handleDialogRequest
 *     维护该集合。
 *
 * 装配:ipc.ts 以 sendSync(BROWSER_EMBEDDED_DIALOG_CHANNEL)同步调用
 * handleDialogRequest,e.returnValue 取 { handled, value? };
 * runBrowserCommandOnView(PCe)在 execute 前 beginAutomation(windowId)、
 * finally 调用其返回的 endAutomation。
 */
import { dialog, nativeImage } from "electron"
import type { BrowserWindow, WebContents } from "electron"
import type { BrowserDialogInfo } from "./types"

/* ── 常量 ──────────────────────────────────────────────────────────── */

/** ZCode 原名 nfe:自动化结束后原生对话框直通宽限(ms)。 */
export const DEFAULT_AUTOMATION_GRACE_MS = 3_000

/**
 * ZCode 原名 rfe:guest 分区前缀。ZCode 为 "browser:",Lume 按 PORTING.md
 * 分区常量表取 persist:lume-browser(与 ipc.ts BROWSER_GUEST_PARTITION 一致)。
 */
export const GUEST_PARTITION_PREFIX = "persist:lume-browser"

/* ── 解析辅助 ──────────────────────────────────────────────────────── */

/** 解析后的对话框请求(alert/confirm 子集;prompt/beforeunload 不接管)。 */
export type EmbeddedDialogRequest = Pick<BrowserDialogInfo, "type" | "message">

/**
 * ZCode 原名 ofe/parseEmbeddedBrowserDialogRequest:仅接管 alert/confirm 且
 * message 为 string 的请求;其余(null/非对象/prompt 等)返回 null 交原生处理。
 */
export function parseEmbeddedBrowserDialogRequest(payload: unknown): EmbeddedDialogRequest | null {
  if (typeof payload !== "object" || payload === null) return null
  const candidate = payload as { type?: unknown; message?: unknown }
  return (candidate.type !== "alert" && candidate.type !== "confirm") || typeof candidate.message !== "string"
    ? null
    : { type: candidate.type, message: candidate.message }
}

/**
 * ZCode 原名 ife/resolveEmbeddedBrowserDialogSource:依次取 frameUrl、guest
 * 当前 URL 的 http(s) host 作为 "<host> says" 标题;blob: 解包 origin 后再试;
 * 全部失败回落 "This page says"。
 */
export function resolveEmbeddedBrowserDialogSource(frameUrl: string, guestUrl: string): string {
  for (const url of [frameUrl, guestUrl]) {
    if (!url) continue
    try {
      const parsed = new URL(url)
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host) return `${parsed.host} says`
      if (parsed.protocol === "blob:" && parsed.origin) {
        const origin = new URL(parsed.origin)
        if ((origin.protocol === "http:" || origin.protocol === "https:") && origin.host) return `${origin.host} says`
      }
    } catch {}
  }
  return "This page says"
}

/**
 * ZCode 原名 sfe/resolveEmbeddedBrowserDialogButtons:locale 按钮文案集。
 * alert:单确认键;confirm:zh-CN 为 [取消, 确定](cancelId=0/defaultId=1),
 * 其余为 [Cancel, OK]。
 */
export function resolveEmbeddedBrowserDialogButtons(locale: string, type: EmbeddedDialogRequest["type"]): string[] {
  return type === "alert"
    ? [locale === "zh-CN" ? "\u786E\u5B9A" : "OK"]
    : locale === "zh-CN"
      ? ["\u53D6\u6D88", "\u786E\u5B9A"]
      : ["Cancel", "OK"]
}

/* ── 控制器 ────────────────────────────────────────────────────────── */

/** 构造依赖(webContents/BrowserWindow 静态访问的可注入形态)。 */
export interface EmbeddedBrowserJavaScriptDialogOptions {
  /** 消息框图标路径(缺省或加载为空时不带 icon) */
  iconPath?: string
  /** 应用 locale(决定按钮文案集) */
  getLocale: () => string
  /** 警告日志(构造注入,禁止 console) */
  warn: (message: string, error?: unknown) => void
  /** Electron webContents.fromId 的可注入形态 */
  webContentsFromId: (id: number) => WebContents | undefined
  /** Electron BrowserWindow.fromId 的可注入形态 */
  browserWindowFromId: (id: number) => BrowserWindow | null | undefined
  /** 自动化后原生直通宽限(ms;缺省 DEFAULT_AUTOMATION_GRACE_MS) */
  automationGraceMs?: number
}

/** 已登记 guest 记录。 */
interface EmbeddedDialogGuestRecord {
  guest: WebContents
  /** guest 分区(ZCode 语境即 tab 标识) */
  tabId: string
  /** 宿主窗口 id(handleDialogRequest 经此定位 BrowserWindow) */
  windowId: number
}

/** 单窗口自动化计数与直通截止状态。 */
interface EmbeddedDialogAutomationState {
  activeCount: number
  passthroughUntil: number
  cleanupTimer?: ReturnType<typeof setTimeout>
}

/** handleDialogRequest 的同步应答(ipc.ts e.returnValue 形状)。 */
export interface EmbeddedDialogHandling {
  handled: boolean
  /** confirm 选项:点击按钮是否为确认键(索引 1) */
  value?: boolean
}

/**
 * ZCode 原名 eh/EmbeddedBrowserJavaScriptDialogController:按分区前缀登记
 * webview guest;JS 对话框以同步 showMessageBoxSync 顶替原生对话框;
 * beginAutomation/endAutomation 在自动化期间与宽限期内强制
 * shouldUseNativeDialog=true 直通(不抢自动化期间的原生对话框)。
 */
export class EmbeddedBrowserJavaScriptDialogController {
  private readonly options: EmbeddedBrowserJavaScriptDialogOptions
  /** webContentsId → guest 记录 */
  private readonly guests = new Map<number, EmbeddedDialogGuestRecord>()
  /** 正在展示(或 CDP 观测到打开)对话框的 guest 集合,防二次接管 */
  private readonly openDialogGuestIds = new Set<number>()
  /** windowId → 自动化计数/直通状态 */
  private readonly automationByWindow = new Map<number, EmbeddedDialogAutomationState>()

  constructor(options: EmbeddedBrowserJavaScriptDialogOptions) {
    this.options = options
  }

  /** 释放全部登记与定时器(guest-manager 关停时调用)。 */
  dispose(): void {
    for (const webContentsId of [...this.guests.keys()]) this.unbindGuest(webContentsId)
    for (const state of this.automationByWindow.values()) {
      if (state.cleanupTimer) clearTimeout(state.cleanupTimer)
    }
    this.automationByWindow.clear()
    this.openDialogGuestIds.clear()
  }

  /**
   * 登记 guest(分区前缀匹配 + 类型必须是 webview);重复登记先解绑。
   * guest destroyed 时自动解绑。
   */
  bindGuest(partition: string, webContentsId: number, windowId: number): void {
    this.unbindGuest(webContentsId)
    if (!partition.startsWith(GUEST_PARTITION_PREFIX)) return
    const guest = this.options.webContentsFromId(webContentsId)
    if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return
    const record: EmbeddedDialogGuestRecord = { guest, tabId: partition, windowId }
    this.guests.set(webContentsId, record)
    guest.once("destroyed", () => {
      if (this.guests.get(webContentsId) === record) this.unbindGuest(webContentsId)
    })
  }

  /**
   * 同步处理 JS 对话框请求(ipc.ts sendSync 通道直调):
   * 未接管(非 alert/confirm、guest 未登记、对话框已打开、自动化直通期、
   * 宿主窗口不可用)返回 { handled:false } 交原生;confirm 返回按钮选择。
   */
  handleDialogRequest(webContentsId: number, frameUrl: string, payload: unknown): EmbeddedDialogHandling {
    const request = parseEmbeddedBrowserDialogRequest(payload)
    const record = this.guests.get(webContentsId)
    if (!request || !record || this.openDialogGuestIds.has(webContentsId) || this.shouldUseNativeDialog(record.windowId)) {
      return { handled: false }
    }
    const window = this.options.browserWindowFromId(record.windowId)
    if (!window || window.isDestroyed()) return { handled: false }
    this.openDialogGuestIds.add(webContentsId)
    try {
      const icon = nativeImage.createFromPath(this.options.iconPath ?? "")
      const choice = dialog.showMessageBoxSync(window, {
        type: request.type === "alert" ? "info" : "question",
        buttons: resolveEmbeddedBrowserDialogButtons(this.options.getLocale(), request.type),
        defaultId: request.type === "alert" ? 0 : 1,
        cancelId: 0,
        message: resolveEmbeddedBrowserDialogSource(frameUrl, record.guest.getURL()),
        detail: request.message,
        noLink: true,
        normalizeAccessKeys: true,
        ...(icon.isEmpty() ? {} : { icon }),
      })
      return { handled: true, ...(request.type === "confirm" ? { value: choice === 1 } : {}) }
    } catch (error) {
      this.options.warn("[browser-pane] failed to handle JavaScript dialog with source", {
        error: error instanceof Error ? error.message : String(error),
        tabId: record.tabId,
      })
      return { handled: false }
    } finally {
      this.openDialogGuestIds.delete(webContentsId)
    }
  }

  /**
   * 进入自动化(runBrowserCommandOnView/PCe 在 execute 前调用):计数 +1 且
   * 直通期置为无限;返回 endAutomation 闭包——计数归零后开启宽限直通窗口
   * (automationGraceMs,缺省 3000ms)并安排 map 清理定时器;幂等(仅首次
   * 调用生效)。
   */
  beginAutomation(windowId: number): () => void {
    const state = this.automationByWindow.get(windowId) ?? { activeCount: 0, passthroughUntil: 0 }
    if (state.cleanupTimer) {
      clearTimeout(state.cleanupTimer)
      state.cleanupTimer = undefined
    }
    state.activeCount += 1
    state.passthroughUntil = Number.POSITIVE_INFINITY
    this.automationByWindow.set(windowId, state)
    let ended = false
    return () => {
      if (ended) return
      ended = true
      state.activeCount = Math.max(0, state.activeCount - 1)
      if (state.activeCount > 0) return
      const graceMs = this.options.automationGraceMs ?? DEFAULT_AUTOMATION_GRACE_MS
      state.passthroughUntil = Date.now() + graceMs
      state.cleanupTimer = setTimeout(() => {
        const current = this.automationByWindow.get(windowId)
        if (current === state && current.activeCount === 0) this.automationByWindow.delete(windowId)
      }, graceMs)
      ;(state.cleanupTimer as { unref?: () => void }).unref?.()
    }
  }

  /** 自动化期间/宽限期内返回 true(对话框直通原生,不接管)。 */
  shouldUseNativeDialog(windowId: number): boolean {
    const state = this.automationByWindow.get(windowId)
    return !!(state && (state.activeCount > 0 || Date.now() < state.passthroughUntil))
  }

  /**
   * 集成锚点:guest-manager 收到 CDP Page.javascriptDialogOpening 时调用,
   * 把该 guest 标记为对话框打开(阻断二次接管)。
   */
  onDialogOpening(webContentsId: number): void {
    this.openDialogGuestIds.add(webContentsId)
  }

  /**
   * 集成锚点:guest-manager 收到 CDP Page.javascriptDialogClosed 时调用,
   * 解除该 guest 的对话框打开标记。
   */
  onDialogClosed(webContentsId: number): void {
    this.openDialogGuestIds.delete(webContentsId)
  }

  /** 解绑 guest(登记与对话框打开标记一并清理)。 */
  unbindGuest(webContentsId: number): void {
    this.guests.delete(webContentsId)
    this.openDialogGuestIds.delete(webContentsId)
  }
}
