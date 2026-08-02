import { describe, expect, test } from 'bun:test'
import type { ChannelModel } from '@lume/shared'
import { mergeChannelModels } from './ChannelForm'

const m = (id: string, name = id, enabled = true): ChannelModel => ({ id, name, enabled })

describe('mergeChannelModels', () => {
  test('returns fetched list when there is nothing to preserve', () => {
    expect(mergeChannelModels([], [m('gpt-4o')])).toEqual([
      { ...m('gpt-4o'), source: 'discovered' },
    ])
  })

  test('preserves manually-added models that the fetch did not return', () => {
    const existing = [m('gpt-4o'), m('my-custom-model')]
    const fetched = [m('gpt-4o'), m('gpt-4o-mini')]
    const merged = mergeChannelModels(existing, fetched)
    expect(merged.map((x) => x.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'my-custom-model'])
  })

  test('manual model wins when fetched contains the same id', () => {
    const existing = [m('dup', 'Manual Name', true)]
    const fetched = [m('dup', 'Fetched Name', false)]
    expect(mergeChannelModels(existing, fetched)).toEqual([
      { ...m('dup', 'Manual Name', true), source: 'manual' },
    ])
  })

  test('removes missing discovered models and enables newly discovered models', () => {
    const existing = [{ ...m('gone'), source: 'discovered' as const }]
    const fetched = [m('new', 'New', false)]
    expect(mergeChannelModels(existing, fetched)).toEqual([
      { ...m('new', 'New', true), source: 'discovered' },
    ])
  })

  test('returns empty when both inputs are empty', () => {
    expect(mergeChannelModels([], [])).toEqual([])
  })
})
