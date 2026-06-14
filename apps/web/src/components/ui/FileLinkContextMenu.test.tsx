import { describe, expect, mock, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { buildFileLinkMenuItems, FileLinkContextMenu } from "./FileLinkContextMenu"
import type { FileLinkContext } from "@/components/agent/file-link-types"

mock.module("@/lib/desktop-api", () => ({
  sidecarCall: async () => "/dir",
  openInSystem: async () => undefined,
  revealPathInSystem: async () => undefined,
  saveFilePathDialog: async () => ({ path: null }),
  copyFile: async () => undefined,
}))
mock.module("sonner", () => ({ toast: { success: () => undefined, error: () => undefined } }))

const noop = () => undefined

describe("buildFileLinkMenuItems", () => {
  test("thread with preview: 6 actions + 3 separators", () => {
    const ctx: FileLinkContext = { source: "thread", relPath: "a.md", threadId: "t1", workspaceSlug: "ws" }
    const items = buildFileLinkMenuItems(ctx, { hasPreview: true, onPreview: noop })
    const labels = items.filter((i) => i.kind === "item").map((i) => i.label)
    expect(labels).toEqual([
      "在右侧预览",
      "用系统应用打开",
      "在 Finder 中显示",
      "复制相对路径",
      "复制绝对路径",
      "另存为…",
    ])
  })

  test("without preview: omits preview item", () => {
    const ctx: FileLinkContext = { source: "workspace", relPath: "a.md", workspaceSlug: "ws" }
    const items = buildFileLinkMenuItems(ctx, { hasPreview: false })
    const labels = items.filter((i) => i.kind === "item").map((i) => i.label)
    expect(labels).not.toContain("在右侧预览")
    expect(labels[0]).toBe("用系统应用打开")
  })

  test("local source: hides copy relative path", () => {
    const ctx: FileLinkContext = { source: "local", relPath: "/abs/a.md" }
    const items = buildFileLinkMenuItems(ctx, { hasPreview: false })
    const labels = items.filter((i) => i.kind === "item").map((i) => i.label)
    expect(labels).not.toContain("复制相对路径")
    expect(labels).toContain("复制绝对路径")
  })
})

describe("FileLinkContextMenu component", () => {
  test("renders ContextMenu trigger wrapper when context usable", () => {
    const ctx: FileLinkContext = { source: "thread", relPath: "a.md", threadId: "t1", workspaceSlug: "ws" }
    const markup = renderToStaticMarkup(
      <FileLinkContextMenu context={ctx} onPreview={noop}>
        <button type="button">file</button>
      </FileLinkContextMenu>,
    )
    expect(markup).toContain('data-slot="context-menu-trigger"')
  })

  test("degrades to bare children when thread context missing threadId", () => {
    const ctx: FileLinkContext = { source: "thread", relPath: "a.md" }
    const markup = renderToStaticMarkup(
      <FileLinkContextMenu context={ctx}>
        <button type="button">file</button>
      </FileLinkContextMenu>,
    )
    expect(markup).not.toContain('data-slot="context-menu-trigger"')
    expect(markup).toContain("<button")
  })
})
