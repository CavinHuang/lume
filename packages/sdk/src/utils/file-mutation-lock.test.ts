// packages/sdk/src/utils/file-mutation-lock.test.ts
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { withFileMutationLock } from "./file-mutation-lock.js"
import { FileStateCache } from "./fileCache.js"

const foldsCase = process.platform === "win32" || process.platform === "darwin"

describe("withFileMutationLock", () => {
  test("serializes concurrent mutations of the same path", async () => {
    let inside = 0
    let overlapped = false
    const section = async () => {
      inside += 1
      if (inside > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 10))
      inside -= 1
    }

    await Promise.all([
      withFileMutationLock(join("/w", "same.txt"), section),
      withFileMutationLock(join("/w", "same.txt"), section),
    ])

    expect(overlapped).toBe(false)
  })

  test("case variants of one path share the lock on case-insensitive filesystems (#334)", async () => {
    let inside = 0
    let overlapped = false
    const section = async () => {
      inside += 1
      if (inside > 1) overlapped = true
      await new Promise((resolve) => setTimeout(resolve, 10))
      inside -= 1
    }

    await Promise.all([
      withFileMutationLock(join("/w", "File.TXT"), section),
      withFileMutationLock(join("/w", "file.txt"), section),
    ])

    // win32/darwin must serialize; a case-sensitive FS genuinely has two files.
    expect(overlapped).toBe(!foldsCase)
  })
})

describe("FileStateCache key normalization", () => {
  test("hits across path-case variants only where the filesystem folds case (#334)", () => {
    const cache = new FileStateCache()
    cache.set(join("/w", "File.TXT"), { content: "payload", timestamp: 1 })

    const hit = cache.get(join("/w", "file.txt"))
    expect(hit?.content).toBe(foldsCase ? "payload" : undefined)
  })

  test("delete clears across case variants on case-insensitive filesystems", () => {
    const cache = new FileStateCache()
    cache.set(join("/w", "File.TXT"), { content: "payload", timestamp: 1 })
    expect(cache.delete(join("/w", "file.txt"))).toBe(foldsCase)
  })
})
