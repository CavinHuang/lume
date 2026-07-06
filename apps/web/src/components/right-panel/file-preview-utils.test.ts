import { describe, expect, test } from "bun:test"
import { isImageFile, lumeFileUrl } from "./file-preview-utils"

describe("isImageFile", () => {
  test.each(["a.png", "photo.JPG", "x.jpeg", "g.gif", "w.webp", "b.bmp", "s.svg"])(
    "true for image %s",
    (f) => {
      expect(isImageFile(f)).toBe(true)
    },
  )
  test.each(["a.md", "a.txt", "notes", "a.mp4", "a.pdf", ""])(
    "false for non-image %s",
    (f) => {
      expect(isImageFile(f)).toBe(false)
    },
  )
  test("absolute path with image ext is still an image", () => {
    expect(isImageFile("C:\\data\\threads\\t1\\files\\image-gen\\x.png")).toBe(true)
    expect(isImageFile("/data/threads/t1/files/image-gen/x.webp")).toBe(true)
  })
})

describe("lumeFileUrl", () => {
  test("编码绝对路径为 lume-file URL", () => {
    expect(lumeFileUrl("/data/threads/t1/a.png")).toBe(
      "lume-file://file/" + encodeURIComponent("/data/threads/t1/a.png"),
    )
  })
  test("Windows 绝对路径也被正确编码", () => {
    const p = "C:\\data\\threads\\t1\\a.png"
    expect(lumeFileUrl(p)).toBe("lume-file://file/" + encodeURIComponent(p))
  })
})
