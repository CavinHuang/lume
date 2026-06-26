import { describe, expect, test } from "bun:test"
import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadFileEnvProvider } from "../thread-file-env"
import { ImageGenResult } from "./image-gen-result"

describe("ImageGenResult", () => {
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
    expect(markup).toContain("加载图片")
    expect(markup).toContain("openai/gpt-image-1")
    expect(markup).toContain("text-to-image")
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
    expect(markup).toContain("加载图片")
  })
})
