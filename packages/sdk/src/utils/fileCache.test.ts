// packages/sdk/src/utils/fileCache.test.ts
import { describe, expect, test } from "bun:test"
import { FileStateCache } from "./fileCache.js"

describe("FileStateCache capacity accounting", () => {
  test("rejects an over-limit entry instead of evicting the whole table (#655)", () => {
    // 30MB 击穿复刻：单条目重量超字节上限时，旧实现清空全表后仍放入，
    // 上限被击穿且工作集全灭；新实现直接拒绝缓存，现有条目原样保留。
    const cache = new FileStateCache(50, 5000)
    for (let i = 0; i < 10; i++) {
      cache.set(`/src/file-${i}.ts`, { content: "x".repeat(200), timestamp: i })
    }
    expect(cache.size).toBe(10)

    cache.set("/bundle.js", { content: "y".repeat(2600), timestamp: 99 }) // 记账 5200 > 5000

    expect(cache.get("/bundle.js")).toBeUndefined()
    expect(cache.size).toBe(10)
    expect(cache.get("/src/file-0.ts")).toBeDefined()
    expect(cache.get("/src/file-9.ts")).toBeDefined()
    expect(cache.accountedBytes).toBe(10 * 400)
  })

  test("accounts residency at chars×2 rather than utf-8 bytes (dual basis, #655)", () => {
    const cache = new FileStateCache(10, 100)

    // CJK：utf8=147 字节（旧磁盘口径必拒），驻留记账 98 ≤ 100（新口径收）
    cache.set("/cjk.txt", { content: "中".repeat(49), timestamp: 1 })
    expect(cache.get("/cjk.txt")).toBeDefined()
    expect(cache.accountedBytes).toBe(98)

    // ASCII：utf8=60 字节（旧口径收），驻留记账 120 > 100（新口径拒）
    cache.set("/ascii.txt", { content: "a".repeat(60), timestamp: 2 })
    expect(cache.get("/ascii.txt")).toBeUndefined()
  })

  test("evicts the least recently used entry and keeps a drop record (#655)", () => {
    const cache = new FileStateCache(2, 10_000_000)
    cache.set("/a.txt", { content: "a", timestamp: 1 })
    cache.set("/b.txt", { content: "b", timestamp: 2 })
    expect(cache.get("/a.txt")).toBeDefined() // 触碰 a，b 变为最久未用

    cache.set("/c.txt", { content: "c", timestamp: 3 })

    expect(cache.get("/b.txt")).toBeUndefined()
    expect(cache.wasDroppedByCapacity("/b.txt")).toBe(true)
    expect(cache.wasDroppedByCapacity("/a.txt")).toBe(false)
    expect(cache.wasDroppedByCapacity("/c.txt")).toBe(false)
  })

  test("keeps entries and bytes under their bounds across churn", () => {
    const cache = new FileStateCache(8, 200)
    for (let i = 0; i < 40; i++) {
      cache.set(`/f-${i}.txt`, { content: "z".repeat(50), timestamp: i }) // 单条记账 100
    }
    expect(cache.size).toBeLessThanOrEqual(8)
    expect(cache.accountedBytes).toBeLessThanOrEqual(200)
  })
})
