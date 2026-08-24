// packages/sdk/src/utils/text-file.test.ts
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { decodeTextFile, readTextFileRange } from "./text-file.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeFile(name: string, content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lume-text-file-"))
  roots.push(root)
  const filePath = join(root, name)
  await writeFile(filePath, content, "utf8")
  return filePath
}

describe("readTextFileRange", () => {
  test("flags truncated when the window fills before EOF (#314)", async () => {
    const filePath = await makeFile(
      "big.txt",
      Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n"),
    )

    const ranged = await readTextFileRange(filePath, 0, 2)

    // A tiny file arrives in one chunk so every line gets counted before the
    // window check fires; truncated means "EOF was never verified", and the
    // read tool must treat totalLines as an unverified count.
    expect(ranged.truncated).toBe(true)
    expect(ranged.content).toBe("line-0\nline-1")
    expect(ranged.totalLines).toBe(10)
  })

  test("reports truncated=false with exact totalLines when the stream reaches EOF", async () => {
    const filePath = await makeFile("small.txt", "a\nb\nc")

    const ranged = await readTextFileRange(filePath, 0, 100)

    expect(ranged.truncated).toBe(false)
    expect(ranged.totalLines).toBe(3)
    expect(ranged.content).toBe("a\nb\nc")
  })

  test("a window that fills exactly at the last line still reports the conservative lower bound", async () => {
    // "alpha\nbeta\n" is exactly two lines; the reader stops at the filled
    // window without seeing EOF, so it must not claim exactness.
    const filePath = await makeFile("trailing.txt", "alpha\nbeta\n")

    const ranged = await readTextFileRange(filePath, 0, 2)

    expect(ranged.truncated).toBe(true)
    expect(ranged.totalLines).toBe(2)
    expect(ranged.content).toBe("alpha\nbeta")
  })

  test("offset windows past EOF report truncated=false", async () => {
    const filePath = await makeFile("tiny.txt", "only\n")

    const ranged = await readTextFileRange(filePath, 50, 10)

    expect(ranged.truncated).toBe(false)
    expect(ranged.totalLines).toBe(1)
    expect(ranged.content).toBe("")
  })

  test("preserves the trailing newline when the window reaches EOF (#569)", async () => {
    // Read 缓存的全视图要与 Edit/Write 侧磁盘原文逐字一致，行尾换行不能丢。
    const filePath = await makeFile("eol.txt", "alpha\nbeta\n")

    const ranged = await readTextFileRange(filePath, 0, 100)

    expect(ranged.truncated).toBe(false)
    expect(ranged.totalLines).toBe(2)
    expect(ranged.content).toBe("alpha\nbeta\n")
  })

  test("range view equals decodeTextFile for every line-ending style (#569)", async () => {
    // 归一口径必须与 Edit/Write 侧 decodeTextFile 一致：CR-only 文件旧口径
    // 只剥行尾 \r，两视图永不相等 → 强制先读后 Edit 撞 stale_read 死循环。
    const samples = [
      "alpha\nbeta\n",
      "alpha\r\nbeta\r\n",
      "alpha\rbeta\r",
      "alpha\rbeta",
      "alpha\nbeta",
      "a\r\nb\nc\rd\n",
    ]
    for (const raw of samples) {
      const filePath = await makeFile("eol.txt", raw)
      const ranged = await readTextFileRange(filePath, 0, 100)
      const decoded = decodeTextFile(await readFile(filePath))
      expect(ranged.truncated).toBe(false)
      expect(ranged.content).toBe(decoded.content)
    }
  })

  test("counts CR-only terminators as lines like the decode view (#569)", async () => {
    const filePath = await makeFile("classic.txt", "alpha\rbeta\r")

    const ranged = await readTextFileRange(filePath, 0, 100)

    expect(ranged.totalLines).toBe(2)
    expect(ranged.content).toBe("alpha\nbeta\n")
  })
})
