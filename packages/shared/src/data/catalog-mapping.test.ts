import { describe, expect, test } from 'bun:test'
import type { ModelMeta } from './model-meta'
import { buildGeneratedFromCatalog } from './catalog-mapping'
import type { Catalog } from './catalog-mapping'

const mkModel = (over: Record<string, unknown>) => over

const miniCatalog: Catalog = {
  providers: {
    openai: {
      models: {
        'gpt-5.2': mkModel({
          name: 'GPT-5.2', description: 'Reliable GPT generation',
          attachment: true, reasoning: true, tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 400000, output: 128000 },
          cost: { input: 1.75, output: 14, cache_read: 0.175 },
        }),
        'gpt-5.2-no-cost': mkModel({ name: 'GPT-5.2 NoCost', tool_call: true, limit: { context: 128000 } }),
        'vision-only': mkModel({
          name: 'Vision Only', tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 8000 },
        }),
      },
    },
    anthropic: {
      models: {
        'claude-sonnet-4-5': mkModel({
          name: 'Claude Sonnet 4.5', attachment: true, reasoning: true, tool_call: true,
          modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
          limit: { context: 200000, output: 64000 },
          cost: { input: 3, output: 15 },
        }),
      },
    },
    openrouter: { models: { 'some-aggregated-model': mkModel({ name: 'X', tool_call: true, limit: { context: 8000 } }) } },
    deepseek: { models: { 'bad-model': mkModel({ name: 'Bad', tool_call: true }) } },
  },
}

describe('buildGeneratedFromCatalog', () => {
  const result = buildGeneratedFromCatalog(miniCatalog)

  test('收录白名单 provider 的模型', () => {
    expect(result.map((m) => m.id)).toContain('gpt-5.2')
    expect(result.map((m) => m.id)).toContain('claude-sonnet-4-5')
  })
  test('不收录非白名单 provider', () => {
    expect(result.map((m) => m.id)).not.toContain('some-aggregated-model')
  })
  test('字段映射正确', () => {
    const gpt = result.find((m) => m.id === 'gpt-5.2') as ModelMeta
    expect(gpt.displayName).toBe('GPT-5.2')
    expect(gpt.contextWindow).toBe(400000)
    expect(gpt.capabilities).toEqual({ vision: true, toolUse: true, reasoning: true })
    expect(gpt.description).toBe('Reliable GPT generation')
  })
  test('vision 也可由 modalities.input 含 image 推出', () => {
    const visionOnly = result.find((m) => m.id === 'vision-only') as ModelMeta
    expect(visionOnly.capabilities.vision).toBe(true)
  })
  test('定价单位不变（USD/1M tokens，禁止换算）', () => {
    const gpt = result.find((m) => m.id === 'gpt-5.2') as ModelMeta
    expect(gpt.pricing).toEqual({ input: 1.75, output: 14 })
  })
  test('缺 cost 的模型 pricing 省略', () => {
    const nocost = result.find((m) => m.id === 'gpt-5.2-no-cost') as ModelMeta
    expect(nocost.pricing).toBeUndefined()
  })
  test('缺 limit.context 的模型被跳过', () => {
    expect(result.map((m) => m.id)).not.toContain('bad-model')
  })
  test('结果按 id 字典序排序', () => {
    const ids = result.map((m) => m.id)
    expect(ids).toEqual([...ids].sort())
  })
})
