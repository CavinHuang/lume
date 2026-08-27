import { describe, expect, test } from "bun:test"
import { detectBrowserActionEffect, type BrowserActionEffectSnapshot } from "./browser-action-effect"

describe("detectBrowserActionEffect", () => {
  test("prioritizes blocking and navigation effects over DOM noise", () => {
    const before = snapshot()
    expect(detectBrowserActionEffect(before, { ...before, dialogId: "dialog-1", domRevision: "2|" })).toEqual({ kind: "dialog_opened" })
    expect(detectBrowserActionEffect(before, { ...before, generation: 2, url: "https://example.test/next", domRevision: "2|" })).toEqual({ kind: "navigation", url: "https://example.test/next" })
  })

  test("reports new tabs, downloads, popup requests and DOM changes", () => {
    const before = snapshot()
    expect(detectBrowserActionEffect(before, { ...before, tabIds: ["tab-1", "tab-2"] })).toEqual({ kind: "new_tab_opened", new_tab_ids: ["tab-2"] })
    expect(detectBrowserActionEffect(before, { ...before, popupCount: 1 })).toEqual({ kind: "new_tab_requested" })
    expect(detectBrowserActionEffect(before, { ...before, downloadIds: ["download-1"] })).toEqual({ kind: "download_started" })
    expect(detectBrowserActionEffect(before, { ...before, domRevision: "1|1-0-0" })).toEqual({ kind: "dom_changed" })
    expect(detectBrowserActionEffect(before, before)).toBeUndefined()
  })

  test("control IDL state flips count as DOM changes (#604)", () => {
    const before = snapshot()
    // checkbox 勾选：DOM revision 不动，控件状态串变化也必须报 dom_changed
    expect(detectBrowserActionEffect(before, { ...before, domRevision: "1|1-0-0" })).toEqual({ kind: "dom_changed" })
    // 两侧采集失败（""）不误报
    expect(detectBrowserActionEffect({ ...before, domRevision: "" }, { ...before, domRevision: "" })).toBeUndefined()
  })
})

function snapshot(): BrowserActionEffectSnapshot {
  return {
    domRevision: "1|",
    downloadIds: [],
    generation: 1,
    lifecycle: "active",
    popupCount: 0,
    tabIds: ["tab-1"],
    url: "https://example.test/",
  }
}
