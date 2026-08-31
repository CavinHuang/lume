/**
 * 内嵌浏览器数据管理 —— ZCode W1/clearEmbeddedBrowserData(F1 导入见偏差)
 * (提取源 O-partition-sessions.b.js / X-dialog.b.js)。
 *
 * 清除语义:
 *  - mode "cache":clearCache + clearStorageData({storages:["shadercache",
 *    "serviceworkers","cachestorage"]})(ZCode Vpe);
 *  - mode "all":clearCache + clearStorageData()(含 cookies/localStorage 登录态)。
 * 非法 mode 由 IPC 层拒收({success:false, error:"invalid_clear_mode"})。
 *
 * 偏差:ZCode 另有 F1/importChromeBrowserData(Chrome Cookie 解密 + LocalStorage
 * 导入),依赖提权解密 helper/Windows App-Bound key reader/macOS 钥匙串读取等
 * 基础设施,Lume 暂无,未移植。
 */
import type { Session } from "electron"

export type EmbeddedBrowserClearMode = "cache" | "all"

export interface EmbeddedBrowserClearResult {
  success: boolean
  error?: string
}

/** ZCode Vpe:cache 模式的部分清除面。 */
const CACHE_MODE_STORAGES = ["shadercache", "serviceworkers", "cachestorage"] as const

export function isEmbeddedBrowserClearMode(value: unknown): value is EmbeddedBrowserClearMode {
  return value === "cache" || value === "all"
}

export async function clearEmbeddedBrowserData(
  session: Session,
  mode: EmbeddedBrowserClearMode,
  logger: { info(message: string, meta?: unknown): void; warn(message: string, meta?: unknown): void },
): Promise<EmbeddedBrowserClearResult> {
  try {
    await session.clearCache()
    if (mode === "all") {
      await session.clearStorageData()
    } else {
      await session.clearStorageData({ storages: [...CACHE_MODE_STORAGES] })
    }
    logger.info("[browser-data] 内置浏览器数据清理完成", { mode })
    return { success: true }
  } catch {
    logger.warn("[browser-data] 内置浏览器数据清理失败", { mode })
    return { success: false, error: "embedded_browser_clear_failed" }
  }
}
