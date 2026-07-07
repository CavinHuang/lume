import { describe, expect, test } from 'bun:test'
import type { ModelMeta } from './model-meta'
import { mergeModelMeta } from './merge-models'
import type { ModelOverride } from './model-meta.override'

const base = (id: string, over: Partial<ModelMeta> = {}): ModelMeta => ({
  id,
  displayName: id,
  contextWindow: 1000,
  capabilities: { vision: false, toolUse: true, reasoning: false },
  ...over,
})

describe('mergeModelMeta', () => {
  test('override 覆盖 generated 标量字段', () => {
    const generated = [base('m1')]
    const overrides: Record<string, ModelOverride> = { m1: { displayName: '新名', contextWindow: 9999 } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.displayName).toBe('新名')
    expect(m.contextWindow).toBe(9999)
  })

  test('capabilities 按分量合并（override 仅覆盖指定分量）', () => {
    const generated = [base('m1', { capabilities: { vision: true, toolUse: true, reasoning: false } })]
    const overrides: Record<string, ModelOverride> = { m1: { capabilities: { reasoning: true } } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.capabilities).toEqual({ vision: true, toolUse: true, reasoning: true })
  })

  test('pricing 整体替换', () => {
    const generated = [base('m1', { pricing: { input: 3, output: 15 } })]
    const overrides: Record<string, ModelOverride> = { m1: { pricing: { input: 1, output: 2 } } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.pricing).toEqual({ input: 1, output: 2 })
  })

  test('aliases 取并集去重，generated 在前', () => {
    const generated = [base('m1', { aliases: ['a', 'b'] })]
    const overrides: Record<string, ModelOverride> = { m1: { aliases: ['b', 'c'] } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.aliases).toEqual(['a', 'b', 'c'])
  })

  test('override 独有 id 作为新条目追加（standalone）', () => {
    const generated = [base('m1')]
    const overrides: Record<string, ModelOverride> = {
      m2: { displayName: '缺口模型', contextWindow: 8000, capabilities: { toolUse: true, reasoning: true } },
    }
    const result = mergeModelMeta(generated, overrides)
    expect(result.map((m) => m.id)).toEqual(['m1', 'm2'])
    const m2 = result[1]
    expect(m2.displayName).toBe('缺口模型')
    expect(m2.contextWindow).toBe(8000)
    // 未指定的 capability 分量补 false
    expect(m2.capabilities).toEqual({ vision: false, toolUse: true, reasoning: true })
  })

  test('无 override 的 generated 条目保持不变', () => {
    const generated = [base('m1', { description: '原描述' })]
    const result = mergeModelMeta(generated, {})
    expect(result[0]).toEqual(generated[0])
  })

  test('override 既无 aliases 又无 generated aliases 时，结果无 aliases 字段', () => {
    const generated = [base('m1')]
    const overrides: Record<string, ModelOverride> = { m1: { description: 'x' } }
    const [m] = mergeModelMeta(generated, overrides)
    expect(m.aliases).toBeUndefined()
  })
})
