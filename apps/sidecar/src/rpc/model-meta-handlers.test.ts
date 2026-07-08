import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_META_IPC_CHANNELS } from '@lume/shared'
import { createModelMetaHandlers } from './model-meta-handlers'

describe('createModelMetaHandlers GET', () => {
  let tmpDir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lume-mm-'))
    prevEnv = process.env.LUME_CONFIG_DIR
    process.env.LUME_CONFIG_DIR = tmpDir
  })
  afterEach(async () => {
    if (prevEnv === undefined) delete process.env.LUME_CONFIG_DIR
    else process.env.LUME_CONFIG_DIR = prevEnv
    await rm(tmpDir, { recursive: true, force: true })
  })
  afterAll(() => { /* bun:test 无 mock.restore 需要 */ })

  test('有合法文件 → 返回 parsed ModelMeta[]', async () => {
    const data = [{ id: 'x', displayName: 'X', contextWindow: 100, capabilities: { vision: false, toolUse: false, reasoning: false } }]
    await writeFile(join(tmpDir, 'model-meta.generated.json'), JSON.stringify(data))
    const handlers = createModelMetaHandlers()
    const result = await handlers[MODEL_META_IPC_CHANNELS.GET]!(null)
    expect(result).toEqual(data)
  })

  test('文件不存在 → 返回 null（web 保持 seed）', async () => {
    const handlers = createModelMetaHandlers()
    const result = await handlers[MODEL_META_IPC_CHANNELS.GET]!(null)
    expect(result).toBeNull()
  })

  test('JSON 损坏 → throw', async () => {
    await writeFile(join(tmpDir, 'model-meta.generated.json'), '{not valid json')
    const handlers = createModelMetaHandlers()
    await expect(handlers[MODEL_META_IPC_CHANNELS.GET]!(null)).rejects.toThrow()
  })
})
