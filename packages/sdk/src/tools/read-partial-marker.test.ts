/**
 * #535 部分读截断信号：Read 的结构化截断字段经 normalizeToolCallResult 坍缩后，
 * 模型侧以 content 尾部文本标记感知；sidecar 账本按 _meta.read 结构化字段判定
 * 完整/部分读（partial/summarized 由各路径权威写入）。
 */
import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileReadTool } from './index.js'

async function makeFile(dir: string, name: string, lines: number): Promise<string> {
  const filePath = join(dir, name)
  await writeFile(filePath, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n'), 'utf-8')
  return filePath
}

function readMeta(result: Awaited<ReturnType<typeof FileReadTool.call>>): Record<string, unknown> {
  const meta = (result as { _meta?: { read?: Record<string, unknown> } })._meta
  return meta?.read ?? {}
}

describe('Read partial-view signals (#535)', () => {
  test('default over-threshold read of non-summarizable file carries marker and partial flag', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lume-read-marker-'))
    try {
      // .vue 不在 SUMMARIZABLE_EXTENSIONS：默认读走 ranged 路径且必然截断
      const filePath = await makeFile(dir, 'comp.vue', 2500)
      const result = await FileReadTool.call({ file_path: filePath }, { cwd: dir } as never)
      const content = (result as { content?: unknown }).content
      expect(String(content)).toContain('[truncated: showing lines 1-2000 of 2500 total. Continue with offset')
      expect(readMeta(result).partial).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('zero-row view (offset past EOF) is authoritative partial — write guard must hold', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lume-read-marker-'))
    try {
      const filePath = await makeFile(dir, 'big.log', 300)
      const result = await FileReadTool.call({ file_path: filePath, offset: 5000, limit: 10 }, { cwd: dir } as never)
      // 零行视图 content 无标记可嗅探，但 partial 标志必须为真（#711 review P1）
      expect(readMeta(result).partial).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('explicit range read reports its shown window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lume-read-marker-'))
    try {
      const filePath = await makeFile(dir, 'big.log', 300)
      const result = await FileReadTool.call({ file_path: filePath, offset: 100, limit: 50 }, { cwd: dir } as never)
      const content = (result as { content?: unknown }).content
      expect(String(content)).toContain('[showing lines 101-150 of 300+; use offset=150 to continue reading]')
      expect(readMeta(result).partial).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('full in-range read has no marker and counts as a full read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lume-read-marker-'))
    try {
      const filePath = await makeFile(dir, 'small.txt', 10)
      const result = await FileReadTool.call({ file_path: filePath }, { cwd: dir } as never)
      const content = (result as { content?: unknown }).content
      expect(String(content)).not.toContain('[showing lines')
      expect(readMeta(result).partial).toBeFalsy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('continuation read reaching EOF from non-zero offset stays partial (#711 review)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lume-read-marker-'))
    try {
      // 分段续读最后一跳：只看了尾部片段，缓存与账本都不得标全量，
      // 否则后续 Edit 以片段比对全文必误报 modified
      const filePath = await makeFile(dir, 'cont.vue', 300)
      const result = await FileReadTool.call({ file_path: filePath, offset: 250, limit: 1000 }, { cwd: dir } as never)
      expect(readMeta(result).partial).toBe(true)
      const content = (result as { content?: unknown }).content
      expect(String(content)).toContain('[showing lines 251-300')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
