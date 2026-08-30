/**
 * 恢复停靠协议 —— `lume-browser-restore://pending` 延迟空 HTML。
 *
 * 挂起 tab 恢复时,renderer 以 `lume-browser-restore://pending` 作为 webview 首个 src
 * 挂载;本协议 handler 故意延迟数秒才返回空 HTML,给 main 侧 attach + 恢复导航
 * (loadURL(restoreUrl) / navigationHistory.restore)留出时间窗,同时让 webview
 * 有一致的首次加载事件序列(did-start-loading → dom-ready)。
 *
 * 来源:.zcode/analysis/extracted/06-ipc-and-wiring.source.js 之外的装配参考与
 * .zcode/analysis/zcode-browser-panel-architecture.md §6(restore 停靠页)。
 *
 * ZCode 原名对照:
 *   installBrowserRestoreBootstrapProtocol(原名同名,@persist:zcode-embedded-browser 分区注册) → installBrowserRestoreBootstrapProtocol
 *
 * 语义偏差(平台前缀替换之外):
 *   1. ZCode 在 `persist:zcode-embedded-browser` 分区注册 `zcode-browser-restore:`;
 *      Lume 改为任意传入 session(集成者传 `session.fromPartition("persist:lume-browser")`),
 *      scheme 改名 `lume-browser-restore:`,路径字面量 `zcode-browser-restore://pending`
 *      → `lume-browser-restore://pending`。
 *   2. 使用 Electron ≥25 的 `session.protocol.handle`(Response 型 handler);
 *      还原源码基于旧 `registerProtocolHandler` 回调风格,行为等价。
 */

import { createRequire } from "module"
import type { CustomScheme, Session } from "electron"

/** 恢复停靠 scheme(ZCode 原 `zcode-browser-restore:`)。 */
export const BROWSER_RESTORE_SCHEME = "lume-browser-restore"

/** 恢复期 webview 占位 src(ZCode 原 `zcode-browser-restore://pending`,Gre)。 */
export const BROWSER_RESTORE_PENDING_URL = `${BROWSER_RESTORE_SCHEME}://pending`

/**
 * 停靠页延迟毫秒数:attach + 恢复导航的时间窗。
 * ZCode 为"延迟数秒"(约 3s);与 renderer 侧 prepare 超时(3s)同量级。
 */
export const BROWSER_RESTORE_BOOTSTRAP_DELAY_MS = 3_000

/** 停靠页响应体:空 HTML,无脚本无资源。 */
const RESTORE_BOOTSTRAP_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>restoring</title></head><body></body></html>"

let privilegedSchemesRegistered = false

/**
 * 在 app ready 之前把 scheme 注册为 privileged(standard/secure/supportFetchAPI/stream)。
 *
 * 注意:Electron 要求 `protocol.registerSchemesAsPrivileged` 必须在 app ready 前调用且
 * 全进程只能一次;本函数内部去重,集成者只需在 app ready 前调用一次。
 * 未注册 privileged 时 webview 仍可加载该 scheme,但 fetch/流式响应等能力受限。
 */
export function ensureBrowserRestoreSchemePrivileged(): void {
  if (privilegedSchemesRegistered) return
  privilegedSchemesRegistered = true
  // 延迟解析:保持模块可被纯逻辑测试加载(electron 运行时才解析)。
  // createRequire 而非裸 require——打包产物是 ESM(main.mjs),裸 require 不存在
  // (与 core/executor/injected-loader.ts 同款接法)。
  const requireFromHere = createRequire(import.meta.url)
  const electronProtocol = requireFromHere("electron").protocol as {
    registerSchemesAsPrivileged(schemes: ReadonlyArray<CustomScheme>): void
  }
  electronProtocol.registerSchemesAsPrivileged([
    {
      scheme: BROWSER_RESTORE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ] satisfies CustomScheme[])
}

/**
 * 在指定 session(集成者传 `persist:lume-browser` 分区)上注册恢复停靠协议 handler:
 * 对任意 `lume-browser-restore://` 请求延迟 `BROWSER_RESTORE_BOOTSTRAP_DELAY_MS` 后
 * 返回空 HTML。
 *
 * @returns 卸载函数(反注册 handler 并取消未决的延迟响应)。
 */
export function installBrowserRestoreBootstrapProtocol(session: Session): () => void {
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  const handler = (): Promise<Response> =>
    new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        resolve(
          new Response(RESTORE_BOOTSTRAP_HTML, {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          }),
        )
      }, BROWSER_RESTORE_BOOTSTRAP_DELAY_MS)
      // unref 语义:Electron 主进程的 setTimeout 无法 unref;dispose 时统一清除。
      pendingTimers.add(timer)
    })
  session.protocol.handle(BROWSER_RESTORE_SCHEME, handler)
  return () => {
    for (const timer of pendingTimers) clearTimeout(timer)
    pendingTimers.clear()
    session.protocol.unhandle(BROWSER_RESTORE_SCHEME)
  }
}
