import { describe, expect, test } from "bun:test"
import { imageDataUrl, isImageFile, imageMimeType } from "./file-preview-utils"

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

describe("imageMimeType", () => {
  test("maps common extensions (case-insensitive)", () => {
    expect(imageMimeType("a.png")).toBe("image/png")
    expect(imageMimeType("a.jpg")).toBe("image/jpeg")
    expect(imageMimeType("a.JPEG")).toBe("image/jpeg")
    expect(imageMimeType("a.svg")).toBe("image/svg+xml")
    expect(imageMimeType("a.webp")).toBe("image/webp")
  })
  test("falls back to image/png for unknown extension", () => {
    expect(imageMimeType("a.bin")).toBe("image/png")
  })
})

describe("imageDataUrl", () => {
  test("builds data url with inferred mime", () => {
    expect(imageDataUrl("a.png", "abc")).toBe("data:image/png;base64,abc")
    expect(imageDataUrl("photo.jpeg", "xyz")).toBe("data:image/jpeg;base64,xyz")
  })
})
