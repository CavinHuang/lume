import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadFileEnvProvider } from "../thread-file-env"
import { createImageGenPreviewScope, ImageGenResult } from "./image-gen-result"

describe("ImageGenResult", () => {
  test("为新式 fileRef 创建受控媒体预览作用域", async () => {
    const ref = { source: "session" as const, scopeId: "ctx-1", relativePath: "files/image-gen/x.png" }
    const created: unknown[] = []
    const converted: unknown[] = []

    const scope = await createImageGenPreviewScope(
      { threadPath: "files/image-gen/x.png", filename: "x.png", mediaType: "image/png", size: 10, fileRef: ref },
      { threadId: "t1", workspaceSlug: "ws" },
      {
        convertLegacyFileRef: async (input) => {
          converted.push(input)
          return ref
        },
        createPreviewScope: async (input) => {
          created.push(input)
          return { token: "preview-1", url: "lume-file://preview/preview-1/x.png", expiresAt: 123 }
        },
      },
    )

    expect(converted).toEqual([])
    expect(created).toEqual([{ ref, kind: "media-file" }])
    expect(scope.url).toBe("lume-file://preview/preview-1/x.png")
  })

  test("旧版 threadPath 先转换为 fileRef 再创建预览作用域", async () => {
    const ref = { source: "session" as const, scopeId: "ctx-1", relativePath: "files/image-gen/old.png" }
    const converted: unknown[] = []

    await createImageGenPreviewScope(
      { threadPath: "files/image-gen/old.png", filename: "old.png", mediaType: "image/png", size: 10 },
      { threadId: "t1", workspaceSlug: "ws" },
      {
        convertLegacyFileRef: async (input) => {
          converted.push(input)
          return ref
        },
        createPreviewScope: async (input) => ({
          token: "preview-2",
          url: `lume-file://preview/preview-2/${input.ref.relativePath}`,
          expiresAt: 123,
        }),
      },
    )

    expect(converted).toEqual([{
      recordKind: "thread-attachment",
      threadId: "t1",
      workspaceSlug: "ws",
      legacyRelativePath: "files/image-gen/old.png",
    }])
  })

  test("无 images 时回退为 JSON 文本显示", () => {
    const markup = renderToStaticMarkup(
      <ImageGenResult input={{}} result={{ modelUsed: "openai/x", mode: "text-to-image" }} />,
    )
    expect(markup).toContain("<pre")
    expect(markup).toContain("modelUsed")
  })

  test("有 images 时渲染图片占位与模型信息（SSR 下 useEffect 不执行，显示加载态）", () => {
    const markup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: "t1" }}>
        <ImageGenResult
          input={{}}
          result={{
            images: [
              { threadPath: "files/image-gen/x.png", filename: "x.png", mediaType: "image/png", size: 10 },
            ],
            modelUsed: "openai/gpt-image-1",
            mode: "text-to-image",
          }}
        />
      </ThreadFileEnvProvider>,
    )
    expect(markup).toContain('data-image-generation-loading="true"')
    expect(markup).toContain("openai/gpt-image-1")
    expect(markup).toContain("text-to-image")
  })

  test("画廊模式把单次输出的多张图片渲染为统一横向卡片且隐藏重复元信息", () => {
    const markup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: "t1" }}>
        <ImageGenResult
          input={{}}
          presentation="gallery"
          result={{
            images: [
              { threadPath: "files/image-gen/a.png", filename: "a.png", mediaType: "image/png", size: 10 },
              { threadPath: "files/image-gen/b.png", filename: "b.png", mediaType: "image/png", size: 10 },
            ],
            modelUsed: "openai/gpt-image-1",
            mode: "text-to-image",
          }}
        />
      </ThreadFileEnvProvider>,
    )

    expect(markup.match(/data-image-generation-image="true"/g)).toHaveLength(2)
    expect(markup).toContain("contents")
    expect(markup).toContain("rounded-[20px]")
    expect(markup).not.toContain("openai/gpt-image-1")
  })

  test("注册到 ToolResultRenderer：image_gen 派发到 ImageGenResult", () => {
    const { ToolResultRenderer } = require("./index")
    const markup = renderToStaticMarkup(
      <ThreadFileEnvProvider value={{ threadId: "t1" }}>
        <ToolResultRenderer
          toolName="image_gen"
          input={{}}
          result={{
            images: [{ threadPath: "files/image-gen/y.png", filename: "y.png", mediaType: "image/png", size: 5 }],
            modelUsed: "doubao/seedream",
            mode: "image-to-image",
          }}
        />
      </ThreadFileEnvProvider>,
    )
    expect(markup).toContain('data-image-generation-loading="true"')
  })
})
