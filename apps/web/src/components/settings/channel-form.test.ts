import { describe, expect, test } from 'bun:test'
import type { ChannelModel } from '@lume/shared'
import { mergeChannelModels } from './ChannelForm'

const m = (id: string, name = id, enabled = true): ChannelModel => ({ id, name, enabled })

describe('mergeChannelModels', () => {
  test('returns fetched list when there is nothing to preserve', () => {
    expect(mergeChannelModels([], [m('gpt-4o')])).toEqual([m('gpt-4o')])
  })

  test('preserves manually-added models that the fetch did not return', () => {
    const existing = [m('gpt-4o'), m('my-custom-model')]
    const fetched = [m('gpt-4o'), m('gpt-4o-mini')]
    const merged = mergeChannelModels(existing, fetched)
    expect(merged.map((x) => x.id)).toEqual(['gpt-4o', 'gpt-4o-mini', 'my-custom-model'])
  })

  test('fetched overrides an existing model with the same id', () => {
    const existing = [m('dup', 'Manual Name', true)]
    const fetched = [m('dup', 'Fetched Name', false)]
    expect(mergeChannelModels(existing, fetched)).toEqual([m('dup', 'Fetched Name', false)])
  })

  test('returns empty when both inputs are empty', () => {
    expect(mergeChannelModels([], [])).toEqual([])
  })
})
