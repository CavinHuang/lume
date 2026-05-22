import { describe, expect, test } from 'bun:test'
import type { ChannelModel } from '@lume/shared'
import {
  filterChannelModels,
  invertChannelModelsEnabled,
  setChannelModelsEnabled,
} from './ChannelForm'

const models: ChannelModel[] = [
  { id: 'Qwen/Qwen3-Embedding-0.6B', name: 'Qwen3 Embedding', enabled: false },
  { id: 'BAAI/bge-m3', name: 'BGE M3', enabled: true },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', enabled: false },
]

describe('ChannelForm model list helpers', () => {
  test('filters models by id or name', () => {
    expect(filterChannelModels(models, 'embedding').map((model) => model.id)).toEqual([
      'Qwen/Qwen3-Embedding-0.6B',
    ])
    expect(filterChannelModels(models, 'bge').map((model) => model.id)).toEqual([
      'BAAI/bge-m3',
    ])
  })

  test('bulk enable and invert only affect filtered model ids', () => {
    const filteredIds = filterChannelModels(models, 'embedding').map((model) => model.id)
    const enabled = setChannelModelsEnabled(models, filteredIds, true)
    expect(enabled.map((model) => [model.id, model.enabled])).toEqual([
      ['Qwen/Qwen3-Embedding-0.6B', true],
      ['BAAI/bge-m3', true],
      ['deepseek-chat', false],
    ])

    const inverted = invertChannelModelsEnabled(enabled, filteredIds)
    expect(inverted.map((model) => [model.id, model.enabled])).toEqual([
      ['Qwen/Qwen3-Embedding-0.6B', false],
      ['BAAI/bge-m3', true],
      ['deepseek-chat', false],
    ])
  })
})
