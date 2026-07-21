import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MODEL_META_IPC_CHANNELS, MODEL_META_SEED, setModelMeta } from '@lume/shared'
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
    setModelMeta(MODEL_META_SEED)
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

describe('createModelMetaHandlers SYNC', () => {
  let tmpDir: string
  let prevEnv: string | undefined

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lume-mm-sync-'))
    prevEnv = process.env.LUME_CONFIG_DIR
    process.env.LUME_CONFIG_DIR = tmpDir
  })
  afterEach(async () => {
    setModelMeta(MODEL_META_SEED)
    mock.restore()
    if (prevEnv === undefined) delete process.env.LUME_CONFIG_DIR
    else process.env.LUME_CONFIG_DIR = prevEnv
    await rm(tmpDir, { recursive: true, force: true })
  })
  afterAll(() => { mock.restore() })

  test('成功：fetch + build + 原子写 + 返回未 merge generated', async () => {
    const miniCatalog = {
      providers: {
        openai: { models: { 'gpt-sync-test': { name: 'GPT Sync Test', tool_call: true, limit: { context: 8000 } } } },
      },
    }
    mock.module('../services/infra/proxy-fetch', () => ({
      fetchWithProxy: async () => new Response(JSON.stringify(miniCatalog), { status: 200 }),
    }))
    const { createModelMetaHandlers } = await import('./model-meta-handlers')
    const handlers = createModelMetaHandlers()
    const result = (await handlers[MODEL_META_IPC_CHANNELS.SYNC]!(null)) as Array<{ id: string }>
    expect(result.map((m) => m.id)).toContain('gpt-sync-test')
    // 验证 config dir 文件已原子写入，内容 = buildGeneratedFromCatalog 输出
    const written = JSON.parse(await readFile(join(tmpDir, 'model-meta.generated.json'), 'utf8')) as Array<{ id: string }>
    expect(written.map((m) => m.id)).toContain('gpt-sync-test')
    // .tmp 不残留
    await expect(readFile(join(tmpDir, 'model-meta.generated.json.tmp'), 'utf8')).rejects.toThrow()
  })

  test('fetch !ok → throw', async () => {
    mock.module('../services/infra/proxy-fetch', () => ({
      fetchWithProxy: async () => new Response('service unavailable', { status: 503 }),
    }))
    const { createModelMetaHandlers } = await import('./model-meta-handlers')
    const handlers = createModelMetaHandlers()
    await expect(handlers[MODEL_META_IPC_CHANNELS.SYNC]!(null)).rejects.toThrow(/503/)
  })
})
