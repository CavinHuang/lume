import { afterEach, describe, expect, test } from 'bun:test'
import { findModelMeta, MODEL_META_SEED, setModelMeta, type ModelMeta } from '@lume/shared'
import { applyModelMetaUpdate } from './model-meta-context'

describe('applyModelMetaUpdate', () => {
  afterEach(() => setModelMeta(MODEL_META_SEED))

  test('null → 返回 false（保持 seed）', () => {
    expect(applyModelMetaUpdate(null)).toBe(false)
  })

  test('空数组 → 返回 true（setModelMeta 接受空）', () => {
    expect(applyModelMetaUpdate([])).toBe(true)
  })

  test('非空 generated → setModelMeta + 返回 true', () => {
    const custom: ModelMeta[] = [
      {
        id: 'ctx-test-model',
        displayName: 'Ctx',
        contextWindow: 123,
        capabilities: { vision: false, toolUse: true, reasoning: false },
      },
    ]
    expect(applyModelMetaUpdate(custom)).toBe(true)
    expect(findModelMeta('ctx-test-model')?.contextWindow).toBe(123)
  })
})
