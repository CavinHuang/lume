export type BrowserActionEffectKind =
  | "crashed"
  | "dialog_opened"
  | "new_tab_opened"
  | "new_tab_requested"
  | "download_started"
  | "navigation"
  | "dom_changed"
  | "no_detectable_change"

export interface BrowserActionEffectSnapshot {
  dialogId?: string
  /** #604：DOM revision + 控件 IDL 状态指纹（checked/selectedIndex/value 零 mutation 也会进语义树）；"" = 采集失败 */
  domRevision: string
  downloadIds: string[]
  generation: number
  lifecycle?: string
  popupCount: number
  tabIds: string[]
  url: string
}

export interface BrowserActionEffect {
  kind: BrowserActionEffectKind
  new_tab_ids?: string[]
  url?: string
}

export function detectBrowserActionEffect(before: BrowserActionEffectSnapshot, after: BrowserActionEffectSnapshot): BrowserActionEffect | undefined {
  if (after.lifecycle === "crashed" && before.lifecycle !== "crashed") return { kind: "crashed" }
  if (after.dialogId && after.dialogId !== before.dialogId) return { kind: "dialog_opened" }
  const newTabIds = after.tabIds.filter((tabId) => !before.tabIds.includes(tabId))
  if (newTabIds.length) return { kind: "new_tab_opened", new_tab_ids: newTabIds }
  if (after.popupCount > before.popupCount) return { kind: "new_tab_requested" }
  if (after.downloadIds.some((downloadId) => !before.downloadIds.includes(downloadId))) return { kind: "download_started" }
  if (after.generation !== before.generation || after.url !== before.url) return { kind: "navigation", url: after.url }
  // 指纹含控件状态串（非单调），任意分量变化即 dom_changed；两侧采集失败（""）不误报
  if (after.domRevision !== before.domRevision) return { kind: "dom_changed" }
  return undefined
}
