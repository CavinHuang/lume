/**
 * 浏览器面板纯语义(ZCode 对齐的可测试核心,无 React/DOM 依赖)。
 *
 * 来源:.zcode/analysis/sidepane/P1-shell-architecture.md §3.4(yAt 标签条:
 * 溢出估宽 tabs*60px + gap*8px、最近关闭环 8 条)、
 * .zcode/analysis/extracted/04-renderer-panel.source.js
 * (vEt/yEt/bEt 桌面 zoom 档位、VTt 布局/变换分解、Wr 证书错误码区间)、
 * docs/analysis/zcode-sidepane-consolidated.md §2(重开换新 id)。
 */

/** 溢出估宽:每 tab 60px + 相邻 8px 间距(ZCode Xkt)。 */
export const TAB_STRIP_TAB_WIDTH_PX = 60
export const TAB_STRIP_TAB_GAP_PX = 8

/** 最近关闭环容量(ZCode Xde=8)。 */
export const CLOSED_TAB_RING_LIMIT = 8

/** 桌面 zoom 档位公式常量(ZCode vEt=1.1 / yEt=-3 / bEt=5)。 */
export const DESKTOP_ZOOM_BASE = 1.1
export const DESKTOP_ZOOM_MIN_LEVEL = -3
export const DESKTOP_ZOOM_MAX_LEVEL = 5

/** Chromium 证书错误码区间(ERR_CERT_* = -201..-217,ZCode Wr 判定范围)。 */
export const CERT_ERROR_CODE_MIN = -217
export const CERT_ERROR_CODE_MAX = -200

/** 桌面 zoom 补偿分解(ZCode VTt 的返回形状)。 */
export interface BrowserZoomCompensation {
  layoutScale: number
  transformScale: number
}

/** 恒等补偿(desktopZoom ≥ 1 时 ZCode 不做分解)。 */
export const IDENTITY_ZOOM_COMPENSATION: BrowserZoomCompensation = { layoutScale: 1, transformScale: 1 }

/** 最近关闭环条目(重开时浏览器 tab 换新 id,故只留描述符)。 */
export interface ClosedTabEntry {
  id: string
  title: string | null
  url: string | null
  faviconUrl: string | null
  closedAt: number
}

/** 标签条估宽:tabs*60px + (tabs-1)*8px;非正数计 0。 */
export function estimateTabStripWidthPx(tabCount: number): number {
  if (!Number.isFinite(tabCount) || tabCount <= 0) return 0
  return tabCount * TAB_STRIP_TAB_WIDTH_PX + (tabCount - 1) * TAB_STRIP_TAB_GAP_PX
}

/** 溢出判定(ZCode Xkt 的 Pe;viewport 未知时不判定溢出)。 */
export function isTabStripOverflowing(tabCount: number, viewportWidth: number): boolean {
  return viewportWidth > 0 && estimateTabStripWidthPx(tabCount) > viewportWidth
}

/**
 * 按 id 全量重排;非同长度/含未知 id 时返回 null(调用方保持原序)。
 * ZCode Ade 语义:重排不改动 activeTabId,由调用方保证。
 */
export function reorderedByIds(ids: readonly string[], orderedIds: readonly string[]): string[] | null {
  if (orderedIds.length !== ids.length) return null
  const indexById = new Map<string, number>()
  orderedIds.forEach((id, index) => indexById.set(id, index))
  if (ids.some((id) => !indexById.has(id))) return null
  return [...ids].sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0))
}

/** 压入最近关闭环:新条目置顶,超出容量从尾部丢弃(ZCode Xde=8)。 */
export function pushClosedTabRing(ring: readonly ClosedTabEntry[], entry: ClosedTabEntry): ClosedTabEntry[] {
  return [entry, ...ring].slice(0, CLOSED_TAB_RING_LIMIT)
}

/** 相对时间(总览弹层/重开菜单共用;中文,分钟级精度)。 */
export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** 桌面 zoom 档位折算(ZCode xEt:1.1^clamp(round(level),-3,5))。 */
export function desktopZoomFactorFromLevel(level: number): number {
  if (!Number.isFinite(level)) return 1
  const clamped = Math.min(DESKTOP_ZOOM_MAX_LEVEL, Math.max(DESKTOP_ZOOM_MIN_LEVEL, Math.round(level)))
  return DESKTOP_ZOOM_BASE ** clamped
}

/**
 * 布局/变换分解(ZCode VTt):desktopZoom < 1 时 guest 需以 1/z 布局 + scale(z)
 * 变换补偿(原点左上),否则恒等。
 */
export function decomposeDesktopZoom(desktopZoomFactor: number): BrowserZoomCompensation {
  const zoom = Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1
  if (zoom < 1) return { layoutScale: 1 / zoom, transformScale: zoom }
  return IDENTITY_ZOOM_COMPENSATION
}

/** 证书错误判定(ZCode Wr:loadErrorCode ∈ [-217,-200])。 */
export function isCertificateErrorCode(loadErrorCode: number | null | undefined): boolean {
  return typeof loadErrorCode === 'number'
    && Number.isFinite(loadErrorCode)
    && loadErrorCode >= CERT_ERROR_CODE_MIN
    && loadErrorCode <= CERT_ERROR_CODE_MAX
}

/** 总览弹层搜索:任一字段命中(大小写不敏感)即保留;空查询全保留。 */
export function matchesTabQuery(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return fields.some((field) => (field ?? '').toLowerCase().includes(needle))
}
