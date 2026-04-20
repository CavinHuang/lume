import { describe, expect, test } from "bun:test"
import type { FileEntry } from "@lume/shared"
import { normalizeDirectoryEntriesResponse } from "./FileBrowser"

describe("normalizeDirectoryEntriesResponse", () => {
  test("应支持新的对象返回形状", () => {
    const entries: FileEntry[] = [
      { name: "a.txt", path: "/tmp/a.txt", isDirectory: false },
    ]
    expect(normalizeDirectoryEntriesResponse({ entries })).toEqual(entries)
  })

  test("应兼容旧的数组返回形状，避免前端崩溃", () => {
    const entries: FileEntry[] = [
      { name: "a.txt", path: "/tmp/a.txt", isDirectory: false },
    ]
    expect(normalizeDirectoryEntriesResponse(entries)).toEqual(entries)
  })

  test("空返回应回退为空数组", () => {
    expect(normalizeDirectoryEntriesResponse(undefined)).toEqual([])
  })
})
