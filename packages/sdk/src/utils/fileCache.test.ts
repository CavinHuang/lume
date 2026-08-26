// packages/sdk/src/utils/fileCache.test.ts
import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, symlink, writeFile } from "fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realpathSync } from "node:fs"
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

describe("FileStateCache canonical path identity", () => {
  test("lexical and realpath spellings of the same file share one entry", async () => {
    // f4643e04 收口后 Read 工具以 canonicalize 后的路径写缓存,而
    // NotebookEditTool 等仍以词法 resolve 路径查询——同一文件两种拼写
    // 必须命中同一条目,否则 read-before-edit 校验在 symlink 环境(macOS
    // /tmp、/var)整体失效。
    const root = await mkdtemp(join(tmpdir(), "lume-filecache-"))
    const realDir = join(root, "real")
    await mkdir(realDir)
    const linkDir = join(root, "link")
    await symlink(realDir, linkDir)
    const filePath = join(linkDir, "book.txt")
    await writeFile(filePath, "hello", "utf8")
    const realPath = realpathSync(filePath)

    const cache = new FileStateCache()
    cache.set(realPath, { content: "hello", timestamp: 1 })

    expect(cache.get(filePath)).toBeDefined()
    expect(cache.get(realPath)).toBeDefined()

    cache.delete(filePath)
    expect(cache.get(realPath)).toBeUndefined()
    expect(cache.wasDroppedByCapacity(realPath)).toBe(false)
  })

  test("clone preserves canonical identity across spellings", async () => {
    const root = await mkdtemp(join(tmpdir(), "lume-filecache-clone-"))
    const realDir = join(root, "real")
    await mkdir(realDir)
    const linkDir = join(root, "link")
    await symlink(realDir, linkDir)
    const filePath = join(linkDir, "book.txt")
    await writeFile(filePath, "hello", "utf8")
    const realPath = realpathSync(filePath)

    const cache = new FileStateCache()
    cache.set(filePath, { content: "hello", timestamp: 1 })
    const clone = cache.clone()

    // clone 直接复制内部 Map:键必须已是归一形态,词法/realpath 双拼写仍命中
    expect(clone.get(realPath)).toBeDefined()
    expect(clone.get(filePath)).toBeDefined()
  })

  // 大小写折叠 × symlink 叠加仅在大小写不敏感文件系统(darwin/win32)成立:
  // Linux 敏感盘上大写拼写本就不指向同一文件,不命中是正确行为(CI Ubuntu 实证)
  test.skipIf(process.platform === "linux")("case folding composes with symlink canonicalization", async () => {
    // macOS/Windows 不敏感盘:toPathKey 折叠大小写,camelize 目录经 symlink
    // 访问时两种拼写、两种大小写必须全部命中同一条目
    const root = await mkdtemp(join(tmpdir(), "lume-filecache-case-"))
    const camelReal = join(root, "CamelDir")
    await mkdir(camelReal)
    const linkPath = join(root, "linkdir")
    await symlink(camelReal, linkPath)
    const viaLinkLower = join(linkPath, "note.txt")
    await writeFile(viaLinkLower, "x", "utf8")

    const cache = new FileStateCache()
    cache.set(viaLinkLower.toUpperCase(), { content: "x", timestamp: 1 })

    expect(cache.get(viaLinkLower)).toBeDefined()
    expect(cache.get(join(realpathSync(linkPath), "NOTE.txt"))).toBeDefined()
    expect(cache.get(join(camelReal.toLowerCase(), "note.txt"))).toBeDefined()
  })
})
