/**
 * #535 部分读截断信号：Read 的结构化截断字段经 normalizeToolCallResult 坍缩后，
 * 截断信息必须以文本标记随 content 传递（模型可见 + sidecar 账本判定）。
 */
import { describe, test, expect } from 'bun:test'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileReadTool, isFullReadText } from './index.js'

async function makeFile(dir: string, name: string, lines: number): Promise<string> {
  const filePath = join(dir, name)
  await writeFile(filePath, Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n'), 'utf-8')
  return filePath
}

function contentOf(result: Awaited<ReturnType<typeof FileReadTool.call>>): string {
  // defineTool.call 已过 normalizeToolCallResult：结构化 data 坍缩为纯文本 content
  const content = (result as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}

describe('Read partial-view markers (#535)', () => {
  test('default over-threshold read of non-summarizable file carries a truncation marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lume-read-marker-'))
    try {
      // .vue 不在 SUMMARIZABLE_EXTENSIONS：默认读走 ranged 路径且必然截断
      const filePath = await makeFile(dir, 'comp.vue', 800)
      const result = await FileReadTool.call({ file_path: filePath }, { cwd: dir } as never)
      const content = contentOf(result)
      expect(content).toContain('\n[showing lines 1-500 of 800+; use offset=500 to continue reading]')
      expect(isFullReadText(content)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('explicit range read reports its shown window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lume-read-marker-'))
    try {
      const filePath = await makeFile(dir, 'big.log', 300)
      const result = await FileReadTool.call({ file_path: filePath, offset: 100, limit: 50 }, { cwd: dir } as never)
      const content = contentOf(result)
      expect(content).toContain('[showing lines 101-150 of 300+; use offset=150 to continue reading]')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('full in-range read has no marker and counts as a full read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lume-read-marker-'))
    try {
      const filePath = await makeFile(dir, 'small.txt', 10)
      const result = await FileReadTool.call({ file_path: filePath }, { cwd: dir } as never)
      const content = contentOf(result)
      expect(content).not.toContain('[showing lines')
      expect(isFullReadText(content)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
